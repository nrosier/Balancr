/**
 * The closed vocabulary of things the AI layer may say.
 *
 * The model returns a code plus numbers; the sentence is rendered locally from
 * the i18n catalogue. That is what makes every finding available in both
 * languages for free, keeps output impossible to half-translate, and stops the
 * model from inventing a claim we have no computed number to back.
 *
 * These lists are therefore load-bearing in three places:
 *  1. the Gemini response schema restricts `code` to `FINDING_CODES`,
 *  2. `scripts/check-i18n.ts` fails if a code lacks a sentence in any locale,
 *  3. the same check fails if a translation drops an interpolation variable —
 *     a missing `{{delta}}` would otherwise ship a sentence with a hole in it.
 *
 * `vars` are already-formatted strings by the time they reach the catalogue:
 * money goes through `src/i18n/format.ts` first, so the renderer stays the only
 * thing that knows how a euro is written.
 */

/** Ordered least to most urgent, so `SEVERITY_RANK` can sort by it. */
export type Severity = 'info' | 'warn' | 'alert'

export const SEVERITY_RANK: Record<Severity, number> = { alert: 0, warn: 1, info: 2 }

export interface FindingSpec {
  /** Interpolation variables the sentence must use, in both locales. */
  readonly vars: readonly string[]
  /** Highest severity this code may carry. The model may report lower. */
  readonly maxSeverity: Severity
  /** False for findings that are good news, so the UI can style them apart. */
  readonly negative: boolean
}

export const FINDING_SPECS = {
  // --- the four overspend signals, reported separately and never merged ---
  over_assigned: { vars: ['category', 'spent', 'assigned'], maxSeverity: 'warn', negative: true },
  over_available: { vars: ['category', 'overspend'], maxSeverity: 'alert', negative: true },
  // Alert, unlike over_assigned: a carried-over balance routinely covers an
  // envelope going over, but running half again above your own 12-month norm on a
  // material amount is the top of the panel. `overspend.baselineAlertBp` is the
  // threshold, and would be a knob that cannot do anything if this were 'warn'.
  above_baseline: { vars: ['category', 'delta', 'baseline'], maxSeverity: 'alert', negative: true },
  above_benchmark: { vars: ['category', 'delta', 'benchmark'], maxSeverity: 'info', negative: true },

  // --- trajectory ---
  burn_rate_over: { vars: ['category', 'projected', 'assigned'], maxSeverity: 'warn', negative: true },
  below_baseline: { vars: ['category', 'delta'], maxSeverity: 'info', negative: false },
  no_spend_streak: { vars: ['category', 'months'], maxSeverity: 'info', negative: false },
  irregular_expense: { vars: ['category', 'amount'], maxSeverity: 'info', negative: true },
  income_change: { vars: ['delta', 'baseline'], maxSeverity: 'warn', negative: true },

  // --- household level ---
  savings_rate_low: { vars: ['rate', 'target'], maxSeverity: 'warn', negative: true },
  savings_rate_up: { vars: ['rate', 'delta'], maxSeverity: 'info', negative: false },
  emergency_fund_short: { vars: ['months', 'target'], maxSeverity: 'alert', negative: true },
  net_worth_high: { vars: ['amount'], maxSeverity: 'info', negative: false },

  // --- data hygiene: surfaced first, because the rest is worthless without it ---
  uncategorised_backlog: { vars: ['count'], maxSeverity: 'warn', negative: true },
  recompute_mismatch: { vars: ['category', 'difference'], maxSeverity: 'alert', negative: true },
  unreconciled_account: { vars: ['account', 'days'], maxSeverity: 'warn', negative: true },
  stale_prices: { vars: ['count', 'days'], maxSeverity: 'warn', negative: true },
} as const satisfies Record<string, FindingSpec>

export type FindingCode = keyof typeof FINDING_SPECS
export const FINDING_CODES = Object.keys(FINDING_SPECS) as FindingCode[]

/**
 * Questions the assistant may ask about a category. Each is a confirm-or-edit
 * card built around the model's guess, never an open-ended interrogation —
 * being quizzed about every envelope is how a tool like this gets abandoned.
 */
export const CLARIFICATION_SPECS = {
  purpose_unknown: { vars: ['category'] },
  nature_unknown: { vars: ['category'] },
  frequency_unknown: { vars: ['category'] },
  custody_shared_unknown: { vars: ['category'] },
  sensitive_unknown: { vars: ['category'] },
} as const satisfies Record<string, { readonly vars: readonly string[] }>

/**
 * Lowers `severity` to whatever the code is allowed to carry.
 *
 * The ceiling in `FINDING_SPECS` is the contract for a code, and both the
 * deterministic signal producers and the model's own output run through here —
 * otherwise the declared maximum would be documentation rather than a rule, and
 * `above_benchmark` (an `info` by design, since v1 has no benchmark) could
 * arrive as an alert.
 */
export function capSeverity(code: FindingCode, severity: Severity): Severity {
  const ceiling = FINDING_SPECS[code].maxSeverity
  return SEVERITY_RANK[severity] < SEVERITY_RANK[ceiling] ? ceiling : severity
}

export type ClarificationCode = keyof typeof CLARIFICATION_SPECS
export const CLARIFICATION_CODES = Object.keys(CLARIFICATION_SPECS) as ClarificationCode[]
