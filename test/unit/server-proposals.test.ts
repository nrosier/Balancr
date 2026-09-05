/**
 * `POST /api/proposals/:id/apply`, `.../reject` and `.../apply-batch` (#45).
 *
 * `category_meta.set` is the proposal type under test here rather than either
 * Actual-writing type: what these three routes are responsible for is the
 * gating (owner-only, 404/409 on a bad id) and the batch's per-id reporting,
 * none of which depends on which handler actually runs. The Actual-writing
 * handlers have their own coverage in `proposals.test.ts` and
 * `proposal-generators.test.ts`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../../src/db/index.ts'
import { auditLog, categoryMeta, users } from '../../src/db/schema.ts'
import { createProposal, encodeBudgetTarget, loadProposal, type ProposalRow } from '../../src/domain/ai/proposals.ts'
import { initI18n } from '../../src/i18n/index.ts'
import { buildApp } from '../../src/server/app.ts'
import { createSession } from '../../src/server/auth/sessions.ts'
import { CSRF_COOKIE, SESSION_COOKIE } from '../../src/server/cookies.ts'
import { CSRF_HEADER, newCsrfToken } from '../../src/server/csrf.ts'
import type {
  ProposalAdjustResult,
  ProposalBatchApply,
  ProposalDecision,
} from '../../src/server/routes/api/schemas.ts'
import { apiFixture, MONTH } from '../helpers/api-fixture.ts'
import { eq } from 'drizzle-orm'

let ctx: ReturnType<typeof apiFixture>
let app: FastifyInstance
let owner: string
let viewer: string

function signIn(db: Db, role: 'owner' | 'viewer'): string {
  const row = db
    .insert(users)
    .values({
      oidcSub: `sub-${crypto.randomUUID()}`,
      email: `${role}@example.test`,
      displayName: role,
      locale: 'en',
      role,
    })
    .returning()
    .all()[0]
  if (row === undefined) throw new Error('inserting the user returned no row')
  return createSession(db, { userId: row.id, method: 'oidc', ip: undefined, userAgent: undefined })
    .token
}

function post(url: string, token = owner) {
  const csrf = newCsrfToken()
  return app.inject({
    method: 'POST',
    url,
    payload: {},
    cookies: { [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf },
    headers: { [CSRF_HEADER]: csrf },
  })
}

function postBody(url: string, body: object, token = owner) {
  const csrf = newCsrfToken()
  return app.inject({
    method: 'POST',
    url,
    payload: body,
    cookies: { [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf },
    headers: { [CSRF_HEADER]: csrf },
  })
}

/** A pending `category_meta.set` proposal against a real category from the fixture. */
async function pendingProposal(categoryId = 'cat-groceries'): Promise<ProposalRow> {
  return createProposal(ctx.db, {
    type: 'category_meta.set',
    targetRef: categoryId,
    payload: { custodyShared: true },
  })
}

/** A pending `budget_amount.set` proposal against a real category/month from the fixture. */
async function pendingBudgetProposal(amountCents = 80_000): Promise<ProposalRow> {
  return createProposal(ctx.db, {
    type: 'budget_amount.set',
    targetRef: encodeBudgetTarget('cat-groceries', MONTH),
    payload: { amountCents },
  })
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(async () => {
  ctx = apiFixture()
  app = await buildApp({ db: ctx.db, web: null })
  owner = signIn(ctx.db, 'owner')
  viewer = signIn(ctx.db, 'viewer')
})

afterEach(async () => {
  await app.close()
  ctx.sqlite.close()
})

describe('POST /api/proposals/:id/apply', () => {
  it('applies a pending proposal and records the audit row', async () => {
    const row = await pendingProposal()

    const res = await post(`/api/proposals/${row.id}/apply`)
    expect(res.statusCode).toBe(200)
    expect(res.json<ProposalDecision>()).toEqual({ id: row.id, status: 'applied' })

    expect(loadProposal(ctx.db, row.id)?.status).toBe('applied')
    const meta = ctx.db
      .select()
      .from(categoryMeta)
      .where(eq(categoryMeta.categoryId, 'cat-groceries'))
      .get()
    expect(meta?.custodyShared).toBe(true)

    const audit = ctx.db.select().from(auditLog).where(eq(auditLog.proposalId, row.id)).all()
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: 'proposal.apply', entity: 'category_meta' })
  })

  it('404s for an id that does not exist', async () => {
    const res = await post('/api/proposals/does-not-exist/apply')
    expect(res.statusCode).toBe(404)
  })

  it('409s for a proposal that was already applied', async () => {
    const row = await pendingProposal()
    expect((await post(`/api/proposals/${row.id}/apply`)).statusCode).toBe(200)

    const res = await post(`/api/proposals/${row.id}/apply`)
    expect(res.statusCode).toBe(409)
  })

  it('refuses a viewer: reading the queue is reading, applying is not', async () => {
    const row = await pendingProposal()
    const res = await post(`/api/proposals/${row.id}/apply`, viewer)
    expect(res.statusCode).toBe(403)
    expect(loadProposal(ctx.db, row.id)?.status).toBe('pending')
  })
})

