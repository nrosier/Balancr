/**
 * The Belgian benchmark (#43): the comparison, the scale, and the two things a person
 * supplies.
 *
 * The comparison is the easiest number in Balancr to make convincingly wrong — every
 * input is plausible, the arithmetic is a division, and the output looks equally
 * authoritative whether or not the categories it summed mean what the reference line
 * means. So most of what is asserted here is the comparisons `compareToBenchmark`
 * *refuses* to draw, and the exclusions that keep the two sides of each division talking
 * about the same money:
 *
 *  - Income, hidden envelopes and refunds are out, each for a different reason.
 *  - `00` is excluded rather than counted as unmapped, at any depth of code.
 *  - Below `MIN_MAPPED_BP` there is no comparison at all, only a reason.
 *  - The household is aged at the year of the month being compared, not at today.
 *
 * The realistic cases run against the shipped `config/statbel-benchmark.yaml`, so a
 * transposed digit in it fails here rather than on a page. The two shapes that file
 * deliberately does not have — a group the survey puts nothing in, and a transcribed
 * reference household — are built by hand, which is also what proves those branches are
 * reachable at all.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { categoryMeta, monthlyCategoryFacts, settings } from '../../src/db/schema.ts'
import {
  compareToBenchmark,
  type BenchmarkComparison,
  type Comparison,
  type SpendRow,
} from '../../src/domain/benchmark/compare.ts'
import {
  DEFAULT_HOUSEHOLD,
  equivalentAdults,
  householdSchema,
  HOUSEHOLD_KEY,
  loadHousehold,
  saveHousehold,
  type Household,
} from '../../src/domain/benchmark/household.ts'
import {
  loadMapping,
  MappingError,
  saveCoicop,
} from '../../src/domain/benchmark/mapping.ts'
import { loadBenchmark, type Benchmark } from '../../src/domain/benchmark/model.ts'
import type { Equivalence } from '../../src/domain/benchmark/schema.ts'
import { MAX_HOUSEHOLD_MEMBERS } from '../../src/domain/benchmark/vocabulary.ts'

/** The file Balancr ships, read from disk. Every realistic case below compares to this. */
const SHIPPED = loadBenchmark('config/statbel-benchmark.yaml')

const HOUSEHOLD = (members: Household['members'] = []): Household => ({
  members,
  sharedCostBp: null,
})

/** One category's month. Consumption unless a test says otherwise. */
function row(overrides: Partial<SpendRow> & { categoryId: string }): SpendRow {
  return {
    categoryName: overrides.categoryId,
    spentCents: 10_000,
    isIncome: false,
    hidden: false,
    ...overrides,
  }
}

function compare(
  rows: readonly SpendRow[],
  coicop: Record<string, string | null>,
  options: { benchmark?: Benchmark | null; household?: Household; month?: string } = {},
): BenchmarkComparison {
  return compareToBenchmark({
    benchmark: options.benchmark === undefined ? SHIPPED : options.benchmark,
    household: options.household ?? DEFAULT_HOUSEHOLD,
    month: options.month ?? '2026-08',
    rows,
    coicop: new Map(Object.entries(coicop)),
  })
}

/** The `ok` branch, or a failure that names what came back instead. */
function ok(result: BenchmarkComparison): Comparison {
  if (result.kind !== 'ok') throw new Error(`unavailable: ${result.reason}`)
  return result
}

const line = (result: Comparison, group: string) =>
  result.groups.find((entry) => entry.group === group)

describe('the shipped benchmark file', () => {
  it('loads, and covers every division exactly once', () => {
    // The schema enforces all of this; what this asserts is that the file Balancr
    // actually ships satisfies it, which no amount of schema testing can.
    expect(SHIPPED.groups).toHaveLength(10)
    expect(SHIPPED.groups.reduce((sum, group) => sum + group.share_bp, 0)).toBe(10_000)
    expect(SHIPPED.groupByDivision.size).toBe(12)
    expect(SHIPPED.groupByDivision.get('04')).toBe('housing')
    // The residual line genuinely is three divisions, which is why the picker offers
    // divisions and not groups.
    expect(SHIPPED.groupByDivision.get('08')).toBe('other')
    expect(SHIPPED.groupByDivision.get('10')).toBe('other')
    expect(SHIPPED.groupByDivision.get('12')).toBe('other')
    // Ships without the euro figures, which is why `mix` is the basis anybody gets.
    expect(SHIPPED.referenceHousehold).toBeNull()
  })
})

