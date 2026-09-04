/**
 * Every deterministic producer, run over one month.
 *
 * Each producer in this folder answers one question and knows nothing about the
 * others, which is right for computing and leaves an obvious gap: something has
 * to decide what to run and in what order, or the signals only ever exist in
 * tests. That is this file, and it is the last purely computational step —
 * everything after it (ranking, redaction, the model) only ever selects, hides or
 * explains what is produced here.
 *
 * Pure: the clock arrives as `today` and `monthProgress`, the data as arrays. The
 * job in `jobs/signals.ts` does the reading and the writing.
 */
import { driftSignals, type DriftPersistence } from '../advice/persistence.ts'
import type { BenchmarkComparison } from '../benchmark/compare.ts'
import { assertDenseMonths } from '../../util/month.ts'
import type { MonthValue } from './baseline.ts'
import { custodySignals, type CustodySplit } from './custody.ts'
import { householdSignals } from './household.ts'
import { hygieneSignals, type AccountReconciliation, type HygieneScore } from './hygiene.ts'
import { benchmarkSignals, categorySignals, sortSignals, type Signal } from './overspend.ts'
import type { AggregateParams } from './params.ts'
import type { NetWorthSummary } from './networth.ts'
import type {
  MonthlyFact,
  MonthTotals,
  RecomputeMismatch,
  UncategorisedBucket,
} from './spend.ts'

export interface SignalInput {
  /** The month being judged, `YYYY-MM`. */
  month: string
  /** Today in the configured timezone, for the staleness checks. */
  today: string
  /** Fraction of `month` elapsed. Pass 1 for a month that is over. */
  monthProgress: number
  /** Facts for `month` only. Baselines are already on them. */
  facts: readonly MonthlyFact[]
  /**
   * Month totals, dense and ascending, **ending at `month`**. The household
   * producers read the trend off this, so a gap would average across the hole.
   */
  totalsHistory: readonly MonthTotals[]
  netWorth: NetWorthSummary | null
  netWorthHistory: readonly { date: string; totalCents: number }[]
  /** The whole loaded window, not just `month`: the backlog is one to-do. */
  uncategorised: readonly UncategorisedBucket[]
  mismatches: readonly RecomputeMismatch[]
  accounts: readonly AccountReconciliation[]
  latestPortfolioSnapshot: string | null
  /**
   * This month against the household-budget benchmark (#43), or an unavailable
   * reason. Computed by the caller because it reads a YAML file and a settings
   * row, and this module is pure — the same reason `netWorth` arrives already
   * summarised.
   */
  benchmark: BenchmarkComparison
  /**
   * This month's shared costs, split into what was paid and what is borne (#44), or an
   * unavailable reason. Computed by the caller for the same reason `benchmark` is: it
   * reads the category flags and a settings row, and this module is pure.
   */
  custody: CustodySplit
  /**
   * How long each portfolio class has been outside its band, or null (#183).
   *
   * Null for every month but one, and deliberately: a drift is a fact about the latest
   * snapshot, not about the month being judged, so attaching today's reading to each of
   * the twelve months in the pass would claim the portfolio looked like this in every one
   * of them. The caller passes it for the month the snapshot falls in and nowhere else.
   *
   * Pre-computed by the caller for the same reason `benchmark` and `custody` are: it reads
   * the risk profile and a series of snapshots, and this module is pure.
   */
  drift: DriftPersistence | null
  params: AggregateParams
}

export interface SignalResult {
  /** Everything found, sorted but uncapped. Ranking is a display decision. */
  signals: Signal[]
  hygiene: HygieneScore
}

const toValues = (
  totals: readonly MonthTotals[],
  pick: (month: MonthTotals) => number,
): MonthValue[] => totals.map((month) => ({ month: month.month, cents: pick(month) }))

/**
 * Runs the producers and returns their union.
 *
 * Deliberately not deduped or capped here: these rows are facts, and the caps in
 * `domain/ai/findings.ts` are a judgement about how much anyone wants to read.
 * Applying them at this layer would mean a threshold change rewrote history.
 */
export function computeSignals(input: SignalInput): SignalResult {
  const { totalsHistory } = input
  assertDenseMonths(totalsHistory.map((month) => month.month), 'month totals history')

  const totals = totalsHistory[totalsHistory.length - 1]
  if (totals === undefined || totals.month !== input.month) {
    // A trailing window that does not end at the month being judged would make
    // every household signal describe a different month from the categories.
    throw new Error(
      `month totals history must end at ${input.month}, got ` +
        `${totals?.month ?? '(empty)'}`,
    )
  }

  const hygiene = hygieneSignals({
    today: input.today,
    uncategorised: input.uncategorised,
    mismatches: input.mismatches,
    accounts: input.accounts,
    latestPortfolioSnapshot: input.latestPortfolioSnapshot,
    params: input.params,
  })

  const signals = [
    ...categorySignals(input.facts, input.monthProgress, input.params),
    ...householdSignals({
      month: input.month,
      totals,
      incomeHistory: toValues(totalsHistory, (month) => month.incomeCents),
      spendHistory: toValues(totalsHistory, (month) => month.spentCents),
      netWorth: input.netWorth,
      netWorthHistory: input.netWorthHistory,
      params: input.params,
    }),
    ...benchmarkSignals(input.benchmark, input.params),
    ...custodySignals(input.custody, input.params),
    ...driftSignals(input.drift, input.params),
    ...hygiene.signals,
  ]

  return { signals: sortSignals(signals), hygiene: hygiene.score }
}
