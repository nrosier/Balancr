/**
 * Server-side sessions.
 *
 * The four properties worth a test are the four that were chosen deliberately:
 *
 *  - **The token is not in the table.** `/data` is backed up nightly and a backup
 *    is a file that travels; a stolen snapshot must not contain working cookies.
 *    Asserted by searching the row for the token, not by trusting the hash call.
 *  - **Revocation takes effect on the next request.** The whole reason for a
 *    lookup rather than a signed token.
 *  - **A disabled account loses the sessions it already has.** Otherwise
 *    disabling someone only stops their next login, which is not what the word
 *    means.
 *  - **Renewal is lazy.** A write per request would put one in front of every read
 *    of the dashboard, so the row is only extended once half the window is gone.
 */
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { config } from '../../src/config.ts'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { sessions, users } from '../../src/db/schema.ts'
import {
  createSession,
  destroySession,
  destroyUserSessions,
  hashSessionToken,
  readSession,
  RENEW_BELOW,
  sessionTtlMs,
  sweepSessions,
} from '../../src/server/auth/sessions.ts'

function freshDb(): ReturnType<typeof createTestDb> {
  const ctx = createTestDb()
  applyMigrations(ctx.db as never)
  return ctx
}

function makeUser(db: Db, overrides: { disabled?: boolean; sub?: string } = {}): string {
  const row = db
    .insert(users)
    .values({
      oidcSub: overrides.sub ?? `sub-${crypto.randomUUID()}`,
      email: 'nick@example.test',
      displayName: 'Nick',
      role: 'owner',
      disabled: overrides.disabled ?? false,
    })
    .returning()
    .all()[0]
  if (row === undefined) throw new Error('no user')
  return row.id
}

const mint = (db: Db, userId: string): string =>
  createSession(db, { userId, method: 'oidc', ip: '10.0.0.1', userAgent: 'vitest' }).token

/** Moves a session's deadline, so renewal and expiry can be reached without waiting. */
function setExpiry(db: Db, token: string, at: Date): void {
  db.update(sessions).set({ expiresAt: at }).where(eq(sessions.id, hashSessionToken(token))).run()
}

describe('minting', () => {
  it('never writes the token, only its hash', () => {
    const { db, sqlite } = freshDb()
    try {
      const token = mint(db, makeUser(db))

      const row = db.select().from(sessions).all()[0]
      expect(row).toBeDefined()
      expect(row?.id).toBe(hashSessionToken(token))
      // The real assertion: the token appears nowhere in the row, whatever the
      // column. A future column that cached it would fail here.
      expect(JSON.stringify(row)).not.toContain(token)
      expect(row?.id).not.toBe(token)
    } finally {
      sqlite.close()
    }
  })

  it('mints an unguessable token and records how the session was established', () => {
    const { db, sqlite } = freshDb()
    try {
      const userId = makeUser(db)
      const first = mint(db, userId)
      const second = mint(db, userId)

      expect(first).not.toBe(second)
      // 32 bytes as base64url.
      expect(first.length).toBeGreaterThanOrEqual(43)

      const row = db.select().from(sessions).where(eq(sessions.id, hashSessionToken(first))).all()[0]
      expect(row?.method).toBe('oidc')
      expect(row?.ip).toBe('10.0.0.1')
      expect(row?.userAgent).toBe('vitest')
    } finally {
      sqlite.close()
    }
  })

  it('gives the session the configured window', () => {
    const { db, sqlite } = freshDb()
    try {
      const before = Date.now()
      const created = createSession(db, {
        userId: makeUser(db),
        method: 'local',
        ip: undefined,
        userAgent: undefined,
      })

      expect(sessionTtlMs()).toBe(config.SESSION_TTL_HOURS * 60 * 60 * 1000)
      expect(created.expiresAt.getTime() - before).toBeGreaterThan(0)
      expect(created.expiresAt.getTime() - before).toBeLessThanOrEqual(sessionTtlMs())
    } finally {
      sqlite.close()
    }
  })

  it('sweeps dead rows on the way in', () => {
    const { db, sqlite } = freshDb()
    try {
      const userId = makeUser(db)
      const stale = mint(db, userId)
      setExpiry(db, stale, new Date(Date.now() - 1000))

      mint(db, userId)
      // Bounded by the number of people who still sign in, rather than needing a
      // housekeeping job for a handful of rows.
      expect(db.select().from(sessions).all()).toHaveLength(1)
    } finally {
      sqlite.close()
    }
  })
})

