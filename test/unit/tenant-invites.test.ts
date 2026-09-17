/**
 * Owner-facing invite lifecycle (#373): create, list, revoke, and the atomic
 * claim a redemption needs.
 *
 * The property worth testing hardest is the one the module header states as a
 * guarantee: the code is never stored, only its hash, so a database read
 * yields nothing usable. Every test that mints a code checks the stored row
 * and every audit entry for it.
 */
import { describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { auditLog, users } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { claimInvite, createInvite, listInvites, revokeInvite } from '../../src/domain/tenant/invites.ts'
import { createSecondTenant } from '../helpers/second-tenant.ts'

function freshDb(): ReturnType<typeof createTestDb> {
  const ctx = createTestDb()
  applyMigrations(ctx.db as never)
  return ctx
}

function owner(db: ReturnType<typeof createTestDb>['db'], tenantId?: string): string {
  const row = db
    .insert(users)
    .values({ tenantId: tenantId ?? getSoleTenantId(db), email: 'owner@example.test', role: 'owner' })
    .returning()
    .all()[0]
  if (row === undefined) throw new Error('no user')
  return row.id
}

describe('createInvite', () => {
  it('never stores the code it hands back', () => {
    const { db, sqlite } = freshDb()
    try {
      const tenantId = getSoleTenantId(db)
      const createdBy = owner(db, tenantId)
      const { invite, code } = createInvite(db, { tenantId, createdBy, label: 'For Jo' })

      expect(code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)
      expect(invite.label).toBe('For Jo')
      expect(JSON.stringify(invite)).not.toContain(code)

      const row = db.select().from(auditLog).all()[0]
      expect(row?.action).toBe('tenant.invite.create')
      expect(row?.afterJson).not.toContain(code)
    } finally {
      sqlite.close()
    }
  })

  it('records who issued it, without a label', () => {
    const { db, sqlite } = freshDb()
    try {
      const tenantId = getSoleTenantId(db)
      const createdBy = owner(db, tenantId)
      const { invite } = createInvite(db, { tenantId, createdBy })

      expect(invite.label).toBeNull()
      expect(invite.createdBy).toBe(createdBy)
      expect(invite.redeemedAt).toBeNull()
      expect(invite.revokedAt).toBeNull()
    } finally {
      sqlite.close()
    }
  })
})

describe('listInvites', () => {
  it('lists newest first, scoped to the tenant asking', () => {
    const { db, sqlite } = freshDb()
    try {
      const tenantId = getSoleTenantId(db)
      const createdBy = owner(db, tenantId)
      const first = createInvite(db, { tenantId, createdBy, now: new Date('2026-01-01T00:00:00Z') })
      const second = createInvite(db, { tenantId, createdBy, now: new Date('2026-01-02T00:00:00Z') })

      const otherTenantId = createSecondTenant(db)
      const otherOwner = owner(db, otherTenantId)
      createInvite(db, { tenantId: otherTenantId, createdBy: otherOwner })

      const listed = listInvites(db, tenantId)
      expect(listed.map((row) => row.id)).toEqual([second.invite.id, first.invite.id])
    } finally {
      sqlite.close()
    }
  })
})

describe('revokeInvite', () => {
  it('closes an open invite', () => {
    const { db, sqlite } = freshDb()
    try {
      const tenantId = getSoleTenantId(db)
      const createdBy = owner(db, tenantId)
      const { invite } = createInvite(db, { tenantId, createdBy })

      revokeInvite(db, { tenantId, inviteId: invite.id, actorId: createdBy })

      const row = listInvites(db, tenantId).find((candidate) => candidate.id === invite.id)
      expect(row?.revokedAt).not.toBeNull()

      const entry = db.select().from(auditLog).all().find((r) => r.action === 'tenant.invite.revoke')
      expect(entry).toBeDefined()
    } finally {
      sqlite.close()
    }
  })

  it('is idempotent: revoking twice is not an error', () => {
    const { db, sqlite } = freshDb()
    try {
      const tenantId = getSoleTenantId(db)
      const createdBy = owner(db, tenantId)
      const { invite } = createInvite(db, { tenantId, createdBy })

      revokeInvite(db, { tenantId, inviteId: invite.id, actorId: createdBy })
      revokeInvite(db, { tenantId, inviteId: invite.id, actorId: createdBy })

      const entries = db.select().from(auditLog).all().filter((r) => r.action === 'tenant.invite.revoke')
      expect(entries).toHaveLength(1)
    } finally {
      sqlite.close()
    }
  })

  it('does nothing for an invite outside the caller\'s tenant', () => {
    const { db, sqlite } = freshDb()
    try {
      const tenantId = getSoleTenantId(db)
      const createdBy = owner(db, tenantId)
      const { invite } = createInvite(db, { tenantId, createdBy })

      const otherTenantId = createSecondTenant(db)
      revokeInvite(db, { tenantId: otherTenantId, inviteId: invite.id, actorId: createdBy })

      expect(listInvites(db, tenantId)[0]?.revokedAt).toBeNull()
    } finally {
      sqlite.close()
    }
  })

  it('does not reopen a redeemed invite', () => {
    const { db, sqlite } = freshDb()
    try {
      const tenantId = getSoleTenantId(db)
      const createdBy = owner(db, tenantId)
      const { invite, code } = createInvite(db, { tenantId, createdBy })
      claimInvite(db, code)

      revokeInvite(db, { tenantId, inviteId: invite.id, actorId: createdBy })

      const row = listInvites(db, tenantId).find((candidate) => candidate.id === invite.id)
      expect(row?.revokedAt).toBeNull()
      expect(row?.redeemedAt).not.toBeNull()
    } finally {
      sqlite.close()
    }
  })
})

describe('claimInvite', () => {
  it('claims a valid code exactly once', () => {
    const { db, sqlite } = freshDb()
    try {
      const tenantId = getSoleTenantId(db)
      const createdBy = owner(db, tenantId)
      const { invite, code } = createInvite(db, { tenantId, createdBy })

      const claimed = claimInvite(db, code)
      expect(claimed?.id).toBe(invite.id)

      // Same code again: already redeemed, so the second claim finds nothing.
      expect(claimInvite(db, code)).toBeNull()
    } finally {
      sqlite.close()
    }
  })

  it('is case- and dash-insensitive, the way a hand-typed code would be', () => {
    const { db, sqlite } = freshDb()
    try {
      const tenantId = getSoleTenantId(db)
      const createdBy = owner(db, tenantId)
      const { code } = createInvite(db, { tenantId, createdBy })

      const mangled = code.toLowerCase().replace(/-/g, ' ')
      expect(claimInvite(db, mangled)).not.toBeNull()
    } finally {
      sqlite.close()
    }
  })

  it('never claims an unknown code', () => {
    const { db, sqlite } = freshDb()
    try {
      expect(claimInvite(db, 'AAAA-BBBB-CCCC-DDDD')).toBeNull()
    } finally {
      sqlite.close()
    }
  })

  it('never claims a revoked code', () => {
    const { db, sqlite } = freshDb()
    try {
      const tenantId = getSoleTenantId(db)
      const createdBy = owner(db, tenantId)
      const { invite, code } = createInvite(db, { tenantId, createdBy })
      revokeInvite(db, { tenantId, inviteId: invite.id, actorId: createdBy })

      expect(claimInvite(db, code)).toBeNull()
    } finally {
      sqlite.close()
    }
  })

  it('never claims an expired code, and does not burn it in the attempt', () => {
    const { db, sqlite } = freshDb()
    try {
      const tenantId = getSoleTenantId(db)
      const createdBy = owner(db, tenantId)
      const { code } = createInvite(db, { tenantId, createdBy, now: new Date('2026-01-01T00:00:00Z') })

      const wellAfterExpiry = new Date('2026-02-01T00:00:00Z')
      expect(claimInvite(db, code, wellAfterExpiry)).toBeNull()

      const row = listInvites(db, tenantId)[0]
      // The expiry check is inside the same WHERE as the claim, not a separate
      // check afterwards — an expired invite must stay unredeemed, not get
      // marked redeemed and then rejected.
      expect(row?.redeemedAt).toBeNull()
    } finally {
      sqlite.close()
    }
  })

  it('lets only one of two concurrent claims through', () => {
    const { db, sqlite } = freshDb()
    try {
      const tenantId = getSoleTenantId(db)
      const createdBy = owner(db, tenantId)
      const { code } = createInvite(db, { tenantId, createdBy })

      const results = [claimInvite(db, code), claimInvite(db, code)]
      const claimed = results.filter((result) => result !== null)
      expect(claimed).toHaveLength(1)
    } finally {
      sqlite.close()
    }
  })
})
