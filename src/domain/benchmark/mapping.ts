/**
 * Which COICOP division each category counts as, and who gets to say so (#43).
 *
 * The benchmark compares your spending to ten published lines, and the only thing that
 * decides which line an envelope feeds is `category_meta.coicop_code`. Until #43 that
 * column had exactly one writer: an approved `category_meta.set` proposal, which the model
 * has to have offered first. Nothing generates those proposals automatically and no
 * clarification code asks about the field, so on an installation with no Gemini key the
 * column stays null for ever — and "make AI optional" is a standing requirement, not a
 * nice-to-have. Hence a hand mapping, and hence this module.
 *
 * Three decisions:
 *
 *  - **Divisions, not groups.** The picker offers the twelve COICOP divisions plus `00`,
 *    because three divisions share the survey's "other expenditure" line: picking "other"
 *    would leave the stored code ambiguous, and a stored code is a fact that outlives
 *    this benchmark file.
 *  - **`null` is a value here, unlike in a proposal.** `categoryMetaSetSchema` cannot
 *    express "unset", because a proposal exists to add knowledge. A person correcting
 *    their own mistake needs to take a mapping back, so this write accepts null and the
 *    route below is the only path that does.
 *  - **A division, not a full code.** The proposal schema accepts `01.1.1`, and rows
 *    written that way keep working — `divisionOf` reads the first two digits. What a form
 *    may *write* is the division alone, because that is the granularity the comparison
 *    uses and offering four levels of a classification nobody has to hand would be a form
 *    people abandon.
 *
 * `custody_shared` (#44) is here for the first of those reasons word for word. Its only
 * writers were an approved `category_meta.set` proposal and an answered
 * `custody_shared_unknown` clarification — both of which need a Gemini key — so the
 * shared-cost split was a feature an installation without AI could not switch on at all.
 * It shares this module rather than sitting beside the split itself because the row, the
 * guard against conjuring one, and the settings list both fields are read out of are the
 * same three things; splitting them would mean two copies of `requireCategory` and two
 * lists of categories on one screen.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { categoryMeta, monthlyCategoryFacts } from '../../db/schema.ts'
import { COICOP_DIVISIONS, OUTSIDE_CONSUMPTION } from './vocabulary.ts'

/** What a person may pick: the twelve divisions, plus "not household consumption". */
export const COICOP_CHOICES = [...COICOP_DIVISIONS, OUTSIDE_CONSUMPTION] as const
export type CoicopChoice = (typeof COICOP_CHOICES)[number]

export class MappingError extends Error {}

/** One row of the mapping table on the settings screen. */
export interface CategoryMapping {
  readonly categoryId: string
  readonly categoryName: string
  readonly isIncome: boolean
  readonly hidden: boolean
  /** As stored, which may be a deeper code than the picker offers. Null when unmapped. */
  readonly coicop: string | null
  /**
   * Whether the cost is split with a co-parent (#44).
   *
   * On the same row as the mapping because it is the same question asked of the same
   * list — "what kind of cost is this" — and because a person going through fifty
   * envelopes should do it once. The split itself ignores this on income and hidden
   * categories, which is why the form disables it there rather than storing a flag that
   * does nothing.
   */
  readonly custodyShared: boolean
  /** The latest computed month, so the biggest envelope can be dealt with first. */
  readonly spentCents: number
}

/**
 * Every category, ordered by how much attention it needs.
 *
 * Income and hidden categories last: the comparison skips both, so a form that put them
 * at the top would be asking for answers that change nothing. Then unmapped before
 * mapped, then by spend — which puts the envelope that is distorting the comparison most
 * on the first line, and is the whole reason this list is not alphabetical.
 */
export function loadMapping(db: Db, month: string | null): CategoryMapping[] {
  const spend = new Map<string, number>()
  if (month !== null) {
    for (const row of db
      .select({
        categoryId: monthlyCategoryFacts.categoryId,
        spentCents: monthlyCategoryFacts.spentCents,
      })
      .from(monthlyCategoryFacts)
      .where(eq(monthlyCategoryFacts.month, month))
      .all()) {
      spend.set(row.categoryId, row.spentCents)
    }
  }

  const rows = db
    .select({
      categoryId: categoryMeta.categoryId,
      categoryName: categoryMeta.nameSnapshot,
      isIncome: categoryMeta.isIncome,
      hidden: categoryMeta.hidden,
      coicop: categoryMeta.coicopCode,
      custodyShared: categoryMeta.custodyShared,
    })
    .from(categoryMeta)
    .all()
    .map((row) => ({ ...row, spentCents: spend.get(row.categoryId) ?? 0 }))

  const rank = (row: CategoryMapping): number =>
    (row.isIncome || row.hidden ? 2 : 0) + (row.coicop === null ? 0 : 1)

  return rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      b.spentCents - a.spentCents ||
      a.categoryName.localeCompare(b.categoryName),
  )
}

/**
 * Throws unless the category already has a metadata row.
 *
 * Both writers below update rather than upsert, and that is deliberate: `category_meta`
 * rows are written by the sync pass out of what Actual actually has, and a row conjured
 * here would be a category that exists only in Balancr — which would then show up in this
 * table for ever with no way to tell it from a real one.
 */
function requireCategory(db: Db, categoryId: string): void {
  const existing = db
    .select({ categoryId: categoryMeta.categoryId })
    .from(categoryMeta)
    .where(eq(categoryMeta.categoryId, categoryId))
    .get()
  if (existing === undefined) throw new MappingError(`category ${categoryId} has no metadata row`)
}

/** Stores one category's division, or clears it. */
export function saveCoicop(db: Db, categoryId: string, code: CoicopChoice | null): void {
  requireCategory(db, categoryId)

  db.update(categoryMeta)
    .set({ coicopCode: code, updatedAt: new Date() })
    .where(eq(categoryMeta.categoryId, categoryId))
    .run()
}

/**
 * Flags one category as shared with a co-parent, or takes the flag back (#44).
 *
 * A boolean and not nullable, unlike the division: there is no third state to express. A
 * category is either one the arrangement splits or it is not, and "unknown" is what the
 * clarification queue is for.
 */
export function saveCustodyShared(db: Db, categoryId: string, shared: boolean): void {
  requireCategory(db, categoryId)

  db.update(categoryMeta)
    .set({ custodyShared: shared, updatedAt: new Date() })
    .where(eq(categoryMeta.categoryId, categoryId))
    .run()
}
