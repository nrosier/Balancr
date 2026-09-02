/**
 * The break-glass password login.
 *
 * This is the path that exists for when Authentik is broken, which means it is
 * also the path an attacker would rather attack — it answers to a password instead
 * of to an identity provider with MFA and its own rate limits. So the tests are
 * about the defences, not about the happy case:
 *
 *  - **Both factors, or nothing.** A right password with a wrong code is a
 *    failure, and it counts as one.
 *  - **A used code is spent.** A six-digit code is valid for a full step and the
 *    steps either side of it, so a code read off a screen is replayable for up to
 *    ninety seconds unless the last accepted step is remembered.
 *  - **Five failures shut the account.** Counted across both factors, because a
 *    guessed code is as much a guess as a guessed password.
 *  - **Every failure gives the same answer.** Wrong password, wrong code, unknown
 *    address, locked out, disabled — one message, so nothing tells whoever is
 *    guessing which half to keep working on.
 *
 * argon2 is deliberately slow, so the fixture password is hashed once for the whole
 * file rather than per test.
 */
import argon2 from 'argon2'
import { beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { Secret, TOTP } from 'otpauth'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { localCredentials, users } from '../../src/db/schema.ts'
import type { HttpError } from '../../src/server/errors.ts'
import {
  ARGON2_OPTIONS,
  LOCKOUT_MS,
  LOCKOUT_THRESHOLD,
  totpStep,
  TOTP_PERIOD_SECONDS,
  verifyLocalLogin,
} from '../../src/server/auth/local.ts'

const EMAIL = 'nick@example.test'
const PASSWORD = 'a-long-enough-break-glass-password'

/** A fixed secret, so a test can compute the code the server will expect. */
const SECRET = new Secret({ size: 20 })
const totp = new TOTP({ secret: SECRET, digits: 6, period: TOTP_PERIOD_SECONDS })

/** The code for a given moment, which is what an authenticator app would show. */
const codeAt = (atMs: number): string => totp.generate({ timestamp: atMs })

let passwordHash: string

beforeAll(async () => {
  passwordHash = await argon2.hash(PASSWORD, ARGON2_OPTIONS)
}, 30_000)

interface Fixture {
  db: Db
  sqlite: { close: () => void }
  userId: string
}

function fixture(overrides: { disabled?: boolean; email?: string } = {}): Fixture {
  const ctx = createTestDb()
  applyMigrations(ctx.db as never)

  const row = ctx.db
    .insert(users)
    .values({
      email: overrides.email ?? EMAIL,
      displayName: 'Nick',
      role: 'owner',
      disabled: overrides.disabled ?? false,
    })
    .returning()
    .all()[0]
  if (row === undefined) throw new Error('fixture user was not created')

  ctx.db
    .insert(localCredentials)
    .values({ userId: row.id, passwordHash, totpSecret: SECRET.base32 })
    .run()

  return { db: ctx.db, sqlite: ctx.sqlite, userId: row.id }
}

const credential = (db: Db, userId: string) =>
  db.select().from(localCredentials).where(eq(localCredentials.userId, userId)).all()[0]

/** The status code of the rejection, or 0 if it did not reject. */
async function refusalOf(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise
    return { status: 0, message: '' }
  } catch (error) {
    const http = error as HttpError
    return { status: http.statusCode, message: http.message }
  }
}

describe('a correct login', () => {
  it('returns the user and clears the failure state', async () => {
    const { db, sqlite, userId } = fixture()
    try {
      const now = Date.now()
      db.update(localCredentials)
        .set({ failedAttempts: 3 })
        .where(eq(localCredentials.userId, userId))
        .run()

      const user = await verifyLocalLogin(
        db,
        { email: EMAIL, password: PASSWORD, totp: codeAt(now) },
        now,
      )

      expect(user.id).toBe(userId)
      expect(user.role).toBe('owner')
      expect(user.displayName).toBe('Nick')

      const row = credential(db, userId)
      expect(row?.failedAttempts).toBe(0)
      expect(row?.lockedUntil).toBeNull()
      // Recorded so the same code cannot be presented again.
      expect(row?.lastTotpStep).toBe(totpStep(now))
    } finally {
      sqlite.close()
    }
  })

  it('records the login on the user', async () => {
    const { db, sqlite, userId } = fixture()
    try {
      const now = Date.now()
      await verifyLocalLogin(db, { email: EMAIL, password: PASSWORD, totp: codeAt(now) }, now)
      const row = db.select().from(users).where(eq(users.id, userId)).all()[0]
      expect(row?.lastSeenAt?.getTime()).toBe(now)
    } finally {
      sqlite.close()
    }
  })

  it('accepts a code from the neighbouring step, for a phone with a slow clock', async () => {
    const { db, sqlite, userId } = fixture()
    try {
      const now = Date.now()
      const stale = codeAt(now - TOTP_PERIOD_SECONDS * 1000)

      await expect(
        verifyLocalLogin(db, { email: EMAIL, password: PASSWORD, totp: stale }, now),
      ).resolves.toMatchObject({ id: userId })

      // Stored as the step the code actually belonged to, not as "now" — otherwise
      // a login with a slow clock would refuse the next, correctly current, code.
      expect(credential(db, userId)?.lastTotpStep).toBe(totpStep(now) - 1)
    } finally {
      sqlite.close()
    }
  })
})

