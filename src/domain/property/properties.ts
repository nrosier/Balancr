/**
 * Property value and mortgage amortization, tracked by Balancr rather than Ghostfolio
 * (#227). Ghostfolio has no liability type that can model a rate that changes, and a
 * paid-down room in an actual house is not a fund position `advice/{drift,suggest}.ts`
 * could ever buy or sell — so this stays out of the `REAL_ESTATE` allocation band and is
 * its own small settings record instead.
 *
 * A list, not a singleton: the household can own the place it lives in (`primary`),
 * separately rent out one or more others (`rental`), and hold a third kind of property
 * that is neither — bought outright, inherited, held for a family member — where `owned`
 * fits without forcing a real distinction into one of the other two. Each row has its own
 * value and zero or more mortgages against it (#393). A rental also carries the rent it brings in,
 * which is what `netCashFlowCents`/`grossYieldBp` in `vocabulary.ts` turn into "is this one
 * actually worth it" — questions neither a primary residence nor an `owned` property ever
 * asks, so those two only mean anything once `rentCents` is set on a `rental` row.
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
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../../db/index.ts'
import { categoryMeta, scheduleMeta, settings } from '../../db/schema.ts'
import { logger } from '../../logger.ts'
import { MAX_MORTGAGES_PER_PROPERTY, MAX_PROPERTIES, propertyKinds } from './vocabulary.ts'

export {
  earliestAnchorDate,
  grossYieldBp,
  MAX_MORTGAGES_PER_PROPERTY,
  MAX_PROPERTIES,
  netCashFlowCents,
  outstandingBalanceCents,
  paidOffBp,
  propertyEquityCents,
  propertyKinds,
  standardMonthlyPaymentCents,
  totalEquityCents,
} from './vocabulary.ts'
export type { Mortgage, Property, PropertyKind, PropertyMortgage } from './vocabulary.ts'

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
    /** What the loan started at, or null when nobody has entered it (#392). */
    originalPrincipalCents: z.int().min(0).nullable().default(null),
    /**
     * The Actual expense category this payment should show up in, or null when
     * nobody has linked one yet (#643). Validated in `saveProperties` rather than
     * here, the same division as the rate/term bounds above — a category's
     * direction and hidden state are facts about the tenant's data, not about the
     * shape of this field.
     */
    paymentCategoryId: z.string().min(1).nullable().default(null),
    /**
     * The Actual schedule this payment should show up in, or null when nobody has
     * linked one yet (#662). When set, its own resolved category supersedes
     * `paymentCategoryId` for the read-only comparison — see `assertKnownSchedule`.
     */
    paymentScheduleId: z.string().min(1).nullable().default(null),
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
    /** The Actual income category this rent should show up in (#643). See `paymentCategoryId`. */
    rentCategoryId: z.string().min(1).nullable().default(null),
    /** The Actual schedule this rent should show up in (#662). See `paymentScheduleId`. */
    rentScheduleId: z.string().min(1).nullable().default(null),
    mortgages: z.array(mortgageSchema).max(MAX_MORTGAGES_PER_PROPERTY).default([]),
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

