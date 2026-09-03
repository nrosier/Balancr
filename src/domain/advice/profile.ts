/**
 * "Some risk, but not super high risk", made into numbers (#41).
 *
 * A risk profile here is not an adjective the model is told to bear in mind. It is a
 * band per asset class — a minimum, a target and a maximum share of the invested value
 * — and every suggestion this folder produces exists because a share left its band.
 * That is the whole point: an adjective cannot motivate a trade, a band can, and the
 * distance from the band is the reason the suggestion carries.
 *
 * Three decisions about how it is held:
 *
 *  - **Presets, with the numbers visible.** Three of them, because "defensive",
 *    "balanced" and "growth" is the vocabulary people already have, and because a
 *    first-run experience that demands twelve numbers gets none. The bands are shown
 *    on screen rather than hidden behind the word, so the word is a shortcut and not a
 *    black box, and `custom` is a first-class choice rather than an escape hatch.
 *  - **In the `settings` table, beside the aggregation parameters.** Same reason as
 *    `aggregate.params`: a web app cannot edit `.env`, and this is exactly the knob
 *    worth turning after looking at a chart. `loadProfile` degrades to the default on a
 *    malformed row, because a nightly job going dark over a saved typo is worse than
 *    one that runs against `balanced`.
 *  - **Bands over the *invested* value, cash excluded.** `allocationByAssetClass`
 *    already excludes cash, and a `LIQUIDITY` position at a Ghostfolio instance fed by
 *    a bank sync is a current account rather than a decision about risk. Mixing the two
 *    would make every drift figure move when a salary lands.
 *
 * What the schema refuses is as load-bearing as what it accepts. Targets that do not
 * add up to 100%, a target outside its own band, and a set of bands no allocation can
 * satisfy at all are all rejected at the point of saving — because each of them
 * produces suggestions that contradict each other, and a suggestion that cannot be
 * satisfied is worse than no advice.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../../db/index.ts'
import { settings } from '../../db/schema.ts'
import { logger } from '../../logger.ts'
import {
  BAND_CLASSES,
  PRESET_IDS,
  PROFILE_IDS,
  type BandClass,
  type PresetId,
  type ProfileId,
} from './vocabulary.ts'

const log = logger.child({ module: 'advice/profile' })

export const PROFILE_KEY = 'advice.profile'

/**
 * Re-exported so that "the risk profile" is one import on the server side.
 *
 * The arrays themselves live in `vocabulary.ts` because the browser needs them and this
 * module reaches the database; nothing else about them changed, and a server file that
 * wants both the names and the schemas should not have to know that.
 */
export { BAND_CLASSES, PRESET_IDS, PROFILE_IDS }
export type { BandClass, PresetId, ProfileId }

/** One class's band, in basis points of the invested value. */
export const bandSchema = z
  .object({
    minBp: z.number().int().min(0).max(10_000),
    targetBp: z.number().int().min(0).max(10_000),
    maxBp: z.number().int().min(0).max(10_000),
  })
  .strict()
  .refine((band) => band.minBp <= band.targetBp && band.targetBp <= band.maxBp, {
    message: 'must satisfy minBp ≤ targetBp ≤ maxBp',
  })

export type Band = z.infer<typeof bandSchema>

/** A band for every class, so a drift line can never be missing a target. */
const bandsSchema = z.object({
  EQUITY: bandSchema,
  FIXED_INCOME: bandSchema,
  REAL_ESTATE: bandSchema,
  COMMODITY: bandSchema,
})

export type Bands = z.infer<typeof bandsSchema>

/**
 * The three presets, with the numbers where they can be read.
 *
 * `balanced` is the default because it is the profile the app was asked for — some
 * risk, not the maximum — and because a default that proposes nothing until somebody
 * chooses would mean the drift figures never appear.
 *
 * The bond band is what actually separates them; the property and commodity bands stay
 * narrow and optional across all three, because a satellite that is allowed to be zero
 * never produces a suggestion to buy something the portfolio has no use for.
 */
