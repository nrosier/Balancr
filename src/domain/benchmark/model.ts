/**
 * Loading the household-budget benchmark, and saying how much to trust it (#43).
 *
 * The tax loader's shape (#42) with one deliberate difference: **absent is a choice
 * here.** A missing tax file means `TAX_RULES_PATH` points at nothing, because a tax
 * figure is part of every suggestion. A missing benchmark file means somebody does not
 * want their spending compared to a national average — a perfectly reasonable position,
 * and one worth being able to take by deleting a file. So `loadBenchmark` still throws
 * for a broken file, and `benchmarkOrNull` distinguishes "not configured" (silent) from
 * "configured and broken" (logged), because only the second is news.
 *
 * The division-to-group map is built once at load rather than searched per category. It
 * is also the thing that makes the file's own aggregation authoritative: a category
 * mapped to COICOP `10.4` finds its group by looking up `10`, so Statbel folding education
 * into "other expenditure items" is a fact about the file rather than a rule in code.
 */
import { config } from '../../config.ts'
import { logger } from '../../logger.ts'
import { readYamlFile } from '../../yaml-file.ts'
import { ageInDays } from '../verified-date.ts'
import {
  benchmarkFileSchema,
  type BenchmarkGroupEntry,
  type BenchmarkProvenance,
  type Equivalence,
  type ReferenceHousehold,
} from './schema.ts'
import { divisionOf, type BenchmarkBlock, type BenchmarkGroup } from './vocabulary.ts'

const log = logger.child({ module: 'benchmark' })

export class BenchmarkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BenchmarkError'
  }
}

export interface BenchmarkSource extends BenchmarkProvenance {
  readonly survey: string
  readonly year: number
}

export interface Benchmark {
  readonly path: string
  readonly jurisdiction: 'BE'
  readonly source: BenchmarkSource
  readonly equivalence: Equivalence
  /** Present only when somebody transcribed the euro figures — see the schema. */
  readonly referenceHousehold: ReferenceHousehold | null
  /** In the file's order, which is the source table's order. */
  readonly groups: readonly BenchmarkGroupEntry[]
  /** `'04'` → `'housing'`, for every division the file covers. */
  readonly groupByDivision: ReadonlyMap<string, BenchmarkGroup>
}

/**
 * Reads and validates the benchmark file.
 *
 * Throws `BenchmarkError` for every failure including a missing file, and names the path
 * in all of them. Callers that can do without a comparison use `benchmarkOrNull`.
 */
export function loadBenchmark(path: string = config.BENCHMARK_PATH): Benchmark {
  const read = readYamlFile(path, benchmarkFileSchema, 'household benchmark')
  if (read.kind === 'absent') {
    throw new BenchmarkError(
      `there is no household benchmark file at ${path}; Balancr ships one at ` +
        `config/statbel-benchmark.yaml — point BENCHMARK_PATH at it, or at your own copy`,
    )
  }
  if (read.kind === 'problem') throw new BenchmarkError(read.message)

  const file = read.value
  const groupByDivision = new Map<string, BenchmarkGroup>()
  for (const group of file.groups) {
    for (const division of group.coicop) groupByDivision.set(division, group.id)
  }

  return {
    path,
    jurisdiction: file.jurisdiction,
    source: file.source,
    equivalence: file.equivalence,
    referenceHousehold: file.reference_household ?? null,
    groups: file.groups,
    groupByDivision,
  }
}

/**
 * The benchmark, or `null`.
 *
 * A missing file is silent: no comparison is a supported state and logging it every
 * fifteen minutes would train the reader to ignore the log. A file that exists and cannot
 * be read is logged as an error, because somebody edited it and wants to know.
 */
export function benchmarkOrNull(path: string = config.BENCHMARK_PATH): Benchmark | null {
  try {
    return loadBenchmark(path)
  } catch (error) {
    if (error instanceof BenchmarkError && error.message.startsWith('there is no ')) return null
    log.error(
      { path, err: error instanceof Error ? error.message : String(error) },
      'the household benchmark could not be read; comparisons will be omitted until it is fixed',
    )
    return null
  }
}

/**
 * The group a COICOP code belongs to, or null.
 *
 * Null covers three different things on purpose — not a code, a code the file does not
 * cover, and the reserved `00` — because every one of them means the same thing to a
 * comparison: this category is not part of it. The caller distinguishes `00` itself,
 * since only that one is an exclusion rather than a gap.
 */
export function groupOf(benchmark: Benchmark, code: string): BenchmarkGroup | null {
  const division = divisionOf(code)
  if (division === null) return null
  return benchmark.groupByDivision.get(division) ?? null
}

/**
 * Which of the file's claims nobody has checked at the source.
 *
 * Returned as a list of block names rather than a boolean, because they are separate
 * claims by separate publishers: a confirmed Statbel table alongside a transcribed
 * equivalence scale is a normal state, and the caveat on screen should say which half is
 * unconfirmed rather than casting doubt on both.
 */
export function transcribedBlocks(benchmark: Benchmark): readonly BenchmarkBlock[] {
  const blocks: BenchmarkBlock[] = []
  if (benchmark.source.status === 'transcribed') blocks.push('source')
  if (benchmark.equivalence.status === 'transcribed') blocks.push('equivalence')
  if (benchmark.referenceHousehold?.status === 'transcribed') blocks.push('reference_household')
  return blocks
}

/** How stale the oldest verification in the file is, in whole days. */
export function oldestVerification(benchmark: Benchmark, asOf: Date = new Date()): number {
  const dates = [benchmark.source.last_verified, benchmark.equivalence.last_verified]
  if (benchmark.referenceHousehold !== null) {
    dates.push(benchmark.referenceHousehold.last_verified)
  }
  return Math.max(...dates.map((date) => ageInDays(date, asOf)))
}
