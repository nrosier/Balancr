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

/**
 * One suggestion per category with a triggered signal this month, sourced from
 * that category's own EWMA baseline rather than a separately-tracked streak —
 * `computeBaseline` already trails several months, so a category has to be off
 * its norm for a while before `above_baseline`/`over_available` fire at all.
 *
 * Rounded to the nearest euro because a suggestion to the cent reads as
 * spuriously precise for a trailing average. Skips a category already at that
 * rounded figure — `createProposal` refuses a no-op diff anyway, but there is
 * no reason to compute one.
 */
export function suggestBudgetAmounts(
  signals: readonly Signal[],
  facts: readonly MonthlyFact[],
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

    const amountCents = Math.round(baselineCents / 100) * 100
    if (amountCents === fact.budgetedCents) continue

    seen.add(signal.categoryId)
    suggestions.push({ categoryId: signal.categoryId, amountCents })
  }

  return suggestions
}