export const PROFILE_PRESETS = {
  defensive: {
    EQUITY: { minBp: 3_000, targetBp: 4_000, maxBp: 5_000 },
    FIXED_INCOME: { minBp: 4_000, targetBp: 5_500, maxBp: 6_500 },
    REAL_ESTATE: { minBp: 0, targetBp: 500, maxBp: 1_500 },
    COMMODITY: { minBp: 0, targetBp: 0, maxBp: 1_000 },
  },
  balanced: {
    EQUITY: { minBp: 5_500, targetBp: 6_500, maxBp: 7_500 },
    FIXED_INCOME: { minBp: 2_000, targetBp: 3_000, maxBp: 4_000 },
    REAL_ESTATE: { minBp: 0, targetBp: 500, maxBp: 1_500 },
    COMMODITY: { minBp: 0, targetBp: 0, maxBp: 1_000 },
  },
  growth: {
    EQUITY: { minBp: 7_500, targetBp: 8_500, maxBp: 9_500 },
    FIXED_INCOME: { minBp: 500, targetBp: 1_000, maxBp: 2_000 },
    REAL_ESTATE: { minBp: 0, targetBp: 500, maxBp: 1_500 },
    COMMODITY: { minBp: 0, targetBp: 0, maxBp: 1_000 },
  },
} as const satisfies Record<PresetId, Bands>

/** A share as the settings page writes it, so a refusal names a number people see. */
function pct(bp: number): string {
  return `${(bp / 100).toFixed(2)}%`
}

/**
 * Whether these bands can all be satisfied at once, or the first reason they cannot.
 *
 * Total by design. The input can be a settings row written by an older version or by
 * hand, so every field is checked here rather than assumed sound from having come
 * through a schema — and the messages are the ones the settings page shows, which is
 * why each names the number that is wrong.
 *
 * Two checks are enough, and the two that are missing are worth naming. A portfolio can
 * sit inside every band only if the floors add up to no more than 100% and the ceilings
 * to at least 100% — and both of those already follow from `minBp ≤ targetBp ≤ maxBp`
 * per class plus targets summing to exactly 100%. Testing them again would add two
 * refusals that can never fire, which is worse than not having them: nobody maintains a
 * branch that never runs, and its message would be the one nobody ever proof-reads.
 */
export function bandsProblem(bands: Bands): string | null {
  for (const key of BAND_CLASSES) {
    const band = bands[key]
    if (band.minBp > band.targetBp) {
      return `${key} has a minimum of ${pct(band.minBp)}, above its target of ${pct(band.targetBp)}`
    }
    if (band.targetBp > band.maxBp) {
      return `${key} has a target of ${pct(band.targetBp)}, above its maximum of ${pct(band.maxBp)}`
    }
  }
  const targets = BAND_CLASSES.reduce((sum, key) => sum + bands[key].targetBp, 0)
  if (targets !== 10_000) return `targets add up to ${pct(targets)} instead of 100%`
  return null
}

/**
 * The stored profile: which bands, and when a drift is worth acting on.
 *
 * `bands` is only meaningful for `custom` and is where a preset's numbers land when
 * somebody edits one — the preset is then no longer what is stored, which is honest:
 * the profile in force is the numbers, and the name is a label on them.
 */
export const riskProfileSchema = z
  .object({
    profile: z.enum(PROFILE_IDS).default('balanced'),
    bands: bandsSchema.optional(),
    /**
     * How far past a band edge a share must be before it is worth a suggestion.
     *
     * Not "how far from target": the band edge is the threshold, and a share resting
     * one basis point outside it is inside the noise of a day's prices. Zero would make
     * the page produce a trade every morning.
     */
    toleranceBp: z.number().int().min(0).max(2_000).default(100),
    /**
     * The smallest correction worth trading.
     *
     * A €40 rebalance costs beurstaks twice and a spread, to move an allocation by
     * three basis points. The floor exists so the page does not suggest it.
     */
    minTradeCents: z.number().int().min(0).default(50_000),
  })
  .strict()
  .prefault({})
  .superRefine((value, ctx) => {
    if (value.profile === 'custom' && value.bands === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['bands'],
        message: 'a custom profile has to state its own bands',
      })
      return
    }
    if (value.bands === undefined) return
    const problem = bandsProblem(value.bands)
    if (problem !== null) ctx.addIssue({ code: 'custom', path: ['bands'], message: problem })
  })

