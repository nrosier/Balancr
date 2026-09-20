/**
 * All Gemini traffic lives in this one file.
 *
 * Same rule as the Ghostfolio adapter, for a different reason: there, one file
 * contains the damage from an unversioned API; here, one file contains *what
 * leaves the machine*. `domain/ai/redact.ts` decides what a payload may contain,
 * and this is the only thing that puts a payload on the wire — so a review of
 * those two files is a review of everything Google ever sees.
 *
 * Three properties are structural rather than conventional:
 *
 *  - **The data is fenced.** Financial figures go inside a delimited block, and
 *    the system instruction says in as many words that the block is data and
 *    never instructions. v1 sends no payee or memo text, which removes most of
 *    the injection surface — but a category *name* is still user-controlled text
 *    that arrived from a bank feed, and the discipline costs nothing.
 *  - **The delimiter cannot be forged.** If a payload contains the fence
 *    markers, the call is refused rather than sent, because a payload that can
 *    close the fence can write instructions outside it.
 *  - **The stable half is cached.** The system prompt is identical between runs;
 *    context caching bills those tokens at a fraction of the rate. A cache that
 *    cannot be created is a cost problem, never a correctness one, so failure
 *    falls back to sending the instruction inline.
 */
import { createHash } from 'node:crypto'
import { GoogleGenAI, type GoogleGenAIOptions } from '@google/genai'
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import { resolvedIntegrations } from '../../db/tenant-integrations.ts'
import { logger } from '../../logger.ts'
import {
  DATA_CLOSE,
  DATA_OPEN,
  FENCE_CONTRACT,
  fenceData as neutralFenceData,
  systemInstruction,
} from '../ai/prompt.ts'
import { AiError, ZERO_USAGE, type AiCall, type AiProvider, type AiResult, type TokenUsage } from '../ai/types.ts'
import { toGeminiSchema } from './json-schema.ts'

const log = logger.child({ module: 'gemini' })

/** A hung model call must not hold the nightly pass open indefinitely. */
const REQUEST_TIMEOUT_MS = 120_000

/**
 * How long a cached system prompt lives.
 *
 * An hour: long enough that the nightly pass and the runs a person triggers
 * while reading the result share one cache, short enough that an edited prompt
 * cannot be served from a stale cache for a whole day. The cache key includes a
 * hash of the prompt text anyway, so an edit gets a new cache either way — the
 * TTL only bounds what is paid for in storage.
 */
const CACHE_TTL_SECONDS = 3_600

/**
 * Characters per token, for deciding whether a cache is worth asking for.
 *
 * Deliberately low. English prose tokenises at roughly four characters per
 * token, so dividing by three **over**-states the count — and that is the safe
 * direction: an over-estimate can only ever make Balancr *attempt* a create that
 * the provider then refuses, which costs one round trip and is exactly the
 * behaviour that existed before this check. An under-estimate would silently
 * skip a cache that would have worked, and nothing in the logs would say so.
 */
const CHARS_PER_TOKEN = 3

/**
 * Roughly how many tokens a string will cost, rounded up.
 *
 * Not a tokeniser and not trying to be. It answers one question — "is this
 * plainly too short to cache?" — where being within a factor of two is enough,
 * and it answers it without a network call. `countTokens` would be exact and
 * would cost a request per model per startup to learn something a division
 * already settles.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * The fence around untrusted data.
 *
 * Long and unlikely rather than pretty: `---` would appear in a category name
 * one day and quietly split the block.
 */
export { DATA_OPEN, DATA_CLOSE, FENCE_CONTRACT, systemInstruction }

/**
 * Prepended to every system prompt, before the user's editable text.
 *
 * Not part of the prompt table on purpose: the fence contract belongs to
 * whichever code writes the fence, and a prompt editor must not be able to edit
 * away the sentence that says the data is not instructions.
 */
export class GeminiError extends AiError {
  constructor(
    message: string,
    override readonly cause?: unknown,
    provider: AiProvider = 'gemini-aistudio',
  ) {
    super(provider, message, cause)
    this.name = 'GeminiError'
  }
}

/**
 * SDK options for the configured provider.
 *
 * Pure, and exported, because this is the decision that determines *where the
 * data goes*: Vertex in `europe-west1` keeps it in the EU, AI Studio does not
 * promise that. Worth being able to assert in a test rather than trusting a
 * constructor call nobody reads.
 */
export function clientOptions(db: Db, tenantId: string): GoogleGenAIOptions {
  const ai = resolvedIntegrations(db, tenantId).ai
  if (ai.provider === 'gemini-vertex') {
    return {
      vertexai: true,
      // Both are guaranteed present for `vertex` by the settings route's cross-field check.
      project: ai.project as string,
      location: config.GOOGLE_CLOUD_LOCATION,
    }
  }
  return { apiKey: ai.apiKey as string }
}

