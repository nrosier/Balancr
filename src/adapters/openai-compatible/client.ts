import { z } from 'zod'
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import { resolvedIntegrations } from '../../db/tenant-integrations.ts'
import { fenceData, systemInstruction } from '../ai/prompt.ts'
import { AiError, ZERO_USAGE, type AiCall, type AiProvider, type AiResult, type TokenUsage } from '../ai/types.ts'

export const OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const XAI_BASE_URL = 'https://api.x.ai/v1'
export const OPENAI_DEFAULT_MODELS = { fast: 'gpt-5.4-mini', deep: 'gpt-5.4' } as const
export const XAI_DEFAULT_MODELS = { fast: 'grok-4.3', deep: 'grok-4.3' } as const

const REQUEST_TIMEOUT_MS = 120_000
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export interface OpenAiCompatibleConfig {
  provider: Extract<AiProvider, 'openai' | 'xai' | 'openai-compatible'>
  baseUrl: string
  apiKey: string | null
}

export class OpenAiCompatibleError extends AiError {
  constructor(
    provider: OpenAiCompatibleConfig['provider'],
    message: string,
    override readonly cause?: unknown,
  ) {
    super(provider, message, cause)
    this.name = 'OpenAiCompatibleError'
  }
}

/** Official presets are code-owned; only custom endpoints can supply a URL. */
export function baseUrlFor(
  provider: OpenAiCompatibleConfig['provider'],
  customBaseUrl: string | null,
): string {
  if (provider === 'openai') return OPENAI_BASE_URL
  if (provider === 'xai') return XAI_BASE_URL
  if (customBaseUrl === null) throw new OpenAiCompatibleError(provider, 'A base URL is required for a custom endpoint.')
  return validateCustomBaseUrl(customBaseUrl)
}

/**
 * Custom endpoints are an operator decision, never a tenant-created egress rule.
 * HTTP is accepted only for an explicitly approved loopback runtime such as Ollama.
 *
 * A hostname string match against `EGRESS_EXTRA_HOSTS`, same as `src/egress.ts`'s
 * allowlist and for the same reason — see that file's module docstring for the
 * allowlist-over-blocklist rationale and the DNS-rebinding trade-off that comes
 * with checking a hostname rather than the IP it resolves to (#467).
 */
export function validateCustomBaseUrl(
  value: string,
  approvedHosts: readonly string[] = config.EGRESS_EXTRA_HOSTS,
): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new OpenAiCompatibleError('openai-compatible', 'The custom AI base URL is not a valid URL.')
  }
  if (url.username !== '' || url.password !== '') {
    throw new OpenAiCompatibleError('openai-compatible', 'The custom AI base URL must not contain credentials.')
  }
  if (url.search !== '') {
    throw new OpenAiCompatibleError('openai-compatible', 'The custom AI base URL must not contain a query string.')
  }
  if (url.hash !== '') {
    throw new OpenAiCompatibleError('openai-compatible', 'The custom AI base URL must not contain a fragment.')
  }
  const hostname = url.hostname.toLowerCase()
  const approved = new Set(approvedHosts.map((host) => host.trim().toLowerCase()).filter(Boolean))
  if (!approved.has(hostname)) {
    throw new OpenAiCompatibleError(
      'openai-compatible',
      `The custom AI host ${hostname} is not deployment-approved in EGRESS_EXTRA_HOSTS.`,
    )
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(hostname))) {
    throw new OpenAiCompatibleError(
      'openai-compatible',
      'Custom AI endpoints must use HTTPS; HTTP is allowed only for an approved loopback host.',
    )
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.href.replace(/\/$/, '')
}

const responseSchema = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullable().optional(),
      refusal: z.string().nullable().optional(),
    }),
    finish_reason: z.string().nullable().optional(),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    prompt_tokens_details: z.object({
      cached_tokens: z.number().int().nonnegative().optional(),
      cache_write_tokens: z.number().int().nonnegative().optional(),
    }).optional(),
    cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  }).optional(),
})

export type OpenAiCompatibleUsage = z.infer<typeof responseSchema>['usage']

export function readOpenAiUsage(usage: OpenAiCompatibleUsage): TokenUsage {
  if (usage === undefined) return { ...ZERO_USAGE }
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0
  const cacheWriteTokens =
    usage.prompt_tokens_details?.cache_write_tokens ?? usage.cache_creation_input_tokens ?? 0
  return {
    inputTokens: Math.max(0, (usage.prompt_tokens ?? 0) - cachedTokens - cacheWriteTokens),
    outputTokens: usage.completion_tokens ?? 0,
    cachedTokens,
    cacheWriteTokens,
  }
}

