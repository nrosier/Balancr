/**
 * How long a class has been outside its band (#183).
 *
 * Every case here is a way the count could be a *plausible wrong number* rather than
 * nothing, which is the only failure that matters for a figure whose whole purpose is to
 * distinguish "markets moved" from "nobody rebalanced":
 *
 *  - a month nobody snapshotted, counted through as if it had been inside the band;
 *  - a month whose invested/cash split was never recorded, whose every class would
 *    measure at 0% and therefore below its floor;
 *  - a class that overshot from below its floor to above its ceiling, counted as three
 *    months of one problem when it is two months of opposite ones;
 *  - a band widened this morning, still reported against the shares of last year;
 *  - a fresh install with one snapshot, reading as reassuring because one month outside a
 *    band sounds like nothing.
 *
 * The figures beside the count are not tested here, and deliberately: they are the live
 * `DriftReport`'s and `advice-drift.test.ts` owns them. What is tested is that they are
 * passed through rather than recomputed.
 */
import { describe, expect, it } from 'vitest'
import { driftPersistence, driftSignals, type AllocationMonth } from '../../src/domain/advice/persistence.ts'
import { driftReport, type AllocationInput } from '../../src/domain/advice/drift.ts'
import { PROFILE_PRESETS, type Bands } from '../../src/domain/advice/profile.ts'
import { DEFAULT_PARAMS, aggregateParamsSchema } from '../../src/domain/aggregate/params.ts'

const BANDS: Bands = PROFILE_PRESETS.balanced
const INVESTED = 1_000_000

/** An allocation from class → share in basis points, valued against `INVESTED`. */
function allocation(shares: Record<string, number>): AllocationInput[] {
  return Object.entries(shares).map(([key, shareBp]) => ({
    key,
    shareBp,
    valueCents: Math.round((INVESTED * shareBp) / 10_000),
  }))
}

/** A month-end observation. `invested: 0` is "the split was never recorded". */
function month(
  m: string,
  shares: Record<string, number>,
  invested: number = INVESTED,
): AllocationMonth {
  return { month: m, allocation: allocation(shares), investedValueCents: invested }
}

/** Equities over their 75% ceiling, bonds under their 20% floor. */
const DRIFTED = { EQUITY: 8_500, FIXED_INCOME: 1_500 }
/** Both inside the balanced preset. */
const SETTLED = { EQUITY: 7_000, FIXED_INCOME: 3_000 }
/** Equities under their 55% floor — the opposite side of the same band. */
const UNDERWEIGHT = { EQUITY: 4_000, FIXED_INCOME: 6_000 }

function persistence(history: AllocationMonth[], live: Record<string, number> = DRIFTED) {
  return driftPersistence({
    drift: driftReport(allocation(live), BANDS, INVESTED),
    history,
    bands: BANDS,
    profile: 'balanced',
    isPreset: true,
  })
}

const lineFor = (
  result: ReturnType<typeof persistence>,
  assetClass: string,
): { monthsOutside: number; state: string; shareBp: number } => {
  const line = result.lines.find((entry) => entry.assetClass === assetClass)
  if (line === undefined) throw new Error(`no line for ${assetClass}`)
  return line
}

