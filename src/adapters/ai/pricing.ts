/**
 * What an AI call costs, in micro-euros.
 *
 * Providers publish per-million-token prices in dollars; this table is in
 * micro-euros per million tokens because every figure downstream — `ai_runs`,
 * the spend view, the budget guard — is an integer of micro-euros, and one
 * conversion done here beats four done later at different rates.
 *
 * Two rules make the guard trustworthy:
 *
 *  1. **Every entry is dated.** A price table with no `verified` date silently
 *     becomes a fiction, and a cost guard reading a fiction is worse than no
 *     guard: it reports a comfortable number while the bill grows.
 *  2. **An unknown model is priced at the most expensive tier** (`FALLBACK_PRICE`).
 *     A model swapped in through settings must make the guard cautious,
 *     not blind — overstating spend costs a banner, understating it costs money.
 */

import type { AiProvider, TokenUsage } from './types.ts'

/** Per million tokens, in micro-euros. */
export interface ModelPrice {
  input: number
  output: number
  /**
   * Cached input tokens, billed at a fraction of the ordinary input rate.
   */
  cachedInput: number
  /** Tokens written to a cache when the provider bills writes separately. */
  cacheWriteInput: number
  /** ISO date these figures were last checked against the provider's price list. */
  verified: string
}

/** Explicit tenant prices for custom endpoints, keyed by exact model id. */
export type ModelPrices = Readonly<Record<string, ModelPrice>>

export function parseModelPricesJson(value: string): ModelPrices {
  const parsed: unknown = JSON.parse(value)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('AI model prices must be a JSON object')
  }
  const prices: Record<string, ModelPrice> = {}
  for (const [model, candidate] of Object.entries(parsed)) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new Error(`AI model price for ${model} is invalid`)
    }
    const entry = candidate as Record<string, unknown>
    for (const key of ['input', 'output', 'cachedInput', 'cacheWriteInput'] as const) {
      if (typeof entry[key] !== 'number' || !Number.isSafeInteger(entry[key]) || entry[key] < 0) {
        throw new Error(`AI model price ${model}.${key} must be a non-negative integer`)
      }
    }
    if (typeof entry['verified'] !== 'string') throw new Error(`AI model price ${model}.verified is invalid`)
    prices[model.trim().toLowerCase()] = {
      input: entry['input'] as number,
      output: entry['output'] as number,
      cachedInput: entry['cachedInput'] as number,
      cacheWriteInput: entry['cacheWriteInput'] as number,
      verified: entry['verified'],
    }
  }
  return prices
}

/**
 * Prices as of the `verified` date, converted at €1 = $1.08.
 *
 * Keyed by model *family*, not by the exact id: `gemini-3.1-pro-preview` and a
 * dated snapshot of it price the same, and a table keyed by full id would fall
 * through to the fallback the day Google appends a date suffix.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'gemini-3.7-flash': { input: 278_000, output: 2_315_000, cachedInput: 69_000, cacheWriteInput: 278_000, verified: '2026-09-02' },
  'gemini-3.7-flash-lite': { input: 93_000, output: 370_000, cachedInput: 23_000, cacheWriteInput: 93_000, verified: '2026-09-02' },
  'gemini-3.1-pro': { input: 1_157_000, output: 9_259_000, cachedInput: 289_000, cacheWriteInput: 1_157_000, verified: '2026-09-02' },
  'gemini-2.5-flash': { input: 278_000, output: 2_315_000, cachedInput: 69_000, cacheWriteInput: 278_000, verified: '2026-09-02' },
  'gemini-2.5-pro': { input: 1_157_000, output: 9_259_000, cachedInput: 289_000, cacheWriteInput: 1_157_000, verified: '2026-09-02' },
}

export const OPENAI_MODEL_PRICES: Record<string, ModelPrice> = {
  'gpt-5.4-mini': { input: 694_445, output: 4_166_667, cachedInput: 69_445, cacheWriteInput: 694_445, verified: '2026-09-20' },
  'gpt-5.4': { input: 2_314_815, output: 13_888_889, cachedInput: 231_482, cacheWriteInput: 2_314_815, verified: '2026-09-20' },
}

export const XAI_MODEL_PRICES: Record<string, ModelPrice> = {
  'grok-4.3': { input: 1_157_408, output: 2_314_815, cachedInput: 185_186, cacheWriteInput: 1_157_408, verified: '2026-09-20' },
}

/** First-party Claude API prices using the 5-minute cache-write tier. */
export const ANTHROPIC_MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-sonnet-5': {
    input: 1_851_852,
    output: 9_259_260,
    cachedInput: 185_186,
    cacheWriteInput: 2_314_815,
    verified: '2026-09-20',
  },
  'claude-opus-5': {
    input: 4_629_630,
    output: 23_148_149,
    cachedInput: 462_963,
    cacheWriteInput: 5_787_038,
    verified: '2026-09-20',
  },
}

