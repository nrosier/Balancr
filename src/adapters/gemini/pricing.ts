/**
 * What a call costs, in micro-euros.
 *
 * Google publishes per-million-token prices in dollars; this table is in
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
 *     A model swapped in via `GEMINI_MODEL_DEEP` must make the guard cautious,
 *     not blind — overstating spend costs a banner, understating it costs money.
 */

/** Per million tokens, in micro-euros. */
export interface ModelPrice {
  input: number
  output: number
  /**
   * Cached input tokens, billed at a fraction of the input rate. Only the
   * *hit* is discounted; cache storage is billed per hour and is not modelled
   * here, which is one more reason the fallback overstates rather than under.
   */
  cachedInput: number
  /** ISO date these figures were last checked against Google's price list. */
  verified: string
}

/**
 * Prices as of the `verified` date, converted at €1 = $1.08.
 *
 * Keyed by model *family*, not by the exact id: `gemini-3.1-pro-preview` and a
 * dated snapshot of it price the same, and a table keyed by full id would fall
 * through to the fallback the day Google appends a date suffix.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'gemini-3.7-flash': { input: 278_000, output: 2_315_000, cachedInput: 69_000, verified: '2026-09-02' },
  'gemini-3.7-flash-lite': { input: 93_000, output: 370_000, cachedInput: 23_000, verified: '2026-09-02' },
  'gemini-3.1-pro': { input: 1_157_000, output: 9_259_000, cachedInput: 289_000, verified: '2026-09-02' },
  'gemini-2.5-flash': { input: 278_000, output: 2_315_000, cachedInput: 69_000, verified: '2026-09-02' },
  'gemini-2.5-pro': { input: 1_157_000, output: 9_259_000, cachedInput: 289_000, verified: '2026-09-02' },
}

/**
 * What an unrecognised model is assumed to cost: the priciest known tier.
 *
 * Deliberately not zero and not an average. The guard exists to stop a surprise
 * bill, so its failure mode has to be "the banner appeared early", never "the
 * model was free as far as we knew".
 */
export const FALLBACK_PRICE: ModelPrice = {
  input: 1_157_000,
  output: 9_259_000,
  cachedInput: 289_000,
  verified: '2026-09-02',
}

/** Tokens as Gemini reports them, already read off `usageMetadata`. */
export interface TokenUsage {
  /** `promptTokenCount` — includes `cachedTokens`, as Google counts it. */
  inputTokens: number
  outputTokens: number
  /** The part of `inputTokens` served from a context cache. */
  cachedTokens: number
}

export const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }

/**
 * The price for a model id, and whether it was actually known.
 *
 * Longest-prefix match, so `gemini-3.1-pro-preview-04-01` prices as
 * `gemini-3.1-pro` rather than falling through. Longest wins because
 * `gemini-3.7-flash-lite` starts with `gemini-3.7-flash` and is a tenth of the
 * price — shortest-match would quietly overcharge the cheap model.
 */
export function priceFor(model: string): { price: ModelPrice; known: boolean } {
  const id = model.trim().toLowerCase()
  const exact = MODEL_PRICES[id]
  if (exact !== undefined) return { price: exact, known: true }

  let bestKey = ''
  for (const key of Object.keys(MODEL_PRICES)) {
    if (id.startsWith(key) && key.length > bestKey.length) bestKey = key
  }
  const matched = bestKey === '' ? undefined : MODEL_PRICES[bestKey]
  if (matched !== undefined) return { price: matched, known: true }

  return { price: FALLBACK_PRICE, known: false }
}

/**
 * Micro-euros for one call.
 *
 * `inputTokens` includes the cached ones, so the billable input is the
 * difference; clamped at zero because the two counters come from the API
 * separately and a mismatch must not turn into a negative cost that eats
 * another run's spend.
 *
 * Rounded up. A call always costs something, and the whole point of the ledger
 * is that the sum of what we recorded is never less than what Google charged.
 */
export function costMicroEur(model: string, usage: TokenUsage): number {
  const { price } = priceFor(model)
  const cached = Math.max(0, usage.cachedTokens)
  const billableInput = Math.max(0, usage.inputTokens - cached)

  const micro =
    (billableInput * price.input) / 1_000_000 +
    (cached * price.cachedInput) / 1_000_000 +
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
  model: string,
  promptChars: number,
  expectedOutputTokens = 2_000,
): number {
  return costMicroEur(model, {
    inputTokens: Math.ceil(promptChars / 4),
    outputTokens: expectedOutputTokens,
    cachedTokens: 0,
  })
}

/** Micro-euros → euros, for display and for comparing against config. */
export const microEurToEur = (micro: number): number => micro / 1_000_000
export const eurToMicroEur = (eur: number): number => Math.round(eur * 1_000_000)
