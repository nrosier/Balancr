/**
 * The risk profile is the only place in the app where a preference becomes a number,
 * so the tests here are mostly about refusals.
 *
 * A set of bands whose targets do not add up to 100%, or whose minimums add up to more
 * than the portfolio, produces suggestions that contradict each other for ever: buy
 * more of four things, with money that does not exist. Refusing those at the point of
 * saving is the only place it can be done, because everything downstream takes the
 * bands as given.
 *
 * The second thing tested is the relationship between a preset's name and its numbers.
 * Editing a band has to make the profile `custom` — a portfolio measured against
 * somebody's own floors while the page calls it "balanced" is the kind of quiet lie
 * that makes the whole page untrustworthy.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import {
  BAND_CLASSES,
  DEFAULT_PROFILE,
  PROFILE_KEY,
  PROFILE_PRESETS,
  bandsOf,
  bandsProblem,
  isPreset,
  loadProfile,
  riskProfileSchema,
  saveProfile,
  type Bands,
} from '../../src/domain/advice/profile.ts'
import { settings } from '../../src/db/schema.ts'

let ctx: ReturnType<typeof createTestDb>

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
})

/** A set of bands that satisfies every rule, as a base for breaking one at a time. */
function bands(overrides: Partial<Bands> = {}): Bands {
  return { ...PROFILE_PRESETS.balanced, ...overrides }
}

describe('the presets', () => {
  it('are each satisfiable', () => {
    for (const [name, preset] of Object.entries(PROFILE_PRESETS)) {
      expect(bandsProblem(preset), name).toBeNull()
    }
  })

  it('give every band class a band, so no drift line can be missing a target', () => {
    for (const [name, preset] of Object.entries(PROFILE_PRESETS)) {
      for (const key of BAND_CLASSES) expect(preset[key], `${name}.${key}`).toBeDefined()
    }
  })

  it('order the equity target defensive < balanced < growth', () => {
    expect(PROFILE_PRESETS.defensive.EQUITY.targetBp).toBeLessThan(
      PROFILE_PRESETS.balanced.EQUITY.targetBp,
    )
    expect(PROFILE_PRESETS.balanced.EQUITY.targetBp).toBeLessThan(
      PROFILE_PRESETS.growth.EQUITY.targetBp,
    )
  })
})

describe('bandsProblem', () => {
  it('accepts bands that add up', () => {
    expect(bandsProblem(bands())).toBeNull()
  })

  it('refuses targets that do not add up to 100%, naming the total', () => {
    const off = bands({ EQUITY: { minBp: 5_500, targetBp: 6_000, maxBp: 7_500 } })
    expect(bandsProblem(off)).toBe('targets add up to 95.00% instead of 100%')
  })

  it('refuses a band whose minimum sits above its target, naming the class', () => {
    // Reachable only from a stored row: the schema catches this per band. `bandsProblem`
    // is still total, because the row can outlive the version that wrote it.
    const inverted = { ...bands(), EQUITY: { minBp: 7_000, targetBp: 6_500, maxBp: 7_500 } }
    expect(bandsProblem(inverted)).toBe(
      'EQUITY has a minimum of 70.00%, above its target of 65.00%',
    )
  })

  it('refuses a band whose target sits above its maximum', () => {
    const inverted = { ...bands(), COMMODITY: { minBp: 0, targetBp: 1_000, maxBp: 500 } }
    expect(bandsProblem(inverted)).toBe(
      'COMMODITY has a target of 10.00%, above its maximum of 5.00%',
    )
  })

  it('does not also refuse feasibility, which the two checks already imply', () => {
    // Every ceiling at its target: the shares add up to exactly 100% with no room to
    // spare, which is a legitimate set of bands (a fixed allocation) and not an error.
    const exact = {
      EQUITY: { minBp: 6_500, targetBp: 6_500, maxBp: 6_500 },
      FIXED_INCOME: { minBp: 3_000, targetBp: 3_000, maxBp: 3_000 },
      REAL_ESTATE: { minBp: 500, targetBp: 500, maxBp: 500 },
      COMMODITY: { minBp: 0, targetBp: 0, maxBp: 0 },
    }
    expect(bandsProblem(exact)).toBeNull()
  })
})

describe('riskProfileSchema', () => {
  it('defaults to balanced with a tolerance and a trade floor', () => {
    expect(DEFAULT_PROFILE).toEqual({
      profile: 'balanced',
      toleranceBp: 100,
      minTradeCents: 50_000,
    })
  })

  it('accepts an entirely absent value, so a first run needs no row', () => {
    expect(riskProfileSchema.parse(undefined)).toEqual(DEFAULT_PROFILE)
  })

  it('refuses a band whose target sits outside its own edges', () => {
    const inverted = bands({ EQUITY: { minBp: 7_000, targetBp: 6_500, maxBp: 7_500 } })
    const parsed = riskProfileSchema.safeParse({ profile: 'custom', bands: inverted })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues.some((i) => i.message.includes('minBp ≤ targetBp ≤ maxBp'))).toBe(
      true,
    )
  })

  it('refuses a custom profile with no bands of its own', () => {
    const parsed = riskProfileSchema.safeParse({ profile: 'custom' })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toBe('a custom profile has to state its own bands')
  })

  it('refuses unsatisfiable bands even under a preset name', () => {
    const parsed = riskProfileSchema.safeParse({
      profile: 'growth',
      bands: bands({ COMMODITY: { minBp: 0, targetBp: 100, maxBp: 1_000 } }),
    })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toContain('101.00% instead of 100%')
  })

  it('refuses an unknown key rather than dropping it', () => {
    expect(riskProfileSchema.safeParse({ profile: 'balanced', rebalance: true }).success).toBe(
      false,
    )
  })

  it('refuses a tolerance wide enough to swallow a whole band', () => {
    expect(riskProfileSchema.safeParse({ toleranceBp: 5_000 }).success).toBe(false)
  })
})

