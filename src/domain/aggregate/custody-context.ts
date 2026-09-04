/**
 * The two things a custody split needs that are not a month's spending (#44).
 *
 * Which categories are shared lives in `category_meta.custody_shared`, and the share to
 * apply lives in the household settings row. Both callers need both: the nightly signals
 * pass, which judges two months, and `GET /api/budget`, which draws the card.
 *
 * Computed per request rather than stored, for the reason the benchmark comparison is:
 * flagging a category is a gesture on the settings screen, and a split stored last night
 * would keep printing yesterday's answer until the next pass. The *signal* is stored,
 * because a finding is a judgement about a month made at a time; the card is recomputed,
 * so a flag lands on the next reload.
 *
 * This reads the roster and the category mapping that `benchmarkContext` also reads, which
 * is a second query and not a second answer: better-sqlite3 is synchronous and there is no
 * `await` between the two, so no write can land in the gap. Merging them into one
 * "everything about this household" context would save a small query at the cost of a
 * module that belongs to neither feature.
 */
import type { Db } from '../../db/index.ts'
import { loadHousehold, type Household } from '../benchmark/household.ts'
import { loadCategoryMeta } from './facts.ts'
import { splitCustody, type CustodySplit } from './custody.ts'
import type { MonthlyFact } from './spend.ts'

export interface CustodyContext {
  /** The categories flagged as shared with a co-parent. */
  readonly shared: ReadonlySet<string>
  readonly household: Household
}

export function custodyContext(db: Db): CustodyContext {
  const shared = new Set<string>()
  for (const [categoryId, meta] of loadCategoryMeta(db)) {
    if (meta.custodyShared) shared.add(categoryId)
  }
  return { shared, household: loadHousehold(db) }
}

/** One month split, given a context that was loaded once. */
export function splitMonth(
  context: CustodyContext,
  month: string,
  rows: readonly MonthlyFact[],
): CustodySplit {
  return splitCustody({ month, rows, shared: context.shared, household: context.household })
}