describe('driftPersistence counts a run', () => {
  it('counts consecutive month ends on the same side, ending at the newest', () => {
    const result = persistence([
      month('2026-06', DRIFTED),
      month('2026-07', DRIFTED),
      month('2026-08', DRIFTED),
    ])
    expect(lineFor(result, 'EQUITY').monthsOutside).toBe(3)
    expect(lineFor(result, 'FIXED_INCOME').monthsOutside).toBe(3)
    expect(result.monthsObserved).toBe(3)
  })

  it('stops at the first month that was inside the band', () => {
    const result = persistence([
      month('2026-06', DRIFTED),
      month('2026-07', SETTLED),
      month('2026-08', DRIFTED),
    ])
    // Not three: the middle month is the household having been inside its own band,
    // and a run that counts through it describes a drift that never happened.
    expect(lineFor(result, 'EQUITY').monthsOutside).toBe(1)
  })

  it('is 0 for a class inside its band, not 1', () => {
    // 0 rather than 1, so a caller filtering on a threshold does not also have to
    // special-case the state — "inside its band" is not a duration.
    const result = persistence([month('2026-08', SETTLED)], SETTLED)
    expect(lineFor(result, 'EQUITY').monthsOutside).toBe(0)
    expect(lineFor(result, 'EQUITY').state).toBe('inside')
  })

  it('reports the window rather than inventing history beyond it', () => {
    // Six months of the same drift, three observations loaded. Three is the honest
    // answer to the question that was asked; four would be a number from nowhere.
    const result = persistence([
      month('2026-06', DRIFTED),
      month('2026-07', DRIFTED),
      month('2026-08', DRIFTED),
    ])
    expect(lineFor(result, 'EQUITY').monthsOutside).toBe(3)
  })

  it('does not count a run through the opposite edge of the same band', () => {
    // Below its floor in June, above its ceiling in August. That is not three months of
    // one problem; it is an overshoot, and calling it persistence describes the opposite
    // of what happened.
    const result = persistence([
      month('2026-06', UNDERWEIGHT),
      month('2026-07', DRIFTED),
      month('2026-08', DRIFTED),
    ])
    expect(lineFor(result, 'EQUITY').monthsOutside).toBe(2)
  })
})

describe('a month nobody can measure ends the run', () => {
  it('does not count through a month whose invested value was never recorded', () => {
    // A backfilled instance: the newest two months have a split, the one before does not.
    // Counting through it would turn a run of two into a run of three — every class
    // measures at 0% against a missing denominator, and 0% is below every floor.
    const result = persistence([
      month('2026-06', DRIFTED),
      month('2026-07', DRIFTED, 0),
      month('2026-08', DRIFTED),
    ])
    expect(lineFor(result, 'EQUITY').monthsOutside).toBe(1)
    // And the months behind the hole are not counted as observed either: what is being
    // reported is how far back the reading goes, which is what makes it the ceiling.
    expect(result.monthsObserved).toBe(1)
  })

  it('does not count through a month with no observation at all', () => {
    // July absent rather than unmeasurable — nobody snapshotted, so there is no row. This
    // is the case a length check misses entirely, because two entries either side of a
    // hole look exactly like two consecutive months.
    const result = persistence([month('2026-06', DRIFTED), month('2026-08', DRIFTED)])
    expect(lineFor(result, 'EQUITY').monthsOutside).toBe(1)
    expect(result.monthsObserved).toBe(1)
  })

  it('reads a run back from the newest observation, not from today', () => {
    // Ghostfolio last synced in June and it is September. Three consecutive readings are
    // still three readings; requiring the newest to be the current month would report a
    // stale instance as never having drifted at all.
    const result = persistence([
      month('2026-04', DRIFTED),
      month('2026-05', DRIFTED),
      month('2026-06', DRIFTED),
    ])
    expect(lineFor(result, 'EQUITY').monthsOutside).toBe(3)
  })

  it('reports one month, not zero, for a drift with no history at all', () => {
    const result = persistence([])
    expect(lineFor(result, 'EQUITY').monthsOutside).toBe(1)
    // The number that stops "one month outside" reading as reassuring: there was only
    // ever one month to look at.
    expect(result.monthsObserved).toBe(0)
  })
})

describe('the live report is the authority on today', () => {
  it('passes its figures through rather than recomputing them from the newest month', () => {
    // The history says 85%, the live report says 78%. The live report wins, because it is
    // the figure the portfolio page is showing — see `latestDriftPersistence`.
    const result = persistence([month('2026-08', DRIFTED)], { EQUITY: 7_800, FIXED_INCOME: 2_200 })
    expect(lineFor(result, 'EQUITY').shareBp).toBe(7_800)
  })

  it('reports one month when a band widened since the newest snapshot', () => {
    // The snapshot was outside; the live report, measured against bands edited this
    // morning, is inside. Today wins, and the run is gone — which is right: the household
    // has just said that share is acceptable.
    const result = persistence([month('2026-08', DRIFTED)], SETTLED)
    expect(lineFor(result, 'EQUITY').state).toBe('inside')
    expect(lineFor(result, 'EQUITY').monthsOutside).toBe(0)
  })

  it('reports at least one month for a drift the newest snapshot does not show', () => {
    // The reverse case: bands narrowed this morning, so today is outside and no
    // observation agrees. Zero would say "not outside at all", which contradicts the line
    // it sits on.
    const result = persistence([month('2026-08', SETTLED)], DRIFTED)
    expect(lineFor(result, 'EQUITY').monthsOutside).toBe(1)
  })

  it('carries the profile through, so a screen can say what the bands are', () => {
    const result = persistence([month('2026-08', DRIFTED)])
    expect(result.profile).toBe('balanced')
    expect(result.isPreset).toBe(true)
  })
})