describe('bandsOf and isPreset', () => {
  it('returns the preset numbers when nothing is stored', () => {
    expect(bandsOf(riskProfileSchema.parse({ profile: 'defensive' }))).toEqual(
      PROFILE_PRESETS.defensive,
    )
  })

  it('lets stored bands win over the name they are labelled with', () => {
    const edited = bands({
      EQUITY: { minBp: 6_000, targetBp: 7_000, maxBp: 8_000 },
      FIXED_INCOME: { minBp: 1_500, targetBp: 2_500, maxBp: 4_000 },
    })
    const profile = riskProfileSchema.parse({ profile: 'balanced', bands: edited })
    expect(bandsOf(profile)).toEqual(edited)
    expect(isPreset(profile)).toBe(false)
  })

  it('still calls a preset a preset when the stored bands match it exactly', () => {
    const profile = riskProfileSchema.parse({ profile: 'growth', bands: PROFILE_PRESETS.growth })
    expect(isPreset(profile)).toBe(true)
  })

  it('never calls a custom profile a preset, even when the numbers coincide', () => {
    const profile = riskProfileSchema.parse({ profile: 'custom', bands: PROFILE_PRESETS.balanced })
    expect(isPreset(profile)).toBe(false)
  })
})

describe('loadProfile', () => {
  it('returns the default when there is no row', () => {
    expect(loadProfile(ctx.db)).toEqual(DEFAULT_PROFILE)
  })

  it('degrades to the default rather than throwing on a row that is not JSON', () => {
    ctx.db.insert(settings).values({ key: PROFILE_KEY, valueJson: 'balanced' }).run()
    expect(loadProfile(ctx.db)).toEqual(DEFAULT_PROFILE)
  })

  it('degrades to the default on bands that no longer parse', () => {
    // The shape a future version could leave behind, or a hand-edited row: the nightly
    // job has to keep running against `balanced` rather than go dark.
    ctx.db
      .insert(settings)
      .values({ key: PROFILE_KEY, valueJson: JSON.stringify({ profile: 'custom' }) })
      .run()
    expect(loadProfile(ctx.db)).toEqual(DEFAULT_PROFILE)
  })
})

describe('saveProfile', () => {
  it('stores a preset by name, with no bands of its own', () => {
    const saved = saveProfile(ctx.db, { profile: 'growth' })
    expect(saved.profile).toBe('growth')
    expect(saved.bands).toBeUndefined()
    expect(bandsOf(loadProfile(ctx.db))).toEqual(PROFILE_PRESETS.growth)
  })

  it('keeps the tolerance when only the profile changes', () => {
    saveProfile(ctx.db, { toleranceBp: 250, minTradeCents: 100_000 })
    const saved = saveProfile(ctx.db, { profile: 'defensive' })
    expect(saved).toEqual({ profile: 'defensive', toleranceBp: 250, minTradeCents: 100_000 })
  })

  it('calls the profile custom the moment somebody edits the bands', () => {
    saveProfile(ctx.db, { profile: 'growth' })
    const edited = bands({
      EQUITY: { minBp: 6_000, targetBp: 7_000, maxBp: 8_000 },
      FIXED_INCOME: { minBp: 1_500, targetBp: 2_500, maxBp: 4_000 },
    })
    const saved = saveProfile(ctx.db, { bands: edited })
    expect(saved.profile).toBe('custom')
    expect(saved.bands).toEqual(edited)
  })

  it('drops edited bands again when a preset is chosen', () => {
    saveProfile(ctx.db, {
      bands: bands({
        EQUITY: { minBp: 6_000, targetBp: 7_000, maxBp: 8_000 },
        FIXED_INCOME: { minBp: 1_500, targetBp: 2_500, maxBp: 4_000 },
      }),
    })
    const saved = saveProfile(ctx.db, { profile: 'balanced' })
    expect(saved.bands).toBeUndefined()
    // Not merely absent from the return value: gone from the row, so a later read of a
    // preset cannot resurrect somebody's old floors.
    const row = ctx.db.select({ valueJson: settings.valueJson }).from(settings).get()
    expect(row?.valueJson).not.toContain('7000')
    expect(bandsOf(loadProfile(ctx.db))).toEqual(PROFILE_PRESETS.balanced)
  })

  it('throws rather than storing bands that contradict each other', () => {
    expect(() =>
      saveProfile(ctx.db, {
        bands: bands({ EQUITY: { minBp: 5_500, targetBp: 6_000, maxBp: 7_500 } }),
      }),
    ).toThrow()
    expect(loadProfile(ctx.db)).toEqual(DEFAULT_PROFILE)
  })

  it('round-trips through the row rather than through memory', () => {
    const saved = saveProfile(ctx.db, { profile: 'custom', bands: PROFILE_PRESETS.defensive })
    expect(loadProfile(ctx.db)).toEqual(saved)
  })
})
