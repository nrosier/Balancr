/**
 * How each finding's numbers are written, for whoever is doing the writing.
 *
 * This is the half of the signal renderer that both sides need. The server turns a
 * signal into a sentence for the insights payload and the digest; the browser does
 * the same for the signals `/api/budget` and `/api/insights` hand over — as codes and
 * integers, by design, so that a finding is never half-translated and adding a
 * language costs a catalogue rather than a model call. Two copies of the table below
 * would be two places to remember that a signal's `deltaBp` is the sentence's
 * `{{delta}}`, and the copy that was forgotten would render `0,18` where the other
 * renders `18%`.
 *
 * It is therefore **pure**: `format.ts`, `codes.ts` and nothing else — no `config`,
 * no i18next instance, no `node:` anything, so the bundler can take it. The one thing
 * it cannot do without is a translator, because a duration is a catalogue entry:
 * "1 day" and "40 days" are different plural forms and no formatter chooses between
 * them. That arrives as `translate`, which the server binds to a language and the
 * browser to react-i18next's own `t`.
 *
 * `NUMERIC_VARS` is exhaustive over `FindingCode` by type, so a new code cannot
 * compile without a decision about how its numbers read, and every value goes through
 * `src/i18n/format.ts` — nothing here decides how a euro or a percentage is written.
 */
import { formatBp, formatDecimal, formatMoney, type Vars } from '../../i18n/format.ts'
import { FINDING_SPECS, type FindingCode } from './codes.ts'

/**
 * `ns:key` and its variables, into a sentence in whatever language the caller is in.
 *
 * Only ever called for the two duration keys in `common`, which is why it takes no
 * language: the caller has already chosen one.
 */
export type Translate = (key: string, vars: Vars) => string

/** What the renderer reads off a signal. Structural, so the wire shape fits too. */
export interface SignalFacts {
  code: FindingCode
  categoryName: string | null
  metrics: Readonly<Record<string, number>>
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
const days = (value: number | undefined, translate: Translate): string | undefined =>
  value === undefined ? undefined : translate('common:time.dayCount', { count: value })

const months = (value: number | undefined, translate: Translate): string | undefined =>
  value === undefined ? undefined : translate('common:time.monthCount', { count: value })

/** Basis points of a month back into months, so "2,4 months" survives the trip. */
const monthsFromBp = (bp: number | undefined, translate: Translate): string | undefined =>
  bp === undefined ? undefined : months(Math.round(bp / 1_000) / 10, translate)

/**
 * How each code's numbers read.
 *
 * `category`, `account` and `group` are deliberately absent: all three come from
 * the signal's single name field, which keeps one rule for them rather than
 * seventeen.
 *
 * One code has no producer yet — `no_spend_streak` waits on the streak detector —
 * so the keys named here are the contract that producer will emit against.
 */
const NUMERIC_VARS: {
  readonly [C in FindingCode]: (metrics: Metrics, translate: Translate) => Vars
} = {
  // --- the five overspend signals ---
  over_assigned: (m) => present({ spent: money(m.spentCents), assigned: money(m.assignedCents) }),
  over_available: (m) => present({ overspend: money(m.overspendCents) }),
  above_baseline: (m) =>
    present({ delta: magnitudePercent(m.deltaBp), baseline: money(m.baselineCents) }),
  above_benchmark: (m) =>
    present({ delta: magnitudePercent(m.deltaBp), benchmark: money(m.benchmarkCents) }),
  // `available` is signed on purpose: an envelope that is already €12 in the red
  // and has a €50 direct debit still coming is a different sentence from one with
  // €38 left, and `formatMoney` prints the minus that says which.
  committed_over_available: (m) =>
    present({ committed: money(m.committedCents), available: money(m.availableCents) }),

  // --- trajectory ---
  burn_rate_over: (m) =>
    present({ projected: money(m.projectedCents), assigned: money(m.assignedCents) }),
  below_baseline: (m) => present({ delta: magnitudePercent(m.deltaBp) }),
  no_spend_streak: (m, translate) => present({ months: months(m.months, translate) }),
  irregular_expense: (m) => present({ amount: money(m.amountCents) }),
  // Signed, unlike the category deltas: "income is off your usual" does not say
  // which way, and up or down is the whole point of the sentence.
  income_change: (m) =>
    present({ delta: signedPercent(m.deltaBp), baseline: money(m.baselineCents) }),

  // --- household level ---
  savings_rate_low: (m) => present({ rate: percent(m.rateBp), target: percent(m.targetBp) }),
  savings_rate_up: (m) => present({ rate: percent(m.rateBp), delta: signedPercent(m.deltaBp) }),
  emergency_fund_short: (m, translate) =>
    present({
      months: monthsFromBp(m.monthsBp, translate),
      target: monthsFromBp(m.targetMonthsBp, translate),
    }),
  net_worth_high: (m) => present({ amount: money(m.amountCents) }),
  // `amount` is the offset — the co-parent's share of what you paid — and `paid` is
  // Actual's own figure, printed beside it because the sentence is only honest with
  // both: half of something is not a claim until the something is on screen.
  custody_offset: (m) =>
    present({
      amount: money(m.offsetCents),
      paid: money(m.paidCents),
      share: percent(m.shareBp),
    }),

  // --- data hygiene ---
  // A count arrives pre-formatted, unlike a duration: these sentences have no
  // plural forms of their own, so there is nothing for a numeric `count` to
  // select and it would only be one more way to write a number.
  uncategorised_backlog: (m) => present({ count: count(m.count) }),
  recompute_mismatch: (m) => present({ difference: absMoney(m.differenceCents) }),
  unreconciled_account: (m, translate) => present({ days: days(m.days, translate) }),
  stale_prices: (m, translate) =>
    present({ count: count(m.count), days: days(m.days, translate) }),
}

/** The formatted variables a signal's sentence needs, its name included. */
export function findingVars(signal: SignalFacts, translate: Translate): Vars {
  const vars = NUMERIC_VARS[signal.code](signal.metrics, translate)
  // `unreconciled_account` names an account, `above_benchmark` names a benchmark
  // group and the rest name a category — one field either way, because a signal is
  // about exactly one thing.
  // Widened: `spec.vars` is a literal tuple, so `includes` would otherwise only
  // accept the strings that particular code already declares.
  const spec: { readonly vars: readonly string[] } = FINDING_SPECS[signal.code]
  const nameVar = spec.vars.includes('account')
    ? 'account'
    : spec.vars.includes('category')
      ? 'category'
      : spec.vars.includes('group')
        ? 'group'
        : null
  if (nameVar === null || signal.categoryName === null) return vars
  // A category and an account are named by whoever keeps the budget and travel as
  // text; a benchmark group is one of ten fixed ids and is *translated*, because
  // `housing` is a key and not a word anybody wants to read on a Dutch page. Same
  // field, because a group is still the one thing the signal is about (#43).
  vars[nameVar] =
    nameVar === 'group'
      ? translate(`budget:benchmark.group.${signal.categoryName}`, {})
      : signal.categoryName
  return vars
}

/**
 * True for the `unreconciled_account` that has never been reconciled at all.
 *
 * `hygiene.ts` states that as `-1` days, which would otherwise render as a negative
 * duration. Both renderers need the same test, and both then reach for
 * `ai:variant.never_reconciled` — the vocabulary is unchanged, the finding is still an
 * `unreconciled_account`, so nothing downstream needs a special case.
 */
export function isNeverReconciled(signal: SignalFacts): boolean {
  return signal.code === 'unreconciled_account' && signal.metrics.days === -1
}
