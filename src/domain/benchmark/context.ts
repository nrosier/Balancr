/**
 * Everything a benchmark comparison needs that is not a month's spending (#43).
 *
 * The file, the household composition and the COICOP mapping are read from four different
 * places — a YAML path, two settings rows, and the `category_meta` table — and both callers
 * need all of them: the nightly signals job, which judges two months, and
 * `GET /api/budget`, which draws the card. Loading them here means the two cannot end up
 * reading a different mapping from each other, and means the job reads the file once per
 * pass rather than once per month.
 *
 * Computed per request rather than stored, the same decision drift (#41) was given: the
 * comparison is a function of the mapping and the household, both of which change from the
 * settings screen, and a stored comparison would keep showing yesterday's answer until the
 * next nightly pass. The signals it produces *are* stored, because a signal is a judgement
 * about a month that was made at a time — but the card on the page is recomputed, so
 * mapping a category updates it on the next reload.
 */
import type { Db } from '../../db/index.ts'
import { loadCategoryMeta } from '../aggregate/facts.ts'
import {
  compareToBenchmark,
  type BenchmarkComparison,
  type BenchmarkPeriodKind,
  type SpendRow,
} from './compare.ts'
import { loadHousehold, type Household } from './household.ts'
import { benchmarkOrNull, type Benchmark } from './model.ts'
import { applyReferenceOverride, loadReferenceOverride } from './reference.ts'

export interface BenchmarkContext {
  /** Null when no file is configured, which is a supported state. */
  readonly benchmark: Benchmark | null
  readonly household: Household
  /** `categoryId` → stored COICOP code, or null for a category nobody has mapped. */
  readonly coicop: ReadonlyMap<string, string | null>
}

export function benchmarkContext(db: Db): BenchmarkContext {
  const coicop = new Map<string, string | null>()
  for (const [categoryId, meta] of loadCategoryMeta(db)) {
    coicop.set(categoryId, meta.coicopCode)
  }
  // The override is applied here rather than at either caller, because this is the one
  // seam both of them pass through — the nightly signals job and `GET /api/budget`. Applied
  // once at either end instead, the two could disagree about which average household they
  // were comparing to, and the stored signals would be about a different reference from the
  // card explaining them (#290).
  const benchmark = applyReferenceOverride(benchmarkOrNull(), loadReferenceOverride(db))
  return { benchmark, household: loadHousehold(db), coicop }
}

/**
 * One period compared, given a context that was loaded once.
 *
 * `rows` must already cover the whole period (summed across months, for `year`/`ytd`) — this
 * function does not know how to load or combine months, only how to compare what it is given.
 */
export function compareMonth(
  context: BenchmarkContext,
  month: string,
  rows: readonly SpendRow[],
  period: BenchmarkPeriodKind = 'month',
  periodMonths = 1,
): BenchmarkComparison {
  return compareToBenchmark({
    benchmark: context.benchmark,
    household: context.household,
    month,
    rows,
    coicop: context.coicop,
    period,
    periodMonths,
  })
}
