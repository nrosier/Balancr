/**
 * Whether the data is good enough to reason about at all.
 *
 * This runs before the AI layer and its findings are shown above them, because
 * the alternative is a confident narrative about a month where a third of the
 * transactions are uncategorised. The model cannot tell the difference; the
 * reader will assume we checked.
 *
 * Four inputs, all four now available:
 *
 *  - **Uncategorised backlog** — transactions Actual could not attribute.
 *  - **Recomputation drift** — our own sum disagreeing with Actual's.
 *  - **Reconciliation staleness** — an account not reconciled in weeks has a
 *    balance that is a guess, and net worth is built out of those balances.
 *  - **Snapshot staleness** — how old the portfolio figures on screen are. Note
 *    what this does *not* measure: Ghostfolio's internal API exposes no
 *    as-of date for a market price, so this is the age of *our* snapshot. That
 *    is the number the reader needs anyway — a stale snapshot misleads whatever
 *    the upstream price is doing.
 */
import { capSeverity } from '../ai/codes.ts'
import { daysBetween } from '../../util/month.ts'
import type { AggregateParams } from './params.ts'
import { sortSignals, type Signal } from './overspend.ts'
import type { RecomputeMismatch, UncategorisedBucket } from './spend.ts'

export interface AccountReconciliation {
  accountId: string
  name: string
  /** Actual's `last_reconciled`, `YYYY-MM-DD`, or null if it never was. */
  lastReconciled: string | null
  closed: boolean
}

export interface HygieneInput {
  /** Today, in the configured timezone. Passed in so staleness is testable. */
  today: string
  uncategorised: readonly UncategorisedBucket[]
  mismatches: readonly RecomputeMismatch[]
  accounts: readonly AccountReconciliation[]
  /** Date of the most recent portfolio snapshot, or null if there is none yet. */
  latestPortfolioSnapshot: string | null
  params: AggregateParams
}

/**
 * A single 0–10000 figure for "can these numbers be trusted".
 *
 * Deductions, not a weighted average, and each one is capped: the score answers
 * "how much doubt is there", and doubt accumulates. The weights are a judgement
 * call — a mismatch costs more than an uncategorised transaction because drift
 * means a rule is wrong everywhere, not just in one row — and they are fixed here
 * rather than tunable on purpose, so a number the AI narrates does not quietly
 * mean something different from one month to the next.
 */
export interface HygieneScore {
  scoreBp: number
  /** What was deducted and why, so the number is never unexplainable. */
  deductions: { reason: string; bp: number }[]
}

const DEDUCTION = {
  /** Per uncategorised transaction over the tolerated count, to a 2500 cap. */
  perUncategorised: 50,
  maxUncategorised: 2_500,
  /** Per mismatched category-month. Drift is a wrong rule, so it costs more. */
  perMismatch: 1_000,
  maxMismatch: 4_000,
  /** Per account whose balance has become a guess. */
  perUnreconciled: 500,
  maxUnreconciled: 2_000,
  /** Flat, once, for portfolio figures past their staleness limit. */
  stalePrices: 1_500,
} as const

export interface HygieneResult {
  signals: Signal[]
  score: HygieneScore
}

export function hygieneSignals(input: HygieneInput): HygieneResult {
  const { hygiene } = input.params
  const signals: Signal[] = []
  const deductions: { reason: string; bp: number }[] = []

  // --- uncategorised ------------------------------------------------------
  // One signal for the window, not one per month: "you have 40 uncategorised
  // transactions" is a to-do, whereas twelve rows of it is a wall.
  const backlog = input.uncategorised.reduce((total, bucket) => total + bucket.txnCount, 0)
  if (backlog > hygiene.uncategorisedWarnCount) {
    signals.push({
      code: 'uncategorised_backlog',
      categoryId: null,
      categoryName: null,
      severity: capSeverity('uncategorised_backlog', 'warn'),
      metrics: {
        count: backlog,
        // Magnitudes: a refund cancelling out a charge does not mean there is
        // nothing left to categorise.
        amountCents: input.uncategorised.reduce(
          (total, bucket) => total + Math.abs(bucket.amountCents),
          0,
        ),
        months: input.uncategorised.length,
      },
    })
    deductions.push({
      reason: 'uncategorised',
      bp: Math.min(
        DEDUCTION.maxUncategorised,
        (backlog - hygiene.uncategorisedWarnCount) * DEDUCTION.perUncategorised,
      ),
    })
  }

  // --- recomputation drift ------------------------------------------------
  // Per category and per month on purpose. A mismatch means one of our own
  // hygiene rules is wrong — most likely a transfer or a split — and the category
  // and month are the entire lead for finding out which.
  for (const mismatch of input.mismatches) {
    signals.push({
      code: 'recompute_mismatch',
      categoryId: mismatch.categoryId,
      categoryName: mismatch.categoryName,
      severity: capSeverity('recompute_mismatch', 'alert'),
      metrics: {
        differenceCents: mismatch.differenceCents,
        actualCents: mismatch.actualCents,
        recomputedCents: mismatch.recomputedCents,
      },
    })
  }
  if (input.mismatches.length > 0) {
    deductions.push({
      reason: 'recompute_mismatch',
      bp: Math.min(DEDUCTION.maxMismatch, input.mismatches.length * DEDUCTION.perMismatch),
    })
  }

  // --- reconciliation -----------------------------------------------------
  let unreconciled = 0
  for (const account of input.accounts) {
    // A closed account's balance is final; nagging about reconciling it is noise.
    if (account.closed) continue

    const days =
      account.lastReconciled === null
        ? null
        : daysBetween(account.lastReconciled, input.today)
    if (days !== null && days <= hygiene.reconcileStaleDays) continue

    unreconciled += 1
    signals.push({
      code: 'unreconciled_account',
      // The account's own id, not null: `Signal.categoryId` is the subject of the
      // signal, and two stale accounts with no subject dedupe into one finding
      // because they share the household group. It is also what lets the
      // redaction boundary give this signal an account label.
      categoryId: account.accountId,
      categoryName: account.name,
      severity: capSeverity('unreconciled_account', 'warn'),
      metrics: {
        // -1 for "never", which is a different problem from "not lately" and the
        // renderer picks its own wording for it.
        days: days ?? -1,
        limitDays: hygiene.reconcileStaleDays,
      },
    })
  }
  if (unreconciled > 0) {
    deductions.push({
      reason: 'unreconciled',
      bp: Math.min(DEDUCTION.maxUnreconciled, unreconciled * DEDUCTION.perUnreconciled),
    })
  }

  // --- snapshot staleness -------------------------------------------------
  // No snapshot at all is not stale data, it is no data: net worth simply has no
  // portfolio component yet, and `unresolvedGroups` is where that shows up.
  if (input.latestPortfolioSnapshot !== null) {
    const age = daysBetween(input.latestPortfolioSnapshot, input.today)
    if (age > hygiene.priceStaleDays) {
      signals.push({
        code: 'stale_prices',
        categoryId: null,
        categoryName: null,
        severity: capSeverity('stale_prices', 'warn'),
        metrics: { count: 1, days: age, limitDays: hygiene.priceStaleDays },
      })
      deductions.push({ reason: 'stale_prices', bp: DEDUCTION.stalePrices })
    }
  }

  const spent = deductions.reduce((total, deduction) => total + deduction.bp, 0)
  return {
    signals: sortSignals(signals),
    score: { scoreBp: Math.max(0, 10_000 - spent), deductions },
  }
}
