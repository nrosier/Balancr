/**
 * The gap between "Authentik vouches for this person" and "which household"
 * (#373) — a sibling of `login-flow.ts`, but for the identity that came back
 * from a successful callback with no `users` row behind it.
 *
 * Not `loginFlows`: that table is consumed by the callback itself, ten
 * minutes after it is opened. Not `sessions`: no `userId` exists yet to hang
 * one off. `pendingIdentities` is its own table for exactly that reason, and
 * it stores the same SHA-256-of-the-token idiom `sessions.ts` uses — a read
 * access to a backup yields no usable cookie here either.
 */
import { createHash, randomBytes } from 'node:crypto'
import { eq, lt } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { pendingIdentities } from '../../db/schema.ts'
import type { OidcIdentity } from './oidc.ts'

/** Longer than a login flow's ten minutes — finding an invite code someone
 * sent you takes longer than typing a password. */
export const PENDING_IDENTITY_TTL_MS = 30 * 60 * 1000

const TOKEN_BYTES = 32

export interface PendingToken {
  token: string
  expiresAt: Date
}

/** `sub` travels here too, unlike the wire-facing subset the session endpoint
 * shows — the onboarding completion routes need it to re-authenticate the
 * identity as the one the callback actually saw. */
export interface PendingIdentity {
  sub: string
  email: string | null
  displayName: string | null
}

const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex')

/**
 * Records an authenticated identity as tenantless, and returns the token
 * for the onboarding cookie.
 *
 * Expired rows are swept on the way in, the same choice `startLoginFlow`
 * makes: there are never more than a handful, so a scheduled job for a table
 * that is usually empty would cost more than sweeping on every call.
 */
export function beginOnboarding(db: Db, identity: OidcIdentity, now = new Date()): PendingToken {
  db.delete(pendingIdentities).where(lt(pendingIdentities.expiresAt, now)).run()

  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const expiresAt = new Date(now.getTime() + PENDING_IDENTITY_TTL_MS)

  db.insert(pendingIdentities)
    .values({
      id: hashToken(token),
      oidcSub: identity.sub,
      email: identity.email ?? null,
      displayName: identity.name ?? null,
      createdAt: now,
      expiresAt,
    })
    .run()

  return { token, expiresAt }
}

/**
 * Reads the pending identity without consuming it.
 *
 * Non-destructive on purpose: the SPA polls `/auth/session` repeatedly while
 * the onboarding screen is open, and every one of those reads must see the
 * same row the first one did.
 */
export function peekPendingIdentity(db: Db, token: string, now = new Date()): PendingIdentity | null {
  const row = db.select().from(pendingIdentities).where(eq(pendingIdentities.id, hashToken(token))).all()[0]
  if (row === undefined) return null
  if (row.expiresAt.getTime() <= now.getTime()) return null
  return { sub: row.oidcSub, email: row.email, displayName: row.displayName }
}

/**
 * Consumes the pending identity, or returns null.
 *
 * Delete-then-check-what-was-deleted, like `consumeLoginFlow` — the delete
 * happens first and its result decides the answer, so two concurrent
 * completions cannot both find the same row still there. Callers use this
 * only after the domain mutation it gates has already succeeded (creating
 * the tenant, or redeeming the invite): a race between two completions is an
 * accepted, explicitly-stated trade-off (a recoverable UNIQUE-constraint
 * error or an orphan tenant, never silent corruption) against the
 * alternative of burning a user's only path back into the app on a
 * recoverable client mistake.
 */
export function consumePendingIdentity(db: Db, token: string, now = new Date()): PendingIdentity | null {
  const rows = db.delete(pendingIdentities).where(eq(pendingIdentities.id, hashToken(token))).returning().all()
  const row = rows[0]
  if (row === undefined) return null
  if (row.expiresAt.getTime() <= now.getTime()) return null
  return { sub: row.oidcSub, email: row.email, displayName: row.displayName }
}