export const PROVIDER_PRICES: Record<AiProvider, Record<string, ModelPrice>> = {
  'gemini-aistudio': MODEL_PRICES,
  'gemini-vertex': MODEL_PRICES,
  openai: OPENAI_MODEL_PRICES,
  xai: XAI_MODEL_PRICES,
  'openai-compatible': {},
  anthropic: ANTHROPIC_MODEL_PRICES,
}

/**
 * What an unrecognised model is assumed to cost: the priciest known tier.
 *
 * Deliberately not zero and not an average. The guard exists to stop a surprise
 * bill, so its failure mode has to be "the banner appeared early", never "the
 * model was free as far as we knew".
 */
export const FALLBACK_PRICE: ModelPrice = {
  input: 4_629_630,
  output: 23_148_149,
  cachedInput: 462_963,
  cacheWriteInput: 5_787_038,
  verified: '2026-09-20',
}

/**
 * The price for a model id, and whether it was actually known.
 *
 * Longest-prefix match, so `gemini-3.1-pro-preview-04-01` prices as
 * `gemini-3.1-pro` rather than falling through. Longest wins because
 * `gemini-3.7-flash-lite` starts with `gemini-3.7-flash` and is a tenth of the
 * price — shortest-match would quietly overcharge the cheap model.
 */
export function priceFor(
  provider: AiProvider,
  model: string,
  overrides?: ModelPrices,
): { price: ModelPrice; known: boolean } {
  const id = model.trim().toLowerCase()
  const override = overrides?.[id]
  if (override !== undefined) return { price: override, known: true }
  let bestOverrideKey = ''
  for (const key of Object.keys(overrides ?? {})) {
    if (id.startsWith(key) && key.length > bestOverrideKey.length) bestOverrideKey = key
  }
  const matchedOverride = bestOverrideKey === '' ? undefined : overrides?.[bestOverrideKey]
  if (matchedOverride !== undefined) return { price: matchedOverride, known: true }
  const prices = PROVIDER_PRICES[provider]
  const exact = prices[id]
  if (exact !== undefined) return { price: exact, known: true }

  let bestKey = ''
  for (const key of Object.keys(prices)) {
    if (id.startsWith(key) && key.length > bestKey.length) bestKey = key
  }
  const matched = bestKey === '' ? undefined : prices[bestKey]
  if (matched !== undefined) return { price: matched, known: true }

  return { price: FALLBACK_PRICE, known: false }
}

/**
 * Micro-euros for one call.
 *
 * Rounded up. A call always costs something, and the whole point of the ledger
 * is that the sum of what we recorded is never less than what the provider charged.
 */
export function costMicroEur(
  provider: AiProvider,
  model: string,
  usage: TokenUsage,
  overrides?: ModelPrices,
): number {
  const { price } = priceFor(provider, model, overrides)
  const cached = Math.max(0, usage.cachedTokens)
  const cacheWrite = Math.max(0, usage.cacheWriteTokens)
  const billableInput = Math.max(0, usage.inputTokens)

  const micro =
    (billableInput * price.input) / 1_000_000 +
    (cached * price.cachedInput) / 1_000_000 +
    (cacheWrite * price.cacheWriteInput) / 1_000_000 +
    (Math.max(0, usage.outputTokens) * price.output) / 1_000_000

  return Math.ceil(micro)
}

/**
 * What a call *would* cost, for the dry-run estimate in the prompt editor.
 *
 * Tokens are estimated from character count at four characters per token — the
 * usual rule of thumb for English, and close enough for a payload that is
 * mostly digits and short labels. The estimate is shown before spending money,
 * so it is deliberately generous: `output` defaults to a full response rather
 * than a hopeful one.
 */
export function estimateCostMicroEur(
  provider: AiProvider,
  model: string,
  promptChars: number,
  expectedOutputTokens = 2_000,
  overrides?: ModelPrices,
): number {
  return costMicroEur(provider, model, {
    inputTokens: Math.ceil(promptChars / 4),
    outputTokens: expectedOutputTokens,
    cachedTokens: 0,
    cacheWriteTokens: 0,
  }, overrides)
}

/** Micro-euros → euros, for display and for comparing against config. */
export const microEurToEur = (micro: number): number => micro / 1_000_000
export const eurToMicroEur = (eur: number): number => Math.round(eur * 1_000_000)