describe('driftSignals', () => {
  const params = (persistentMonths: number) =>
    aggregateParamsSchema.parse({ drift: { persistentMonths } })

  it('says nothing until the run reaches the threshold', () => {
    const two = persistence([month('2026-07', DRIFTED), month('2026-08', DRIFTED)])
    expect(driftSignals(two, params(3))).toEqual([])
    expect(driftSignals(two, params(2)).map((s) => s.code)).toEqual([
      'drift_above_band',
      'drift_below_band',
    ])
  })

  it('names the edge in the code, so neither renderer needs a direction variable', () => {
    const result = persistence(
      [month('2026-06', UNDERWEIGHT), month('2026-07', UNDERWEIGHT), month('2026-08', UNDERWEIGHT)],
      UNDERWEIGHT,
    )
    const codes = driftSignals(result, params(3)).map((signal) => signal.code)
    // Equities below their floor, bonds above their ceiling: opposite codes, same month.
    expect(codes).toContain('drift_below_band')
    expect(codes).toContain('drift_above_band')
  })

  it('carries the class in the name field and no category id', () => {
    const signals = driftSignals(
      persistence([month('2026-06', DRIFTED), month('2026-07', DRIFTED), month('2026-08', DRIFTED)]),
      params(3),
    )
    const equity = signals.find((signal) => signal.code === 'drift_above_band')
    expect(equity?.categoryId).toBeNull()
    // A fixed id, translated on the way to a screen — never text anybody typed.
    expect(equity?.categoryName).toBe('EQUITY')
  })

  it('is capped at warn: a band is the household’s own number, and no money is lost', () => {
    const signals = driftSignals(
      persistence([month('2026-06', DRIFTED), month('2026-07', DRIFTED), month('2026-08', DRIFTED)]),
      params(3),
    )
    expect(signals.every((signal) => signal.severity === 'warn')).toBe(true)
  })

  it('supplies the metrics its sentence needs, plus a Cents key for ranking', () => {
    const signals = driftSignals(
      persistence([month('2026-06', DRIFTED), month('2026-07', DRIFTED), month('2026-08', DRIFTED)]),
      params(3),
    )
    const equity = signals.find((signal) => signal.code === 'drift_above_band')
    expect(equity?.metrics.monthsOutside).toBe(3)
    expect(equity?.metrics.shareBp).toBe(8_500)
    expect(equity?.metrics.maxBp).toBe(7_500)
    // `sortSignals` ranks by the largest absolute value among keys ending in `Cents`,
    // so without this two drifts would be ordered by asset-class name.
    expect(equity?.metrics.gapCents).toBeDefined()
  })

  it('says nothing at all when there is no portfolio to measure', () => {
    expect(driftSignals(null, DEFAULT_PARAMS)).toEqual([])
  })

  it('says nothing about a class that is inside its band', () => {
    const result = persistence(
      [month('2026-06', SETTLED), month('2026-07', SETTLED), month('2026-08', SETTLED)],
      SETTLED,
    )
    expect(driftSignals(result, params(3))).toEqual([])
  })
})

describe('the default threshold', () => {
  it('is three months, and cannot be set to one', () => {
    expect(DEFAULT_PARAMS.drift.persistentMonths).toBe(3)
    // One month would repeat, less precisely, what the portfolio page already shows —
    // for a share a fortnight of markets can move on its own.
    expect(aggregateParamsSchema.safeParse({ drift: { persistentMonths: 1 } }).success).toBe(false)
  })
})
