import { z } from 'zod'
import type { Db } from '../../db/index.ts'
import { resolvedIntegrations } from '../../db/tenant-integrations.ts'
import { fenceData, systemInstruction } from '../ai/prompt.ts'
import { AiError, ZERO_USAGE, type AiCall, type AiResult, type TokenUsage } from '../ai/types.ts'

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1'
export const ANTHROPIC_DEFAULT_MODELS = { fast: 'claude-sonnet-5', deep: 'claude-opus-5' } as const

const API_VERSION = '2023-06-01'
const REQUEST_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export interface AnthropicConfig {
  apiKey: string
}

export class AnthropicError extends AiError {
  constructor(message: string, override readonly cause?: unknown) {
    super('anthropic', message, cause)
    this.name = 'AnthropicError'
  }
}

const responseSchema = z.object({
  model: z.string(),
  content: z.array(z.object({
    type: z.string(),
    text: z.string().optional(),
  })),
  stop_reason: z.string().nullable(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    cache_creation_input_tokens: z.number().int().nonnegative().optional(),
    cache_read_input_tokens: z.number().int().nonnegative().optional(),
  }).optional(),
})

export type AnthropicUsage = z.infer<typeof responseSchema>['usage']

/** Anthropic already reports four non-overlapping bins; do not subtract again. */
export function readAnthropicUsage(usage: AnthropicUsage): TokenUsage {
  if (usage === undefined) return { ...ZERO_USAGE }
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cachedTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  }
}

export function normalizeAnthropicStopReason(reason: string | null): string | null {
  if (reason === null) return null
  if (reason === 'max_tokens') return 'MAX_TOKENS'
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'STOP'
  return reason.toUpperCase()
}

function upstreamError(status: number): string {
  if (status === 401 || status === 403) return `authentication failed (HTTP ${status})`
  if (status === 404) return 'the selected Claude model was not found (HTTP 404)'
  if (status === 429) return 'the Anthropic rate limit was reached (HTTP 429)'
  return `Anthropic returned HTTP ${status}`
}

/** Native Messages API seam shared by normal calls and the settings capability probe. */
export async function callAnthropicWithConfig(connection: AnthropicConfig, call: AiCall): Promise<AiResult> {
  const started = Date.now()
  try {
    const response = await fetch(`${ANTHROPIC_BASE_URL}/messages`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'anthropic-version': API_VERSION,
        'x-api-key': connection.apiKey,
      },
      body: JSON.stringify({
        model: call.model,
        max_tokens: call.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        system: [{
          type: 'text',
          text: systemInstruction(call.systemPrompt),
          // Only the stable prefix is cacheable. The changing instruction and
          // financial payload remain in the later user message.
          cache_control: { type: 'ephemeral' },
        }],
        messages: [{
          role: 'user',
          content: `${call.instruction.trim()}\n\n${fenceData(call.payload, 'anthropic')}`,
        }],
        ...(call.temperature === undefined ? {} : { temperature: call.temperature }),
        ...(call.responseJsonSchema === undefined
          ? {}
          : { output_config: { format: { type: 'json_schema', schema: call.responseJsonSchema } } }),
      }),
      signal: call.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (REDIRECT_STATUSES.has(response.status)) {
      throw new AnthropicError('The Anthropic endpoint returned a redirect; redirects are refused.')
    }
    if (!response.ok) throw new AnthropicError(upstreamError(response.status))

    const parsed = responseSchema.safeParse(await response.json())
    if (!parsed.success) throw new AnthropicError('Anthropic returned an invalid Messages API response.')
    if (parsed.data.stop_reason === 'refusal') throw new AnthropicError('Claude refused the request.')

    const text = parsed.data.content
      .filter((block) => block.type === 'text' && block.text !== undefined)
      .map((block) => block.text as string)
      .join('')
    if (text.trim() === '') throw new AnthropicError('Claude returned no text.')

    const usage = readAnthropicUsage(parsed.data.usage)
    return {
      provider: 'anthropic',
      text,
      usage,
      model: parsed.data.model,
      cached: usage.cachedTokens > 0,
      durationMs: Date.now() - started,
      finishReason: normalizeAnthropicStopReason(parsed.data.stop_reason),
    }
  } catch (error) {
    if (error instanceof AnthropicError) throw error
    const detail = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'failed'
    throw new AnthropicError(`Anthropic call ${detail} after ${Date.now() - started}ms.`, error)
  }
}

export async function callAnthropic(db: Db, tenantId: string, call: AiCall): Promise<AiResult> {
  const ai = resolvedIntegrations(db, tenantId).ai
  if (ai.provider !== 'anthropic') throw new AiError(ai.provider, 'The selected provider is not Anthropic.')
  if (ai.apiKey === null) throw new AnthropicError('An Anthropic API key is required.')
  return callAnthropicWithConfig({ apiKey: ai.apiKey }, call)
}
