/**
 * Turning an identity from Authentik into a row in `users`.
 *
 * The `sub` claim is the key, not the email address. Authentik lets a person
 * change their address, and an email-keyed lookup would either lose the account's
 * history at that point or — worse, if someone else later takes the old address —
 * hand it over. `sub` is opaque and stable for the life of the provider, which is
 * exactly the property wanted.
 *
 * Balancr is single-user by design, and this file is where that shows: the first
 * subject to log in becomes the `owner`, and anyone after that is a `viewer`. It
 * is a deliberate default rather than a config flag, because the failure it avoids
 * is silent — an Authentik policy widened to a group, and the second person
 * through the door holding write access to someone else's finances. Promoting a
 * viewer is a database edit today; the UI for it belongs with the settings screen.
 */
import { count, eq } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { users } from '../../db/schema.ts'
import { logger } from '../../logger.ts'
import { forbidden } from '../errors.ts'
import type { OidcIdentity } from './oidc.ts'
import type { SessionUser } from './sessions.ts'

const log = logger.child({ module: 'server.auth.users' })

const toSessionUser = (row: {
  id: string
  email: string | null
  displayName: string | null
  locale: string
  role: 'owner' | 'viewer'
}): SessionUser => ({
  id: row.id,
  email: row.email,
  displayName: row.displayName,
  locale: row.locale,
  role: row.role,
})

/**
 * Finds or creates the user behind an identity.
 *
 * Email and display name are refreshed on every login: they are the provider's to
 * own, and a stale name in the UI after someone changes it in Authentik is a small
 * puzzle with no upside. `locale` and `role` are Balancr's own and are never
 * overwritten from claims — the language you chose here should survive a login.
 *
 * A disabled account is refused rather than resurrected. Throwing is right: the
 * caller is a route that must not go on to mint a session.
 */
export function upsertOidcUser(db: Db, identity: OidcIdentity): SessionUser {
  const existing = db.select().from(users).where(eq(users.oidcSub, identity.sub)).all()[0]

  if (existing !== undefined) {
    if (existing.disabled) {
      log.warn({ userId: existing.id }, 'login refused for a disabled account')
      throw forbidden('This account is disabled.')
    }

    const email = identity.email ?? existing.email
    const displayName = identity.name ?? existing.displayName
    const changed = email !== existing.email || displayName !== existing.displayName

    if (changed) {
      db.update(users).set({ email, displayName }).where(eq(users.id, existing.id)).run()
    }
    db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, existing.id)).run()

    return toSessionUser({ ...existing, email, displayName })
  }

  // Counted rather than assumed: a local break-glass account created before the
  // first OIDC login is still a user, and it should not be demoted by having
  // someone else arrive first.
  const [existingCount] = db.select({ value: count() }).from(users).all()
  const isFirstUser = (existingCount?.value ?? 0) === 0

  const created = db
    .insert(users)
    .values({
      oidcSub: identity.sub,
      email: identity.email ?? null,
      displayName: identity.name ?? null,
      locale: 'en',
      role: isFirstUser ? 'owner' : 'viewer',
      lastSeenAt: new Date(),
    })
    .returning()
    .all()[0]

  if (created === undefined) throw new Error('user insert returned no row')

  log.info({ userId: created.id, role: created.role }, 'user created from OIDC identity')
  return toSessionUser(created)
}
