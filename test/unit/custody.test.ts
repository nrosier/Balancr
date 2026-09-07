/**
 * The custody-aware split (#44, #289): what a shared cost costs you, beside what you paid.
 *
 * Three things here are load-bearing beyond the arithmetic, and each is about a figure
 * that is easy to make quietly wrong:
 *
 *  - **Actual's number is never adjusted.** `paidCents` on every line and on the total is
 *    the month's own figure, and everything else is an addition. A test that only checked
 *    the halves would pass on an implementation that silently halved the budget.
 *  - **The rows add up to the total under them.** Rounding per line and rounding once are
 *    a cent or two apart on a real month, and the cent is what costs somebody an evening
 *    with a calculator.
 *  - **The direction is not a label on the same numbers.** `whole_invoice` multiplies down
 *    to your part; `my_share` divides up to a total your account never held. Reading the
 *    same stored share the wrong way applies it twice, so the two directions are asserted
 *    against the same inputs and expected to disagree.
 *
 * The rest is the refusals: no month, nothing flagged, a roster the share cannot be
 * derived from, and a stated 0% there is nothing to divide by. Four different answers,
 * because the card draws nothing for two of them and says a different thing for each of
 * the other two.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { categoryMeta, settings } from '../../src/db/schema.ts'
import {
  custodyShare,
  custodySignals,
  splitCustody,
  type CustodySplit,
} from '../../src/domain/aggregate/custody.ts'
import { custodyContext, splitMonth } from '../../src/domain/aggregate/custody-context.ts'
import { DEFAULT_PARAMS } from '../../src/domain/aggregate/params.ts'
import type { MonthlyFact } from '../../src/domain/aggregate/spend.ts'
import {
  DEFAULT_HOUSEHOLD,
  HOUSEHOLD_KEY,
  type Household,
} from '../../src/domain/benchmark/household.ts'

const MONTH = '2026-08'

function fact(id: string, spentCents: number, overrides: Partial<MonthlyFact> = {}): MonthlyFact {
  return {
    month: MONTH,
    categoryId: id,
    categoryName: id,
    isIncome: false,
    hidden: false,
    spentCents,
    budgetedCents: spentCents,
    availableCents: 0,
    carryoverEnabled: false,
    txnCount: 1,
    recomputedSpentCents: spentCents,
    committedCents: 0,
    committedToDateCents: 0,
    committedApproximate: false,
    baseline: null,
    ...overrides,
  }
}

const household = (overrides: Partial<Household> = {}): Household => ({
  members: [],
  sharedCostBp: null,
  // The stored default, and the direction every case below is in unless it says otherwise:
  // it is what the feature modelled before #289, so it is the reading these tests were
  // written against and the one a regression would have to break to be noticed.
  sharedCostDirection: 'whole_invoice',
  ...overrides,
})

/** A roster with one half-time child, which is the case the feature exists for. */
const HALF_TIME = household({ members: [{ birthYear: 2013, custodyBp: 5_000 }] })

/** The same household reading the same share the other way round (#289). */
const GROSSED_UP = household({ ...HALF_TIME, sharedCostDirection: 'my_share' })

function split(
  rows: readonly MonthlyFact[],
  shared: string[],
  who: Household = HALF_TIME,
): CustodySplit {
  return splitCustody({ month: MONTH, rows, shared: new Set(shared), household: who })
}

/** Narrows for the assertions, so a wrong `kind` fails as itself and not as `undefined`. */
function ok(result: CustodySplit): Extract<CustodySplit, { kind: 'ok' }> {
  if (result.kind !== 'ok') throw new Error(`expected a split, got ${result.reason}`)
  return result
}