describe('compareToBenchmark: the comparisons it refuses', () => {
  it('reports no file rather than an error when none is configured', () => {
    const result = compare([row({ categoryId: 'c1' })], { c1: '01' }, { benchmark: null })
    expect(result).toEqual({ kind: 'unavailable', reason: 'no_file', mappedShareBp: null })
  })

  it('reports no month when nothing was spent on consumption', () => {
    // Income, a hidden envelope and an untouched category. Not an unmapped month —
    // there is nothing here to map, and sending somebody to the mapping screen would
    // send them somewhere that cannot help.
    const result = compare(
      [
        row({ categoryId: 'salary', isIncome: true, spentCents: 300_000 }),
        row({ categoryId: 'secret', hidden: true, spentCents: 50_000 }),
        row({ categoryId: 'unused', spentCents: 0 }),
      ],
      { salary: null, secret: '01', unused: '01' },
    )
    expect(result).toEqual({ kind: 'unavailable', reason: 'no_month', mappedShareBp: null })
  })

  it('reports no month for a month that went entirely to savings', () => {
    // Everything mapped to `00`: real money, none of it household consumption, so there
    // is no denominator and no share to compare. The reason has to be `no_month` rather
    // than `no_mapping`, because every category here *is* mapped.
    const result = compare([row({ categoryId: 'invest', spentCents: 200_000 })], { invest: '00' })
    expect(result).toEqual({ kind: 'unavailable', reason: 'no_month', mappedShareBp: null })
  })

  it('reports nothing mapped when spending exists and no code does', () => {
    const result = compare(
      [row({ categoryId: 'c1', spentCents: 80_000 }), row({ categoryId: 'c2' })],
      { c1: null },
    )
    expect(result).toEqual({ kind: 'unavailable', reason: 'no_mapping', mappedShareBp: 0 })
  })

  it('refuses a comparison below the mapped floor, and says how far below', () => {
    // 120000 of 185000 is 64,86% — under the 70% floor. "Housing is 40% above the
    // reference" on two thirds of the money is a statement about the mapping.
    const result = compare(
      [
        row({ categoryId: 'rent', spentCents: 120_000 }),
        row({ categoryId: 'groceries', spentCents: 65_000 }),
      ],
      { rent: '04', groceries: null },
    )
    expect(result).toEqual({ kind: 'unavailable', reason: 'too_unmapped', mappedShareBp: 6_486 })
  })

  it('draws the comparison once enough is mapped', () => {
    // The same month with the groceries mapped: 100% mapped, and nothing refused.
    const result = ok(
      compare(
        [
          row({ categoryId: 'rent', spentCents: 120_000 }),
          row({ categoryId: 'groceries', spentCents: 65_000 }),
        ],
        { rent: '04', groceries: '01' },
      ),
    )
    expect(result.mappedShareBp).toBe(10_000)
    expect(result.comparedCents).toBe(185_000)
  })
})