export type RiskProfile = z.infer<typeof riskProfileSchema>
export type RiskProfilePatch = z.input<typeof riskProfileSchema>

export const DEFAULT_PROFILE: RiskProfile = riskProfileSchema.parse({})

/**
 * The bands in force: the stored ones when there are any, the preset's otherwise.
 *
 * Stored bands win even for a named preset, because that is what "I moved the equity
 * floor to 60%" has to mean. The name then survives as a label; `isPreset` says
 * whether the numbers still match it.
 */
export function bandsOf(profile: RiskProfile): Bands {
  if (profile.bands !== undefined) return profile.bands
  if (profile.profile === 'custom') return PROFILE_PRESETS.balanced
  return PROFILE_PRESETS[profile.profile]
}

/** Whether these bands are still exactly the preset they are named after. */
export function isPreset(profile: RiskProfile): boolean {
  if (profile.profile === 'custom') return false
  return JSON.stringify(bandsOf(profile)) === JSON.stringify(PROFILE_PRESETS[profile.profile])
}

// ---------------------------------------------------------------------------
//  Storage
// ---------------------------------------------------------------------------

/**
 * The stored profile, or the default with the reason logged.
 *
 * Same contract as `loadParams`: reading degrades, writing throws. A profile nobody
 * can parse should not take the portfolio page down, and the log names the key.
 */
export function loadProfile(db: Db): RiskProfile {
  const row = db
    .select({ valueJson: settings.valueJson })
    .from(settings)
    .where(eq(settings.key, PROFILE_KEY))
    .get()

  if (!row) return DEFAULT_PROFILE

  let raw: unknown
  try {
    raw = JSON.parse(row.valueJson)
  } catch (error) {
    log.error({ err: error, key: PROFILE_KEY }, 'the stored risk profile is not JSON; using the default')
    return DEFAULT_PROFILE
  }

  const parsed = riskProfileSchema.safeParse(raw)
  if (!parsed.success) {
    log.error(
      { key: PROFILE_KEY, issues: z.prettifyError(parsed.error) },
      'the stored risk profile is invalid; using the default',
    )
    return DEFAULT_PROFILE
  }
  return parsed.data
}

/**
 * Validates and stores a patch, merged over what is there.
 *
 * One level deep, like `saveParams` — but `bands` is replaced wholesale rather than
 * merged, because a half-merged set of bands is precisely the state `bandsProblem`
 * exists to refuse: four targets that no longer add up to 100% because one of them
 * came from the previous profile.
 *
 * Choosing a named preset drops any stored bands, which is what picking a preset has
 * to mean. Editing bands without naming a profile makes it `custom`, because the
 * numbers are the profile and a preset's name on somebody else's numbers is a lie.
 */
export function saveProfile(db: Db, patch: RiskProfilePatch): RiskProfile {
  const current = loadProfile(db)
  const incoming = patch ?? {}

  const named = incoming.profile !== undefined && incoming.profile !== 'custom'
  const bands = incoming.bands ?? (named ? undefined : current.bands)
  const profile = incoming.profile ?? (incoming.bands === undefined ? current.profile : 'custom')

  // Built field by field rather than spread over `current`, so that dropping the bands
  // is dropping them: a spread would carry the old ones back in, and the only thing
  // stopping them from being stored would be `JSON.stringify` skipping an `undefined`.
  const next = riskProfileSchema.parse({
    profile,
    toleranceBp: incoming.toleranceBp ?? current.toleranceBp,
    minTradeCents: incoming.minTradeCents ?? current.minTradeCents,
    ...(bands === undefined ? {} : { bands }),
  })

  const valueJson = JSON.stringify(next)
  db.insert(settings)
    .values({ key: PROFILE_KEY, valueJson })
    .onConflictDoUpdate({ target: settings.key, set: { valueJson, updatedAt: new Date() } })
    .run()

  return next
}