describe('the share and where it came from', () => {
  it('averages the part-time members when nobody has stated a split', () => {
    expect(
      custodyShare(
        household({
          members: [
            { birthYear: 2013, custodyBp: 5_000 },
            { birthYear: 2016, custodyBp: 3_000 },
          ],
        }),
      ),
    ).toEqual({ basis: 'roster', shareBp: 4_000, members: 2 })
  })

  it('ignores full-time members, who are not who a shared cost is about', () => {
    // A live-in partner averaged in would pull the share towards 100% and make the
    // whole feature do nothing but print Actual's figure twice.
    expect(
      custodyShare(
        household({
          members: [
            { birthYear: 1985, custodyBp: 10_000 },
            { birthYear: 2013, custodyBp: 5_000 },
          ],
        }),
      ),
    ).toEqual({ basis: 'roster', shareBp: 5_000, members: 1 })
  })

  it('prefers a stated split over the roster, and says it was stated', () => {
    // 50% of the time, 60% of the costs: the two are negotiated separately, which is
    // exactly why `sharedCostBp` exists rather than being derived from `custodyBp`.
    expect(custodyShare(household({ ...HALF_TIME, sharedCostBp: 6_000 }))).toEqual({
      basis: 'stated',
      shareBp: 6_000,
      members: 0,
    })
  })

  it('has no basis at all for a household of one', () => {
    expect(custodyShare(DEFAULT_HOUSEHOLD)).toBeNull()
  })

  it('takes a stated zero as a share and not as an absence', () => {
    // "None of it is mine" is a real arrangement, and `?? null` on a falsy number is the
    // bug this pins: it would fall back to deriving and print half.
    expect(custodyShare(household({ sharedCostBp: 0 }))).toEqual({
      basis: 'stated',
      shareBp: 0,
      members: 0,
    })
  })
})

describe('splitting a month', () => {
  it('reports what was paid and what is yours, and never adjusts what was paid', () => {
    const result = ok(
      split(
        [fact('school', 40_000), fact('rent', 100_000), fact('clothes', 12_000)],
        ['school', 'clothes'],
      ),
    )

    expect(result.paidCents).toBe(52_000)
    expect(result.direction).toBe('whole_invoice')
    // The whole invoice landed here, so the total is Actual's own figure and the split is
    // inside it: nothing is grossed up and nothing is inferred.
    expect(result.totalCents).toBe(52_000)
    expect(result.yoursCents).toBe(26_000)
    expect(result.otherCents).toBe(26_000)
    // € 520 of € 1.520 spent in the month.
    expect(result.shareOfSpendBp).toBe(3_421)
    expect(result.basis).toBe('roster')
    expect(result.shareBp).toBe(5_000)
    expect(result.members).toBe(1)
    expect(
      result.lines.map((line) => [
        line.categoryId,
        line.paidCents,
        line.yoursCents,
        line.otherCents,
      ]),
    ).toEqual([
      ['school', 40_000, 20_000, 20_000],
      ['clothes', 12_000, 6_000, 6_000],
    ])
  })

  it('rounds per line, so the rows add up to the total printed under them', () => {
    // Three lines that each round up at a third: rounded once at the end the total is
    // 3.334 and the rows say 3.335.
    const result = ok(split([fact('a', 3_333), fact('b', 3_333), fact('c', 3_333)], ['a', 'b', 'c']))
    expect(result.lines.map((line) => line.yoursCents)).toEqual([1_667, 1_667, 1_667])
    expect(result.yoursCents).toBe(5_001)
    expect(result.yoursCents).toBe(result.lines.reduce((sum, line) => sum + line.yoursCents, 0))
    expect(result.paidCents - result.yoursCents).toBe(result.otherCents)
  })

  it('lists the largest paid first, and breaks a tie by name', () => {
    const result = ok(
      split(
        [fact('zoo', 5_000), fact('books', 5_000), fact('camp', 30_000)],
        ['zoo', 'books', 'camp'],
      ),
    )
    expect(result.lines.map((line) => line.categoryId)).toEqual(['camp', 'books', 'zoo'])
  })

  it('leaves out income, hidden envelopes and a flagged month with no spending', () => {
    // Each for the reason it is excluded everywhere else: shared income is not a cost,
    // a hidden envelope is one somebody asked not to see, and a zero row would bury the
    // rows that are what the arrangement actually cost.
    const result = ok(
      split(
        [
          fact('maintenance', 60_000, { isIncome: true }),
          fact('old', 20_000, { hidden: true }),
          fact('dormant', 0),
          fact('school', 40_000),
          fact('rent', 100_000),
        ],
        ['maintenance', 'old', 'dormant', 'school'],
      ),
    )
    expect(result.lines.map((line) => line.categoryId)).toEqual(['school'])
    expect(result.paidCents).toBe(40_000)
    // The month's own spend excludes the income and the hidden row too, or the share of
    // spend would be measured against money the budget page does not show either.
    expect(result.shareOfSpendBp).toBe(2_857)
  })

  it('says no_month when nothing was spent at all', () => {
    expect(split([], ['school'])).toEqual({ kind: 'unavailable', reason: 'no_month', paidCents: null })
    expect(split([fact('school', 0)], ['school'])).toEqual({
      kind: 'unavailable',
      reason: 'no_month',
      paidCents: null,
    })
  })

  it('says no_shared when nothing is flagged, without a figure', () => {
    // The ordinary state of most budgets, and the card draws nothing: there is no
    // number to withhold, so `paidCents` stays null rather than reporting the month.
    expect(split([fact('rent', 100_000)], [])).toEqual({
      kind: 'unavailable',
      reason: 'no_shared',
      paidCents: null,
    })
  })

  it('says no_basis with the unsplit total when the roster cannot imply a share', () => {
    // Somebody flagged the categories, so they meant this to work — which is why this
    // reason carries the figure and is the only one the card explains.
    expect(split([fact('school', 40_000)], ['school'], DEFAULT_HOUSEHOLD)).toEqual({
      kind: 'unavailable',
      reason: 'no_basis',
      paidCents: 40_000,
    })
  })

  it('says zero_share, not no_basis, when a grossed-up share is a stated nought', () => {
    // A stated 0% is a share, not an absence — `custodyShare` has its own test for that.
    // Dividing by it is what has no answer, so the reason names the share rather than
    // telling somebody who typed a number that nothing says what their share is (#289).
    expect(
      split(
        [fact('school', 40_000)],
        ['school'],
        household({ sharedCostBp: 0, sharedCostDirection: 'my_share' }),
      ),
    ).toEqual({ kind: 'unavailable', reason: 'zero_share', paidCents: 40_000 })
  })

  it('still splits a stated nought the other way round, where nothing divides', () => {
    // `whole_invoice` multiplies, so 0% is a legitimate "none of this is mine" and the
    // whole paid figure belongs to the other household.
    const result = ok(split([fact('school', 40_000)], ['school'], household({ sharedCostBp: 0 })))
    expect(result.yoursCents).toBe(0)
    expect(result.otherCents).toBe(40_000)
  })

  it('splits nothing off when the stated share is the whole cost', () => {
    const result = ok(split([fact('school', 40_000)], ['school'], household({ sharedCostBp: 10_000 })))
    expect(result.yoursCents).toBe(40_000)
    expect(result.otherCents).toBe(0)
    expect(result.basis).toBe('stated')
  })
})