describe('compareToBenchmark: what counts and what does not', () => {
  const ROWS = [
    row({ categoryId: 'salary', categoryName: 'Salary', isIncome: true, spentCents: 420_000 }),
    row({ categoryId: 'rent', categoryName: 'Rent', spentCents: 120_000 }),
    row({ categoryId: 'groceries', categoryName: 'Groceries', spentCents: 65_000 }),
    row({ categoryId: 'pension', categoryName: 'Pension', spentCents: 30_000 }),
    row({ categoryId: 'therapy', categoryName: 'Therapy', hidden: true, spentCents: 12_000 }),
    row({ categoryId: 'refund', categoryName: 'Returns', spentCents: -8_000 }),
  ]
  const CODES = {
    salary: null,
    rent: '04.1',
    groceries: '01',
    pension: '00',
    therapy: '06',
    refund: '03',
  }

  it('compares only mapped consumption, and discloses the rest', () => {
    const result = ok(compare(ROWS, CODES))

    // 120000 + 65000. Income is out because the reference is expenditure; the hidden
    // envelope because somebody already decided not to look at it; the refund because a
    // negative month is not evidence about what households spend.
    expect(result.comparedCents).toBe(185_000)
    expect(result.consumptionCents).toBe(185_000)
    // Savings are excluded rather than unmapped: counting them as unmapped would
    // suppress the whole comparison for anybody who saves seriously.
    expect(result.outsideCents).toBe(30_000)
    expect(result.unmapped).toEqual([])
    expect(result.basis).toBe('mix')
  })

  it('reads a deep code as its division, on both sides of the exclusion', () => {
    // `04.1` is housing and `00.1` is still outside consumption. A proposal may write
    // either, so both readers have to agree with `divisionOf`.
    const deep = ok(compare(ROWS, { ...CODES, pension: '00.1.1' }))
    expect(deep.outsideCents).toBe(30_000)
    expect(line(deep, 'housing')?.yourCents).toBe(120_000)
  })

  it('states each line as a share of compared spending, with the published share beside it', () => {
    const result = ok(compare(ROWS, CODES))

    // Literal, because these are the figures a page prints: 65000/185000 against the
    // survey's 14,00%, and 185000 × 14,00% as the reference in euros.
    expect(line(result, 'food')).toEqual({
      group: 'food',
      yourCents: 65_000,
      yourShareBp: 3_514,
      referenceShareBp: 1_400,
      benchmarkCents: 25_900,
      deltaBp: 15_097,
      deltaCents: 39_100,
      categories: 1,
    })
    expect(line(result, 'housing')).toEqual({
      group: 'housing',
      yourCents: 120_000,
      yourShareBp: 6_486,
      referenceShareBp: 3_060,
      benchmarkCents: 56_610,
      deltaBp: 11_198,
      deltaCents: 63_390,
      categories: 1,
    })
    // The reference lines add up to the compared total, so the mix comparison is a
    // division of the same money on both sides.
    expect(result.groups.reduce((sum, group) => sum + group.benchmarkCents, 0)).toBe(185_000)
  })

  it('distinguishes a group nothing maps to from a group nothing was spent on', () => {
    const result = ok(compare(ROWS, CODES))
    // `categories: 0` is what the card turns into "nothing mapped" rather than "you
    // spend nothing on health", which are opposite conclusions.
    expect(line(result, 'health')?.categories).toBe(0)
    expect(line(result, 'health')?.yourCents).toBe(0)
    expect(line(result, 'health')?.deltaBp).toBe(-10_000)

    // The hidden Therapy envelope is mapped to health and still does not feed it.
    expect(result.groups.reduce((sum, group) => sum + group.categories, 0)).toBe(2)
  })

  it('counts every category that feeds a line, so the mapping reads as a total', () => {
    const result = ok(
      compare(
        [
          row({ categoryId: 'rent', spentCents: 100_000 }),
          row({ categoryId: 'water', spentCents: 6_000 }),
          row({ categoryId: 'energy', spentCents: 14_000 }),
        ],
        { rent: '04.1', water: '04.4', energy: '04.5' },
      ),
    )
    expect(line(result, 'housing')).toMatchObject({
      yourCents: 120_000,
      categories: 3,
      yourShareBp: 10_000,
    })
  })

  it('names what it left out, largest first, against all of consumption', () => {
    const result = ok(
      compare(
        [
          row({ categoryId: 'rent', categoryName: 'Rent', spentCents: 120_000 }),
          row({ categoryId: 'gifts', categoryName: 'Gifts', spentCents: 20_000 }),
          row({ categoryId: 'pets', categoryName: 'Pets', spentCents: 30_000 }),
        ],
        { rent: '04', gifts: null, pets: null },
      ),
    )
    // Shares of consumption, not of compared spending: the reader is being told how much
    // of their month the comparison could not see.
    expect(result.unmapped).toEqual([
      { categoryId: 'pets', categoryName: 'Pets', spentCents: 30_000, shareBp: 1_765 },
      { categoryId: 'gifts', categoryName: 'Gifts', spentCents: 20_000, shareBp: 1_176 },
    ])
    expect(result.mappedShareBp).toBe(7_059)
  })

  it('leaves a refunded category out of the unmapped list too', () => {
    // Flooring at zero happens before the mapping question, so a month that came out
    // negative does not appear on the "go and map this" list either — there is nothing
    // to map it for.
    const result = ok(
      compare(
        [
          row({ categoryId: 'rent', spentCents: 120_000 }),
          row({ categoryId: 'refund', spentCents: -8_000 }),
        ],
        { rent: '04', refund: null },
      ),
    )
    expect(result.unmapped).toEqual([])
    expect(result.consumptionCents).toBe(120_000)
  })

  it('carries the provenance of the file it compared against', () => {
    const result = ok(compare(ROWS, CODES))
    expect(result.source).toEqual({
      survey: SHIPPED.source.survey,
      year: SHIPPED.source.year,
      citation: SHIPPED.source.citation,
      sourceUrl: SHIPPED.source.source_url ?? null,
      lastVerified: SHIPPED.source.last_verified,
      status: SHIPPED.source.status,
    })
    // Both blocks of the shipped file are transcribed, and the card says which.
    expect(result.transcribed).toEqual(['source', 'equivalence'])
    expect(result.referenceHouseholdBp).toBeNull()
  })
})

