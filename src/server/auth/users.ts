/**
 * Turning an identity from Authentik into a row in `users`.
 *
 * The `sub` claim is the key, not the email address. Authentik lets a person
 * change their address, and an email-keyed lookup would either lose the account's
 * history at that point or — worse, if someone else later takes the old address —
 * hand it over. `sub` is opaque and stable for the life of the provider, which is
 * exactly the property wanted.
 *
 * Before #373, an unknown `sub` was auto-provisioned here — first ever login
 * became the tenant's `owner`, everyone after that a `viewer`. That rule only
 * made sense while a household could only ever have one tenant. Now an unknown
 * subject gets no row at all: the callback in `routes/auth.ts` sends it to
 * onboarding instead, where it either creates a new tenant (as that tenant's
 * owner, `domain/tenant/provisioning.ts`) or redeems an invite into an existing
 * one (as a viewer). Promoting a viewer to owner is still a database edit; the
 * UI for it belongs with the settings screen.
 */
import { eq } from 'drizzle-orm'
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import { users } from '../../db/schema.ts'
import { logger } from '../../logger.ts'
import { badRequest, forbidden } from '../errors.ts'
import type { OidcIdentity } from './oidc.ts'
import type { SessionUser } from './sessions.ts'

const log = logger.child({ module: 'server.auth.users' })

export const toSessionUser = (row: {
  id: string
  tenantId: string
  email: string | null
  displayName: string | null
  locale: string
  role: 'owner' | 'viewer'
}): SessionUser => ({
  id: row.id,
  tenantId: row.tenantId,
  email: row.email,
  displayName: row.displayName,
  locale: row.locale,
  role: row.role,
})

/**
 * Finds the user behind an identity, or null for a subject nobody has ever
 * assigned to a tenant.
 *
 * Email and display name are refreshed on every login: they are the provider's to
 * own, and a stale name in the UI after someone changes it in Authentik is a small
 * puzzle with no upside. `locale` and `role` are Balancr's own and are never
 * overwritten from claims — the language you chose here should survive a login.
 *
 * A disabled account is refused rather than resurrected. Throwing is right: the
 * caller is a route that must not go on to mint a session.
 */
export function resolveOidcUser(db: Db, identity: OidcIdentity): SessionUser | null {
  const existing = db.select().from(users).where(eq(users.oidcSub, identity.sub)).all()[0]
  if (existing === undefined) return null

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

/**
 * The one field of a user's own row that the user may change.
 *
 * Validated against `SUPPORTED_LOCALES` here rather than only at the route,
 * because the value is read back into `<html lang>` and into every catalogue
 * lookup: a locale nobody has a catalogue for would render an interface of raw
 * key names. `badRequest` rather than a silent fallback — someone chose this, and
 * quietly storing something else is how a settings page loses trust.
 *
 * Role is deliberately not settable. Promoting a viewer to owner from a page any
 * viewer can open would make the distinction decorative; it stays a database edit
 * until there is a reason for a second person to have write access at all.
 */
export function setUserLocale(db: Db, userId: string, locale: string): SessionUser {
  if (!config.SUPPORTED_LOCALES.includes(locale)) {
    throw badRequest(`Unsupported locale: ${locale}`, { supported: config.SUPPORTED_LOCALES })
  }

  const updated = db
    .update(users)
    .set({ locale })
    .where(eq(users.id, userId))
    .returning()
    .all()[0]

  if (updated === undefined) throw badRequest('No such user.')

  log.info({ userId, locale }, 'user locale changed')
  return toSessionUser(updated)
}
