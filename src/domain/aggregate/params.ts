/**
 * Every tunable number the aggregation engine uses.
 *
 * They live in the `settings` table rather than in `.env` for one reason: a web
 * app cannot edit `.env`, and these are exactly the knobs worth turning after
 * looking at a chart ("stop flagging that category", "three months of history is
 * not enough"). Secrets stay in the environment; judgement calls live here.
 *
 * Defaults are the schema's, so a fresh install works before anything is stored
 * and an unrecognised key in a stored row is ignored rather than fatal.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../../db/index.ts'
import { settings } from '../../db/schema.ts'
import { logger } from '../../logger.ts'

const log = logger.child({ module: 'aggregate/params' })

export const PARAMS_KEY = 'aggregate.params'

/**
 * `.prefault({})` rather than `.default({})`: in Zod 4 a default short-circuits
 * parsing and must be the *output* type, so it would have to repeat every field.
 * A prefault is run through the schema, which means each group's own field
 * defaults fill it in — and a stored row holding only one group keeps working.
 */
const baseline = z
  .object({
    /** How many observations feed the EWMA. */
    windowMonths: z.number().int().min(3).max(60).default(12),
    /** Weight halves every this many months, so recent months dominate. */
    halfLifeMonths: z.number().positive().max(24).default(3),
    /**
     * Clamp the extremes before averaging. One boiler repair should not become
     * the definition of normal, and clamping is gentler than dropping the month.
     */
    winsorLowerPct: z.number().min(0).max(0.4).default(0.05),
    winsorUpperPct: z.number().min(0.6).max(1).default(0.95),
    /**
     * Below this many observations, no baseline is emitted at all. A confident
     * norm computed from two months is worse than an honest "not yet".
     */
    minMonths: z.number().int().min(2).max(24).default(4),
  })
  .prefault({})

const overspend = z
  .object({
    /** Above-baseline thresholds, basis points of the baseline. */
    baselineWarnBp: z.number().int().min(0).default(2_000),
    baselineAlertBp: z.number().int().min(0).default(5_000),
    /**
     * Absolute floor for any relative signal. A €7 envelope going 40% over is
     * €2.80 — arithmetically true, and noise.
     */
    materialityFloorCents: z.number().int().min(0).default(2_500),
    /** Actual's `balance` below this counts as an overspent envelope. */
    availableFloorCents: z.number().int().min(0).default(500),
  })
  .prefault({})

const burnRate = z
  .object({
    /**
     * No projection before this fraction of the month has passed. Extrapolating
     * from day two produces a number that is wrong by construction.
     */
    minMonthProgress: z.number().min(0.05).max(0.9).default(0.25),
    /** Projected overrun must exceed this share of the assigned amount. */
    toleranceBp: z.number().int().min(0).default(1_000),
  })
  .prefault({})

const hygiene = z
  .object({
    /** An account not reconciled in this long makes its balance a guess. */
    reconcileStaleDays: z.number().int().min(1).default(45),
    /** Portfolio prices older than this stop being "current value". */
    priceStaleDays: z.number().int().min(1).default(5),
    /** Uncategorised transactions tolerated before it is a finding. */
    uncategorisedWarnCount: z.number().int().min(0).default(5),
    /**
     * How far Actual's own `spent` may differ from our recomputation before it
     * is reported. Zero: a single cent of drift means a hygiene rule is wrong,
     * and that same rule feeds the baselines and the findings.
     */
    recomputationToleranceCents: z.number().int().min(0).default(0),
  })
  .prefault({})

const household = z
  .object({
    savingsRateTargetBp: z.number().int().min(0).max(10_000).default(1_500),
    emergencyFundTargetMonths: z.number().min(0).max(24).default(3),
  })
  .prefault({})

/**
 * How long a portfolio class has to sit outside its band before anybody is told (#183).
 *
 * Its own group rather than a field under `overspend`, because it judges a portfolio
 * against a risk profile and not a month against an envelope — and because the settings
 * page renders one card per group, where "a class has been outside its band for N months"
 * belongs next to nothing else on the page.
 */
const drift = z
  .object({
    /**
     * Consecutive month ends outside the same edge of the band before a finding.
     *
     * Three, and the floor is two: at one month the insights page would be repeating
     * what the portfolio page already shows in more detail, for a share that a fortnight
     * of markets can move on its own. Three is a household that has decided not to
     * rebalance, which is the thing worth a sentence.
     */
    persistentMonths: z.number().int().min(2).max(24).default(3),
  })
  .prefault({})