describe('compareToBenchmark: the two bases', () => {
  const EQUIVALENCE: Equivalence = SHIPPED.equivalence

  /** A two-line benchmark, for the shapes the shipped file deliberately does not have. */
  function synthetic(options: {
    shares: [number, number]
    referenceHousehold?: Benchmark['referenceHousehold']
  }): Benchmark {
    return {
      path: 'test',
      jurisdiction: 'BE',
      source: SHIPPED.source,
      equivalence: EQUIVALENCE,
      referenceHousehold: options.referenceHousehold ?? null,
      groups: [
        { id: 'food', share_bp: options.shares[0], coicop: ['01'] },
        { id: 'health', share_bp: options.shares[1], coicop: ['06'] },
      ],
      groupByDivision: new Map([
        ['01', 'food'],
        ['06', 'health'],
      ]),
    }
  }

  it('refuses a percentage against a reference of nothing', () => {
    // A group the survey puts no money in makes every euro an infinite overshoot, and
    // "∞% above the Belgian reference of € 0,00" is not a sentence worth rendering.
    const result = ok(
      compare(
        [row({ categoryId: 'meds', spentCents: 50_000 })],
        { meds: '06' },
        { benchmark: synthetic({ shares: [10_000, 0] }) },
      ),
    )
    expect(line(result, 'health')).toMatchObject({
      benchmarkCents: 0,
      deltaBp: null,
      deltaCents: 50_000,
    })
  })

  it('compares euros against euros once the reference household is transcribed', () => {
    // The average household spends 300000 at 2,3 on the scale. A single parent with a
    // half-time thirteen-year-old is 1,15, which is exactly half — so the reference for
    // this household is 150000, and food's 60% of it is 90000.
    const benchmark = synthetic({
      shares: [6_000, 4_000],
      referenceHousehold: {
        mean_monthly_cents: 300_000,
        equivalent_adults_bp: 23_000,
        citation: 'the survey spreadsheet',
        last_verified: '2026-09-03',
        status: 'transcribed',
      },
    })
    const result = ok(
      compare(
        [
          row({ categoryId: 'groceries', spentCents: 80_000 }),
          row({ categoryId: 'meds', spentCents: 20_000 }),
        ],
        { groceries: '01', meds: '06' },
        { benchmark, household: HOUSEHOLD([{ birthYear: 2013, custodyBp: 5_000 }]) },
      ),
    )

    expect(result.basis).toBe('level')
    expect(result.household.bp).toBe(11_500)
    expect(result.referenceHouseholdBp).toBe(23_000)
    // The euro reference is the scaled household's, not this month's spending — which is
    // the whole difference between the two bases.
    expect(line(result, 'food')?.benchmarkCents).toBe(90_000)
    expect(line(result, 'health')?.benchmarkCents).toBe(60_000)
    // Shares still divide the month, so the two halves of the card answer different
    // questions on purpose.
    expect(line(result, 'food')?.yourShareBp).toBe(8_000)
    expect(result.transcribed).toEqual(['source', 'equivalence', 'reference_household'])
  })

  it('falls back to the mix when the reference household has no size', () => {
    // Both figures are required by the schema, so what is left to guard is a size of
    // zero — which would divide by nothing.
    const benchmark = synthetic({
      shares: [6_000, 4_000],
      referenceHousehold: {
        mean_monthly_cents: 300_000,
        equivalent_adults_bp: 0,
        citation: 'a file somebody edited by hand',
        last_verified: '2026-09-03',
        status: 'confirmed',
      },
    })
    const result = ok(
      compare([row({ categoryId: 'groceries', spentCents: 80_000 })], { groceries: '01' }, { benchmark }),
    )
    expect(result.basis).toBe('mix')
    expect(line(result, 'food')?.benchmarkCents).toBe(48_000)
  })
})

