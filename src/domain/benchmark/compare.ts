/**
 * Your month against what Belgian households spend (#43).
 *
 * One pure function, and most of it is about the comparisons it refuses to draw. A
 * benchmark is the easiest number on this site to make convincingly wrong: every input is
 * plausible, the arithmetic is a division, and the output looks equally authoritative
 * whether or not the categories it summed actually mean what the reference line means. So
 * the rules are:
 *
 *  - **Only mapped spending is compared, and the rest is disclosed.** A category with no
 *    COICOP code is left out of both sides and named on screen with its share, the way
 *    `driftReport` names an unmapped asset class. Quietly dropping it would shrink every
 *    group's figure by an unknown amount.
 *  - **Below `MIN_MAPPED_BP` of mapped spending, there is no comparison at all.** With a
 *    third of the money unaccounted for, "housing is 40% above the reference" is a
 *    statement about the mapping, not about housing. `too_unmapped` says so, and the
 *    settings screen is where it gets fixed.
 *  - **Savings, taxes and transfers are excluded rather than unmapped.** They are not
 *    household consumption and the reference shares do not cover them (see
 *    `OUTSIDE_CONSUMPTION`). Counting them as unmapped would suppress the whole
 *    comparison for anybody who saves seriously, which is exactly the wrong direction.
 *  - **Unavailability is a reason, never an empty result.** Four enumerated reasons, the
 *    way `suggestionSchema.unavailable` enumerates its two: "no comparison" and "no
 *    comparison because nothing is mapped yet" need different actions from the reader.
 *
 * **The two bases, and why the file decides which.** A `mix` comparison asks how your
 * spending is *divided* — each group's share of your mapped spend against the published
 * share — and needs no euro total and no household size, so it always works. A `level`
 * comparison asks what a comparable household *spends*, in euros, and needs the average
 * household's monthly total and its size on the equivalence scale; both live in the
 * survey's spreadsheet rather than on its summary page, so the shipped file leaves them
 * out and this falls back to `mix`. The basis travels on the wire because the two answer
 * different questions and a card that did not say which is which would be inviting the
 * reader to draw the stronger conclusion from the weaker comparison.
 *
 * Pure: rows in, comparison out. The month's facts and the category mapping arrive as
 * arguments, so the two callers — the nightly signals job and `GET /api/budget` — cannot
 * disagree about what the comparison says.
 */
import { equivalentAdults, type EquivalentAdults, type Household } from './household.ts'
import { groupOf, transcribedBlocks, type Benchmark } from './model.ts'
import {
  isOutsideConsumption,
  MIN_MAPPED_BP,
  type BenchmarkBlock,
  type BenchmarkGroup,
} from './vocabulary.ts'

/** Why there is no comparison. Enumerated, because each one needs a different action. */
export const BENCHMARK_UNAVAILABLE = ['no_file', 'no_month', 'no_mapping', 'too_unmapped'] as const
export type BenchmarkUnavailable = (typeof BENCHMARK_UNAVAILABLE)[number]

/** What the comparison is measuring — see the module comment. */
export const BENCHMARK_BASES = ['mix', 'level'] as const
export type BenchmarkBasis = (typeof BENCHMARK_BASES)[number]

/**
 * One month of one category's spending, as both callers already have it.
 *
 * Structural and minimal, so `MonthlyFact` satisfies it without this module importing
 * anything from `aggregate/` — which would be a cycle the moment `overspend.ts` produces
 * benchmark signals.
 */
export interface SpendRow {
  readonly categoryId: string
  readonly categoryName: string
  readonly spentCents: number
  readonly isIncome: boolean
  readonly hidden: boolean
}

/** One group's line: what you spent, what the reference says, and the gap. */
export interface GroupComparison {
  readonly group: BenchmarkGroup
  readonly yourCents: number
  /** Your share of compared spending, in basis points. */
  readonly yourShareBp: number
  /** The published share, from the file. */
  readonly referenceShareBp: number
  /** The reference in euros on this comparison's basis. */
  readonly benchmarkCents: number
  /** Signed difference against the reference. Null when the reference is zero. */
  readonly deltaBp: number | null
  readonly deltaCents: number
  /** How many of your categories are mapped here — a mapping that reads as a total. */
  readonly categories: number
}

/** A category that could not be compared, and how much of the month it is. */
export interface UnmappedCategory {
  readonly categoryId: string
  readonly categoryName: string
  readonly spentCents: number
  readonly shareBp: number
}

export interface BenchmarkSourceWire {
  readonly survey: string
  readonly year: number
  readonly citation: string
  readonly sourceUrl: string | null
  readonly lastVerified: string
  readonly status: 'confirmed' | 'transcribed'
}

export interface Comparison {
  readonly kind: 'ok'
  readonly month: string
  readonly basis: BenchmarkBasis
  readonly groups: readonly GroupComparison[]
  /** Mapped spending — the total both sides of every group line are shares of. */
  readonly comparedCents: number
  /** Mapped plus unmapped: everything that is household consumption. */
  readonly consumptionCents: number
  /** Savings, taxes, transfers — excluded by mapping, not by omission. */
  readonly outsideCents: number
  readonly mappedShareBp: number
  readonly unmapped: readonly UnmappedCategory[]
  /** Your household on the scale, and whether custody proration was involved. */
  readonly household: EquivalentAdults
  /** The average household on the same scale. Null unless the file carries one. */
  readonly referenceHouseholdBp: number | null
  readonly source: BenchmarkSourceWire
  /** Which of the file's blocks nobody has confirmed at the source. */
  readonly transcribed: readonly BenchmarkBlock[]
}

