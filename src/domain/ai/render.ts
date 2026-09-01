/**
 * Signals into sentences, locally.
 *
 * A finding is a code plus numbers; the sentence comes from the i18n catalogue.
 * That is what makes every finding available in both languages at no extra cost,
 * keeps output impossible to half-translate, and means a finding can never claim
 * something there is no computed number behind.
 *
 * `NUMERIC_VARS` below is the one place that knows a signal's `deltaBp` is the
 * sentence's `{{delta}}`. It is exhaustive over `FindingCode` by type, so a new
 * code cannot compile without deciding how its numbers read, and every value
 * goes through `src/i18n/format.ts` — nothing here decides how a euro or a
 * percentage is written.
 */
import { config } from '../../config.ts'
import { formatBp, formatDecimal, formatMoney } from '../../i18n/format.ts'
import { renderFinding, t, type Vars } from '../../i18n/index.ts'
import type { Signal } from '../aggregate/overspend.ts'
import { FINDING_SPECS, type FindingCode, type Severity } from './codes.ts'

export interface RenderedFinding {
  code: FindingCode
  categoryId: string | null
  severity: Severity
  /** False for good news, so the UI can style it apart from a problem. */
  negative: boolean
  /** The raw numbers, kept beside the sentence for charts and for audit. */
  metrics: Readonly<Record<string, number>>
  /** The sentence, already in `lang`. */
  text: string
}

/** A signal's metrics: every lookup is `number | undefined` by design. */
type Metrics = Readonly<Record<string, number>>

/** Keeps only the variables a signal had a number for, so `missingVars` sees the rest. */
function present(entries: Record<string, string | undefined>): Vars {
  const vars: Vars = {}
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) vars[key] = value
  }
  return vars
}

const money = (cents: number | undefined): string | undefined =>
  cents === undefined ? undefined : formatMoney(cents)

/** For a difference whose direction the sentence does not claim. */
const absMoney = (cents: number | undefined): string | undefined =>
  cents === undefined ? undefined : formatMoney(Math.abs(cents))

const signedPercent = (bp: number | undefined): string | undefined =>
  bp === undefined ? undefined : formatBp(bp, { signed: true })

const percent = (bp: number | undefined): string | undefined =>
  bp === undefined ? undefined : formatBp(bp)

/**
 * `{{delta}}` in a sentence that already says which way it went.
 *
 * "18% above your norm" and "18% below your usual level" read off the same
 * `deltaBp`, whose sign the wording already carries — printing "−18% below"
 * would say it twice and read as a double negative.
 */
const magnitudePercent = (bp: number | undefined): string | undefined =>
  bp === undefined ? undefined : formatBp(Math.abs(bp))

/** A plain count, thousands separated: `1.234` transactions, not `1234`. */
const count = (value: number | undefined): string | undefined =>
  value === undefined ? undefined : formatDecimal(value, 0)

/** Durations go through the catalogue: "1 day" and "40 days" are different keys. */
const days = (value: number | undefined, lang: string): string | undefined =>
  value === undefined ? undefined : t(lang, 'common:time.dayCount', { count: value })

const months = (value: number | undefined, lang: string): string | undefined =>
  value === undefined ? undefined : t(lang, 'common:time.monthCount', { count: value })

/** Basis points of a month back into months, so "2,4 months" survives the trip. */
const monthsFromBp = (bp: number | undefined, lang: string): string | undefined =>
  bp === undefined ? undefined : months(Math.round(bp / 1_000) / 10, lang)

/**
 * How each code's numbers read.
 *
 * `category` and `account` are deliberately absent: both come from the signal's
 * single name field, which keeps one rule for them rather than seventeen.
 *
 * Two codes have no producer yet — `above_benchmark` waits on the Statbel model
 * and `no_spend_streak` on the streak detector — so the keys named here are the
 * contract those producers will emit against.
 */