describe('equivalentAdults', () => {
  const SCALE = SHIPPED.equivalence

  it('is one adult when nobody else is here', () => {
    expect(equivalentAdults(DEFAULT_HOUSEHOLD, SCALE, 2026)).toEqual({
      bp: 10_000,
      prorated: false,
      children: 0,
      members: 0,
    })
  })

  it('ages the same roster at the year being compared', () => {
    // Born 2012, so thirteen in the January being compared and fourteen in the next.
    // The scale moves them from 0,3 to 0,5 on that birthday, and a comparison of last
    // year has to use last year's weight — which is why this takes a year and not a
    // `Date`.
    const household = HOUSEHOLD([{ birthYear: 2012, custodyBp: 10_000 }])
    expect(equivalentAdults(household, SCALE, 2025)).toEqual({
      bp: 13_000,
      prorated: false,
      children: 1,
      members: 1,
    })
    expect(equivalentAdults(household, SCALE, 2026)).toEqual({
      bp: 15_000,
      prorated: false,
      children: 0,
      members: 1,
    })
  })

  it('prorates a part-time member and says that it did', () => {
    // 1,00 + 0,3 × 0,5. The scale has no notion of part-time membership at all, so the
    // flag is what lets every screen say the proration is Balancr's assumption.
    const result = equivalentAdults(
      HOUSEHOLD([{ birthYear: 2013, custodyBp: 5_000 }]),
      SCALE,
      2026,
    )
    expect(result).toEqual({ bp: 11_500, prorated: true, children: 1, members: 1 })
  })

  it('counts a member who is never here as a member, at no weight', () => {
    // Zero is a legitimate answer — a child who lives with the other parent and whose
    // costs are still worth tracking — and it is still an assumption to disclose.
    const result = equivalentAdults(HOUSEHOLD([{ birthYear: 2013, custodyBp: 0 }]), SCALE, 2026)
    expect(result).toEqual({ bp: 10_000, prorated: true, children: 1, members: 1 })
  })

  it('rounds each member rather than the total', () => {
    // 0,5 × 33,33% is 1666,5 basis points, which rounds to 1667 twice rather than to
    // 3333 once. The figure on screen has to add up to the figure used, and a basis
    // point of disagreement between them is the kind of thing that costs an afternoon.
    const result = equivalentAdults(
      HOUSEHOLD([
        { birthYear: 1990, custodyBp: 3_333 },
        { birthYear: 1991, custodyBp: 3_333 },
      ]),
      SCALE,
      2026,
    )
    expect(result.bp).toBe(13_334)
    expect(result.members).toBe(2)
  })

  it('does not read the first person a name at all (#215)', () => {
    // The whole point of a name rather than a row: nothing about the weight logic may
    // notice this field, so the same household with and without it scores identically.
    const named = HOUSEHOLD([{ birthYear: 2013, custodyBp: 5_000 }])
    named.selfLabel = 'Nick'
    expect(equivalentAdults(named, SCALE, 2026)).toEqual(
      equivalentAdults(HOUSEHOLD([{ birthYear: 2013, custodyBp: 5_000 }]), SCALE, 2026),
    )
  })
})

