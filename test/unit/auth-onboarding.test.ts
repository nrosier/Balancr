/**
 * The cookie mechanics for a tenantless identity (#373): the gap between a
 * successful OIDC callback and a real `users` row.
 *
 * `peek` has to be safe to call over and over — the SPA polls
 * `/auth/session` while the onboarding screen sits open — and `consume` has
 * to actually end that row's life, since it runs only after the tenant/invite
 * mutation it gates has already succeeded.
 */
import { describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { pendingIdentities } from '../../src/db/schema.ts'
import {
  beginOnboarding,
  consumePendingIdentity,
  peekPendingIdentity,
  PENDING_IDENTITY_TTL_MS,
} from '../../src/server/auth/onboarding.ts'
import type { OidcIdentity } from '../../src/server/auth/oidc.ts'

function freshDb(): ReturnType<typeof createTestDb> {
  const ctx = createTestDb()
  applyMigrations(ctx.db as never)
  return ctx
}

const IDENTITY: OidcIdentity = { sub: 'ak-nick', email: 'nick@example.test', name: 'Nick' }

describe('beginOnboarding', () => {
  it('returns a token that peeks back to the identity it was given', () => {
    const { db, sqlite } = freshDb()
    try {
      const { token } = beginOnboarding(db, IDENTITY)
      const pending = peekPendingIdentity(db, token)

      expect(pending).toEqual({ sub: IDENTITY.sub, email: IDENTITY.email, displayName: IDENTITY.name })
    } finally {
      sqlite.close()
    }
  })

  it('never stores the token itself, only its hash', () => {
    const { db, sqlite } = freshDb()
    try {
      const { token } = beginOnboarding(db, IDENTITY)

      const row = db.select().from(pendingIdentities).all()[0]
      expect(row?.id).not.toBe(token)
      expect(JSON.stringify(row)).not.toContain(token)
    } finally {
      sqlite.close()
    }
  })

  it('sweeps rows that expired before this call', () => {
    const { db, sqlite } = freshDb()
    try {
      const start = new Date('2026-01-01T00:00:00Z')
      const stale = beginOnboarding(db, IDENTITY, start)

      const later = new Date(start.getTime() + PENDING_IDENTITY_TTL_MS + 1)
      beginOnboarding(db, { ...IDENTITY, sub: 'ak-jo' }, later)

      expect(peekPendingIdentity(db, stale.token, later)).toBeNull()
      expect(db.select().from(pendingIdentities).all()).toHaveLength(1)
    } finally {
      sqlite.close()
    }
  })
})

describe('peekPendingIdentity', () => {
  it('is non-destructive: reading it twice sees the same row both times', () => {
    const { db, sqlite } = freshDb()
    try {
      const { token } = beginOnboarding(db, IDENTITY)

      expect(peekPendingIdentity(db, token)).not.toBeNull()
      expect(peekPendingIdentity(db, token)).not.toBeNull()
    } finally {
      sqlite.close()
    }
  })

  it('returns null for an unknown token', () => {
    const { db, sqlite } = freshDb()
    try {
      expect(peekPendingIdentity(db, 'not-a-real-token')).toBeNull()
    } finally {
      sqlite.close()
    }
  })

  it('returns null for a token that has expired', () => {
    const { db, sqlite } = freshDb()
    try {
      const start = new Date('2026-01-01T00:00:00Z')
      const { token } = beginOnboarding(db, IDENTITY, start)

      const afterExpiry = new Date(start.getTime() + PENDING_IDENTITY_TTL_MS + 1)
      expect(peekPendingIdentity(db, token, afterExpiry)).toBeNull()
    } finally {
      sqlite.close()
    }
  })
})

describe('consumePendingIdentity', () => {
  it('is destructive: consuming it once means a second consume finds nothing', () => {
    const { db, sqlite } = freshDb()
    try {
      const { token } = beginOnboarding(db, IDENTITY)

      expect(consumePendingIdentity(db, token)).toEqual({
        sub: IDENTITY.sub,
        email: IDENTITY.email,
        displayName: IDENTITY.name,
      })
      expect(consumePendingIdentity(db, token)).toBeNull()
      expect(peekPendingIdentity(db, token)).toBeNull()
    } finally {
      sqlite.close()
    }
  })

  it('returns null for an unknown token', () => {
    const { db, sqlite } = freshDb()
    try {
      expect(consumePendingIdentity(db, 'not-a-real-token')).toBeNull()
    } finally {
      sqlite.close()
    }
  })

  it('returns null for an expired token, even though the row is gone either way', () => {
    const { db, sqlite } = freshDb()
    try {
      const start = new Date('2026-01-01T00:00:00Z')
      const { token } = beginOnboarding(db, IDENTITY, start)

      const afterExpiry = new Date(start.getTime() + PENDING_IDENTITY_TTL_MS + 1)
      expect(consumePendingIdentity(db, token, afterExpiry)).toBeNull()
    } finally {
      sqlite.close()
    }
  })
})
