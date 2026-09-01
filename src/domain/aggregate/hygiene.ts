/**
 * Whether the data is good enough to reason about at all.
 *
 * This runs before the AI layer and its findings are shown above them, because
 * the alternative is a confident narrative about a month where a third of the
 * transactions are uncategorised. The model cannot tell the difference; the
 * reader will assume we checked.
 *
 * **There is deliberately no hygiene *score* yet.** The plan calls for one over
 * four inputs — uncategorised backlog, reconciliation staleness, price
 * staleness, and our own recomputation drift — and only the first and last exist
 * so far. A "92%" computed from half the inputs is worse than no number: it
 * would move when the missing halves arrive and nobody would know why. The score
 * lands with `unreconciled_account` and `stale_prices`, which need the account
 * and portfolio snapshots.
 */
import { capSeverity } from '../ai/codes.ts'
import type { AggregateParams } from './params.ts'
import { sortSignals, type Signal } from './overspend.ts'
import type { RecomputeMismatch, UncategorisedBucket } from './spend.ts'

export interface HygieneInput {
  uncategorised: readonly UncategorisedBucket[]
  mismatches: readonly RecomputeMismatch[]
  params: AggregateParams
}

export function hygieneSignals(input: HygieneInput): Signal[] {
  const signals: Signal[] = []

  // One signal for the window, not one per month: "you have 40 uncategorised
  // transactions" is a to-do, whereas twelve rows of it is a wall.
  const backlog = input.uncategorised.reduce((total, bucket) => total + bucket.txnCount, 0)
  if (backlog > input.params.hygiene.uncategorisedWarnCount) {
    signals.push({
      code: 'uncategorised_backlog',
      categoryId: null,
      categoryName: null,
      severity: capSeverity('uncategorised_backlog', 'warn'),
      metrics: {
        count: backlog,
        amountCents: input.uncategorised.reduce(
          (total, bucket) => total + Math.abs(bucket.amountCents),
          0,
        ),
        months: input.uncategorised.length,
      },
    })
  }

  // These are per-category and per-month on purpose. A mismatch means one of our
  // own hygiene rules is wrong — most likely a transfer or a split — and the
  // category and month are the entire lead for finding out which.
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

  return sortSignals(signals)
}