describe('householdSchema', () => {
  it('defaults to one person, which cannot be wrong about anybody', () => {
    // And to a null shared-cost share, which is not zero: null means "work it out from
    // the roster", and zero would be a stated claim that none of a shared cost is yours
    // (#44).
    expect(DEFAULT_HOUSEHOLD).toEqual({ members: [], sharedCostBp: null })
    expect(householdSchema.parse(undefined)).toEqual({ members: [], sharedCostBp: null })
  })

  it('treats a member as full time unless told otherwise', () => {
    expect(householdSchema.parse({ members: [{ birthYear: 2013 }] })).toEqual({
      members: [{ birthYear: 2013, custodyBp: 10_000 }],
      sharedCostBp: null,
    })
  })

  it('refuses a year that cannot be one, and a share over the whole', () => {
    expect(householdSchema.safeParse({ members: [{ birthYear: 26 }] }).success).toBe(false)
    expect(
      householdSchema.safeParse({ members: [{ birthYear: 2013, custodyBp: 10_001 }] }).success,
    ).toBe(false)
  })

  it('refuses an unknown field rather than dropping it', () => {
    // Strict, so a renamed field fails loudly instead of silently reverting to full
    // custody on the next save.
    expect(
      householdSchema.safeParse({ members: [{ birthYear: 2013, custody: 50 }] }).success,
    ).toBe(false)
  })

  it('caps the roster at the same number the form stops offering', () => {
    const members = Array.from({ length: MAX_HOUSEHOLD_MEMBERS + 1 }, () => ({
      birthYear: 2000,
    }))
    expect(householdSchema.safeParse({ members }).success).toBe(false)
  })

  it('accepts a name for the first person, trimmed like a member label (#215)', () => {
    expect(householdSchema.parse({ members: [], selfLabel: '  Nick  ' })).toEqual({
      members: [],
      selfLabel: 'Nick',
      sharedCostBp: null,
    })
  })

  it('refuses a name longer than a member label may be', () => {
    expect(householdSchema.safeParse({ members: [], selfLabel: 'x'.repeat(41) }).success).toBe(
      false,
    )
  })
})

describe('the stored household', () => {
  let ctx: ReturnType<typeof createTestDb>

  beforeEach(() => {
    ctx = createTestDb()
    applyMigrations(ctx.db as never)
  })

  const write = (valueJson: string): void => {
    ctx.db.insert(settings).values({ key: HOUSEHOLD_KEY, valueJson }).run()
  }

  it('is one person until somebody says otherwise', () => {
    expect(loadHousehold(ctx.db)).toEqual(DEFAULT_HOUSEHOLD)
  })

  it('round-trips a roster and the share that travels with it', () => {
    saveHousehold(ctx.db, {
      members: [{ birthYear: 2013, custodyBp: 5_000, label: 'Teenager' }],
      sharedCostBp: 6_000,
    })
    expect(loadHousehold(ctx.db)).toEqual({
      members: [{ birthYear: 2013, custodyBp: 5_000, label: 'Teenager' }],
      sharedCostBp: 6_000,
    })
  })

  it('round-trips a name for the first person, and drops it when the patch omits it (#215)', () => {
    saveHousehold(ctx.db, { members: [], selfLabel: '  Nick  ' })
    expect(loadHousehold(ctx.db).selfLabel).toBe('Nick')

    // Wholesale, like every other field here: a patch that says nothing about the name
    // clears it, the same direction `sharedCostBp` already takes for the same reason.
    saveHousehold(ctx.db, { members: [] })
    expect(loadHousehold(ctx.db).selfLabel).toBeUndefined()
  })

  it('is replaced whole, so a row can be removed', () => {
    saveHousehold(ctx.db, {
      members: [{ birthYear: 2013 }, { birthYear: 2016 }],
    })
    saveHousehold(ctx.db, { members: [{ birthYear: 2013 }] })
    expect(loadHousehold(ctx.db).members).toHaveLength(1)
  })

  it('degrades to one person rather than throwing, for either kind of damage', () => {
    // Reading degrades and writing throws, the same contract `loadProfile` has: a
    // roster nobody can parse should cost the level comparison, not the budget page.
    write('{ not json')
    expect(loadHousehold(ctx.db)).toEqual(DEFAULT_HOUSEHOLD)

    ctx.db.delete(settings).run()
    write(JSON.stringify({ members: [{ birthYear: 'last year' }] }))
    expect(loadHousehold(ctx.db)).toEqual(DEFAULT_HOUSEHOLD)
  })

  it('refuses to store what it could not read back', () => {
    expect(() => saveHousehold(ctx.db, { members: [{ birthYear: 12 }] })).toThrow()
  })
})

