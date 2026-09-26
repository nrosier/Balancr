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
import { storeNarrative } from '../../src/domain/ai/narrative.ts'
import { recordRun } from '../../src/domain/ai/runs.ts'
import {
  DEFAULT_DIGEST_PREFERENCE,
  loadDigestPreference,
  MAX_DIGEST_RECIPIENTS,
  resolveDigestLocale,
  saveDigestPreference,
} from '../../src/domain/digest/preference.ts'
import { createSecondTenant } from '../helpers/second-tenant.ts'

const PERIOD = '2026-03'

function storeSomeNarrative(locale: string): void {
  const runId = recordRun(ctx.db, tenantId, {
    kind: 'narrative',
    provider: 'gemini-aistudio',
    model: 'gemini-3.7-flash',
    locale,
    payload: {},
    payloadHash: 'unrelated-hash',
    status: 'ok',
  })
  storeNarrative(ctx.db, tenantId, { runId, period: PERIOD, locale, bodyMd: 'text' })
}

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
  it("prefers the preference's own override, even with no narrative in it (an owner's deliberate choice)", () => {
    const preference = saveDigestPreference(ctx.db, tenantId, { mode: 'pdf', locale: 'nl' })
    expect(resolveDigestLocale(ctx.db, tenantId, PERIOD, preference)).toBe('nl')
  })

  it("follows the tenant's oldest owner when unset and this period has a narrative in that language", () => {
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
    storeSomeNarrative('fr')

    const preference = saveDigestPreference(ctx.db, tenantId, { mode: 'pdf' })
    expect(resolveDigestLocale(ctx.db, tenantId, PERIOD, preference)).toBe('fr')
  })

  it(
    "falls back to config.DEFAULT_LOCALE when the oldest owner's language has no narrative for " +
      'this period — nothing in the nightly pipeline ever writes one in anything but the default, ' +
      "so following the owner's account language here would otherwise silently skip every month",
    () => {
      ctx.db
        .insert(users)
        .values({
          tenantId,
          oidcSub: 'sub-owner',
          email: 'owner@example.test',
          displayName: 'Owner',
          role: 'owner',
          locale: 'fr',
        })
        .run()
      storeSomeNarrative(config.DEFAULT_LOCALE)

      const preference = saveDigestPreference(ctx.db, tenantId, { mode: 'pdf' })
      expect(resolveDigestLocale(ctx.db, tenantId, PERIOD, preference)).toBe(config.DEFAULT_LOCALE)
    },
  )

  it('falls back to config.DEFAULT_LOCALE when the tenant has no owner at all', () => {
    const bare = createSecondTenant(ctx.db, 'No owner')
    expect(resolveDigestLocale(ctx.db, bare, PERIOD, DEFAULT_DIGEST_PREFERENCE)).toBe(config.DEFAULT_LOCALE)
  })
})
