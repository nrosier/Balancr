/**
 * A per-month fingerprint of the facts a judgement actually depends on (#162).
 *
 * `signals.ts` used to assume only the newest two stored months could ever
 * change; they cannot rejudge a month edited five months after the fact
 * without something that notices the edit landed. This hash is that
 * something: written by the sync pass for every target month, and compared
 * night over night in `month-store.ts` to decide whether a month's
 * `factsChangedAt` moves.
 *
 * Deliberately excludes `baseline` (an EWMA over the trailing window, not a
 * fact about this month) and every `committed*` field (a function of today's
 * date, not of what changed upstream) — a month whose own figures are
 * unchanged should not be treated as "changed" just because the clock moved
 * or an older month's baseline shifted it.
 */
import { createHash } from 'node:crypto'
import type { MonthlyFact, MonthTotals } from './spend.ts'

export function monthFingerprint(
  facts: readonly MonthlyFact[],
  totals: MonthTotals,
): string {
  const totalsPart = {
    incomeCents: totals.incomeCents,
    spentCents: totals.spentCents,
    budgetedCents: totals.budgetedCents,
    toBudgetCents: totals.toBudgetCents,
    fromLastMonthCents: totals.fromLastMonthCents,
    balanceCents: totals.balanceCents,
    savingsRateBp: totals.savingsRateBp,
  }

  const factsPart = [...facts]
    .sort((a, b) => a.categoryId.localeCompare(b.categoryId))
    .map((fact) => ({
      categoryId: fact.categoryId,
      spentCents: fact.spentCents,
      budgetedCents: fact.budgetedCents,
      availableCents: fact.availableCents,
      carryoverEnabled: fact.carryoverEnabled,
      txnCount: fact.txnCount,
    }))

  return createHash('sha256')
    .update(JSON.stringify({ totals: totalsPart, facts: factsPart }))
    .digest('hex')
}
