import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { categoryMeta, monthlyCategoryFacts, tenantIntegrations } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import {
  loadCategoryNames,
  loadFacts,
} from '../../src/domain/aggregate/facts.ts'
import {
  clearTranslationsForLocale,
  loadCategoryTranslationRows,
  saveCategoryTranslation,
  SourceLocaleError,
  TranslationError,
} from '../../src/domain/i18n/category-translations.ts'
import { createSecondTenant } from '../helpers/second-tenant.ts'

describe('category translations (#479)', () => {
  let ctx: ReturnType<typeof createTestDb>
  let TENANT_ID: string

  beforeEach(() => {
    ctx = createTestDb()
    applyMigrations(ctx.db as never)
    TENANT_ID = getSoleTenantId(ctx.db)
  })

  interface Row {
    id: string
    name: string
    isIncome?: boolean
    hidden?: boolean
  }

  function seed(rows: Row[], tenantId = TENANT_ID): void {
    for (const entry of rows) {
      ctx.db
        .insert(categoryMeta)
        .values({
          tenantId,
          categoryId: entry.id,
          nameSnapshot: entry.name,
          isIncome: entry.isIncome ?? false,
          hidden: entry.hidden ?? false,
        })
        .run()
    }
  }

  /** A tenant with no seeded `tenant_integrations` row has no source locale on record at all. */
  function seedSourceLocale(locale: string, tenantId = TENANT_ID): void {
    ctx.db
      .insert(tenantIntegrations)
      .values({
        tenantId,
        actualServerUrl: '',
        actualPasswordEnc: '',
        actualSyncId: '',
        actualCategorySourceLocale: locale,
        ghostfolioUrl: '',
        ghostfolioSecurityTokenEnc: '',
        aiProvider: 'gemini-aistudio',
        aiApiKeyEnc: null,
        googleCloudProject: null,
      })
      .onConflictDoUpdate({
        target: tenantIntegrations.tenantId,
        set: { actualCategorySourceLocale: locale },
      })
      .run()
  }

  describe('saveCategoryTranslation', () => {
    it('writes a name for a locale, and reads it back through loadCategoryNames', () => {
      seed([{ id: 'groceries', name: 'Groceries' }])
      seedSourceLocale('en')

      saveCategoryTranslation(ctx.db, TENANT_ID, 'groceries', 'nl', 'Boodschappen')

      expect(loadCategoryNames(ctx.db, TENANT_ID, 'nl').get('groceries')).toBe('Boodschappen')
      // Untouched locales still fall back to the source snapshot.
      expect(loadCategoryNames(ctx.db, TENANT_ID, 'fr').get('groceries')).toBe('Groceries')
    })

    it('clears an override back to the source name when given null', () => {
      seed([{ id: 'groceries', name: 'Groceries' }])
      seedSourceLocale('en')

      saveCategoryTranslation(ctx.db, TENANT_ID, 'groceries', 'nl', 'Boodschappen')
      saveCategoryTranslation(ctx.db, TENANT_ID, 'groceries', 'nl', null)

      expect(loadCategoryNames(ctx.db, TENANT_ID, 'nl').get('groceries')).toBe('Groceries')
    })

    it('clears an override back to the source name when given a blank string', () => {
      seed([{ id: 'groceries', name: 'Groceries' }])
      seedSourceLocale('en')

      saveCategoryTranslation(ctx.db, TENANT_ID, 'groceries', 'nl', 'Boodschappen')
      saveCategoryTranslation(ctx.db, TENANT_ID, 'groceries', 'nl', '   ')

      expect(loadCategoryNames(ctx.db, TENANT_ID, 'nl').get('groceries')).toBe('Groceries')
    })

    it('overwrites an existing translation rather than duplicating the row', () => {
      seed([{ id: 'groceries', name: 'Groceries' }])
      seedSourceLocale('en')

      saveCategoryTranslation(ctx.db, TENANT_ID, 'groceries', 'nl', 'Boodschappen')
      saveCategoryTranslation(ctx.db, TENANT_ID, 'groceries', 'nl', 'Kruidenier')

      expect(loadCategoryNames(ctx.db, TENANT_ID, 'nl').get('groceries')).toBe('Kruidenier')
    })

    it('refuses to invent a category', () => {
      seedSourceLocale('en')
      // `category_meta` rows come from what Actual actually has. One conjured here would
      // sit in the translation table for ever with nothing to tell it from a real one.
      expect(() => saveCategoryTranslation(ctx.db, TENANT_ID, 'ghost', 'nl', 'Spook')).toThrow(
        TranslationError,
      )
    })

    it('refuses a translation for the tenant\'s own configured source locale', () => {
      seed([{ id: 'groceries', name: 'Groceries' }])
      seedSourceLocale('en')

      expect(() => saveCategoryTranslation(ctx.db, TENANT_ID, 'groceries', 'en', 'Groceries 2')).toThrow(
        SourceLocaleError,
      )
      // Confirmed to be a no-op: no row was written for the rejected locale.
      expect(loadCategoryTranslationRows(ctx.db, TENANT_ID)[0]?.translations).toEqual({})
    })

    it('keeps category metadata inside the requested tenant (#409)', () => {
      const tenantB = createSecondTenant(ctx.db)
      seed([{ id: 'same-id', name: 'A groceries' }])
      seed([{ id: 'same-id', name: 'B groceries' }], tenantB)
      seedSourceLocale('en')
      seedSourceLocale('en', tenantB)

      saveCategoryTranslation(ctx.db, tenantB, 'same-id', 'nl', 'B boodschappen')

      expect(loadCategoryNames(ctx.db, TENANT_ID, 'nl').get('same-id')).toBe('A groceries')
      expect(loadCategoryNames(ctx.db, tenantB, 'nl').get('same-id')).toBe('B boodschappen')
    })
  })

  describe('clearTranslationsForLocale', () => {
    it('drops every translation on file for that locale, across categories', () => {
      seed([
        { id: 'groceries', name: 'Groceries' },
        { id: 'rent', name: 'Rent' },
      ])
      seedSourceLocale('en')

      saveCategoryTranslation(ctx.db, TENANT_ID, 'groceries', 'nl', 'Boodschappen')
      saveCategoryTranslation(ctx.db, TENANT_ID, 'rent', 'nl', 'Huur')
      saveCategoryTranslation(ctx.db, TENANT_ID, 'groceries', 'fr', 'Courses')

      clearTranslationsForLocale(ctx.db, TENANT_ID, 'nl')

      expect(loadCategoryNames(ctx.db, TENANT_ID, 'nl').get('groceries')).toBe('Groceries')
      expect(loadCategoryNames(ctx.db, TENANT_ID, 'nl').get('rent')).toBe('Rent')
      // The other locale's override is untouched.
      expect(loadCategoryNames(ctx.db, TENANT_ID, 'fr').get('groceries')).toBe('Courses')
    })

    it('leaves other tenants alone (#409)', () => {
      const tenantB = createSecondTenant(ctx.db)
      seed([{ id: 'groceries', name: 'Groceries' }])
      seed([{ id: 'groceries', name: 'B groceries' }], tenantB)
      seedSourceLocale('en')
      seedSourceLocale('en', tenantB)

      saveCategoryTranslation(ctx.db, TENANT_ID, 'groceries', 'nl', 'Boodschappen')
      saveCategoryTranslation(ctx.db, tenantB, 'groceries', 'nl', 'B boodschappen')

      clearTranslationsForLocale(ctx.db, TENANT_ID, 'nl')

      expect(loadCategoryNames(ctx.db, TENANT_ID, 'nl').get('groceries')).toBe('Groceries')
      expect(loadCategoryNames(ctx.db, tenantB, 'nl').get('groceries')).toBe('B boodschappen')
    })
  })

  describe('loadCategoryTranslationRows', () => {
    it('lists every category, translated or not', () => {
      seed([
        { id: 'groceries', name: 'Groceries' },
        { id: 'rent', name: 'Rent' },
      ])
      seedSourceLocale('en')

      saveCategoryTranslation(ctx.db, TENANT_ID, 'groceries', 'nl', 'Boodschappen')

      const rows = loadCategoryTranslationRows(ctx.db, TENANT_ID)
      expect(rows.map((row) => row.categoryId).sort()).toEqual(['groceries', 'rent'])
      expect(rows.find((row) => row.categoryId === 'groceries')?.translations).toEqual({
        nl: 'Boodschappen',
      })
      expect(rows.find((row) => row.categoryId === 'rent')?.translations).toEqual({})
    })

    it('carries one entry per locale a category has been translated into', () => {
      seed([{ id: 'groceries', name: 'Groceries' }])
      seedSourceLocale('en')

      saveCategoryTranslation(ctx.db, TENANT_ID, 'groceries', 'nl', 'Boodschappen')
      saveCategoryTranslation(ctx.db, TENANT_ID, 'groceries', 'fr', 'Courses')

      expect(loadCategoryTranslationRows(ctx.db, TENANT_ID)[0]?.translations).toEqual({
        nl: 'Boodschappen',
        fr: 'Courses',
      })
    })
  })

  describe('loadFacts with a locale', () => {
    function seedFact(categoryId: string, month = '2026-08'): void {
      ctx.db
        .insert(monthlyCategoryFacts)
        .values({ tenantId: TENANT_ID, month, categoryId, spentCents: 1_000, txnCount: 1 })
        .run()
    }

    it('resolves a translated name into the category list', () => {
      seed([{ id: 'groceries', name: 'Groceries' }])
      seedSourceLocale('en')
      seedFact('groceries')
      saveCategoryTranslation(ctx.db, TENANT_ID, 'groceries', 'nl', 'Boodschappen')

      const facts = loadFacts(ctx.db, TENANT_ID, '2026-08', 'nl')
      expect(facts.find((fact) => fact.categoryId === 'groceries')?.categoryName).toBe('Boodschappen')
    })

    it('falls back to the source snapshot when no locale is given', () => {
      seed([{ id: 'groceries', name: 'Groceries' }])
      seedSourceLocale('en')
      seedFact('groceries')
      saveCategoryTranslation(ctx.db, TENANT_ID, 'groceries', 'nl', 'Boodschappen')

      const facts = loadFacts(ctx.db, TENANT_ID, '2026-08')
      expect(facts.find((fact) => fact.categoryId === 'groceries')?.categoryName).toBe('Groceries')
    })
  })
})