export interface Unavailable {
  readonly kind: 'unavailable'
  readonly reason: BenchmarkUnavailable
  /** How much of the month is mapped, when that is the problem. */
  readonly mappedShareBp: number | null
}

export type BenchmarkComparison = Comparison | Unavailable

export interface CompareInput {
  /** Null when no benchmark file is configured — `no_file`, not an error. */
  readonly benchmark: Benchmark | null
  readonly household: Household
  /** `yyyy-mm`. Its year is what the equivalence scale ages the household at. */
  readonly month: string
  readonly rows: readonly SpendRow[]
  /** `categoryId` → the stored COICOP code, or null. */
  readonly coicop: ReadonlyMap<string, string | null>
}

const unavailable = (
  reason: BenchmarkUnavailable,
  mappedShareBp: number | null = null,
): Unavailable => ({ kind: 'unavailable', reason, mappedShareBp })

/** Basis points of a whole, or 0 when there is no whole to be a share of. */
function shareBp(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.round((part / whole) * 10_000)
}

/**
 * Your month, compared.
 *
 * Income and hidden categories are left out — the reference is expenditure, and a hidden
 * envelope is one somebody has already decided not to look at. Net refunds are floored at
 * zero rather than subtracted: a category that came out negative this month is not
 * evidence about what households spend on it, and letting it reduce a group would make
 * one refund look like thrift across the whole line.
 */
export function compareToBenchmark(input: CompareInput): BenchmarkComparison {
  const { benchmark, household, month, rows, coicop } = input
  if (benchmark === null) return unavailable('no_file')

  const totals = new Map<BenchmarkGroup, { cents: number; categories: number }>()
  const unmappedRows: { categoryId: string; categoryName: string; spentCents: number }[] = []
  let comparedCents = 0
  let unmappedCents = 0
  let outsideCents = 0

  for (const row of rows) {
    if (row.isIncome || row.hidden) continue
    const spentCents = Math.max(0, row.spentCents)
    if (spentCents === 0) continue

    const code = coicop.get(row.categoryId) ?? null
    if (code !== null && isOutsideConsumption(code)) {
      outsideCents += spentCents
      continue
    }

    const group = code === null ? null : groupOf(benchmark, code)
    if (group === null) {
      unmappedCents += spentCents
      unmappedRows.push({
        categoryId: row.categoryId,
        categoryName: row.categoryName,
        spentCents,
      })
      continue
    }

    const running = totals.get(group) ?? { cents: 0, categories: 0 }
    totals.set(group, { cents: running.cents + spentCents, categories: running.categories + 1 })
    comparedCents += spentCents
  }

  const consumptionCents = comparedCents + unmappedCents
  // Nothing spent on consumption at all. Not the same as an unmapped month: there is
  // nothing here to map, and telling somebody to go and map their categories would send
  // them to a screen that would not help.
  if (consumptionCents <= 0) return unavailable('no_month')
  if (comparedCents <= 0) return unavailable('no_mapping', 0)

  const mappedShareBp = shareBp(comparedCents, consumptionCents)
  if (mappedShareBp < MIN_MAPPED_BP) return unavailable('too_unmapped', mappedShareBp)

  const year = Number(month.slice(0, 4))
  const scaled = equivalentAdults(household, benchmark.equivalence, year)
  const reference = benchmark.referenceHousehold

  // The level basis needs both of the reference household's numbers *and* a scale figure
  // to divide by. The schema already requires the pair, so what is left to guard is a
  // reference size of zero, which would divide by nothing.
  const level = reference !== null && reference.equivalent_adults_bp > 0
  const basis: BenchmarkBasis = level ? 'level' : 'mix'
  const levelTotalCents =
    reference === null
      ? 0
      : Math.round((reference.mean_monthly_cents * scaled.bp) / reference.equivalent_adults_bp)

  const groups = benchmark.groups.map((entry): GroupComparison => {
    const mine = totals.get(entry.id) ?? { cents: 0, categories: 0 }
    const benchmarkCents = Math.round(
      ((level ? levelTotalCents : comparedCents) * entry.share_bp) / 10_000,
    )
    const deltaCents = mine.cents - benchmarkCents
    return {
      group: entry.id,
      yourCents: mine.cents,
      yourShareBp: shareBp(mine.cents, comparedCents),
      referenceShareBp: entry.share_bp,
      benchmarkCents,
      // Null rather than a large number: a reference of zero makes every euro spent an
      // infinite overshoot, and "∞% above the Belgian reference of € 0,00" is not a
      // sentence worth rendering.
      deltaBp: benchmarkCents <= 0 ? null : Math.round((deltaCents / benchmarkCents) * 10_000),
      deltaCents,
      categories: mine.categories,
    }
  })

  return {
    kind: 'ok',
    month,
    basis,
    groups,
    comparedCents,
    consumptionCents,
    outsideCents,
    mappedShareBp,
    // Largest first: the one worth mapping next is the one at the top.
    unmapped: unmappedRows
      .sort((a, b) => b.spentCents - a.spentCents)
      .map((row) => ({ ...row, shareBp: shareBp(row.spentCents, consumptionCents) })),
    household: scaled,
    referenceHouseholdBp: reference?.equivalent_adults_bp ?? null,
    source: {
      survey: benchmark.source.survey,
      year: benchmark.source.year,
      citation: benchmark.source.citation,
      sourceUrl: benchmark.source.source_url ?? null,
      lastVerified: benchmark.source.last_verified,
      status: benchmark.source.status,
    },
    transcribed: transcribedBlocks(benchmark),
  }
}
