/**
 * The one thing #252's household signals need that is not a month's spending:
 * which categories the user has manually tagged `savings` or `investments` in
 * `category_meta.nature`.
 *
 * Manual, not AI-set (see the comment on `nature` in `db/schema.ts`) — the same
 * reason `custodyContext` reads `custody_shared` straight off the mapping rather
 * than inferring it: a household's savings envelope is a Settings-page answer,
 * not something the sync pass or a model should be guessing at.
 *
 * Same shape as `custody-context.ts`: a context built once per run from
 * `loadCategoryMeta`, and a per-month aggregate over that month's already-loaded
 * `MonthlyFact` rows — `spentCents` and each category's own already-computed
 * baseline, summed across every savings-or-investments category. Reusing that
 * per-category baseline (rather than computing a new one) is what lets
 * `savings_drawn_down` ask "is this month's total withdrawal unusual" with no
 * new EWMA of its own.
 */
import type { Db } from '../../db/index.ts'
import { loadCategoryMeta } from './facts.ts'
import type { MonthlyFact } from './spend.ts'

export interface SavingsContext {
  readonly savings: ReadonlySet<string>
  readonly investments: ReadonlySet<string>
}

export function savingsContext(db: Db): SavingsContext {
  const savings = new Set<string>()
  const investments = new Set<string>()
  for (const [categoryId, meta] of loadCategoryMeta(db)) {
    if (meta.nature === 'savings') savings.add(categoryId)
    else if (meta.nature === 'investments') investments.add(categoryId)
  }
  return { savings, investments }
}

/** One month's savings/investments envelopes, given a context loaded once. */
export interface SavingsAggregate {
  /** Whether the user has tagged any category `savings` at all — not month-specific. */
  hasSavings: boolean
  /** Same, for `investments`. */
  hasInvestments: boolean
  /** This month's spend across every savings-or-investments envelope. A withdrawal
   *  from savings shows up here the same way any other spend does. */
  spentCents: number
  /** Sum of each envelope's own baseline, or null when none of them has one yet. */
  baselineCents: number | null
}

export function splitSavingsMonth(
  context: SavingsContext,
  rows: readonly MonthlyFact[],
): SavingsAggregate {
  let spentCents = 0
  let baselineCents = 0
  let hasBaseline = false

  for (const row of rows) {
    if (!context.savings.has(row.categoryId) && !context.investments.has(row.categoryId)) continue
    spentCents += row.spentCents
    if (row.baseline !== null) {
      baselineCents += row.baseline.baselineCents
      hasBaseline = true
    }
  }

  return {
    hasSavings: context.savings.size > 0,
    hasInvestments: context.investments.size > 0,
    spentCents,
    baselineCents: hasBaseline ? baselineCents : null,
  }
}