describe('the COICOP mapping', () => {
  let ctx: ReturnType<typeof createTestDb>

  beforeEach(() => {
    ctx = createTestDb()
    applyMigrations(ctx.db as never)
  })

  interface Row {
    id: string
    name: string
    coicop?: string | null
    isIncome?: boolean
    hidden?: boolean
    spentCents?: number
  }

  function seed(rows: Row[], month = '2026-08'): void {
    for (const entry of rows) {
      ctx.db
        .insert(categoryMeta)
        .values({
          categoryId: entry.id,
          nameSnapshot: entry.name,
          isIncome: entry.isIncome ?? false,
          hidden: entry.hidden ?? false,
          coicopCode: entry.coicop ?? null,
        })
        .run()
      if (entry.spentCents === undefined) continue
      ctx.db
        .insert(monthlyCategoryFacts)
        .values({ month, categoryId: entry.id, spentCents: entry.spentCents, txnCount: 1 })
        .run()
    }
  }

  it('puts the envelope distorting the comparison most on the first line', () => {
    seed([
      { id: 'salary', name: 'Salary', isIncome: true, spentCents: 420_000 },
      { id: 'rent', name: 'Rent', coicop: '04', spentCents: 120_000 },
      { id: 'groceries', name: 'Groceries', spentCents: 65_000 },
      { id: 'transport', name: 'Transport', spentCents: 90_000 },
      { id: 'old', name: 'Old habit', hidden: true, spentCents: 5_000 },
    ])

    // Unmapped and spending first, largest first; then mapped; then income and hidden,
    // because the comparison skips both and asking about them changes nothing.
    expect(loadMapping(ctx.db, '2026-08').map((row) => row.categoryId)).toEqual([
      'transport',
      'groceries',
      'rent',
      'salary',
      'old',
    ])
  })

  it('falls back to names when no month has been computed', () => {
    seed([
      { id: 'b', name: 'Bikes', spentCents: 10_000 },
      { id: 'a', name: 'Ants', spentCents: 90_000 },
    ])
    const rows = loadMapping(ctx.db, null)
    expect(rows.map((row) => row.categoryName)).toEqual(['Ants', 'Bikes'])
    // No month, so no figure to show: a zero here is "not computed", and the panel
    // prints it as the euro figure it is rather than inventing one.
    expect(rows.every((row) => row.spentCents === 0)).toBe(true)
  })

  it('reports the stored code as stored, however deep it is', () => {
    // The form writes divisions; a proposal may have written `04.5.1`, and the settings
    // panel is the one place that has to cope with the difference.
    seed([{ id: 'energy', name: 'Energy', coicop: '04.5.1', spentCents: 8_000 }])
    expect(loadMapping(ctx.db, '2026-08')[0]?.coicop).toBe('04.5.1')
  })

  it('writes a division, and takes one back', () => {
    seed([{ id: 'groceries', name: 'Groceries' }])
    saveCoicop(ctx.db, 'groceries', '01')
    expect(loadMapping(ctx.db, null)[0]?.coicop).toBe('01')

    // Null is a value here and nowhere else: correcting your own mistake is what this
    // route exists for.
    saveCoicop(ctx.db, 'groceries', null)
    expect(loadMapping(ctx.db, null)[0]?.coicop).toBeNull()
  })

  it('refuses to invent a category', () => {
    // `category_meta` rows come from what Actual actually has. One conjured here would
    // sit in the mapping table for ever with nothing to tell it from a real one.
    expect(() => saveCoicop(ctx.db, 'ghost', '01')).toThrow(MappingError)
  })
})
