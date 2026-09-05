/**
 * Budget's own sub-navigation (#230), the same mechanism Settings settled on (#200)
 * and Insights reused (#228): `../ui/sections.ts`'s generic `Section`/`sectionFor`
 * over the page's own tab order.
 *
 * Three tabs, following the issue's own grouping: Overview carries the totals, the
 * uncategorised notice, the charts and the burn-rate pace — everything that answers
 * "how did this month go" — while Benchmark and Custody are each a standing
 * comparison that is not a verdict on the month itself, and already came last on
 * the page for that reason before this split.
 */
import { sectionFor as sectionForGeneric, type Section } from '../ui/sections.ts'

export type BudgetSectionId = 'overview' | 'benchmark' | 'custody'

export const BUDGET_SECTIONS: readonly Section<BudgetSectionId>[] = [
  { id: 'overview', path: '/budget', labelKey: 'budget:nav.overview' },
  { id: 'benchmark', path: '/budget/benchmark', labelKey: 'budget:nav.benchmark' },
  { id: 'custody', path: '/budget/custody', labelKey: 'budget:nav.custody' },
]

/** The section an arbitrary `/budget*` path belongs to; an unknown one lands on Overview. */
export function sectionFor(pathname: string): BudgetSectionId {
  return sectionForGeneric(BUDGET_SECTIONS, pathname, 'overview')
}
