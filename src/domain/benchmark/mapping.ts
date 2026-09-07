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
  /**
   * Manually tagged as a savings or investments envelope (#252), or neither.
   *
   * `category_meta.nature` also carries `fixed`/`variable`/`discretionary`/`income`,
   * but those are AI-proposal territory (`proposals.ts`'s `NATURES`) — this column
   * shows and writes only the two values a person sets here, so a category the AI
   * classified `fixed` reads as unset in this form rather than something to clear.
   */
  readonly nature: 'savings' | 'investments' | null
  /**
   * How much of this envelope the AI layer may see (#278).
   *
   * One field over two columns, because the question a person is answering is one
   * question with three answers rather than two independent boxes — and two boxes
   * would let somebody tick "absent" and "name withheld" together, which is a state
   * with only one meaning and two ways to write it.
   */
  readonly aiVisibility: AiVisibility
  /** The latest computed month, so the biggest envelope can be dealt with first. */
  readonly spentCents: number
}

/** The only two values this module's own writer may set. */
export const SAVINGS_NATURE_CHOICES = ['savings', 'investments'] as const
export type SavingsNatureChoice = (typeof SAVINGS_NATURE_CHOICES)[number]

/**
 * What the AI layer may see of one envelope, from most to least (#278).
 *
 * `label_only` is `category_meta.sensitive`: the amounts, the COICOP class and the
 * nature cross, and the name and the description do not. `absent` is `ai_excluded`:
 * nothing crosses, and the money survives only inside the month's totals and the
 * count `redact.ts` sends beside them.
 *
 * Ordered widest-first, which is the order the control offers them in: the default is
 * the first entry, and a person reading down the list reads decreasing disclosure.
 */
export const AI_VISIBILITY_CHOICES = ['shown', 'label_only', 'absent'] as const
export type AiVisibility = (typeof AI_VISIBILITY_CHOICES)[number]

/**
 * The pair of columns, read as one answer.
 *
 * `ai_excluded` wins: it is the stronger answer, and `saveAiVisibility` sets
 * `sensitive` alongside it so the two can never disagree about which of them is in
 * force. Reading the pair in this order means that even a row written by some other
 * path — an old `category_meta.set` proposal clearing `sensitive`, say — still reads as
 * `absent` while the exclusion stands.
 */
export function aiVisibilityOf(row: {
  aiExcluded: boolean
  sensitive: boolean
}): AiVisibility {
  if (row.aiExcluded) return 'absent'
  return row.sensitive ? 'label_only' : 'shown'
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
      nature: categoryMeta.nature,
      sensitive: categoryMeta.sensitive,
      aiExcluded: categoryMeta.aiExcluded,
    })
    .from(categoryMeta)
    .all()
    .map(({ sensitive, aiExcluded, ...row }) => ({
      ...row,
      nature: row.nature === 'savings' || row.nature === 'investments' ? row.nature : null,
      // The two columns collapse to the one answer here rather than on the wire, so
      // every reader of a `CategoryMapping` sees the same three states and nobody
      // downstream has to know which column carries which.
      aiVisibility: aiVisibilityOf({ sensitive, aiExcluded }),
      spentCents: spend.get(row.categoryId) ?? 0,
    }))

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

/**
 * Sets how much of one envelope the AI layer may see (#278).
 *
 * Writes both columns from the one answer, always, so the pair is never contradictory
 * and the state a person picked is the state that reads back.
 *
 * `absent` sets `sensitive` as well as `ai_excluded`. Not redundant: exclusion is
 * strictly the stronger answer, so the weaker flag being on alongside it is consistent,
 * and it means the flag fails towards withholding — a future path that reads only
 * `sensitive` still keeps the name back. It also stops the `sensitive_unknown`
 * clarification asking about an envelope whose answer has already been given.
 */
export function saveAiVisibility(db: Db, categoryId: string, visibility: AiVisibility): void {
  requireCategory(db, categoryId)

  db.update(categoryMeta)
    .set({
      aiExcluded: visibility === 'absent',
      sensitive: visibility !== 'shown',
      updatedAt: new Date(),
    })
    .where(eq(categoryMeta.categoryId, categoryId))
    .run()
}

/**
 * Tags one category as `savings` or `investments`, or clears the tag (#252).
 *
 * Nullable for the same reason `saveCoicop`'s division is: a person correcting
 * their own mistake needs to take the tag back. Only ever writes these two values
 * (or null) — never the AI-proposal values `category_meta.nature` also carries —
 * so this and `category_meta.set` can never contend over the same column.
 */
export function saveNature(db: Db, categoryId: string, nature: SavingsNatureChoice | null): void {
  requireCategory(db, categoryId)

  db.update(categoryMeta)
    .set({ nature, updatedAt: new Date() })
    .where(eq(categoryMeta.categoryId, categoryId))
    .run()
}