export function loadProperties(db: Db, tenantId: string): Properties {
  const row = db
    .select({ valueJson: settings.valueJson })
    .from(settings)
    .where(and(eq(settings.tenantId, tenantId), eq(settings.key, PROPERTY_KEY)))
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

/**
 * Thrown when a `rentCategoryId`/`paymentCategoryId` names no category this tenant
 * has ever seen, names one of the wrong direction, or names a hidden one. Its own
 * error rather than a `ZodError`, for the same reason `goal/goals.ts`'s
 * `UnknownCategoryError` is: it is not a fact the shape of the body can tell. Hidden
 * is rejected too, stricter than a goal's `assertKnownCategory` — a hidden category
 * can stop receiving new transactions at any time, which would freeze the #643
 * comparison silently rather than surfacing as a clear "pick another one." The route
 * maps it to 400, same as a `ZodError`.
 */
export class InvalidCategoryLinkError extends Error {
  constructor(
    public readonly field: 'rentCategoryId' | 'paymentCategoryId',
    categoryId: string,
  ) {
    super(`No income/expense category ${categoryId} is available for this tenant to link as ${field}.`)
    this.name = 'InvalidCategoryLinkError'
  }
}

/** Throws `InvalidCategoryLinkError` when `categoryId` is set but not a valid link target. */
function assertCategoryDirection(
  db: Db,
  tenantId: string,
  categoryId: string | null,
  direction: 'income' | 'expense',
  field: 'rentCategoryId' | 'paymentCategoryId',
): void {
  if (categoryId === null) return
  const row = db
    .select({ isIncome: categoryMeta.isIncome, hidden: categoryMeta.hidden })
    .from(categoryMeta)
    .where(and(eq(categoryMeta.tenantId, tenantId), eq(categoryMeta.categoryId, categoryId)))
    .get()
  if (row === undefined || row.hidden || row.isIncome !== (direction === 'income')) {
    throw new InvalidCategoryLinkError(field, categoryId)
  }
}

/**
 * Thrown when a `rentScheduleId`/`paymentScheduleId` names no schedule this tenant
 * has ever synced, or one that is completed, or one whose own resolved category
 * disagrees with the direction/hidden rule `InvalidCategoryLinkError` above
 * enforces. Same 400 mapping as that error.
 */
export class InvalidScheduleLinkError extends Error {
  constructor(
    public readonly field: 'rentScheduleId' | 'paymentScheduleId',
    scheduleId: string,
  ) {
    super(`No schedule ${scheduleId} is available for this tenant to link as ${field}.`)
    this.name = 'InvalidScheduleLinkError'
  }
}

/**
 * Throws `InvalidScheduleLinkError` when `scheduleId` is set but not a valid link
 * target. A schedule whose own rule resolves no category is allowed to link —
 * mirroring `committed.ts`'s own tolerance for unallocated schedules — it just
 * won't drive a comparison beyond its own scheduled amount.
 */
function assertKnownSchedule(
  db: Db,
  tenantId: string,
  scheduleId: string | null,
  direction: 'income' | 'expense',
  field: 'rentScheduleId' | 'paymentScheduleId',
): void {
  if (scheduleId === null) return
  const row = db
    .select({ completed: scheduleMeta.completed, categoryId: scheduleMeta.categoryId })
    .from(scheduleMeta)
    .where(and(eq(scheduleMeta.tenantId, tenantId), eq(scheduleMeta.scheduleId, scheduleId)))
    .get()
  if (row === undefined || row.completed) {
    throw new InvalidScheduleLinkError(field, scheduleId)
  }
  if (row.categoryId === null) return

  const category = db
    .select({ isIncome: categoryMeta.isIncome, hidden: categoryMeta.hidden })
    .from(categoryMeta)
    .where(and(eq(categoryMeta.tenantId, tenantId), eq(categoryMeta.categoryId, row.categoryId)))
    .get()
  if (category === undefined || category.hidden || category.isIncome !== (direction === 'income')) {
    throw new InvalidScheduleLinkError(field, scheduleId)
  }
}

export function saveProperties(
  db: Db,
  tenantId: string,
  patch: { properties: PropertyPatch[] },
): Properties {
  const next = propertiesSchema.parse(patch ?? {})
  for (const property of next.properties) {
    assertCategoryDirection(db, tenantId, property.rentCategoryId, 'income', 'rentCategoryId')
    assertKnownSchedule(db, tenantId, property.rentScheduleId, 'income', 'rentScheduleId')
    for (const mortgage of property.mortgages) {
      assertCategoryDirection(db, tenantId, mortgage.paymentCategoryId, 'expense', 'paymentCategoryId')
      assertKnownSchedule(db, tenantId, mortgage.paymentScheduleId, 'expense', 'paymentScheduleId')
    }
  }
  const valueJson = JSON.stringify(next)

  db.insert(settings)
    .values({ tenantId, key: PROPERTY_KEY, valueJson })
    .onConflictDoUpdate({
      target: [settings.tenantId, settings.key],
      set: { valueJson, updatedAt: new Date() },
    })
    .run()

  return next
}
