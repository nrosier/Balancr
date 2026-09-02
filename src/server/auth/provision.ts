/**
 * Creating the break-glass credential.
 *
 * A chicken and egg: the local password exists for when nobody can sign in, so it
 * cannot be set through a screen that requires signing in. It is set from the
 * command line instead — `npm run auth:local` — which also means the one moment the
 * TOTP secret is readable happens on the operator's own terminal rather than in an
 * HTTP response that a proxy might log.
 *
 * Separate from `local.ts` because nothing on the request path should be able to
 * write a password hash. Importing this module is how a caller says it is a
 * provisioning tool, and `grep` over `src/server/routes` proves none of them does.
 */
import argon2 from 'argon2'
import { count, eq } from 'drizzle-orm'
import { Secret, TOTP } from 'otpauth'
import type { Db } from '../../db/index.ts'
import { localCredentials, users } from '../../db/schema.ts'
import { ARGON2_OPTIONS, TOTP_PERIOD_SECONDS } from './local.ts'

/**
 * 20 bytes, the length RFC 4226 specifies for an HMAC-SHA1 key and what every
 * authenticator app expects. Longer is not stronger here — HMAC-SHA1 folds a
 * longer key back to its block size anyway.
 */
export const TOTP_SECRET_BYTES = 20

export interface ProvisionInput {
  /** The address the login form asks for. Matched exactly. */
  email: string
  password: string
  displayName?: string | undefined
}

export interface ProvisionResult {
  userId: string
  /** `owner` for the first account in an empty database, `viewer` after that. */
  role: 'owner' | 'viewer'
  /** True when this replaced an existing password rather than creating one. */
  replaced: boolean
  /** Base32, for typing into an authenticator by hand. */
  totpSecret: string
  /** `otpauth://totp/...`, for a QR generator or a paste into an app. */
  totpUri: string
}

/**
 * Inserts the user a local credential is being created for.
 *
 * The role follows the same rule as the OIDC path in `users.ts`: the first account
 * in an empty database owns it, anything after that has to be promoted by hand. A
 * break-glass account should not be a way to mint an owner.
 */
function createUser(db: Db, input: ProvisionInput): string {
  const empty = (db.select({ n: count() }).from(users).all()[0]?.n ?? 0) === 0

  const created = db
    .insert(users)
    .values({
      email: input.email,
      displayName: input.displayName ?? null,
      role: empty ? 'owner' : 'viewer',
    })
    .returning()
    .all()[0]

  if (created === undefined) throw new Error('inserting the user returned no row')
  return created.id
}

/**
 * Sets or resets the local password for `email`, creating the user if needed.
 *
 * The TOTP secret is regenerated on every call, deliberately. A password reset
 * that silently kept the old second factor would leave an operator who ran this
 * because they suspected a compromise with half the compromise intact.
 */
export async function provisionLocalCredential(
  db: Db,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const matches = db.select().from(users).where(eq(users.email, input.email)).all()
  if (matches.length > 1) {
    // Nothing stops two accounts sharing an address — `users.email` is deliberately
    // not unique, because the OIDC path has to cope with an address moving from one
    // subject to another. But the login form asks for an address, so an ambiguous
    // one has to be resolved by a person rather than guessed at here.
    throw new Error(
      `${matches.length} accounts have the address ${input.email}; resolve that before setting a local password`,
    )
  }

  const userId = matches[0]?.id ?? createUser(db, input)

  const secret = new Secret({ size: TOTP_SECRET_BYTES })
  const totp = new TOTP({
    issuer: 'Balancr',
    label: input.email,
    secret,
    digits: 6,
    period: TOTP_PERIOD_SECONDS,
  })

  const passwordHash = await argon2.hash(input.password, ARGON2_OPTIONS)
  const prior = db
    .select()
    .from(localCredentials)
    .where(eq(localCredentials.userId, userId))
    .all()[0]

  db.insert(localCredentials)
    .values({
      userId,
      passwordHash,
      totpSecret: secret.base32,
      failedAttempts: 0,
      lockedUntil: null,
      // Cleared with the secret: steps counted against the old secret say nothing
      // about the new one, and leaving a high value behind would refuse every code
      // until the clock caught up with it.
      lastTotpStep: null,
      passwordChangedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: localCredentials.userId,
      set: {
        passwordHash,
        totpSecret: secret.base32,
        failedAttempts: 0,
        lockedUntil: null,
        lastTotpStep: null,
        passwordChangedAt: new Date(),
      },
    })
    .run()

  const role = db.select().from(users).where(eq(users.id, userId)).all()[0]?.role ?? 'viewer'

  return {
    userId,
    role,
    replaced: prior !== undefined,
    totpSecret: secret.base32,
    totpUri: totp.toString(),
  }
}
