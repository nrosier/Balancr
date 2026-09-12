/**
 * "What if I put €200 more into investments each month?" (#51).
 *
 * Two real numbers seed the calculator instead of an arbitrary round one: the
 * household's current monthly investment contribution, and its current invested
 * net worth. Both already exist elsewhere and are reused, not recomputed:
 *
 *  - `savingsContext(db).investments` is the same manual `category_meta.nature`
 *    tagging `savings-context.ts` reads for #252, and `loadFacts` already carries
 *    a nature-agnostic EWMA `baseline` for every category. Summing that baseline
 *    across investments-tagged categories for the latest stored month is the
 *    household's real, already-smoothed monthly contribution — no new tracking.
 *    This is *not* `splitSavingsMonth`, which unions `savings` and `investments`
 *    for #252's purposes; here only `investments` is wanted.
 *  - `loadLatestNetWorth`'s `investedCents` is the real starting point for the
 *    projection.
 *
 * What does not exist anywhere in this codebase is a real rate of return: Ghostfolio
 * sync carries point-in-time valuation only, never a dated cashflow series, so
 * `domain/portfolio/metrics.ts` explicitly declines to compute MWR/CAGR, and its
 * `reportedTwrBp` is copied from Ghostfolio's own report rather than derived. There is
 * nothing honest to seed a growth rate from, so `DEFAULT_GROWTH_RATE_BP` is a plainly
 * documented assumption, editable on the page rather than presented as measured.
 *
 * The compounding math itself (`projectScenario` and friends) lives in
 * `scenario-projection.ts`, not here — see that module's doc comment for why: this
 * file reaches the database, and the browser must not import that chain just to get
 * a pure function.
 */
import type { Db } from '../../db/index.ts'
import { loadFacts } from './facts.ts'
import { latestStoredMonth } from './month-store.ts'
import { loadLatestNetWorth } from './networth-store.ts'
import { savingsContext } from './savings-context.ts'

export {
  DEFAULT_GROWTH_RATE_BP,
  DEFAULT_HORIZON_MONTHS,
  MAX_HORIZON_MONTHS,
  projectScenario,
  type ScenarioInput,
  type ScenarioMonth,
} from './scenario-projection.ts'

export interface ScenarioBaseline {
  /** The stored month `baselineCents` was read from, or null with no stored month. */
  month: string | null
  /** Current monthly contribution to investments-tagged categories, or null when
   *  no category is tagged `investments` or none has a baseline yet. */
  baselineCents: number | null
  /** The net worth snapshot date `startingValueCents` was read from, or null. */
  snapshotDate: string | null
  /** Latest invested net worth, or null with no snapshot. */
  startingValueCents: number | null
}

export function scenarioBaseline(db: Db): ScenarioBaseline {
  const month = latestStoredMonth(db)
  const { investments } = savingsContext(db)

  let baselineCents: number | null = null
  if (month !== null && investments.size > 0) {
    let sum = 0
    let hasBaseline = false
    for (const row of loadFacts(db, month)) {
      if (!investments.has(row.categoryId) || row.baseline === null) continue
      sum += row.baseline.baselineCents
      hasBaseline = true
    }
    baselineCents = hasBaseline ? sum : null
  }

  const netWorth = loadLatestNetWorth(db)
  return {
    month,
    baselineCents,
    snapshotDate: netWorth?.date ?? null,
    startingValueCents: netWorth === null ? null : netWorth.investedCents,
  }
}

