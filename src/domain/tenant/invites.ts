/**
 * Owner-facing invite lifecycle (#373): create, list, revoke, and the atomic claim
 * a redemption needs.
 *
 * The code itself is never stored — only `codeHash`, the same
 * hash-the-token idiom `sessions.ts` uses for the session cookie — so a read
 * access to the database yields no usable invite any more than it yields a
 * usable session.
 */
import { randomBytes, createHash } from 'node:crypto'
import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { tenantInvites } from '../../db/schema.ts'
import { recordAudit, type AuditWriter } from '../audit.ts'

/** How long an issued code stays redeemable. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type TenantInvite = typeof tenantInvites.$inferSelect

const hashCode = (code: string): string => createHash('sha256').update(code, 'utf8').digest('hex')

/**
 * `randomBytes(8)` hex, uppercased and dash-grouped in 4s — 64 bits of
 * entropy, short enough to type or read aloud (`A1B2-C3D4-E5F6-A7B8`).
 */
function generateCode(): string {
  const hex = randomBytes(8).toString('hex').toUpperCase()
  return (hex.match(/.{1,4}/g) ?? [hex]).join('-')
}

/** Strips everything but hex digits and uppercases, so a pasted or hand-typed
 * code with different dashing/casing still hashes to the same value. */
const normalizeCode = (raw: string): string => raw.replace(/[^0-9a-fA-F]/g, '').toUpperCase()

export interface CreateInviteInput {
  tenantId: string
  createdBy: string
  label?: string | null
  now?: Date
}

export interface CreatedInvite {
  invite: TenantInvite
  /** Plaintext, shown once — never stored, never logged, never audited. */
  code: string
}

export function createInvite(db: Db, input: CreateInviteInput): CreatedInvite {
  const now = input.now ?? new Date()
  const code = generateCode()

  return db.transaction((tx) => {
    const created = tx
      .insert(tenantInvites)
      .values({
        tenantId: input.tenantId,
        codeHash: hashCode(normalizeCode(code)),
        label: input.label ?? null,
        createdBy: input.createdBy,
        createdAt: now,
        expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
      })
      .returning()
      .all()[0]
    if (created === undefined) throw new Error('inviting failed: insert returned no row')

    recordAudit(tx, {
      tenantId: input.tenantId,
      action: 'tenant.invite.create',
      entity: 'tenant_invites',
      entityRef: created.id,
      actorId: input.createdBy,
      after: { label: created.label },
      at: now,
    })

    return { invite: created, code }
  })
}

/** Newest first, matching every other settings list in this app. */
export function listInvites(db: Db, tenantId: string): TenantInvite[] {
  return db
    .select()
    .from(tenantInvites)
    .where(eq(tenantInvites.tenantId, tenantId))
    .orderBy(desc(tenantInvites.createdAt))
    .all()
}

export interface RevokeInviteInput {
  tenantId: string
  inviteId: string
  actorId: string
  now?: Date
}

/**
 * Idempotent: revoking an already-revoked (or already-redeemed) invite is a
 * no-op, not an error, so an owner double-clicking "Revoke" never sees a
 * failure for a door that is already closed.
 */
export function revokeInvite(db: Db, input: RevokeInviteInput): void {
  const now = input.now ?? new Date()

  db.transaction((tx) => {
    const row = tx
      .select()
      .from(tenantInvites)
      .where(and(eq(tenantInvites.id, input.inviteId), eq(tenantInvites.tenantId, input.tenantId)))
      .get()
    if (row === undefined) return
    if (row.revokedAt !== null || row.redeemedAt !== null) return

    tx.update(tenantInvites).set({ revokedAt: now }).where(eq(tenantInvites.id, row.id)).run()

    recordAudit(tx, {
      tenantId: input.tenantId,
      action: 'tenant.invite.revoke',
      entity: 'tenant_invites',
      entityRef: row.id,
      actorId: input.actorId,
      at: now,
    })
  })
}

/**
 * The atomic claim: one `UPDATE ... WHERE` that only matches a pending,
 * unexpired, unrevoked invite, `RETURNING` what it touched.
 *
 * Adapts `login-flow.ts`'s delete-then-check-what-was-deleted idiom to a row
 * that must survive redemption (the owner's invite list needs history, so
 * this claims by `UPDATE` rather than `DELETE`) — the same atomicity
 * guarantee holds: two concurrent redemptions of one code cannot both
 * succeed, because only the first `UPDATE` finds a row still matching the
 * `WHERE` clause. The expiry check is part of that same `WHERE`, not a
 * separate check afterwards — otherwise an expired invite would still get
 * marked redeemed by the `UPDATE` before being rejected, burning it for good
 * on a claim that was supposed to fail.
 */
export function claimInvite(db: AuditWriter, code: string, now = new Date()): TenantInvite | null {
  const codeHash = hashCode(normalizeCode(code))

  const claimed = (db as Db)
    .update(tenantInvites)
    .set({ redeemedAt: now })
    .where(
      and(
        eq(tenantInvites.codeHash, codeHash),
        isNull(tenantInvites.redeemedAt),
        isNull(tenantInvites.revokedAt),
        gt(tenantInvites.expiresAt, now),
      ),
    )
    .returning()
    .all()[0]
  return claimed ?? null
}
