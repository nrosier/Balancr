/**
 * The state of a login between the redirect out and the callback back.
 *
 * Three properties are the reason this is a table and not a signed cookie, and
 * each has a test here:
 *
 *  - **Single use.** A captured callback URL must fail the second time, or the
 *    whole flow is replayable by anyone who reads a browser history.
 *  - **A deadline.** An abandoned tab is a code-exchange window left open.
 *  - **No distinction between the failure modes.** Unknown, used and expired are
 *    one answer, because telling them apart confirms a guess.
 *
 * `safeReturnTo` is tested harder than its size suggests. It is the open-redirect
 * surface of the login endpoint, which is exactly the place a phishing link wants
 * a real domain in front of it.
 */
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { loginFlows } from '../../src/db/schema.ts'
import {
  consumeLoginFlow,
  LOGIN_FLOW_TTL_MS,
  safeReturnTo,
  startLoginFlow,
} from '../../src/server/auth/login-flow.ts'

function freshDb(): ReturnType<typeof createTestDb> {
  const ctx = createTestDb()
  applyMigrations(ctx.db as never)
  return ctx
}

describe('starting a flow', () => {
  it('stores the three secrets and hands back the same ones', () => {
    const { db, sqlite } = freshDb()
    try {
      const flow = startLoginFlow(db, '/insights')

      const row = db.select().from(loginFlows).where(eq(loginFlows.state, flow.state)).all()[0]
      expect(row).toBeDefined()
      expect(row?.nonce).toBe(flow.nonce)
      expect(row?.codeVerifier).toBe(flow.codeVerifier)
      expect(row?.returnTo).toBe('/insights')
    } finally {
      sqlite.close()
    }
  })

  it('generates values that are neither guessable nor shared between flows', () => {
    const { db, sqlite } = freshDb()
    try {
      const first = startLoginFlow(db, '/')
      const second = startLoginFlow(db, '/')

      expect(first.state).not.toBe(second.state)
      expect(first.nonce).not.toBe(second.nonce)
      expect(first.codeVerifier).not.toBe(second.codeVerifier)
      // Three distinct secrets, not one value used three times — each defends
      // against a different thing, and reusing one would collapse all three.
      expect(new Set([first.state, first.nonce, first.codeVerifier]).size).toBe(3)
      // 43 characters is the shortest a PKCE verifier is allowed to be.
      expect(first.codeVerifier.length).toBeGreaterThanOrEqual(43)
      expect(first.state.length).toBeGreaterThanOrEqual(20)
    } finally {
      sqlite.close()
    }
  })

  it('gives the flow a deadline in the near future', () => {
    const { db, sqlite } = freshDb()
    try {
      // Bracketed between two readings of the clock, because the deadline comes
      // from a `Date.now()` taken inside the call: measured against `before`
      // alone, a millisecond ticking over mid-call reads as one past the TTL.
      const before = Date.now()
      const flow = startLoginFlow(db, '/')
      const after = Date.now()
      const row = db.select().from(loginFlows).where(eq(loginFlows.state, flow.state)).all()[0]

      const deadline = row?.expiresAt.getTime() ?? 0
      expect(deadline).toBeGreaterThanOrEqual(before + LOGIN_FLOW_TTL_MS)
      expect(deadline).toBeLessThanOrEqual(after + LOGIN_FLOW_TTL_MS)
    } finally {
      sqlite.close()
    }
  })

  it('sweeps flows nobody came back for', () => {
    const { db, sqlite } = freshDb()
    try {
      const abandoned = startLoginFlow(db, '/')
      db.update(loginFlows)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(loginFlows.state, abandoned.state))
        .run()

      // The sweep is on the way in, so the table is bounded by people who still
      // start logins rather than by how long the container has been up.
      startLoginFlow(db, '/')
      expect(db.select().from(loginFlows).all()).toHaveLength(1)
    } finally {
      sqlite.close()
    }
  })
})

describe('consuming a flow', () => {
  it('returns the secrets and removes the row', () => {
    const { db, sqlite } = freshDb()
    try {
      const flow = startLoginFlow(db, '/budget')
      const taken = consumeLoginFlow(db, flow.state)

      expect(taken?.nonce).toBe(flow.nonce)
      expect(taken?.codeVerifier).toBe(flow.codeVerifier)
      expect(taken?.returnTo).toBe('/budget')
      expect(db.select().from(loginFlows).all()).toHaveLength(0)
    } finally {
      sqlite.close()
    }
  })

  it('refuses the second attempt with the same state', () => {
    const { db, sqlite } = freshDb()
    try {
      const flow = startLoginFlow(db, '/')
      expect(consumeLoginFlow(db, flow.state)).not.toBeNull()
      // The replay. A signed cookie would verify here for the second time.
      expect(consumeLoginFlow(db, flow.state)).toBeNull()
    } finally {
      sqlite.close()
    }
  })

  it('refuses an expired flow, and does not leave it behind', () => {
    const { db, sqlite } = freshDb()
    try {
      const flow = startLoginFlow(db, '/')
      db.update(loginFlows)
        .set({ expiresAt: new Date(Date.now() - 1) })
        .where(eq(loginFlows.state, flow.state))
        .run()

      expect(consumeLoginFlow(db, flow.state)).toBeNull()
      // Deleted on the way to the refusal, because the delete is what decides the
      // answer — so an expired row cannot sit there being retried.
      expect(db.select().from(loginFlows).all()).toHaveLength(0)
    } finally {
      sqlite.close()
    }
  })

  it('answers the same way for a state that never existed', () => {
    const { db, sqlite } = freshDb()
    try {
      expect(consumeLoginFlow(db, 'never-issued')).toBeNull()
    } finally {
      sqlite.close()
    }
  })
})

describe('safeReturnTo', () => {
  // Built from code points rather than written as escapes, for the same reason the
  // check itself is a scan and not a regexp: a literal control character in a
  // source file is the kind of thing an editor silently rewrites.
  const cr = String.fromCharCode(13)
  const lf = String.fromCharCode(10)
  const tab = String.fromCharCode(9)

  it('keeps a local path, query and all', () => {
    expect(safeReturnTo('/insights')).toBe('/insights')
    expect(safeReturnTo('/budget?month=2026-08')).toBe('/budget?month=2026-08')
  })

  it('refuses anything that leaves the site', () => {
    // The protocol-relative form is the one that gets missed: it carries no
    // scheme, so a naive "must not contain ://" check waves it through.
    expect(safeReturnTo('//evil.example/phish')).toBe('/')
    expect(safeReturnTo('https://evil.example')).toBe('/')
    expect(safeReturnTo('http://evil.example')).toBe('/')
    // A backslash is normalised to a slash while some browsers resolve a URL,
    // which turns this into the protocol-relative case above.
    expect(safeReturnTo('/\\evil.example')).toBe('/')
    expect(safeReturnTo('insights')).toBe('/')
  })

  it('refuses a value that could split the Location header', () => {
    expect(safeReturnTo(`/ok${cr}${lf}Set-Cookie: a=b`)).toBe('/')
    expect(safeReturnTo(`/ok${lf}X-Injected: 1`)).toBe('/')
    expect(safeReturnTo(`/ok${tab}`)).toBe('/')
  })

  it('falls back for anything that is not a non-empty string', () => {
    expect(safeReturnTo(undefined)).toBe('/')
    expect(safeReturnTo('')).toBe('/')
    expect(safeReturnTo(42)).toBe('/')
    // A repeated query parameter arrives as an array, which must not become a
    // stringified redirect target.
    expect(safeReturnTo(['/a', '/b'])).toBe('/')
  })
})
