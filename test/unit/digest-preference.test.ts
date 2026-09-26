/**
 * `digest/preference.ts` (#52) — the digest mode/recipients/locale row, stored and
 * loaded the same way `benchmark/household.ts` handles the household composition.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { users } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { config } from '../../src/config.ts'
import {
  DEFAULT_DIGEST_PREFERENCE,
  loadDigestPreference,
  MAX_DIGEST_RECIPIENTS,
  resolveDigestLocale,
  saveDigestPreference,
} from '../../src/domain/digest/preference.ts'
import { createSecondTenant } from '../helpers/second-tenant.ts'

let ctx: ReturnType<typeof createTestDb>
let tenantId: string

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  tenantId = getSoleTenantId(ctx.db)
})

describe('loadDigestPreference', () => {
  it('is off, with no recipients, before anything is saved', () => {
    expect(loadDigestPreference(ctx.db, tenantId)).toEqual(DEFAULT_DIGEST_PREFERENCE)
    expect(DEFAULT_DIGEST_PREFERENCE.mode).toBe('off')
    expect(DEFAULT_DIGEST_PREFERENCE.recipientEmails).toEqual([])
  })
})

describe('saveDigestPreference', () => {
  it('round-trips a pdf preference', () => {
    saveDigestPreference(ctx.db, tenantId, { mode: 'pdf' })
    expect(loadDigestPreference(ctx.db, tenantId)).toEqual({
      mode: 'pdf',
      recipientEmails: [],
      locale: undefined,
    })
  })

  it('round-trips an email preference with its recipients and locale', () => {
    saveDigestPreference(ctx.db, tenantId, {
      mode: 'email',
      recipientEmails: ['a@example.test', 'b@example.test'],
      locale: 'nl',
    })
    expect(loadDigestPreference(ctx.db, tenantId)).toEqual({
      mode: 'email',
      recipientEmails: ['a@example.test', 'b@example.test'],
      locale: 'nl',
    })
  })

  it('replaces the preference wholesale, not merging with what was there', () => {
    saveDigestPreference(ctx.db, tenantId, {
      mode: 'email',
      recipientEmails: ['a@example.test'],
      locale: 'nl',
    })
    saveDigestPreference(ctx.db, tenantId, { mode: 'pdf' })

    expect(loadDigestPreference(ctx.db, tenantId)).toEqual({
      mode: 'pdf',
      recipientEmails: [],
      locale: undefined,
    })
  })

  it('refuses email mode with no recipients', () => {
    expect(() => saveDigestPreference(ctx.db, tenantId, { mode: 'email' })).toThrow()
    expect(loadDigestPreference(ctx.db, tenantId)).toEqual(DEFAULT_DIGEST_PREFERENCE)
  })

  it('refuses more recipients than the cap', () => {
    const recipientEmails = Array.from(
      { length: MAX_DIGEST_RECIPIENTS + 1 },
      (_, i) => `r${String(i)}@example.test`,
    )
    expect(() =>
      saveDigestPreference(ctx.db, tenantId, { mode: 'email', recipientEmails }),
    ).toThrow()
  })

  it('refuses a malformed recipient address', () => {
    expect(() =>
      saveDigestPreference(ctx.db, tenantId, { mode: 'email', recipientEmails: ['not-an-email'] }),
    ).toThrow()
  })
})

describe('resolveDigestLocale', () => {
  it("prefers the preference's own override", () => {
    const preference = saveDigestPreference(ctx.db, tenantId, { mode: 'pdf', locale: 'nl' })
    expect(resolveDigestLocale(ctx.db, tenantId, preference)).toBe('nl')
  })

  it("falls back to the tenant's oldest owner when unset", () => {
    ctx.db
      .insert(users)
      .values([
        {
          tenantId,
          oidcSub: 'sub-newer',
          email: 'newer@example.test',
          displayName: 'Newer',
          role: 'owner',
          locale: 'nl',
          createdAt: new Date('2026-02-01'),
        },
        {
          tenantId,
          oidcSub: 'sub-older',
          email: 'older@example.test',
          displayName: 'Older',
          role: 'owner',
          locale: 'fr',
          createdAt: new Date('2026-01-01'),
        },
      ])
      .run()

    const preference = saveDigestPreference(ctx.db, tenantId, { mode: 'pdf' })
    expect(resolveDigestLocale(ctx.db, tenantId, preference)).toBe('fr')
  })

  it('falls back to config.DEFAULT_LOCALE when the tenant has no owner at all', () => {
    const bare = createSecondTenant(ctx.db, 'No owner')
    expect(resolveDigestLocale(ctx.db, bare, DEFAULT_DIGEST_PREFERENCE)).toBe(config.DEFAULT_LOCALE)
  })
})
