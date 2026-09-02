/**
 * Creating the break-glass credential.
 *
 * What is worth asserting here is mostly about what provisioning refuses to do
 * quietly:
 *
 *  - **A reset mints a new TOTP secret.** Somebody resetting this password may be
 *    doing it because they think the old one leaked, and keeping the second factor
 *    would leave half of a suspected compromise in place.
 *  - **It does not hand out `owner`.** Only the first account in an empty database
 *    owns it, exactly as on the OIDC path — a break-glass account must not be a way
 *    to mint write access.
 *  - **An ambiguous address is refused rather than guessed at.** `users.email` is
 *    not unique, because the OIDC path needs an address to be able to move between
 *    subjects, so two matching rows is a situation a person has to resolve.
 *
 * And the round trip: what this writes is what `verifyLocalLogin` accepts. That is
 * the one assertion that would catch a hashing or base32 mismatch between the two.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { Secret, TOTP } from 'otpauth'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { localCredentials, users } from '../../src/db/schema.ts'
import { TOTP_PERIOD_SECONDS, verifyLocalLogin } from '../../src/server/auth/local.ts'
import { provisionLocalCredential } from '../../src/server/auth/provision.ts'

const EMAIL = 'nick@example.test'
const PASSWORD = 'a-long-enough-break-glass-password'

function freshDb(): ReturnType<typeof createTestDb> {
  const ctx = createTestDb()
  applyMigrations(ctx.db as never)
  return ctx
}

const credential = (db: Db, userId: string) =>
  db.select().from(localCredentials).where(eq(localCredentials.userId, userId)).all()[0]

/** The code an authenticator would show for a secret this returned. */
const codeFor = (base32: string): string =>
  new TOTP({
    secret: Secret.fromBase32(base32),
    digits: 6,
    period: TOTP_PERIOD_SECONDS,
  }).generate()

describe('provisioning a local credential', () => {
  it('creates the user, the hash and the secret, and reports the enrolment URI', async () => {
    const { db, sqlite } = freshDb()
    try {
      const result = await provisionLocalCredential(db, {
        email: EMAIL,
        password: PASSWORD,
        displayName: 'Nick',
      })

      expect(result.replaced).toBe(false)
      expect(result.role).toBe('owner')
      expect(result.totpSecret).toMatch(/^[A-Z2-7]{32}$/)
      expect(result.totpUri).toContain('otpauth://totp/')
      expect(result.totpUri).toContain('issuer=Balancr')

      const row = credential(db, result.userId)
      // argon2id, and the password itself is nowhere in the row.
      expect(row?.passwordHash).toMatch(/^\$argon2id\$/)
      expect(JSON.stringify(row)).not.toContain(PASSWORD)
      expect(row?.failedAttempts).toBe(0)
      expect(row?.lastTotpStep).toBeNull()
    } finally {
      sqlite.close()
    }
  }, 30_000)

  it('produces a credential the login path accepts', async () => {
    const { db, sqlite } = freshDb()
    try {
      const result = await provisionLocalCredential(db, { email: EMAIL, password: PASSWORD })
      await expect(
        verifyLocalLogin(db, {
          email: EMAIL,
          password: PASSWORD,
          totp: codeFor(result.totpSecret),
        }),
      ).resolves.toMatchObject({ id: result.userId })
    } finally {
      sqlite.close()
    }
  }, 30_000)

  it('mints a new second factor when the password is reset', async () => {
    const { db, sqlite } = freshDb()
    try {
      const first = await provisionLocalCredential(db, { email: EMAIL, password: PASSWORD })
      const second = await provisionLocalCredential(db, { email: EMAIL, password: 'a-different-one' })

      expect(second.replaced).toBe(true)
      expect(second.userId).toBe(first.userId)
      expect(second.totpSecret).not.toBe(first.totpSecret)

      // The old code no longer works, which is the point.
      await expect(
        verifyLocalLogin(db, {
          email: EMAIL,
          password: 'a-different-one',
          totp: codeFor(first.totpSecret),
        }),
      ).rejects.toThrow()
    } finally {
      sqlite.close()
    }
  }, 30_000)

  it('clears a lockout, because a reset is how an operator gets back in', async () => {
    const { db, sqlite } = freshDb()
    try {
      const first = await provisionLocalCredential(db, { email: EMAIL, password: PASSWORD })
      db.update(localCredentials)
        .set({ failedAttempts: 4, lockedUntil: new Date(Date.now() + 60_000), lastTotpStep: 99 })
        .where(eq(localCredentials.userId, first.userId))
        .run()

      const second = await provisionLocalCredential(db, { email: EMAIL, password: PASSWORD })
      const row = credential(db, second.userId)
      expect(row?.failedAttempts).toBe(0)
      expect(row?.lockedUntil).toBeNull()
      // Reset with the secret: a step counted against the old one would refuse every
      // code until the clock caught up with it.
      expect(row?.lastTotpStep).toBeNull()
    } finally {
      sqlite.close()
    }
  }, 30_000)

  it('does not make the second account an owner', async () => {
    const { db, sqlite } = freshDb()
    try {
      await provisionLocalCredential(db, { email: EMAIL, password: PASSWORD })
      const second = await provisionLocalCredential(db, {
        email: 'someone@example.test',
        password: PASSWORD,
      })
      expect(second.role).toBe('viewer')
    } finally {
      sqlite.close()
    }
  }, 30_000)

  it('keeps the role an existing account already had', async () => {
    const { db, sqlite } = freshDb()
    try {
      db.insert(users).values({ email: EMAIL, role: 'viewer' }).run()
      const result = await provisionLocalCredential(db, { email: EMAIL, password: PASSWORD })
      // Setting a password is not a promotion.
      expect(result.role).toBe('viewer')
    } finally {
      sqlite.close()
    }
  }, 30_000)

  it('refuses an address that matches more than one account', async () => {
    const { db, sqlite } = freshDb()
    try {
      db.insert(users).values({ email: EMAIL, oidcSub: 'sub-a' }).run()
      db.insert(users).values({ email: EMAIL, oidcSub: 'sub-b' }).run()

      await expect(
        provisionLocalCredential(db, { email: EMAIL, password: PASSWORD }),
      ).rejects.toThrow(/2 accounts/)
    } finally {
      sqlite.close()
    }
  })
})

describe('the provisioning boundary', () => {
  it('is not reachable from anything on the request path', () => {
    // The claim in the module header, asserted rather than asserted-in-a-comment:
    // no route may import the one module that can write a password hash. The same
    // shape as the read-only boundary test for the Actual adapter, and for the same
    // reason — a promise about the source is only kept if something checks it.
    const dir = 'src/server/routes'
    const offenders = readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => readFileSync(`${dir}/${name}`, 'utf8').includes('auth/provision.ts'))

    expect(offenders).toEqual([])
  })
})
