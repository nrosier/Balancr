/**
 * Break-glass login: a password and a TOTP code, for when Authentik is what broke.
 *
 * The whole point of this path is that it works when the identity provider does
 * not, which means it cannot lean on any of the provider's protections. So it
 * carries its own, and they are deliberately stricter than a normal password
 * login would be:
 *
 *  - **Both factors, always.** `totpSecret` is not nullable, so there is no such
 *    thing as a local account with a password alone. A single-factor bypass of an
 *    MFA-enforcing provider is not a break-glass path, it is a back door.
 *  - **One message for every failure.** Wrong password, wrong code, no such
 *    address, no local credential, locked out — all the same 401. Distinguishing
 *    them tells whoever is guessing which half to keep working on.
 *  - **Constant-ish work for an unknown account.** A miss verifies against a decoy
 *    hash, because argon2id takes long enough that skipping it would answer "is
 *    there an account for this address?" through the response time alone.
 *  - **A used code is a spent code.** See `lastTotpStep` in the schema.
 *
 * The lockout is per account and time-boxed rather than permanent, which is a
 * trade: someone inside the allowed range who knows the address can keep the owner
 * locked out in fifteen-minute increments. Permanent lockout on the one path that
 * exists for emergencies would be worse — it would turn a nuisance into the outage
 * it was meant to survive. The CIDR gate in `routes/auth.ts` is what keeps that
 * nuisance on the LAN.
 */
import argon2 from 'argon2'
import { eq } from 'drizzle-orm'
import { Secret, TOTP } from 'otpauth'
import type { Db } from '../../db/index.ts'
import { localCredentials, users } from '../../db/schema.ts'
import { logger } from '../../logger.ts'
import { HttpError } from '../errors.ts'
import type { SessionUser } from './sessions.ts'

const log = logger.child({ module: 'server.auth.local' })

/**
 * Failures before the account is shut for a while.
 *
 * Five, counted across both factors: a wrong code is as much a guess as a wrong
 * password, and letting the code be retried freely would leave a six-digit secret
 * defended by nothing but its length.
 */
export const LOCKOUT_THRESHOLD = 5

/** How long a locked account stays shut. Long enough to be useless to a script. */
export const LOCKOUT_MS = 15 * 60 * 1000

/**
 * argon2id at the library's defaults for memory and time, which land around 64 MiB
 * and a tenth of a second on this class of hardware.
 *
 * Not tuned upward, because the threat model here is not an offline crack of a
 * stolen hash — it is a handful of online guesses, and `LOCKOUT_THRESHOLD` is what
 * answers those. Not tuned downward either: 64 MiB is affordable for a login that
 * happens when something has gone wrong.
 */
export const ARGON2_OPTIONS = { type: argon2.argon2id } as const

/** TOTP as every authenticator app assumes it: six digits, thirty seconds, SHA-1. */
export const TOTP_PERIOD_SECONDS = 30

/**
 * Steps of clock skew tolerated either side of now.
 *
 * One, so a phone thirty seconds out still works. Two would double the window a
 * captured code stays live in, and `lastTotpStep` only closes replay of a code
 * that has actually been used.
 */
export const TOTP_WINDOW = 1

/** The step a timestamp falls in. Shared with the replay check and the tests. */
export const totpStep = (atMs: number): number =>
  Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS)

/**
 * The single answer to every kind of failure. See the module header.
 *
 * 401 rather than 403: the request is unauthenticated, and 403 would imply that
 * being someone else would not have helped.
 */
const loginRefused = (): HttpError =>
  new HttpError(401, 'unauthenticated', 'Those details were not accepted.')

/**
 * A hash to verify against when there is no account, so a miss costs what a hit
 * costs.
 *
 * Computed once, lazily, over a value nobody knows — a constant in the source
 * would be a hash an attacker could pre-verify against to detect this path, and
 * hashing at import would put ~100 ms of argon2 in front of every process start
 * including the ones that never serve a login.
 */
let decoy: Promise<string> | null = null
const decoyHash = (): Promise<string> => {
  decoy ??= argon2.hash(crypto.randomUUID(), ARGON2_OPTIONS)
  return decoy
}

export interface LocalLoginAttempt {
  email: string
  password: string
  totp: string
}

interface CredentialRow {
  userId: string
  passwordHash: string
  totpSecret: string
  failedAttempts: number
  lockedUntil: Date | null
  lastTotpStep: number | null
}

/**
 * Records a failure and locks the account once there have been enough of them.
 *
 * Reaching the threshold sets a deadline and resets the counter, so each further
 * lockout costs another `LOCKOUT_THRESHOLD` attempts rather than one — the
 * alternative leaves an account that has once been locked permanently one guess
 * away from being locked again.
 */
