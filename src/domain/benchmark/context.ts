/**
 * Everything a benchmark comparison needs that is not a month's spending (#43).
 *
 * The file, the household composition and the COICOP mapping are read from three
 * different places — a YAML path, a settings row, and the `category_meta` table — and both
 * callers need all three: the nightly signals job, which judges two months, and
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
import { compareToBenchmark, type BenchmarkComparison, type SpendRow } from './compare.ts'
import { loadHousehold, type Household } from './household.ts'
import { benchmarkOrNull, type Benchmark } from './model.ts'

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
  return { benchmark: benchmarkOrNull(), household: loadHousehold(db), coicop }
}

/** One month compared, given a context that was loaded once. */
export function compareMonth(
  context: BenchmarkContext,
  month: string,
  rows: readonly SpendRow[],
): BenchmarkComparison {
  return compareToBenchmark({
    benchmark: context.benchmark,
    household: context.household,
    month,
    rows,
    coicop: context.coicop,
  })
}