interface TenantGeminiState {
  client: GoogleGenAI
  /** Cache resource name per (model, system instruction), keyed by content hash. */
  cacheNames: Map<string, string>
}

const tenants = new Map<string, TenantGeminiState>()

/**
 * Set by `setGeminiClient`, installed into whichever tenant the next
 * `tenantState` call resolves. Only one override is ever pending at a time —
 * every test that stubs a client calls `callGemini`/`clientOptions` for a
 * single tenant immediately after, so there is never a second tenant waiting
 * for the same override.
 */
let pendingClientOverride: GoogleGenAI | undefined

function providerFor(db: Db, tenantId: string): AiProvider {
  return resolvedIntegrations(db, tenantId).ai.provider
}

function tenantState(db: Db, tenantId: string): TenantGeminiState {
  const key = `${tenantId}:${providerFor(db, tenantId)}`
  if (pendingClientOverride !== undefined) {
    const state: TenantGeminiState = { client: pendingClientOverride, cacheNames: new Map() }
    tenants.set(key, state)
    pendingClientOverride = undefined
    return state
  }
  let state = tenants.get(key)
  if (state === undefined) {
    state = { client: new GoogleGenAI(clientOptions(db, tenantId)), cacheNames: new Map() }
    tenants.set(key, state)
  }
  return state
}

function genai(db: Db, tenantId: string): GoogleGenAI {
  return tenantState(db, tenantId).client
}

/** Test seam: swap the SDK client, or drop every tenant's so config changes take effect. */
export function setGeminiClient(next: GoogleGenAI | null): void {
  if (next === null) {
    tenants.clear()
    pendingClientOverride = undefined
    return
  }
  pendingClientOverride = next
}

/**
 * The fenced data block.
 *
 * Refuses rather than escapes: an escaping scheme has to be got right in two
 * places and stays right only until someone changes one of them, while a payload
 * containing the fence marker is a bug worth hearing about. It cannot happen by
 * accident — the marker is not a string that turns up in a budget.
 */
export function fenceData(payload: unknown, provider: AiProvider = 'gemini-aistudio'): string {
  try {
    return neutralFenceData(payload, provider)
  } catch (error) {
    if (error instanceof AiError) throw new GeminiError(error.message, error, provider)
    throw error
  }
}

/** What the SDK reports about token use. Every counter is optional upstream. */
export interface RawUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
  cachedContentTokenCount?: number
  thoughtsTokenCount?: number
}

/** Tokens as the API reported them, with absent counters read as zero. */
export function readUsage(usageMetadata: RawUsage | undefined): TokenUsage {
  if (usageMetadata === undefined) return { ...ZERO_USAGE }
  const cachedTokens = usageMetadata.cachedContentTokenCount ?? 0
  return {
    // Google includes cache reads in promptTokenCount; the neutral contract
    // records ordinary input and cache reads as separate, non-overlapping bins.
    inputTokens: Math.max(0, (usageMetadata.promptTokenCount ?? 0) - cachedTokens),
    // Thinking tokens are billed as output and are absent from
    // `candidatesTokenCount`. Leaving them out would make the ledger read low on
    // exactly the model chosen for the monthly narrative.
    outputTokens:
      (usageMetadata.candidatesTokenCount ?? 0) + (usageMetadata.thoughtsTokenCount ?? 0),
    cachedTokens,
    cacheWriteTokens: 0,
  }
}

const cacheKey = (model: string, instruction: string): string =>
  `${model} ${createHash('sha256').update(instruction).digest('hex')}`

/**
 * The cached-content resource for this system instruction, or null.
 *
 * Null is a normal answer, not a failure: providers impose a minimum cacheable
 * token count, and a short prompt is simply below it. Either way the call goes
 * out — with `cachedContent` when there is one, with `systemInstruction` inline
 * when there is not. The empty string is remembered for a prompt that could not
 * be cached, so a nightly pass does not retry a doomed create every run.
 *
 * The minimum is checked here rather than discovered from a rejection (#121).
 * Balancr's own prompts are ~450–600 tokens against Google's floor of 1024, so
 * every process start was spending a failed `caches.create` per model to learn
 * something arithmetic already knows, and writing an "unavailable" warning into
 * the log of a system that is working correctly. The estimate is local and
 * approximate and the provider remains the authority: when the estimate clears
 * the floor the create is attempted, and a rejection still falls back inline.
 *
 * The branch is not dead code waiting to be deleted. The fund universe (#40) is
 * the reason caching was built, and it is what will push the system prompt past
 * the floor — at which point this check stops firing and nothing else changes.
 */
