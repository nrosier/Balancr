/**
 * Property value and mortgage amortization, tracked by Balancr rather than Ghostfolio
 * (#227). Ghostfolio has no liability type that can model a rate that changes, and a
 * paid-down room in an actual house is not a fund position `advice/{drift,suggest}.ts`
 * could ever buy or sell — so this stays out of the `REAL_ESTATE` allocation band and is
 * its own small settings record instead.
 *
 * A list, not a singleton: the household can own the place it lives in (`primary`) and
 * separately rent out one or more others (`rental`), each with its own value and its own
 * mortgage or none at all. A rental also carries the rent it brings in, which is what
 * `netCashFlowCents`/`grossYieldBp` in `vocabulary.ts` turn into "is this one actually
 * worth it" — questions a primary residence never asks, so those two only mean anything
 * once `rentCents` is set.
 *
 * The arithmetic lives in `vocabulary.ts`, a module a browser can import; this file adds
 * the zod schema and the two functions that touch the database. Same load/save contract
 * as `household.ts` and `upcoming-note.ts`: reading degrades to the default (an empty
 * list) and never throws, writing validates and throws.
 *
 * There is no rate-history table. When a mortgage's rate, payment, or remaining term
 * changes, the owner re-enters today's actual outstanding balance (from a statement) as
 * the new `anchorDate`/`principalCents` — a re-anchor, not an appended row. Every other
 * settings singleton in this codebase is a current-state snapshot rather than a history,
 * and a mortgage doesn't need to be the exception to answer "what if the rate changes":
 * it just needs updating when it does.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../../db/index.ts'
import { settings } from '../../db/schema.ts'
import { logger } from '../../logger.ts'
import { MAX_PROPERTIES, propertyKinds } from './vocabulary.ts'

export {
  grossYieldBp,
  MAX_PROPERTIES,
  netCashFlowCents,
  outstandingBalanceCents,
  propertyEquityCents,
  propertyKinds,
  standardMonthlyPaymentCents,
  totalEquityCents,
} from './vocabulary.ts'
export type { Mortgage, Property, PropertyKind } from './vocabulary.ts'

const log = logger.child({ module: 'property/properties' })

export const PROPERTY_KEY = 'property.properties'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const mortgageSchema = z
  .object({
    principalCents: z.int().min(0),
    anchorDate: isoDate,
    /** Bounded at 50% as a sanity check on fat fingers. */
    rateBp: z.int().min(0).max(5_000),
    monthlyPaymentCents: z.int().min(0),
    /** Bounded at 50 years. */
    remainingTermMonths: z.int().min(0).max(600),
  })
  .strict()

export const propertySchema = z
  .object({
    /** Stable across edits, so a re-ordered list doesn't lose track of which row is which. */
    id: z.string().min(1),
    kind: z.enum(propertyKinds).default('primary'),
    /** A short name the owner gave it, e.g. "Home" or "Antwerp flat". Empty is fine. */
    label: z.string().max(80).default(''),
    propertyValueCents: z.int().min(0).nullable().default(null),
    rentCents: z.int().min(0).nullable().default(null),
    mortgage: mortgageSchema.nullable().default(null),
  })
  .strict()

export type PropertyPatch = z.input<typeof propertySchema>

export const propertiesSchema = z
  .object({
    properties: z.array(propertySchema).max(MAX_PROPERTIES).default([]),
  })
  .strict()
  .prefault({})

export type Properties = z.infer<typeof propertiesSchema>

export const DEFAULT_PROPERTIES: Properties = propertiesSchema.parse({})

export function loadProperties(db: Db): Properties {
  const row = db
    .select({ valueJson: settings.valueJson })
    .from(settings)
    .where(eq(settings.key, PROPERTY_KEY))
    .get()

  if (!row) return DEFAULT_PROPERTIES

  let raw: unknown
  try {
    raw = JSON.parse(row.valueJson)
  } catch (error) {
    log.error({ err: error, key: PROPERTY_KEY }, 'the stored properties are not JSON; using none')
    return DEFAULT_PROPERTIES
  }

  const parsed = propertiesSchema.safeParse(raw)
  if (!parsed.success) {
    log.error(
      { key: PROPERTY_KEY, issues: z.prettifyError(parsed.error) },
      'the stored properties are invalid; using none',
    )
    return DEFAULT_PROPERTIES
  }
  return parsed.data
}

export function saveProperties(db: Db, patch: { properties: PropertyPatch[] }): Properties {
  const next = propertiesSchema.parse(patch ?? {})
  const valueJson = JSON.stringify(next)

  db.insert(settings)
    .values({ key: PROPERTY_KEY, valueJson })
    .onConflictDoUpdate({ target: settings.key, set: { valueJson, updatedAt: new Date() } })
    .run()

  return next
}