const NUMERIC_VARS: {
  readonly [C in FindingCode]: (metrics: Metrics, lang: string) => Vars
} = {
  // --- the four overspend signals ---
  over_assigned: (m) => present({ spent: money(m.spentCents), assigned: money(m.assignedCents) }),
  over_available: (m) => present({ overspend: money(m.overspendCents) }),
  above_baseline: (m) =>
    present({ delta: magnitudePercent(m.deltaBp), baseline: money(m.baselineCents) }),
  above_benchmark: (m) =>
    present({ delta: magnitudePercent(m.deltaBp), benchmark: money(m.benchmarkCents) }),

  // --- trajectory ---
  burn_rate_over: (m) =>
    present({ projected: money(m.projectedCents), assigned: money(m.assignedCents) }),
  below_baseline: (m) => present({ delta: magnitudePercent(m.deltaBp) }),
  no_spend_streak: (m, lang) => present({ months: months(m.months, lang) }),
  irregular_expense: (m) => present({ amount: money(m.amountCents) }),
  // Signed, unlike the category deltas: "income is off your usual" does not say
  // which way, and up or down is the whole point of the sentence.
  income_change: (m) =>
    present({ delta: signedPercent(m.deltaBp), baseline: money(m.baselineCents) }),

  // --- household level ---
  savings_rate_low: (m) => present({ rate: percent(m.rateBp), target: percent(m.targetBp) }),
  savings_rate_up: (m) => present({ rate: percent(m.rateBp), delta: signedPercent(m.deltaBp) }),
  emergency_fund_short: (m, lang) =>
    present({
      months: monthsFromBp(m.monthsBp, lang),
      target: monthsFromBp(m.targetMonthsBp, lang),
    }),
  net_worth_high: (m) => present({ amount: money(m.amountCents) }),

  // --- data hygiene ---
  // A count arrives pre-formatted, unlike a duration: these sentences have no
  // plural forms of their own, so there is nothing for a numeric `count` to
  // select and it would only be one more way to write a number.
  uncategorised_backlog: (m) => present({ count: count(m.count) }),
  recompute_mismatch: (m) => present({ difference: absMoney(m.differenceCents) }),
  unreconciled_account: (m, lang) => present({ days: days(m.days, lang) }),
  stale_prices: (m, lang) => present({ count: count(m.count), days: days(m.days, lang) }),
}

/** The formatted variables a signal's sentence needs, its name included. */
export function findingVars(signal: Signal, lang: string): Vars {
  const vars = NUMERIC_VARS[signal.code](signal.metrics, lang)
  // `unreconciled_account` names an account and the rest name a category — one
  // field either way, because a signal is about exactly one thing.
  // Widened: `spec.vars` is a literal tuple, so `includes` would otherwise only
  // accept the strings that particular code already declares.
  const spec: { readonly vars: readonly string[] } = FINDING_SPECS[signal.code]
  const nameVar = spec.vars.includes('account')
    ? 'account'
    : spec.vars.includes('category')
      ? 'category'
      : null
  if (nameVar !== null && signal.categoryName !== null) vars[nameVar] = signal.categoryName
  return vars
}

/**
 * Renders one signal, or null when its sentence would have a hole in it.
 *
 * Null rather than a throw: one malformed signal must not take down the insights
 * page. `test/unit/ai-render.test.ts` walks the whole vocabulary in both
 * languages, so a code without a working sentence is a failing build rather than
 * a finding that quietly disappears.
 */
export function renderSignal(
  signal: Signal,
  lang: string = config.DEFAULT_LOCALE,
): RenderedFinding | null {
  // "Never reconciled" is a different statement from "not reconciled in 40
  // days", and the `-1` that `hygiene.ts` uses for it would otherwise render as
  // a negative duration. The vocabulary is unchanged: the finding is still an
  // `unreconciled_account`, so nothing downstream needs a special case.
  const text =
    signal.code === 'unreconciled_account' && signal.metrics.days === -1
      ? signal.categoryName === null
        ? null
        : t(lang, 'ai:variant.never_reconciled', { account: signal.categoryName })
      : renderFinding(signal.code, findingVars(signal, lang), lang)
  if (text === null) return null

  return {
    code: signal.code,
    categoryId: signal.categoryId,
    severity: signal.severity,
    negative: FINDING_SPECS[signal.code].negative,
    metrics: signal.metrics,
    text,
  }
}

/** Renders what can be rendered, in the order given. */
export function renderSignals(
  signals: readonly Signal[],
  lang: string = config.DEFAULT_LOCALE,
): RenderedFinding[] {
  const rendered: RenderedFinding[] = []
  for (const signal of signals) {
    const one = renderSignal(signal, lang)
    if (one !== null) rendered.push(one)
  }
  return rendered
}
