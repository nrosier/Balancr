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
import { loadCategoryTrends, loadFacts } from '../../../domain/aggregate/facts.ts'
import {
  latestStoredMonth,
  loadMonthTotals,
  loadTrailingTotals,
  loadUncategorised,
  storedMonths,
} from '../../../domain/aggregate/month-store.ts'
import { loadSignals } from '../../../domain/aggregate/signals-store.ts'
import { custodyContext, splitMonth } from '../../../domain/aggregate/custody-context.ts'
import { benchmarkContext, compareMonth } from '../../../domain/benchmark/context.ts'
import { badRequest } from '../../errors.ts'
import { freshness } from './freshness.ts'
import { budgetSchema, type Budget } from './schemas.ts'

/** How much history the trend charts get. Two years, matching `JOBS_HISTORY_MONTHS`. */
export const HISTORY_MONTHS = 24

/**
 * How much history each category's own series gets.
 *
 * Twelve rather than `HISTORY_MONTHS`, and not because of payload size: twelve months
 * is the window the EWMA norm is taken over, so a category's line and the norm drawn
 * across it describe the same period. Two years of line against a one-year average
 * would invite reading the gap as a trend.
 */
export const TREND_MONTHS = 12

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

  // Hoisted, because the benchmark comparison is a function of the same rows the
  // category list is built from. Loading them twice would let one of the two see a
  // mapping the other did not, which is how a card and a table come to disagree.
  const facts = loadFacts(db, resolved)
  const history = loadTrailingTotals(db, resolved, HISTORY_MONTHS)
  const trends = loadCategoryTrends(db, resolved, TREND_MONTHS)
  const totals = loadMonthTotals(db, [resolved])[0] ?? null
  const uncategorised = loadUncategorised(db, [resolved])[0] ?? null

  return budgetSchema.parse({
    freshness: freshness(db),
    month: resolved,
    // Every stored month, not the window `history` covers: the picker has to keep
    // offering August while July is on screen, and a month that was never computed
    // still needs somewhere to navigate to.
    months: storedMonths(db),
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
            committedCents: totals.committedCents,
            committedUnallocatedCents: totals.committedUnallocatedCents,
            committedUnallocatedCount: totals.committedUnallocatedCount,
            committedApproximate: totals.committedApproximate,
          },
    history: history.map((entry) => ({
      month: entry.month,
      incomeCents: entry.incomeCents,
      spentCents: entry.spentCents,
      budgetedCents: entry.budgetedCents,
      savingsRateBp: entry.savingsRateBp,
    })),
    trendMonths: trends.months,
    categories: facts.map((fact) => ({
      categoryId: fact.categoryId,
      categoryName: fact.categoryName,
      isIncome: fact.isIncome,
      hidden: fact.hidden,
      spentCents: fact.spentCents,
      budgetedCents: fact.budgetedCents,
      availableCents: fact.availableCents,
      txnCount: fact.txnCount,
      committedCents: fact.committedCents,
      committedApproximate: fact.committedApproximate,
      // Flattened out of `baseline`, because a client charting a norm wants the
      // number and the delta, and the months that fed the average are the
      // aggregation layer's business.
      baselineCents: fact.baseline?.baselineCents ?? null,
      deltaBp: fact.baseline?.deltaBp ?? null,
      // Zeroes rather than an empty array for a category with no history at all: the
      // client indexes into `trendMonths`, and a short series would misalign the axis.
      trendCents:
        trends.byCategory.get(fact.categoryId) ??
        new Array<number>(trends.months.length).fill(0),
    })),
    signals: loadSignals(db, resolved),
    benchmark: compareMonth(benchmarkContext(db), resolved, facts),
    custody: splitMonth(custodyContext(db), resolved, facts),
    uncategorised:
      uncategorised === null
        ? null
        : { txnCount: uncategorised.txnCount, amountCents: uncategorised.amountCents },
  })
}
