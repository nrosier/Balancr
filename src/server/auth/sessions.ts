/**
 * Sessions, server-side.
 *
 * The cookie carries 32 random bytes and nothing else. Not a signed payload, not
 * a JWT: this application already has a database on the request path, so the
 * lookup is free, and a lookup buys two things a self-contained token cannot.
 * Revocation is a `delete` that takes effect on the next request rather than
 * whenever the token happens to expire, and there is no signing key whose leak
 * would mint valid identities.
 *
 * What is stored is `sha256(token)`, never the token. `/data` gets backed up
 * nightly and a backup is a file that travels; a stolen snapshot of this table
 * should not contain working cookies. No salt and no slow KDF, deliberately — the
 * input is 32 uniformly random bytes, so there is no dictionary to build and
 * nothing for a work factor to slow down.
 *
 * Expiry is renewed rather than fixed, but not on every request: rewriting a row
 * per request would put a write in front of every read of the dashboard. The row
 * is extended only once its remaining life drops below half the window, which
 * makes an active session effectively permanent and an abandoned one expire on
 * schedule, for one write every few days.
 */
import { createHash, randomBytes } from 'node:crypto'
import { eq, lt } from 'drizzle-orm'
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import { sessions, users } from '../../db/schema.ts'

/** 32 bytes, base64url. The same order as the CSRF token, and beyond guessing. */
export const SESSION_TOKEN_BYTES = 32

/** How long a session lives from its last renewal. */
export const sessionTtlMs = (): number => config.SESSION_TTL_HOURS * 60 * 60 * 1000

/**
 * Renew when less than this fraction of the window is left.
 *
 * Half: high enough that a daily user is never renewed more than a couple of
 * times a week, low enough that someone who reads the dashboard once a week keeps
 * their session rather than being logged out on the eighth day.
 */
export const RENEW_BELOW = 0.5

/**
 * The stored form of a token.
 *
 * Exported because the tests assert that the token itself is absent from the
 * table, and that assertion needs to know how to find the row it should not be in.
 */
export const hashSessionToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex')

export interface SessionUser {
  id: string
  email: string | null
  displayName: string | null
  locale: string
  role: 'owner' | 'viewer'
}

export interface ActiveSession {
  id: string
  userId: string
  method: 'oidc' | 'local'
  expiresAt: Date
}

export interface CreateSessionInput {
  userId: string
  method: 'oidc' | 'local'
  /** For the audit trail only — the header-derived address, not a trust decision. */
  ip: string | undefined
  userAgent: string | undefined
}

export interface CreatedSession {
  /** Give this to the browser. It is not stored anywhere. */
  token: string
  expiresAt: Date
}

/**
 * Mints a session and hands back the token to put in the cookie.
 *
 * Expired rows are swept here rather than by a scheduled job, for the same reason
 * `login-flow.ts` does it on start: a login is rare, so the sweep is free, and it
 * bounds the table by the number of people who still sign in rather than by how
 * long the container has been up. `readSession` deletes the row it finds expired,
 * so what accumulates is only sessions whose browser never came back.
 */
export function createSession(db: Db, input: CreateSessionInput): CreatedSession {
  const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url')
  const now = Date.now()
  const expiresAt = new Date(now + sessionTtlMs())

  sweepSessions(db, new Date(now))

  db.insert(sessions)
    .values({
      id: hashSessionToken(token),
      userId: input.userId,
      method: input.method,
      expiresAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    })
    .run()

  return { token, expiresAt }
}

export interface ResolvedSession {
  session: ActiveSession
  user: SessionUser
}

/**
 * Looks a token up, or returns null.
 *
 * An expired row is deleted rather than left to the sweeper, so the table does
 * not accumulate rows for a browser that keeps presenting a dead cookie. A
 * disabled user is refused here too: disabling an account has to end the sessions
 * it already has, or it only stops the next login.
 */
export function readSession(db: Db, token: string): ResolvedSession | null {
  if (token.length === 0) return null

  const rows = db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      method: sessions.method,
      expiresAt: sessions.expiresAt,
      userEmail: users.email,
      userDisplayName: users.displayName,
      userLocale: users.locale,
      userRole: users.role,
      userDisabled: users.disabled,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, hashSessionToken(token)))
    .all()

  const row = rows[0]
  if (row === undefined) return null

  const now = Date.now()
  if (row.expiresAt.getTime() <= now) {
    db.delete(sessions).where(eq(sessions.id, row.id)).run()
    return null
  }
  if (row.userDisabled) return null

  const ttl = sessionTtlMs()
  let expiresAt = row.expiresAt
  if (row.expiresAt.getTime() - now < ttl * RENEW_BELOW) {
    expiresAt = new Date(now + ttl)
    db.update(sessions).set({ expiresAt }).where(eq(sessions.id, row.id)).run()
    db.update(users).set({ lastSeenAt: new Date(now) }).where(eq(users.id, row.userId)).run()
  }

  return {
    session: { id: row.id, userId: row.userId, method: row.method, expiresAt },
    user: {
      id: row.userId,
      email: row.userEmail,
      displayName: row.userDisplayName,
      locale: row.userLocale,
      role: row.userRole,
    },
  }
}

/** Ends one session. Idempotent, so a repeated logout is not an error. */
export function destroySession(db: Db, token: string): void {
  db.delete(sessions).where(eq(sessions.id, hashSessionToken(token))).run()
}

/** Ends every session a user has. For a password change or a disabled account. */
export function destroyUserSessions(db: Db, userId: string): number {
  return db.delete(sessions).where(eq(sessions.userId, userId)).returning().all().length
}

/** Removes rows nothing will ever look up again. */
export function sweepSessions(db: Db, now = new Date()): number {
  return db.delete(sessions).where(lt(sessions.expiresAt, now)).returning().all().length
}