describe('reading', () => {
  it('resolves the user behind the token', () => {
    const { db, sqlite } = freshDb()
    try {
      const userId = makeUser(db)
      const resolved = readSession(db, mint(db, userId))

      expect(resolved?.user.id).toBe(userId)
      expect(resolved?.user.email).toBe('nick@example.test')
      expect(resolved?.user.role).toBe('owner')
      expect(resolved?.session.method).toBe('oidc')
    } finally {
      sqlite.close()
    }
  })

  it('refuses a token that is not a session', () => {
    const { db, sqlite } = freshDb()
    try {
      mint(db, makeUser(db))
      expect(readSession(db, 'not-a-session')).toBeNull()
      expect(readSession(db, '')).toBeNull()
    } finally {
      sqlite.close()
    }
  })

  it('refuses an expired session and deletes the row', () => {
    const { db, sqlite } = freshDb()
    try {
      const token = mint(db, makeUser(db))
      setExpiry(db, token, new Date(Date.now() - 1))

      expect(readSession(db, token)).toBeNull()
      // Not left for the sweeper: a browser that keeps presenting a dead cookie
      // should not keep a row alive.
      expect(db.select().from(sessions).all()).toHaveLength(0)
    } finally {
      sqlite.close()
    }
  })

  it('refuses a session whose account was disabled after it was minted', () => {
    const { db, sqlite } = freshDb()
    try {
      const userId = makeUser(db)
      const token = mint(db, userId)
      expect(readSession(db, token)).not.toBeNull()

      db.update(users).set({ disabled: true }).where(eq(users.id, userId)).run()

      // Disabling has to end the sessions that already exist, or it only stops the
      // next login — which is not what anyone means by disabling an account.
      expect(readSession(db, token)).toBeNull()
    } finally {
      sqlite.close()
    }
  })

  it('leaves the deadline alone while most of the window is left', () => {
    const { db, sqlite } = freshDb()
    try {
      const token = mint(db, makeUser(db))
      const before = db.select().from(sessions).all()[0]?.expiresAt

      readSession(db, token)
      readSession(db, token)

      const after = db.select().from(sessions).all()[0]?.expiresAt
      // A write per request would put one in front of every dashboard read.
      expect(after?.getTime()).toBe(before?.getTime())
    } finally {
      sqlite.close()
    }
  })

  it('extends the deadline once less than half the window is left', () => {
    const { db, sqlite } = freshDb()
    try {
      const userId = makeUser(db)
      const token = mint(db, userId)

      const nearly = new Date(Date.now() + sessionTtlMs() * RENEW_BELOW - 60_000)
      setExpiry(db, token, nearly)

      const resolved = readSession(db, token)
      expect(resolved?.session.expiresAt.getTime()).toBeGreaterThan(nearly.getTime())

      const stored = db.select().from(sessions).all()[0]
      // The returned value and the stored one agree, so the cookie's Max-Age and
      // the row cannot drift apart.
      expect(stored?.expiresAt.getTime()).toBe(resolved?.session.expiresAt.getTime())
      // A renewal is also the cheapest honest moment to record activity.
      expect(db.select().from(users).where(eq(users.id, userId)).all()[0]?.lastSeenAt).not.toBeNull()
    } finally {
      sqlite.close()
    }
  })
})

describe('ending', () => {
  it('takes effect on the next request', () => {
    const { db, sqlite } = freshDb()
    try {
      const token = mint(db, makeUser(db))
      destroySession(db, token)
      // The property a self-contained token cannot offer at all.
      expect(readSession(db, token)).toBeNull()
    } finally {
      sqlite.close()
    }
  })

  it('does not mind being asked twice', () => {
    const { db, sqlite } = freshDb()
    try {
      const token = mint(db, makeUser(db))
      destroySession(db, token)
      expect(() => destroySession(db, token)).not.toThrow()
    } finally {
      sqlite.close()
    }
  })

  it('ends every session of one user without touching another’s', () => {
    const { db, sqlite } = freshDb()
    try {
      const mine = makeUser(db, { sub: 'sub-mine' })
      const theirs = makeUser(db, { sub: 'sub-theirs' })
      const phone = mint(db, mine)
      const laptop = mint(db, mine)
      const other = mint(db, theirs)

      expect(destroyUserSessions(db, mine)).toBe(2)
      expect(readSession(db, phone)).toBeNull()
      expect(readSession(db, laptop)).toBeNull()
      expect(readSession(db, other)).not.toBeNull()
    } finally {
      sqlite.close()
    }
  })

  it('sweeps only what has actually elapsed', () => {
    const { db, sqlite } = freshDb()
    try {
      const userId = makeUser(db)
      const live = mint(db, userId)
      const dead = mint(db, userId)
      setExpiry(db, dead, new Date(Date.now() - 1000))

      expect(sweepSessions(db)).toBe(1)
      expect(readSession(db, live)).not.toBeNull()
    } finally {
      sqlite.close()
    }
  })
})