export function normalizeFinishReason(reason: string | null | undefined): string | null {
  if (reason === undefined || reason === null) return null
  if (reason === 'length') return 'MAX_TOKENS'
  if (reason === 'stop') return 'STOP'
  if (reason === 'content_filter') return 'SAFETY'
  return reason.toUpperCase()
}

function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`
}

function upstreamError(status: number): string {
  if (status === 401 || status === 403) return `authentication failed (HTTP ${status})`
  if (status === 404) return 'the endpoint or selected model was not found (HTTP 404)'
  if (status === 429) return 'the provider rate limit was reached (HTTP 429)'
  return `the provider returned HTTP ${status}`
}

/** A direct seam used by the settings capability probe as well as normal calls. */
export async function callOpenAiCompatibleWithConfig(
  connection: OpenAiCompatibleConfig,
  call: AiCall,
): Promise<AiResult> {
  const baseUrl = baseUrlFor(connection.provider, connection.baseUrl)
  const started = Date.now()
  try {
    const response = await fetch(chatCompletionsUrl(baseUrl), {
      method: 'POST',
      redirect: 'manual',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(connection.apiKey === null ? {} : { authorization: `Bearer ${connection.apiKey}` }),
      },
      body: JSON.stringify({
        model: call.model,
        messages: [
          { role: 'system', content: systemInstruction(call.systemPrompt) },
          { role: 'user', content: `${call.instruction.trim()}\n\n${fenceData(call.payload, connection.provider)}` },
        ],
        ...(call.temperature === undefined ? {} : { temperature: call.temperature }),
        ...(call.maxOutputTokens === undefined ? {} : { max_completion_tokens: call.maxOutputTokens }),
        ...(call.responseJsonSchema === undefined
          ? {}
          : {
              response_format: {
                type: 'json_schema',
                json_schema: { name: 'balancr_response', strict: true, schema: call.responseJsonSchema },
              },
            }),
      }),
      signal: call.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (REDIRECT_STATUSES.has(response.status)) {
      throw new OpenAiCompatibleError(connection.provider, 'The AI endpoint returned a redirect; redirects are refused.')
    }
    if (!response.ok) throw new OpenAiCompatibleError(connection.provider, upstreamError(response.status))

    const parsed = responseSchema.safeParse(await response.json())
    if (!parsed.success) {
      throw new OpenAiCompatibleError(connection.provider, 'The AI endpoint returned an invalid Chat Completions response.')
    }
    const choice = parsed.data.choices[0]!
    if (choice.message.refusal !== undefined && choice.message.refusal !== null) {
      throw new OpenAiCompatibleError(connection.provider, 'The model refused the request.')
    }
    const text = choice.message.content
    if (text === undefined || text === null || text.trim() === '') {
      throw new OpenAiCompatibleError(connection.provider, 'The model returned no text.')
    }
    return {
      provider: connection.provider,
      text,
      usage: readOpenAiUsage(parsed.data.usage),
      model: parsed.data.model ?? call.model,
      cached: (parsed.data.usage?.prompt_tokens_details?.cached_tokens ?? 0) > 0,
      durationMs: Date.now() - started,
      finishReason: normalizeFinishReason(choice.finish_reason),
    }
  } catch (error) {
    if (error instanceof OpenAiCompatibleError) throw error
    const detail = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'failed'
    throw new OpenAiCompatibleError(
      connection.provider,
      `OpenAI-compatible call ${detail} after ${Date.now() - started}ms.`,
      error,
    )
  }
}

export async function callOpenAiCompatible(db: Db, tenantId: string, call: AiCall): Promise<AiResult> {
  const ai = resolvedIntegrations(db, tenantId).ai
  if (ai.provider !== 'openai' && ai.provider !== 'xai' && ai.provider !== 'openai-compatible') {
    throw new AiError(ai.provider, 'The selected provider is not OpenAI-compatible.')
  }
  return callOpenAiCompatibleWithConfig(
    { provider: ai.provider, baseUrl: baseUrlFor(ai.provider, ai.baseUrl), apiKey: ai.apiKey },
    call,
  )
}
