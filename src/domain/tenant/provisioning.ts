/**
 * The two ways an authenticated-but-tenantless OIDC identity becomes a real
 * `users` row (#373): starting a brand-new household, or redeeming an
 * invite into an existing one.
 *
 * Each function wraps its mutation and its `recordAudit` call in one
 * `db.transaction` — a user inserted with no trail, or a trail for a user
 * who was rolled back, are both worse than either failing outright.
 *
 * Domain code never imports from `src/server/*`, so both take a plain
 * identity shape rather than `OidcIdentity`/`SessionUser`.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { tenantIntegrations, tenantInvites, tenants, users } from '../../db/schema.ts'
import { config } from '../../config.ts'
import { encryptField } from '../../db/field-crypto.ts'
import { recordAudit } from '../audit.ts'
import { seedPrompts } from '../ai/prompts.ts'
import { claimInvite } from './invites.ts'

export type User = typeof users.$inferSelect

/** The minimal shape either operation needs from an authenticated identity. */
export interface Identity {
  sub: string
  email?: string | undefined
  name?: string | undefined
}

export interface CreateTenantAndOwnerInput {
  label: string
  identity: Identity
  locale: string
  now?: Date
}

/**
 * Starts a new household: a `tenants` row, a placeholder `tenantIntegrations`
 * row (required — `integrationsRow` hard-throws without one, and the new
 * owner's own `/settings` has to load), tenant-local built-in prompts, and the
 * `users` row that owns them.
 *
 * The creator is unconditionally the owner — not decided by counting
 * anything, since a brand-new tenant has no other user by construction.
 */
export function createTenantAndOwner(db: Db, input: CreateTenantAndOwnerInput): User {
  const now = input.now ?? new Date()

  return db.transaction((tx) => {
    const tenant = tx.insert(tenants).values({ label: input.label, createdAt: now }).returning().all()[0]
    if (tenant === undefined) throw new Error('creating the tenant returned no row')

    tx.insert(tenantIntegrations)
      .values({
        tenantId: tenant.id,
        actualServerUrl: '',
        actualPasswordEnc: encryptField(''),
        actualSyncId: '',
        actualE2ePasswordEnc: null,
        ghostfolioUrl: '',
        ghostfolioSecurityTokenEnc: encryptField(''),
        geminiProvider: 'aistudio',
        geminiApiKeyEnc: null,
        googleCloudProject: null,
        geminiModelFast: config.GEMINI_MODEL_FAST,
        geminiModelDeep: config.GEMINI_MODEL_DEEP,
        geminiMonthlyBudgetEurMicro: 0,
      })
      .run()

    const owner = tx
      .insert(users)
      .values({
        tenantId: tenant.id,
        oidcSub: input.identity.sub,
        email: input.identity.email ?? null,
        displayName: input.identity.name ?? null,
        locale: input.locale,
        role: 'owner',
        lastSeenAt: now,
      })
      .returning()
      .all()[0]
    if (owner === undefined) throw new Error('creating the owner returned no row')

    recordAudit(tx, {
      tenantId: tenant.id,
      action: 'tenant.create',
      entity: 'tenants',
      entityRef: tenant.id,
      actorId: owner.id,
      after: { label: tenant.label },
      at: now,
    })

    // A tenant starts with its own rows rather than falling through to another
    // household's editable prompt history. Nested transactions are savepoints in
    // SQLite, so prompt seeding remains part of this all-or-nothing provisioning.
    seedPrompts(tx, tenant.id)

    return owner
  })
}

export interface RedeemInviteAsViewerInput {
  code: string
  identity: Identity
  locale: string
  now?: Date
}

/**
 * Joins an existing household as a viewer. Always yields `viewer`, never
 * `owner` — there is no role choice in the invite flow.
 *
 * `null` collapses every failure — wrong code, expired, revoked, already
 * used — into one answer, the same generic-failure idiom `consumeLoginFlow`
 * uses, so a caller can't probe which of the four is true.
 */
export function redeemInviteAsViewer(db: Db, input: RedeemInviteAsViewerInput): User | null {
  const now = input.now ?? new Date()

  return db.transaction((tx) => {
    // `claimInvite`'s atomic UPDATE...WHERE only stamps `redeemedAt` — that
    // alone is what makes two concurrent redemptions of one code mutually
    // exclusive, since the second one finds no row left matching the WHERE.
    // `redeemedBy` is filled in below, once the viewer it names actually
    // exists. Running the claim inside this transaction still gives the
    // whole redemption one all-or-nothing outcome: a throw anywhere below
    // rolls the claim back too.
    const invite = claimInvite(tx, input.code, now)
    if (invite === null) return null

    const viewer = tx
      .insert(users)
      .values({
        tenantId: invite.tenantId,
        oidcSub: input.identity.sub,
        email: input.identity.email ?? null,
        displayName: input.identity.name ?? null,
        locale: input.locale,
        role: 'viewer',
        lastSeenAt: now,
      })
      .returning()
      .all()[0]
    if (viewer === undefined) throw new Error('creating the viewer returned no row')

    tx.update(tenantInvites).set({ redeemedBy: viewer.id }).where(eq(tenantInvites.id, invite.id)).run()

    recordAudit(tx, {
      tenantId: invite.tenantId,
      action: 'tenant.invite.redeem',
      entity: 'tenant_invites',
      entityRef: invite.id,
      actorId: viewer.id,
      at: now,
    })

    return viewer
  })
}
