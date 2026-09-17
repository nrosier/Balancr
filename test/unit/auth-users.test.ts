/**
 * Turning an Authentik identity into a row in `users` — or, since #373,
 * refusing to.
 *
 * Three decisions are load-bearing and each is tested:
 *
 *  - **An unknown `sub` gets no row at all.** Provisioning moved to
 *    onboarding (`domain/tenant/provisioning.ts`); this function's job
 *    shrank to "find the existing row, or say there isn't one."
 *  - **`sub` is the key, not the email.** An email-keyed lookup loses the account's
 *    history when someone changes their address, and hands the account over if
 *    that address is later reused by somebody else.
 *  - **`locale` and `role` are Balancr's, not the provider's.** A login must not
 *    overwrite the language you chose here, or quietly re-grant a role.
 */
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { users } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import type { OidcIdentity } from '../../src/server/auth/oidc.ts'
import { resolveOidcUser } from '../../src/server/auth/users.ts'
import { HttpError } from '../../src/server/errors.ts'

function freshDb(): ReturnType<typeof createTestDb> {
  const ctx = createTestDb()
  applyMigrations(ctx.db as never)
  return ctx
}

const identity = (over: Partial<OidcIdentity> = {}): OidcIdentity => ({
  sub: 'ak-1',
  email: 'nick@example.test',
  name: 'Nick',
  ...over,
})

/** A user row already sitting in the tenant, as if provisioned by onboarding. */
function seedUser(db: Db, over: Partial<typeof users.$inferInsert> = {}): string {
  const row = db
    .insert(users)
    .values({
      tenantId: getSoleTenantId(db),
      oidcSub: 'ak-1',
      email: 'nick@example.test',
      displayName: 'Nick',
      role: 'owner',
      ...over,
    })
    .returning()
    .all()[0]
  if (row === undefined) throw new Error('no user')
  return row.id
}

describe('an unknown subject', () => {
  it('gets no row, rather than being auto-provisioned', () => {
    const { db, sqlite } = freshDb()
    try {
      expect(resolveOidcUser(db, identity())).toBeNull()
      expect(db.select().from(users).all()).toHaveLength(0)
    } finally {
      sqlite.close()
    }
  })

  it('is still nobody even with no email or name to go on', () => {
    const { db, sqlite } = freshDb()
    try {
      expect(resolveOidcUser(db, { sub: 'ak-1', email: undefined, name: undefined })).toBeNull()
      expect(db.select().from(users).all()).toHaveLength(0)
    } finally {
      sqlite.close()
    }
  })

  it('does not treat a pre-existing local account as this subject', () => {
    const { db, sqlite } = freshDb()
    try {
      seedUser(db, { oidcSub: null, email: 'break@glass.test' })
      expect(resolveOidcUser(db, identity())).toBeNull()
    } finally {
      sqlite.close()
    }
  })
})

describe('a returning login', () => {
  it('finds the same row again rather than creating a second', () => {
    const { db, sqlite } = freshDb()
    try {
      const id = seedUser(db)
      const found = resolveOidcUser(db, identity())

      expect(found?.id).toBe(id)
      expect(db.select().from(users).all()).toHaveLength(1)
    } finally {
      sqlite.close()
    }
  })

  it('follows the subject through an email change', () => {
    const { db, sqlite } = freshDb()
    try {
      const id = seedUser(db)
      const after = resolveOidcUser(db, identity({ email: 'nick@newdomain.test' }))

      // Same account, new address. Keyed on email this would have found no user at all.
      expect(after?.id).toBe(id)
      expect(after?.email).toBe('nick@newdomain.test')
    } finally {
      sqlite.close()
    }
  })

  it('does not hand the account to whoever inherits the old address', () => {
    const { db, sqlite } = freshDb()
    try {
      const mine = seedUser(db)
      const someoneElse = resolveOidcUser(db, identity({ sub: 'ak-2' }))

      expect(someoneElse).toBeNull()
      expect(mine).not.toBeNull()
    } finally {
      sqlite.close()
    }
  })

  it('refreshes the display name from the provider', () => {
    const { db, sqlite } = freshDb()
    try {
      const id = seedUser(db)
      const after = resolveOidcUser(db, identity({ name: 'Nick R.' }))

      expect(after?.id).toBe(id)
      expect(after?.displayName).toBe('Nick R.')
    } finally {
      sqlite.close()
    }
  })

  it('keeps the locale and the role that Balancr decided', () => {
    const { db, sqlite } = freshDb()
    try {
      const id = seedUser(db)
      db.update(users).set({ locale: 'nl', role: 'viewer' }).where(eq(users.id, id)).run()

      const again = resolveOidcUser(db, identity())
      // The language you chose here should survive a login, and a claim should not
      // be able to re-grant a role that was deliberately reduced.
      expect(again?.locale).toBe('nl')
      expect(again?.role).toBe('viewer')
    } finally {
      sqlite.close()
    }
  })

  it('records the visit', () => {
    const { db, sqlite } = freshDb()
    try {
      const id = seedUser(db)
      db.update(users).set({ lastSeenAt: null }).where(eq(users.id, id)).run()

      resolveOidcUser(db, identity())
      expect(db.select().from(users).all()[0]?.lastSeenAt).not.toBeNull()
    } finally {
      sqlite.close()
    }
  })
})

describe('a disabled account', () => {
  it('is refused rather than resurrected', () => {
    const { db, sqlite } = freshDb()
    try {
      const id = seedUser(db)
      db.update(users).set({ disabled: true }).where(eq(users.id, id)).run()

      // A throw, not a null: the caller is a route that must not go on to mint a
      // session, and 403 is the honest status.
      let thrown: unknown
      try {
        resolveOidcUser(db, identity())
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(HttpError)
      expect((thrown as HttpError).statusCode).toBe(403)
      expect(db.select().from(users).all()[0]?.disabled).toBe(true)
    } finally {
      sqlite.close()
    }
  })
})