describe('the other direction: what landed here is already only my share (#289)', () => {
  it('works the total back up out of the share, and leaves what was paid alone', () => {
    // € 400 paid at a 50% share is € 800 in total, of which € 400 was settled by the other
    // household directly and never touched this account. The same input read the other way
    // says € 200 is yours and € 200 is owed to you — both columns different, which is why
    // the direction is stored rather than guessed.
    const result = ok(split([fact('school', 40_000)], ['school'], GROSSED_UP))
    expect(result.direction).toBe('my_share')
    expect(result.paidCents).toBe(40_000)
    expect(result.totalCents).toBe(80_000)
    expect(result.yoursCents).toBe(40_000)
    expect(result.otherCents).toBe(40_000)
  })

  it('never inflates the share of the month, which is a fact about the account', () => {
    // The grossed-up total includes money the bank never saw, so counting it in the
    // numerator would put "how much of my spending is shared" over 100% on a 40% share.
    const result = ok(split([fact('school', 40_000), fact('rent', 60_000)], ['school'], GROSSED_UP))
    expect(result.totalCents).toBe(80_000)
    expect(result.shareOfSpendBp).toBe(4_000)
  })

  it('rounds per line here too, so the rows add up and total equals yours plus theirs', () => {
    const result = ok(
      split([fact('a', 3_333), fact('b', 3_333), fact('c', 3_333)], ['a', 'b', 'c'], GROSSED_UP),
    )
    expect(result.lines.map((line) => line.totalCents)).toEqual([6_666, 6_666, 6_666])
    expect(result.totalCents).toBe(19_998)
    expect(result.totalCents).toBe(result.lines.reduce((sum, line) => sum + line.totalCents, 0))
    for (const line of result.lines) {
      expect(line.totalCents).toBe(line.yoursCents + line.otherCents)
    }
    expect(result.totalCents).toBe(result.yoursCents + result.otherCents)
  })

  it('reports a stated 70% as your part of a larger cost, not as a discount on it', () => {
    // The bug the direction exists to prevent, in one assertion: € 700 paid at a stated
    // 70% is € 1.000 in total with € 300 settled elsewhere. Read as a whole invoice it
    // would say € 490 is yours and € 210 is owed to you — the share applied twice, and a
    // debt asserted that the other household has already paid.
    const stated = household({ sharedCostBp: 7_000, sharedCostDirection: 'my_share' })
    const result = ok(split([fact('school', 70_000)], ['school'], stated))
    expect(result.totalCents).toBe(100_000)
    expect(result.yoursCents).toBe(70_000)
    expect(result.otherCents).toBe(30_000)
  })
})

