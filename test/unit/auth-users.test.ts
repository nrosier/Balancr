/**
 * Turning an Authentik identity into a row in `users`.
 *
 * Three decisions are load-bearing and each is tested:
 *
 *  - **`sub` is the key, not the email.** An email-keyed lookup loses the account's
 *    history when someone changes their address, and hands the account over if
 *    that address is later reused by somebody else.
 *  - **The first subject through the door is the owner; everyone after is a
 *    viewer.** The failure this avoids is silent — an Authentik policy widened to
 *    a group, and the second person arriving with write access to someone else's
 *    finances.
 *  - **`locale` and `role` are Balancr's, not the provider's.** A login must not
 *    overwrite the language you chose here, or quietly re-grant a role.
 */
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { users } from '../../src/db/schema.ts'
import type { OidcIdentity } from '../../src/server/auth/oidc.ts'
import { upsertOidcUser } from '../../src/server/auth/users.ts'
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

/** A local break-glass account, which exists before any OIDC login happens. */
function localAccount(db: Db): string {
  const row = db
    .insert(users)
    .values({ oidcSub: null, email: 'break@glass.test', role: 'owner' })
    .returning()
    .all()[0]
  if (row === undefined) throw new Error('no user')
  return row.id
}

describe('the first login', () => {
  it('creates the user as owner', () => {
    const { db, sqlite } = freshDb()
    try {
      const user = upsertOidcUser(db, identity())

      expect(user.role).toBe('owner')
      expect(user.email).toBe('nick@example.test')
      expect(user.displayName).toBe('Nick')
      expect(user.locale).toBe('en')
    } finally {
      sqlite.close()
    }
  })

  it('makes a second subject a viewer', () => {
    const { db, sqlite } = freshDb()
    try {
      expect(upsertOidcUser(db, identity()).role).toBe('owner')
      // The case that matters: an Authentik application assigned to a group rather
      // than to a person, and somebody else signs in.
      expect(upsertOidcUser(db, identity({ sub: 'ak-2' })).role).toBe('viewer')
    } finally {
      sqlite.close()
    }
  })

  it('does not treat a pre-existing local account as nobody', () => {
    const { db, sqlite } = freshDb()
    try {
      localAccount(db)
      // Counted rather than assumed: the break-glass account is a user, so the
      // first OIDC login is not the first user and must not arrive as owner.
      expect(upsertOidcUser(db, identity()).role).toBe('viewer')
    } finally {
      sqlite.close()
    }
  })

  it('copes with a provider that sends no email or name', () => {
    const { db, sqlite } = freshDb()
    try {
      const user = upsertOidcUser(db, { sub: 'ak-1', email: undefined, name: undefined })
      expect(user.email).toBeNull()
      expect(user.displayName).toBeNull()
      expect(user.role).toBe('owner')
    } finally {
      sqlite.close()
    }
  })
})

describe('a returning login', () => {
  it('finds the same row again rather than creating a second', () => {
    const { db, sqlite } = freshDb()
    try {
      const first = upsertOidcUser(db, identity())
      const second = upsertOidcUser(db, identity())

      expect(second.id).toBe(first.id)
      expect(db.select().from(users).all()).toHaveLength(1)
    } finally {
      sqlite.close()
    }
  })

  it('follows the subject through an email change', () => {
    const { db, sqlite } = freshDb()
    try {
      const before = upsertOidcUser(db, identity())
      const after = upsertOidcUser(db, identity({ email: 'nick@newdomain.test' }))

      // Same account, new address. Keyed on email this would have been a new user
      // with none of the history.
      expect(after.id).toBe(before.id)
      expect(after.email).toBe('nick@newdomain.test')
    } finally {
      sqlite.close()
    }
  })

  it('does not hand the account to whoever inherits the old address', () => {
    const { db, sqlite } = freshDb()
    try {
      const mine = upsertOidcUser(db, identity())
      const someoneElse = upsertOidcUser(db, identity({ sub: 'ak-2' }))

      expect(someoneElse.id).not.toBe(mine.id)
      expect(someoneElse.role).toBe('viewer')
    } finally {
      sqlite.close()
    }
  })

  it('refreshes the display name from the provider', () => {
    const { db, sqlite } = freshDb()
    try {
      const before = upsertOidcUser(db, identity())
      const after = upsertOidcUser(db, identity({ name: 'Nick R.' }))

      expect(after.id).toBe(before.id)
      expect(after.displayName).toBe('Nick R.')
    } finally {
      sqlite.close()
    }
  })

  it('keeps the locale and the role that Balancr decided', () => {
    const { db, sqlite } = freshDb()
    try {
      const user = upsertOidcUser(db, identity())
      db.update(users).set({ locale: 'nl', role: 'viewer' }).where(eq(users.id, user.id)).run()

      const again = upsertOidcUser(db, identity())
      // The language you chose here should survive a login, and a claim should not
      // be able to re-grant a role that was deliberately reduced.
      expect(again.locale).toBe('nl')
      expect(again.role).toBe('viewer')
    } finally {
      sqlite.close()
    }
  })

  it('records the visit', () => {
    const { db, sqlite } = freshDb()
    try {
      const user = upsertOidcUser(db, identity())
      db.update(users).set({ lastSeenAt: null }).where(eq(users.id, user.id)).run()

      upsertOidcUser(db, identity())
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
      const user = upsertOidcUser(db, identity())
      db.update(users).set({ disabled: true }).where(eq(users.id, user.id)).run()

      // A throw, not a null: the caller is a route that must not go on to mint a
      // session, and 403 is the honest status.
      let thrown: unknown
      try {
        upsertOidcUser(db, identity())
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