describe('a refused login', () => {
  it('refuses a wrong password even with the right code', async () => {
    const { db, sqlite, userId } = fixture()
    try {
      const now = Date.now()
      const refusal = await refusalOf(
        verifyLocalLogin(db, { email: EMAIL, password: 'wrong', totp: codeAt(now) }, now),
      )
      expect(refusal.status).toBe(401)
      expect(credential(db, userId)?.failedAttempts).toBe(1)
    } finally {
      sqlite.close()
    }
  })

  it('refuses a wrong code even with the right password, and counts it', async () => {
    // The half that a password-only implementation gets wrong: without this the
    // second factor is a formality, because it can be retried without cost.
    const { db, sqlite, userId } = fixture()
    try {
      const refusal = await refusalOf(
        verifyLocalLogin(db, { email: EMAIL, password: PASSWORD, totp: '000000' }),
      )
      expect(refusal.status).toBe(401)
      expect(credential(db, userId)?.failedAttempts).toBe(1)
    } finally {
      sqlite.close()
    }
  })

  it('refuses a code that has already been used', async () => {
    const { db, sqlite, userId } = fixture()
    try {
      const now = Date.now()
      const code = codeAt(now)
      await verifyLocalLogin(db, { email: EMAIL, password: PASSWORD, totp: code }, now)

      // Same code, same step, one second later — the shape of a shoulder-surfed or
      // screenshotted code being reused inside its window.
      const refusal = await refusalOf(
        verifyLocalLogin(db, { email: EMAIL, password: PASSWORD, totp: code }, now + 1000),
      )
      expect(refusal.status).toBe(401)
      expect(credential(db, userId)?.failedAttempts).toBe(1)
    } finally {
      sqlite.close()
    }
  })

  it('accepts the next step after one has been used', async () => {
    const { db, sqlite } = fixture()
    try {
      const now = Date.now()
      await verifyLocalLogin(db, { email: EMAIL, password: PASSWORD, totp: codeAt(now) }, now)

      const later = now + TOTP_PERIOD_SECONDS * 1000
      await expect(
        verifyLocalLogin(db, { email: EMAIL, password: PASSWORD, totp: codeAt(later) }, later),
      ).resolves.toBeDefined()
    } finally {
      sqlite.close()
    }
  })

  it('gives the same answer for an address that has no account', async () => {
    const { db, sqlite } = fixture()
    try {
      const now = Date.now()
      const real = await refusalOf(
        verifyLocalLogin(db, { email: EMAIL, password: 'wrong', totp: codeAt(now) }, now),
      )
      const absent = await refusalOf(
        verifyLocalLogin(
          db,
          { email: 'nobody@example.test', password: 'wrong', totp: codeAt(now) },
          now,
        ),
      )

      expect(absent.status).toBe(real.status)
      expect(absent.message).toBe(real.message)
    } finally {
      sqlite.close()
    }
  })

  it('refuses a disabled account', async () => {
    const { db, sqlite } = fixture({ disabled: true })
    try {
      const now = Date.now()
      const refusal = await refusalOf(
        verifyLocalLogin(db, { email: EMAIL, password: PASSWORD, totp: codeAt(now) }, now),
      )
      expect(refusal.status).toBe(401)
    } finally {
      sqlite.close()
    }
  })

  it('says nothing about which factor was wrong', async () => {
    const { db, sqlite } = fixture()
    try {
      const now = Date.now()
      const badPassword = await refusalOf(
        verifyLocalLogin(db, { email: EMAIL, password: 'wrong', totp: codeAt(now) }, now),
      )
      const badCode = await refusalOf(
        verifyLocalLogin(db, { email: EMAIL, password: PASSWORD, totp: '000000' }, now),
      )
      expect(badCode.message).toBe(badPassword.message)
      expect(badPassword.message).not.toMatch(/password|code|totp/i)
    } finally {
      sqlite.close()
    }
  })
})

describe('the lockout', () => {
  it('shuts the account after the threshold and refuses the right details', async () => {
    const { db, sqlite, userId } = fixture()
    try {
      const now = Date.now()
      for (let attempt = 0; attempt < LOCKOUT_THRESHOLD; attempt += 1) {
        await refusalOf(verifyLocalLogin(db, { email: EMAIL, password: 'wrong', totp: '000000' }, now))
      }

      const row = credential(db, userId)
      expect(row?.lockedUntil?.getTime()).toBe(now + LOCKOUT_MS)
      // Reset, so the next lockout costs another five attempts rather than one.
      expect(row?.failedAttempts).toBe(0)

      const refusal = await refusalOf(
        verifyLocalLogin(db, { email: EMAIL, password: PASSWORD, totp: codeAt(now) }, now),
      )
      expect(refusal.status).toBe(401)
    } finally {
      sqlite.close()
    }
  })

  it('cannot be extended by attempts made while it is in force', async () => {
    // Otherwise a script pointed at the endpoint holds the account shut for as long
    // as it keeps running, which on the break-glass path is the outage it exists to
    // survive.
    const { db, sqlite, userId } = fixture()
    try {
      const now = Date.now()
      const until = new Date(now + LOCKOUT_MS)
      db.update(localCredentials)
        .set({ lockedUntil: until })
        .where(eq(localCredentials.userId, userId))
        .run()

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await refusalOf(verifyLocalLogin(db, { email: EMAIL, password: 'wrong', totp: '000000' }, now))
      }

      const row = credential(db, userId)
      expect(row?.lockedUntil?.getTime()).toBe(until.getTime())
      expect(row?.failedAttempts).toBe(0)
    } finally {
      sqlite.close()
    }
  })

  it('lets the right details through once it has elapsed', async () => {
    const { db, sqlite, userId } = fixture()
    try {
      const now = Date.now()
      db.update(localCredentials)
        .set({ lockedUntil: new Date(now - 1) })
        .where(eq(localCredentials.userId, userId))
        .run()

      await expect(
        verifyLocalLogin(db, { email: EMAIL, password: PASSWORD, totp: codeAt(now) }, now),
      ).resolves.toMatchObject({ id: userId })
      expect(credential(db, userId)?.lockedUntil).toBeNull()
    } finally {
      sqlite.close()
    }
  })
})