describe('the finding', () => {
  const signals = (result: CustodySplit) => custodySignals(result, DEFAULT_PARAMS)

  it('reports one info finding for the household, not one per envelope', () => {
    const result = split([fact('school', 40_000), fact('camp', 30_000)], ['school', 'camp'])
    expect(signals(result)).toEqual([
      {
        code: 'custody_offset',
        categoryId: null,
        categoryName: null,
        severity: 'info',
        metrics: {
          otherCents: 35_000,
          paidCents: 70_000,
          totalCents: 70_000,
          yoursCents: 35_000,
          shareBp: 5_000,
        },
      },
    ])
  })

  it('reports the other direction under its own code, not the same sentence reworded', () => {
    // One says money is owed to you, the other says money was never yours to be owed. A
    // single code could only carry a sentence vague enough to be true of both (#289).
    const result = split(
      [fact('school', 40_000), fact('camp', 30_000)],
      ['school', 'camp'],
      GROSSED_UP,
    )
    expect(signals(result)).toEqual([
      {
        code: 'custody_total',
        categoryId: null,
        categoryName: null,
        severity: 'info',
        metrics: {
          otherCents: 70_000,
          paidCents: 70_000,
          totalCents: 140_000,
          yoursCents: 70_000,
          shareBp: 5_000,
        },
      },
    ])
  })

  it('stays quiet under the materiality floor', () => {
    // € 20 off a shared subscription is true and not worth a line on the insights page.
    const result = split([fact('streaming', 4_000)], ['streaming'])
    expect(ok(result).otherCents).toBe(2_000)
    expect(signals(result)).toEqual([])
  })

  it('says nothing when there is no split', () => {
    expect(signals({ kind: 'unavailable', reason: 'no_basis', paidCents: 40_000 })).toEqual([])
  })
})

describe('the context, read off the database', () => {
  let ctx: ReturnType<typeof createTestDb>

  beforeEach(() => {
    ctx = createTestDb()
    applyMigrations(ctx.db as never)
  })

  const meta = (id: string, custodyShared: boolean): void => {
    ctx.db
      .insert(categoryMeta)
      .values({ categoryId: id, nameSnapshot: id, custodyShared })
      .run()
  }

  it('reads the flags and the roster, and splits a month with them', () => {
    meta('school', true)
    meta('rent', false)
    ctx.db
      .insert(settings)
      .values({
        key: HOUSEHOLD_KEY,
        valueJson: JSON.stringify({ members: [{ birthYear: 2013, custodyBp: 4_000 }] }),
      })
      .run()

    const context = custodyContext(ctx.db)
    expect([...context.shared]).toEqual(['school'])

    const result = ok(splitMonth(context, MONTH, [fact('school', 50_000), fact('rent', 100_000)]))
    expect(result.month).toBe(MONTH)
    expect(result.shareBp).toBe(4_000)
    expect(result.yoursCents).toBe(20_000)
    // Absent from the stored JSON above, so this is the schema's default arriving through
    // the loader — the guarantee that a roster saved before #289 still reads as it did.
    expect(result.direction).toBe('whole_invoice')
  })

  it('falls back to one person with no flags on an empty database', () => {
    const context = custodyContext(ctx.db)
    expect(context.shared.size).toBe(0)
    expect(context.household).toEqual(DEFAULT_HOUSEHOLD)
    expect(splitMonth(context, MONTH, [fact('rent', 100_000)])).toEqual({
      kind: 'unavailable',
      reason: 'no_shared',
      paidCents: null,
    })
  })
})
