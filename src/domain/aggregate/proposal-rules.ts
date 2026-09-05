/**
 * Deterministic suggestion rules for #45's proposal generators.
 *
 * Pure — no Actual call, no DB read, no `createProposal`. `src/domain/ai/proposal-generators.ts`
 * wires these to the adapter and the proposal lifecycle; this file only decides
 * *what* to suggest, so the confidence and rounding rules can be tested without
 * mocking anything.
 */
import type { FindingCode } from '../ai/codes.ts'
import type { MonthlyFact } from './spend.ts'
import type { Signal } from './overspend.ts'

export interface PayeeCategorySample {
  categoryId: string | null
}

export interface CategorySuggestion {
  categoryId: string
}

/**
 * Majority vote over a payee's past categorisations. Below `minSamples` or
 * `minConfidence`, returns null rather than a low-confidence guess — that gap
 * is deliberately left for the AI-assisted fallback fast-follow, not filled
 * here with a lower bar.
 */
export function suggestCategoryForPayee(
  history: readonly PayeeCategorySample[],
  options?: { minSamples?: number; minConfidence?: number },
): CategorySuggestion | null {
  const minSamples = options?.minSamples ?? 2
  const minConfidence = options?.minConfidence ?? 0.8

  const counts = new Map<string, number>()
  let total = 0
  for (const { categoryId } of history) {
    if (categoryId === null) continue
    total += 1
    counts.set(categoryId, (counts.get(categoryId) ?? 0) + 1)
  }
  if (total < minSamples) return null

  let bestId: string | null = null
  let bestCount = 0
  for (const [categoryId, count] of counts) {
    if (count > bestCount) {
      bestId = categoryId
      bestCount = count
    }
  }
  if (bestId === null || bestCount / total < minConfidence) return null

  return { categoryId: bestId }
}

export interface CategoryHistorySample {
  categoryId: string
  count: number
}

/**
 * Raw history collapsed into per-category counts, dropping uncategorised
 * samples — the shape #216's candidate cache stores and its redaction step
 * turns into opaque labels, so a category id only ever appears once,
 * regardless of how many transactions the AQL query happened to return.
 */
export function summariseCategoryHistory(
  history: readonly PayeeCategorySample[],
): CategoryHistorySample[] {
  const counts = new Map<string, number>()
  for (const { categoryId } of history) {
    if (categoryId === null) continue
    counts.set(categoryId, (counts.get(categoryId) ?? 0) + 1)
  }
  return [...counts].map(([categoryId, count]) => ({ categoryId, count }))
}

export interface BudgetSuggestion {
  categoryId: string
  amountCents: number
}

/** The two overspend signals that mean a category's budget looks miscalibrated, not just spent. */
const BUDGET_TRIGGER_CODES: ReadonlySet<FindingCode> = new Set(['over_available', 'above_baseline'])

/** How much a suggestion leans on the last 3 months over the 9 before them (#220). */
const RECENT_WEIGHT = 0.6
const OLDER_WEIGHT = 1 - RECENT_WEIGHT

const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length

/**
 * A trailing spend history, oldest first, into one weighted figure — the last 3
 * entries count for 60%, the up-to-9 before them for the other 40% (#220). Plain
 * `mean` rather than the closed-form weighted average, because the two windows
 * can have different lengths (a category with under a year of history) and
 * a per-sample weight would have to change with that length to keep the 60/40
 * split honest.
 */
function weightedTrailingAverageCents(history: readonly number[]): number | null {
  const recent = history.slice(Math.max(0, history.length - 3))
  const older = history.slice(Math.max(0, history.length - 12), Math.max(0, history.length - 3))

  const recentMean = mean(recent)
  if (recentMean === null) return null
  const olderMean = mean(older)
  if (olderMean === null) return recentMean

  return recentMean * RECENT_WEIGHT + olderMean * OLDER_WEIGHT
}

/**
 * One suggestion per category with a triggered signal this month, sourced from a
 * weighted trailing average of what it actually spent rather than the rounded EWMA
 * baseline alone — the baseline is still what decides *whether* a category looks
 * miscalibrated (below), but the amount itself now tracks recent spend more closely
 * than a single smoothed figure does.
 *
 * Rounded to the nearest euro because a suggestion to the cent reads as spuriously
 * precise for a trailing average. Skips a category already at that rounded figure —
 * `createProposal` refuses a no-op diff anyway, but there is no reason to compute one.
 */
export function suggestBudgetAmounts(
  signals: readonly Signal[],
  facts: readonly MonthlyFact[],
  trailingSpendCents: ReadonlyMap<string, readonly number[]>,
): BudgetSuggestion[] {
  const factsByCategory = new Map(facts.map((fact) => [fact.categoryId, fact]))
  const suggestions: BudgetSuggestion[] = []
  const seen = new Set<string>()

  for (const signal of signals) {
    if (!BUDGET_TRIGGER_CODES.has(signal.code)) continue
    if (signal.categoryId === null || seen.has(signal.categoryId)) continue

    const fact = factsByCategory.get(signal.categoryId)
    if (fact === undefined) continue
    const baselineCents = fact.baseline?.baselineCents
    if (baselineCents === undefined || baselineCents <= 0) continue

    const history = trailingSpendCents.get(signal.categoryId) ?? []
    const weightedCents = weightedTrailingAverageCents(history) ?? baselineCents
    const amountCents = Math.round(weightedCents / 100) * 100
    if (amountCents === fact.budgetedCents) continue

    seen.add(signal.categoryId)
    suggestions.push({ categoryId: signal.categoryId, amountCents })
  }

  return suggestions
}
