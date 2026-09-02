/**
 * `GET /api/budget` — one month in detail, plus the trail behind it.
 *
 * Takes `?month=YYYY-MM`, defaulting to the latest month a job has actually
 * written. A month that was asked for but never computed is answered with empty
 * arrays and a null total rather than a 404: the client's month picker offers
 * `months`, and a request for a month outside it is a stale bookmark, not an error
 * worth a red banner.
 *
 * `signals` is the same shape the AI layer produces and the same shape
 * `insights` returns — codes and integers, never sentences. The client renders
 * them through the i18n catalogue, which is why this endpoint has no opinion about
 * language.
 */
import type { Db } from '../../../db/index.ts'
import { loadFacts } from '../../../domain/aggregate/facts.ts'
import {
  latestStoredMonth,
  loadMonthTotals,
  loadTrailingTotals,
  loadUncategorised,
} from '../../../domain/aggregate/month-store.ts'
import { loadSignals } from '../../../domain/aggregate/signals-store.ts'
import { badRequest } from '../../errors.ts'
import { freshness } from './freshness.ts'
import { budgetSchema, type Budget } from './schemas.ts'

/** How much history the trend charts get. Two years, matching `JOBS_HISTORY_MONTHS`. */
export const HISTORY_MONTHS = 24

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

/**
 * The month to report on.
 *
 * A malformed value is a 400 rather than a silent fallback to the latest month: a
 * client that sends `2026-13` has a bug, and answering it with a different month's
 * numbers under the label it asked for would hide that bug behind plausible data.
 */
export function resolveMonth(db: Db, raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return latestStoredMonth(db)
  if (typeof raw !== 'string' || !MONTH_PATTERN.test(raw)) {
    throw badRequest('month must be YYYY-MM.')
  }
  return raw
}

export function buildBudget(db: Db, monthParam: unknown): Budget {
  const month = resolveMonth(db, monthParam)
  // Nothing computed at all: report the empty state under the current month rather
  // than inventing one, so the client has a label for its own "no data yet" screen.
  const resolved = month ?? new Date().toISOString().slice(0, 7)

  const history = loadTrailingTotals(db, resolved, HISTORY_MONTHS)
  const totals = loadMonthTotals(db, [resolved])[0] ?? null
  const uncategorised = loadUncategorised(db, [resolved])[0] ?? null

  return budgetSchema.parse({
    freshness: freshness(db),
    month: resolved,
    // Descending, so the picker's first entry is the most recent month.
    months: history.map((entry) => entry.month).reverse(),
    totals:
      totals === null
        ? null
        : {
            month: totals.month,
            incomeCents: totals.incomeCents,
            spentCents: totals.spentCents,
            budgetedCents: totals.budgetedCents,
            toBudgetCents: totals.toBudgetCents,
            fromLastMonthCents: totals.fromLastMonthCents,
            balanceCents: totals.balanceCents,
            savingsRateBp: totals.savingsRateBp,
          },
    history: history.map((entry) => ({
      month: entry.month,
      incomeCents: entry.incomeCents,
      spentCents: entry.spentCents,
      budgetedCents: entry.budgetedCents,
      savingsRateBp: entry.savingsRateBp,
    })),
    categories: loadFacts(db, resolved).map((fact) => ({
      categoryId: fact.categoryId,
      categoryName: fact.categoryName,
      isIncome: fact.isIncome,
      hidden: fact.hidden,
      spentCents: fact.spentCents,
      budgetedCents: fact.budgetedCents,
      availableCents: fact.availableCents,
      txnCount: fact.txnCount,
      // Flattened out of `baseline`, because a client charting a norm wants the
      // number and the delta, and the months that fed the average are the
      // aggregation layer's business.
      baselineCents: fact.baseline?.baselineCents ?? null,
      deltaBp: fact.baseline?.deltaBp ?? null,
    })),
    signals: loadSignals(db, resolved),
    uncategorised:
      uncategorised === null
        ? null
        : { txnCount: uncategorised.txnCount, amountCents: uncategorised.amountCents },
  })
}
