/**
 * Who lives here, and for how much of the time (#43).
 *
 * A national average is an average over households of every size, so comparing your
 * spending to it without saying how many people yours holds produces a number that means
 * nothing: a single parent spends less than the average household and is not being
 * frugal. The equivalence scale in the benchmark file is what makes the two comparable,
 * and this is its input.
 *
 * Four decisions, and the second is the one to disagree with:
 *
 *  - **Everyone but you is a `member`, and you are always counted at full weight.** No
 *    `adults` count and no separate children list, because Balancr is being built for a
 *    household with a teenager in it and a teenager turns fourteen. On the modified OECD
 *    scale that moves them from 0,3 to 0,5 — and in a model with an adult *count* and a
 *    child *list*, it would also move them out of the list that carries their custody
 *    share, silently making a half-time child into a full-time adult.
 *  - **A year of birth, not a "child" checkbox.** A checkbox is correct on the day it is
 *    ticked and quietly wrong from the next birthday on, with nothing on screen to say
 *    so. A year is enough — the scale's threshold is a whole age — and it keeps the
 *    weight right without anybody maintaining it. Only the year is stored; a date of
 *    birth would be more personal data for no more accuracy than the scale can use.
 *  - **Custody is a share of time, in basis points, per member.** The scale has no notion
 *    of part-time membership at all, so prorating a member's weight by their share of the
 *    time is *Balancr's assumption and not the published scale's*. `prorated` is on the
 *    result so every screen that prints a benchmark figure can say so, which #43 requires
 *    and which is the honest way to use a number the source does not support.
 *  - **In `settings`, like the risk profile.** Same reason: a web app cannot edit `.env`,
 *    and this is a fact about a life rather than about a deployment. Not to be confused
 *    with the `household` group in `aggregate.params`, which holds savings and
 *    emergency-fund *targets* — those are goals, this is a composition.
 *
 * The default is an empty member list: one person, full weight, no proration and no
 * assumption to disclose. That is the only default that cannot be wrong about somebody's
 * family, and it is why the level comparison is worth switching on rather than assumed.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../../db/index.ts'
import { settings } from '../../db/schema.ts'
import { logger } from '../../logger.ts'
import type { Equivalence } from './schema.ts'
import { MAX_HOUSEHOLD_MEMBERS } from './vocabulary.ts'

const log = logger.child({ module: 'benchmark/household' })

export const HOUSEHOLD_KEY = 'benchmark.household'

export const memberSchema = z
  .object({
    /**
     * Year of birth. The scale only distinguishes above and below one whole age, so a
     * year answers it — accurately except in the months around a birthday, which moves a
     * weight by 0,2 on a comparison that is context rather than a verdict.
     */
    birthYear: z.int().min(1900).max(2200),
    /**
     * Share of the time this person is part of this household, in basis points. 10 000 is
     * full time, 5 000 is alternating weeks.
     */
    custodyBp: z.int().min(0).max(10_000).default(10_000),
    /**
     * A name for the row, so a form with three of them is readable. Never leaves the
     * machine: `redact.ts` sends aggregates and category names, and a household roster is
     * not among them.
     */
    label: z.string().trim().max(40).optional(),
  })
  .strict()

export type HouseholdMember = z.infer<typeof memberSchema>

export const householdSchema = z
  .object({
    /**
     * Everyone in the household besides you.
     *
     * You are not a row: there is always exactly one first person on the scale, and
     * making yourself editable would allow a household of zero people — which divides by
     * nothing and produces a comparison against infinity.
     */
    members: z.array(memberSchema).max(MAX_HOUSEHOLD_MEMBERS).default([]),
    /**
     * The share of a cost flagged `custody_shared` that is economically yours, in basis
     * points, or null to derive it from the roster (#44).
     *
     * Null rather than a number as the default, because the two are different claims: a
     * number is the split in somebody's arrangement, and null means "work it out from the
     * shares of time above". Both produce a figure, and every screen that prints one says
     * which — a derived share is Balancr guessing at an agreement it has never seen.
     *
     * Separate from `custodyBp` and not derivable from it in general: who pays for the
     * winter coat is negotiated separately from who has the children on Wednesday, and
     * plenty of agreements split costs down the middle on an unequal week.
     */
    sharedCostBp: z.int().min(0).max(10_000).nullable().default(null),
  })
  .strict()
  .prefault({})