function recordFailure(db: Db, row: CredentialRow, now: number): void {
  const attempts = row.failedAttempts + 1
  const locked = attempts >= LOCKOUT_THRESHOLD

  db.update(localCredentials)
    .set({
      failedAttempts: locked ? 0 : attempts,
      lockedUntil: locked ? new Date(now + LOCKOUT_MS) : row.lockedUntil,
    })
    .where(eq(localCredentials.userId, row.userId))
    .run()

  if (locked) {
    log.warn(
      { userId: row.userId, minutes: LOCKOUT_MS / 60_000 },
      'local login locked after repeated failures',
    )
  }
}

/**
 * Verifies a local login and returns the user, or throws.
 *
 * Both factors are checked before either verdict is used, so the work done does
 * not depend on which one was wrong.
 */
export async function verifyLocalLogin(
  db: Db,
  attempt: LocalLoginAttempt,
  now = Date.now(),
): Promise<SessionUser> {
  const rows = db
    .select({
      userId: localCredentials.userId,
      passwordHash: localCredentials.passwordHash,
      totpSecret: localCredentials.totpSecret,
      failedAttempts: localCredentials.failedAttempts,
      lockedUntil: localCredentials.lockedUntil,
      lastTotpStep: localCredentials.lastTotpStep,
      email: users.email,
      displayName: users.displayName,
      locale: users.locale,
      role: users.role,
      disabled: users.disabled,
    })
    .from(localCredentials)
    .innerJoin(users, eq(localCredentials.userId, users.id))
    .where(eq(users.email, attempt.email))
    .all()

  if (rows.length > 1) {
    // `users.email` is not unique — the OIDC path needs an address to be able to
    // move between subjects — so two credentialed accounts could in principle share
    // one. Guessing which was meant is the wrong answer for a login, and
    // `provisionLocalCredential` refuses to create the situation in the first place.
    log.error({ matches: rows.length }, 'more than one local credential for one address')
    throw loginRefused()
  }

  const row = rows[0]

  if (row === undefined) {
    // Deliberately still pays for a hash. The comparison cannot succeed, and its
    // only purpose is that the answer takes as long as a real refusal.
    await argon2.verify(await decoyHash(), attempt.password).catch(() => false)
    // The address is not logged. It is the one piece of the attempt that is
    // personal data, and an operator diagnosing this does not need it: the line
    // says a local login was tried and missed, and the rest is in the CIDR gate's
    // own log line above it.
    log.warn('local login for an address with no local credential')
    throw loginRefused()
  }

  if (row.disabled) {
    log.warn({ userId: row.userId }, 'local login for a disabled account')
    throw loginRefused()
  }

  if (row.lockedUntil !== null && row.lockedUntil.getTime() > now) {
    // No counter increment: an attempt against a locked account cannot extend the
    // lock, or a script would hold it shut indefinitely.
    log.warn({ userId: row.userId, until: row.lockedUntil }, 'local login while locked out')
    throw loginRefused()
  }

  // `verify` throws on a malformed stored hash rather than returning false, and a
  // corrupted row must read as a refusal rather than as a 500 that names argon2.
  const passwordOk = await argon2.verify(row.passwordHash, attempt.password).catch((error) => {
    log.error({ err: error, userId: row.userId }, 'stored password hash could not be verified')
    return false
  })

  const totp = new TOTP({
    secret: Secret.fromBase32(row.totpSecret),
    digits: 6,
    period: TOTP_PERIOD_SECONDS,
  })
  // `validate` returns how many steps out the code was, or null. `timestamp` is
  // passed so the caller's clock is the only clock involved.
  const delta = totp.validate({ token: attempt.totp, window: TOTP_WINDOW, timestamp: now })
  const step = delta === null ? null : totpStep(now) + delta
  const fresh = step !== null && (row.lastTotpStep === null || step > row.lastTotpStep)

  if (!passwordOk || !fresh) {
    recordFailure(db, row, now)
    log.warn(
      { userId: row.userId, password: passwordOk, code: step !== null, replay: step !== null && !fresh },
      'local login refused',
    )
    throw loginRefused()
  }

  db.update(localCredentials)
    .set({ failedAttempts: 0, lockedUntil: null, lastTotpStep: step })
    .where(eq(localCredentials.userId, row.userId))
    .run()

  db.update(users).set({ lastSeenAt: new Date(now) }).where(eq(users.id, row.userId)).run()

  log.info({ userId: row.userId, role: row.role }, 'signed in locally')
  return {
    id: row.userId,
    email: row.email,
    displayName: row.displayName,
    locale: row.locale,
    role: row.role,
  }
}
