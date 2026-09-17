/**
 * The two ways a tenantless identity becomes a real `users` row (#373):
 * starting a household, or redeeming an invite into an existing one.
 *
 * Both are transactions that touch several tables at once — a tenant, its
 * placeholder integrations row, a user, an audit entry — so the tests care
 * about all of those landing together, and about the invite code never
 * turning up anywhere a reader of the database could find it.
 */
import { describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { auditLog, tenantIntegrations, users } from '../../src/db/schema.ts'
import { allTenantIds, getSoleTenantId } from '../../src/db/tenant.ts'
import { createInvite } from '../../src/domain/tenant/invites.ts'
import { createTenantAndOwner, redeemInviteAsViewer } from '../../src/domain/tenant/provisioning.ts'

function freshDb(): ReturnType<typeof createTestDb> {
  const ctx = createTestDb()
  applyMigrations(ctx.db as never)
  return ctx
}

const NICK = { sub: 'ak-nick', email: 'nick@example.test', name: 'Nick' }
const JO = { sub: 'ak-jo', email: 'jo@example.test', name: 'Jo' }

describe('createTenantAndOwner', () => {
  it('creates a household with a working integrations row and its owner', () => {
    const { db, sqlite } = freshDb()
    try {
      const owner = createTenantAndOwner(db, { label: 'The Rosiers', identity: NICK, locale: 'en' })

      expect(owner.role).toBe('owner')
      expect(owner.oidcSub).toBe(NICK.sub)
      expect(owner.email).toBe(NICK.email)
      expect(owner.displayName).toBe(NICK.name)

      const integrations = db
        .select()
        .from(tenantIntegrations)
        .all()
        .find((row) => row.tenantId === owner.tenantId)
      expect(integrations).toBeDefined()

      const entry = db.select().from(auditLog).all().find((row) => row.action === 'tenant.create')
      expect(entry?.entityRef).toBe(owner.tenantId)
      expect(entry?.actorId).toBe(owner.id)
    } finally {
      sqlite.close()
    }
  })

  it('is unconditionally the owner, never counted against other tenants', () => {
    const { db, sqlite } = freshDb()
    try {
      // A pre-existing tenant with its own owner must not affect the count a
      // second, unrelated tenant's creator is judged against.
      createTenantAndOwner(db, { label: 'First household', identity: NICK, locale: 'en' })
      const second = createTenantAndOwner(db, { label: 'Second household', identity: JO, locale: 'en' })

      expect(second.role).toBe('owner')
      expect(allTenantIds(db)).toHaveLength(3) // the bootstrap tenant plus these two
    } finally {
      sqlite.close()
    }
  })

  it('leaves the tenant it seeded through migrations untouched', () => {
    const { db, sqlite } = freshDb()
    try {
      const soleBefore = getSoleTenantId(db)
      const owner = createTenantAndOwner(db, { label: 'New household', identity: NICK, locale: 'en' })

      expect(owner.tenantId).not.toBe(soleBefore)
    } finally {
      sqlite.close()
    }
  })
})

describe('redeemInviteAsViewer', () => {
  it('joins the inviting tenant as a viewer, never an owner', () => {
    const { db, sqlite } = freshDb()
    try {
      const tenantId = getSoleTenantId(db)
      const owner = db.insert(users).values({ tenantId, email: 'owner@example.test', role: 'owner' }).returning().all()[0]
      if (owner === undefined) throw new Error('no user')
      const { code, invite } = createInvite(db, { tenantId, createdBy: owner.id })

      const viewer = redeemInviteAsViewer(db, { code, identity: JO, locale: 'nl' })

      expect(viewer?.role).toBe('viewer')
      expect(viewer?.tenantId).toBe(tenantId)
      expect(viewer?.oidcSub).toBe(JO.sub)
      expect(viewer?.locale).toBe('nl')

      const redeemedInvite = db.select().from(auditLog).all().find((row) => row.action === 'tenant.invite.redeem')
      expect(redeemedInvite?.entityRef).toBe(invite.id)
      expect(redeemedInvite?.actorId).toBe(viewer?.id)
      expect(JSON.stringify(redeemedInvite)).not.toContain(code)
    } finally {
      sqlite.close()
    }
  })

  it('returns null for any invalid code, and creates nobody', () => {
    const { db, sqlite } = freshDb()
    try {
      const viewer = redeemInviteAsViewer(db, { code: 'AAAA-BBBB-CCCC-DDDD', identity: JO, locale: 'en' })

      expect(viewer).toBeNull()
      expect(db.select().from(users).all()).toHaveLength(0)
      expect(db.select().from(auditLog).all().filter((row) => row.action === 'tenant.invite.redeem')).toHaveLength(0)
    } finally {
      sqlite.close()
    }
  })

  it('lets only one of two concurrent redemptions through', () => {
    const { db, sqlite } = freshDb()
    try {
      const tenantId = getSoleTenantId(db)
      const owner = db.insert(users).values({ tenantId, email: 'owner@example.test', role: 'owner' }).returning().all()[0]
      if (owner === undefined) throw new Error('no user')
      const { code } = createInvite(db, { tenantId, createdBy: owner.id })

      const first = redeemInviteAsViewer(db, { code, identity: NICK, locale: 'en' })
      const second = redeemInviteAsViewer(db, { code, identity: JO, locale: 'en' })

      expect(first).not.toBeNull()
      expect(second).toBeNull()
      // Just the owner and the one viewer who actually claimed it.
      expect(db.select().from(users).all()).toHaveLength(2)
    } finally {
      sqlite.close()
    }
  })
})
