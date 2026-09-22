/**
 * An owner's own translation of a category's name into one locale (#479).
 *
 * `category_meta.nameSnapshot` is the household's source-language name, taken from
 * whatever Actual itself calls the category. This table is the only other writer of
 * a category's display name, and it is deliberately narrower than the source: a row
 * here can only exist for a locale *other* than the tenant's configured
 * `actualCategorySourceLocale` (`tenant-integrations.ts`) — a "translation" into the
 * language the household already typed the name in would be a second, competing
 * answer to the same question, so it is rejected at write time rather than merely
 * discouraged. `loadCategoryNames` (`aggregate/facts.ts`) is the read side: it
 * resolves each category's name for a given locale, falling back to the snapshot
 * whenever no row here overrides it.
 */
import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { categoryMeta, categoryTranslations } from '../../db/schema.ts'
import { integrationsRow } from '../../db/tenant-integrations.ts'

/** No `category_meta` row for this category — the same "not found" case `MappingError` covers. */
export class TranslationError extends Error {}

/** The requested locale is the tenant's own category source locale — a 400, not a 404. */
export class SourceLocaleError extends Error {}

/** One category's source name plus whatever explicit per-locale overrides exist. */
export interface CategoryTranslationRow {
  readonly categoryId: string
  readonly categoryName: string
  readonly isIncome: boolean
  readonly hidden: boolean
  /** locale → name, one entry per locale with an explicit override. Never the source locale. */
  readonly translations: Readonly<Record<string, string>>
}

/**
 * Throws unless the category already has a metadata row.
 *
 * Mirrors `benchmark/mapping.ts`'s `requireCategory`: a translation is an override of
 * something Actual reported, so it cannot be written for a category Balancr has never
 * seen synced.
 */
function requireCategory(db: Db, tenantId: string, categoryId: string): void {
  const existing = db
    .select({ categoryId: categoryMeta.categoryId })
    .from(categoryMeta)
    .where(and(eq(categoryMeta.tenantId, tenantId), eq(categoryMeta.categoryId, categoryId)))
    .get()
  if (existing === undefined) throw new TranslationError(`category ${categoryId} has no metadata row`)
}

/**
 * Every category, with the translations already on file for it.
 *
 * All categories rather than only the translated ones, so the settings panel can
 * offer a row — and an empty input — for a category nobody has translated yet,
 * without a second fetch to learn the full list exists.
 */
export function loadCategoryTranslationRows(db: Db, tenantId: string): CategoryTranslationRow[] {
  const metaRows = db
    .select({
      categoryId: categoryMeta.categoryId,
      categoryName: categoryMeta.nameSnapshot,
      isIncome: categoryMeta.isIncome,
      hidden: categoryMeta.hidden,
    })
    .from(categoryMeta)
    .where(eq(categoryMeta.tenantId, tenantId))
    .all()

  const translationsByCategory = new Map<string, Record<string, string>>()
  for (const row of db
    .select({
      categoryId: categoryTranslations.categoryId,
      locale: categoryTranslations.locale,
      name: categoryTranslations.name,
    })
    .from(categoryTranslations)
    .where(eq(categoryTranslations.tenantId, tenantId))
    .all()) {
    const existing = translationsByCategory.get(row.categoryId) ?? {}
    existing[row.locale] = row.name
    translationsByCategory.set(row.categoryId, existing)
  }

  return metaRows
    .map((row) => ({ ...row, translations: translationsByCategory.get(row.categoryId) ?? {} }))
    .sort(
      (a, b) =>
        Number(a.isIncome || a.hidden) - Number(b.isIncome || b.hidden) ||
        a.categoryName.localeCompare(b.categoryName),
    )
}

/**
 * Stores one category's name for one locale, or clears it back to the source snapshot.
 *
 * Rejects a write for the tenant's configured source locale: that locale's name is
 * `category_meta.nameSnapshot` itself, so a row here for it would be a second, silently
 * losing answer the moment the snapshot next changed. `name === null` (or blank) deletes
 * the override rather than storing an empty string, which is what falling back to the
 * source name actually means.
 */
export function saveCategoryTranslation(
  db: Db,
  tenantId: string,
  categoryId: string,
  locale: string,
  name: string | null,
): void {
  requireCategory(db, tenantId, categoryId)

  if (locale === integrationsRow(db, tenantId).actualCategorySourceLocale) {
    throw new SourceLocaleError(`${locale} is the household's category source locale, not a translation target`)
  }

  const matches = and(
    eq(categoryTranslations.tenantId, tenantId),
    eq(categoryTranslations.categoryId, categoryId),
    eq(categoryTranslations.locale, locale),
  )

  const trimmed = name?.trim() ?? ''
  if (trimmed === '') {
    db.delete(categoryTranslations).where(matches).run()
    return
  }

  db.insert(categoryTranslations)
    .values({ tenantId, categoryId, locale, name: trimmed })
    .onConflictDoUpdate({
      target: [categoryTranslations.tenantId, categoryTranslations.categoryId, categoryTranslations.locale],
      set: { name: trimmed, updatedAt: new Date() },
    })
    .run()
}

/**
 * Drops every translation on file for one locale, across all categories.
 *
 * Called when the tenant's category source locale changes to this one: `loadCategoryNames`
 * would otherwise keep preferring a now-stale override over the fresh source snapshot, and
 * `saveCategoryTranslation`'s own guard blocks clearing it any other way, since a write for
 * the source locale is rejected outright.
 */
export function clearTranslationsForLocale(db: Db, tenantId: string, locale: string): void {
  db.delete(categoryTranslations)
    .where(and(eq(categoryTranslations.tenantId, tenantId), eq(categoryTranslations.locale, locale)))
    .run()
}