async function cacheFor(
  db: Db,
  tenantId: string,
  model: string,
  instruction: string,
): Promise<string | null> {
  const state = tenantState(db, tenantId)
  const key = cacheKey(model, instruction)
  const held = state.cacheNames.get(key)
  if (held !== undefined) return held === '' ? null : held

  const estimated = estimateTokens(instruction)
  if (config.GEMINI_CACHE_MIN_TOKENS > 0 && estimated < config.GEMINI_CACHE_MIN_TOKENS) {
    // A statement of fact at debug, once per prompt, not a warning: there is
    // nothing here for an operator to fix.
    log.debug(
      { model, estimated, minimum: config.GEMINI_CACHE_MIN_TOKENS },
      'context caching does not apply at this prompt size; sending it inline',
    )
    state.cacheNames.set(key, '')
    return null
  }

  try {
    const cache = await state.client.caches.create({
      model,
      config: {
        systemInstruction: instruction,
        ttl: `${CACHE_TTL_SECONDS}s`,
        displayName: 'balancr-system-prompt',
      },
    })
    if (cache.name === undefined || cache.name === '') {
      state.cacheNames.set(key, '')
      return null
    }
    state.cacheNames.set(key, cache.name)
    log.debug({ model, cache: cache.name }, 'cached system prompt')
    return cache.name
  } catch (error) {
    // Below the minimum token count, quota, an unsupported model: all of them
    // mean "pay full price for the input", which is not a reason to skip the run.
    log.debug(
      { model, err: error instanceof Error ? error.message : String(error) },
      'context caching unavailable; sending the system prompt inline',
    )
    state.cacheNames.set(key, '')
    return null
  }
}

/**
 * One call. Returns text and tokens; every interpretation happens elsewhere.
 *
 * Deliberately does not touch the database. `domain/ai/runs.ts` records the
 * attempt and `domain/ai/budget.ts` decides whether it may happen — an adapter
 * that wrote its own ledger row would be a second place where cost is counted.
 */
export async function callGemini(db: Db, tenantId: string, call: AiCall): Promise<AiResult> {
  const provider = providerFor(db, tenantId)
  const instruction = systemInstruction(call.systemPrompt)
  const prompt = `${call.instruction.trim()}\n\n${fenceData(call.payload, provider)}`
  const cache = await cacheFor(db, tenantId, call.model, instruction)

  const started = Date.now()
  try {
    const response = await genai(db, tenantId).models.generateContent({
      model: call.model,
      contents: prompt,
      config: {
        ...(cache === null ? { systemInstruction: instruction } : { cachedContent: cache }),
        temperature: call.temperature ?? 0.2,
        ...(call.maxOutputTokens === undefined ? {} : { maxOutputTokens: call.maxOutputTokens }),
        ...(call.responseJsonSchema === undefined
          ? {}
          : {
              responseMimeType: 'application/json',
              responseJsonSchema: toGeminiSchema(call.responseJsonSchema),
            }),
        abortSignal: call.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    })

    const text = response.text
    if (text === undefined || text.trim() === '') {
      // An empty candidate list is what a safety block looks like from here.
      throw new GeminiError(
        'model returned no text (finish reason: ' +
          `${response.candidates?.[0]?.finishReason ?? 'unknown'})`,
      )
    }

    return {
      provider,
      text,
      usage: readUsage(response.usageMetadata),
      model: response.modelVersion ?? call.model,
      cached: cache !== null,
      durationMs: Date.now() - started,
      finishReason: response.candidates?.[0]?.finishReason ?? null,
    }
  } catch (error) {
    if (error instanceof GeminiError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new GeminiError(
      `Gemini call failed after ${Date.now() - started}ms: ${detail}` +
        schemaHint(call, detail),
      error,
      provider,
    )
  }
}

/**
 * The sentence #96 was missing.
 *
 * `INVALID_ARGUMENT` on a call that carries a response schema is almost always
 * the schema: the rest of the request is what a narrative call sends too, and
 * that one succeeds in the same pass. Gemini names no keyword and returns no
 * field path, so without this the log says only that a 400 happened — which is
 * indistinguishable from a bad key, a missing model, or a malformed payload.
 */
function schemaHint(call: AiCall, detail: string): string {
  if (call.responseJsonSchema === undefined) return ''
  if (!detail.includes('INVALID_ARGUMENT')) return ''
  return (
    ' — this call carried a response schema, and Gemini rejects a schema using ' +
    'keywords outside its supported subset without saying which; check ' +
    'toGeminiSchema in adapters/gemini/json-schema.ts'
  )
}
