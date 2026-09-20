import type { AiProvider } from '../../domain/ai/providers.ts'

export { AI_PROVIDERS } from '../../domain/ai/providers.ts'
export type { AiProvider } from '../../domain/ai/providers.ts'

/** The provider-neutral request contract used by Balancr's AI domain. */
export interface AiCall {
  model: string
  /** The editable prompt body. The adapter prepends Balancr's immutable fence contract. */
  systemPrompt: string
  /** What to do with the data. Varies per run, so it is not cached. */
  instruction: string
  /** The redacted payload. Serialised inside the fence, and nowhere else. */
  payload: unknown
  /** Standard JSON Schema for structured runs; absent for free-text narratives. */
  responseJsonSchema?: unknown
  temperature?: number
  maxOutputTokens?: number
  signal?: AbortSignal
}

/** Provider usage normalised so the ledger can price every token category. */
export interface TokenUsage {
  /** Ordinary input tokens, excluding cache reads and cache writes. */
  inputTokens: number
  outputTokens: number
  /** The part of input served from a provider cache. */
  cachedTokens: number
  /** The part written to a provider cache and billed at a distinct rate. */
  cacheWriteTokens: number
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
}

/** The provider-neutral result contract returned to the domain layer. */
export interface AiResult {
  provider: AiProvider
  text: string
  usage: TokenUsage
  /** The model the API says answered, which is not always the requested alias. */
  model: string
  /** Whether any input was served from a provider cache. */
  cached: boolean
  durationMs: number
  finishReason: string | null
}

/** One error type for domain callers; adapters retain the provider as evidence. */
export class AiError extends Error {
  constructor(
    readonly provider: AiProvider,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'AiError'
  }
}

/** Tokens spent across multiple attempts, all of which were billed. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  }
}