describe('POST /api/proposals/:id/adjust', () => {
  it('supersedes the proposal with a new one at the adjusted amount', async () => {
    const row = await pendingBudgetProposal(80_000)

    const res = await postBody(`/api/proposals/${row.id}/adjust`, { amountCents: 90_000 })
    expect(res.statusCode).toBe(200)

    const body = res.json<ProposalAdjustResult>()
    expect(body.status).toBe('pending')
    expect(body.id).not.toBe(row.id)
    expect(loadProposal(ctx.db, row.id)?.status).toBe('expired')
    expect(loadProposal(ctx.db, body.id)?.status).toBe('pending')
  })

  it('rejects the original instead of erroring when the adjustment matches what is already budgeted', async () => {
    const row = await pendingBudgetProposal(80_000)

    const res = await postBody(`/api/proposals/${row.id}/adjust`, { amountCents: 73_000 })
    expect(res.statusCode).toBe(200)
    expect(res.json<ProposalAdjustResult>()).toEqual({ id: row.id, status: 'rejected' })
    expect(loadProposal(ctx.db, row.id)?.status).toBe('rejected')
  })

  it('400s a proposal type with no amount to adjust', async () => {
    const row = await pendingProposal()

    const res = await postBody(`/api/proposals/${row.id}/adjust`, { amountCents: 1_000 })
    expect(res.statusCode).toBe(400)
  })

  it('404s for an id that does not exist', async () => {
    const res = await postBody('/api/proposals/does-not-exist/adjust', { amountCents: 1_000 })
    expect(res.statusCode).toBe(404)
  })

  it('409s for a proposal that was already decided', async () => {
    const row = await pendingBudgetProposal(80_000)
    expect((await post(`/api/proposals/${row.id}/reject`)).statusCode).toBe(200)

    const res = await postBody(`/api/proposals/${row.id}/adjust`, { amountCents: 90_000 })
    expect(res.statusCode).toBe(409)
  })

  it('400s a malformed amount', async () => {
    const row = await pendingBudgetProposal(80_000)
    const res = await postBody(`/api/proposals/${row.id}/adjust`, { amountCents: 'lots' })
    expect(res.statusCode).toBe(400)
  })

  it('refuses a viewer: only the owner may adjust a proposed amount', async () => {
    const row = await pendingBudgetProposal(80_000)
    const res = await postBody(`/api/proposals/${row.id}/adjust`, { amountCents: 90_000 }, viewer)
    expect(res.statusCode).toBe(403)
    expect(loadProposal(ctx.db, row.id)?.status).toBe('pending')
  })
})

describe('POST /api/proposals/:id/reject', () => {
  it('rejects a pending proposal without touching the target row', async () => {
    const row = await pendingProposal()

    const res = await post(`/api/proposals/${row.id}/reject`)
    expect(res.statusCode).toBe(200)
    expect(res.json<ProposalDecision>()).toEqual({ id: row.id, status: 'rejected' })

    expect(loadProposal(ctx.db, row.id)?.status).toBe('rejected')
    const meta = ctx.db
      .select()
      .from(categoryMeta)
      .where(eq(categoryMeta.categoryId, 'cat-groceries'))
      .get()
    expect(meta?.custodyShared).toBe(false)
  })

  it('404s for an id that does not exist', async () => {
    const res = await post('/api/proposals/does-not-exist/reject')
    expect(res.statusCode).toBe(404)
  })

  it('409s for a proposal that was already rejected', async () => {
    const row = await pendingProposal()
    expect((await post(`/api/proposals/${row.id}/reject`)).statusCode).toBe(200)

    const res = await post(`/api/proposals/${row.id}/reject`)
    expect(res.statusCode).toBe(409)
  })

  it('refuses a viewer', async () => {
    const row = await pendingProposal()
    const res = await post(`/api/proposals/${row.id}/reject`, viewer)
    expect(res.statusCode).toBe(403)
  })
})

describe('POST /api/proposals/apply-batch', () => {
  it('applies every valid id and reports a stale one inline, rather than failing the batch', async () => {
    const ok = await pendingProposal('cat-groceries')
    const stale = await pendingProposal('cat-energy')
    // Rejected by hand before the batch runs, standing in for "already decided
    // by someone else" — the case the per-id reporting exists for.
    expect((await post(`/api/proposals/${stale.id}/reject`)).statusCode).toBe(200)

    const res = await postBody('/api/proposals/apply-batch', { ids: [ok.id, stale.id] })
    expect(res.statusCode).toBe(200)

    const body = res.json<ProposalBatchApply>()
    expect(body.results).toHaveLength(2)
    expect(body.results.find((r) => r.id === ok.id)).toEqual({ id: ok.id, ok: true, reason: null })
    const staleResult = body.results.find((r) => r.id === stale.id)
    expect(staleResult?.ok).toBe(false)
    expect(staleResult?.reason).toBeTruthy()

    expect(loadProposal(ctx.db, ok.id)?.status).toBe('applied')
    expect(loadProposal(ctx.db, stale.id)?.status).toBe('rejected')
  })

  it('rejects an empty list as a bad request', async () => {
    const res = await postBody('/api/proposals/apply-batch', { ids: [] })
    expect(res.statusCode).toBe(400)
  })

  it('refuses a viewer', async () => {
    const row = await pendingProposal()
    const res = await postBody('/api/proposals/apply-batch', { ids: [row.id] }, viewer)
    expect(res.statusCode).toBe(403)
  })
})