export type Household = z.infer<typeof householdSchema>
export type HouseholdPatch = z.input<typeof householdSchema>

export const DEFAULT_HOUSEHOLD: Household = householdSchema.parse({})

// ---------------------------------------------------------------------------
//  The scale
// ---------------------------------------------------------------------------

export interface EquivalentAdults {
  /** The household's size on the scale, in basis points. 13 000 is 1,3. */
  readonly bp: number
  /** Whether any member was counted at less than full time — an assumption to disclose. */
  readonly prorated: boolean
  /** How many people were counted at the child weight, for the sentence on screen. */
  readonly children: number
  /** Everyone besides you, including part-time members. */
  readonly members: number
}

/**
 * The household's size on the equivalence scale.
 *
 * `year` is the year being compared, not today: a comparison of last January uses the
 * household as it was then, and a member who has since turned fourteen was a child in it.
 *
 * Rounded per member rather than at the end, so the figure on screen adds up to the
 * figure used — a total rounded once is off by a basis point from the rows that explain
 * it, and that basis point is the kind of thing that costs an afternoon.
 */
export function equivalentAdults(
  household: Household,
  equivalence: Equivalence,
  year: number,
): EquivalentAdults {
  let bp = equivalence.first_person_bp
  let prorated = false
  let children = 0

  for (const member of household.members) {
    const age = year - member.birthYear
    const child = age < equivalence.child_age_below
    const weight = child ? equivalence.child_bp : equivalence.additional_person_bp
    if (child) children += 1
    if (member.custodyBp < 10_000) prorated = true
    bp += Math.round((weight * member.custodyBp) / 10_000)
  }

  return { bp, prorated, children, members: household.members.length }
}

// ---------------------------------------------------------------------------
//  Storage
// ---------------------------------------------------------------------------

/**
 * The stored composition, or the default with the reason logged.
 *
 * Same contract as `loadProfile` and `loadParams`: reading degrades, writing throws. A
 * roster nobody can parse should cost the level comparison, not the budget page.
 */
export function loadHousehold(db: Db): Household {
  const row = db
    .select({ valueJson: settings.valueJson })
    .from(settings)
    .where(eq(settings.key, HOUSEHOLD_KEY))
    .get()

  if (!row) return DEFAULT_HOUSEHOLD

  let raw: unknown
  try {
    raw = JSON.parse(row.valueJson)
  } catch (error) {
    log.error(
      { err: error, key: HOUSEHOLD_KEY },
      'the stored household composition is not JSON; using one person',
    )
    return DEFAULT_HOUSEHOLD
  }

  const parsed = householdSchema.safeParse(raw)
  if (!parsed.success) {
    log.error(
      { key: HOUSEHOLD_KEY, issues: z.prettifyError(parsed.error) },
      'the stored household composition is invalid; using one person',
    )
    return DEFAULT_HOUSEHOLD
  }
  return parsed.data
}

/**
 * Validates and stores a composition.
 *
 * Replaced wholesale rather than merged, unlike the parameters: `members` is a list, and
 * the only two gestures a form makes on a list are "here is the new one" and "remove a
 * row". A merge would make the second impossible to express.
 */
export function saveHousehold(db: Db, patch: HouseholdPatch): Household {
  const next = householdSchema.parse(patch ?? {})
  const valueJson = JSON.stringify(next)

  db.insert(settings)
    .values({ key: HOUSEHOLD_KEY, valueJson })
    .onConflictDoUpdate({ target: settings.key, set: { valueJson, updatedAt: new Date() } })
    .run()

  return next
}