export const aggregateParamsSchema = z
  .object({ baseline, overspend, burnRate, hygiene, household, drift })
  .prefault({})
  .refine((p) => p.baseline.winsorLowerPct < p.baseline.winsorUpperPct, {
    message: 'winsorLowerPct must be below winsorUpperPct',
    path: ['baseline', 'winsorLowerPct'],
  })
  .refine((p) => p.overspend.baselineWarnBp <= p.overspend.baselineAlertBp, {
    message: 'baselineWarnBp must not exceed baselineAlertBp',
    path: ['overspend', 'baselineWarnBp'],
  })

export type AggregateParams = z.infer<typeof aggregateParamsSchema>
export type AggregateParamsPatch = z.input<typeof aggregateParamsSchema>

export const DEFAULT_PARAMS: AggregateParams = aggregateParamsSchema.parse({})

/**
 * Reads the stored parameters, falling back to the defaults.
 *
 * A malformed row logs and degrades to defaults rather than throwing: the
 * nightly job going dark because someone saved a bad threshold would be a worse
 * failure than analysing with the default one, and the log says which key broke.
 */
export function loadParams(db: Db): AggregateParams {
  const row = db
    .select({ valueJson: settings.valueJson })
    .from(settings)
    .where(eq(settings.key, PARAMS_KEY))
    .get()

  if (!row) return DEFAULT_PARAMS

  let raw: unknown
  try {
    raw = JSON.parse(row.valueJson)
  } catch (error) {
    log.error({ err: error, key: PARAMS_KEY }, 'stored parameters are not JSON; using defaults')
    return DEFAULT_PARAMS
  }

  const parsed = aggregateParamsSchema.safeParse(raw)
  if (!parsed.success) {
    log.error(
      { key: PARAMS_KEY, issues: z.prettifyError(parsed.error) },
      'stored parameters are invalid; using defaults',
    )
    return DEFAULT_PARAMS
  }
  return parsed.data
}

/**
 * Validates and stores a patch, merging it over what is already there.
 *
 * The merge is one level deep, which is exactly the schema's depth: a settings
 * form that submits only `baseline` must not silently reset the thresholds it
 * never showed. Throws on invalid input — unlike reading, a bad *write* should
 * be reported to whoever is trying to save it.
 */
export function saveParams(db: Db, patch: AggregateParamsPatch): AggregateParams {
  const current = loadParams(db) as Record<string, Record<string, unknown>>
  const incoming = (patch ?? {}) as Record<string, Record<string, unknown>>

  const merged: Record<string, unknown> = { ...current }
  for (const [group, values] of Object.entries(incoming)) {
    merged[group] = { ...(current[group] ?? {}), ...(values ?? {}) }
  }

  const next = aggregateParamsSchema.parse(merged)
  const valueJson = JSON.stringify(next)

  db.insert(settings)
    .values({ key: PARAMS_KEY, valueJson })
    .onConflictDoUpdate({
      target: settings.key,
      set: { valueJson, updatedAt: new Date() },
    })
    .run()

  return next
}

/**
 * Field names in a patch that no group actually has.
 *
 * `aggregateParamsSchema` strips them, which is the right behaviour for *reading* a
 * stored row written by an older shape and the wrong answer for a form: a request
 * that misspells `windowMonths` would be accepted, stored without it, and answered
 * with a payload that looks saved. The settings screen would show the old value
 * back with no error anywhere.
 *
 * Derived from `DEFAULT_PARAMS` rather than from a list, so it cannot fall behind
 * the schema. Group names themselves are the wire schema's job — it knows the five.
 */
export function unknownParamFields(patch: AggregateParamsPatch): string[] {
  const known = DEFAULT_PARAMS as unknown as Record<string, Record<string, unknown>>
  const incoming = (patch ?? {}) as Record<string, Record<string, unknown> | undefined>

  return Object.entries(incoming).flatMap(([group, values]) =>
    Object.keys(values ?? {})
      .filter((field) => !Object.hasOwn(known[group] ?? {}, field))
      .map((field) => `${group}.${field}`),
  )
}
