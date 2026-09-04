/**
 * Decisions on a pending proposal — the first writes #45 exposes over HTTP.
 *
 * Outside `routes/api/`, for the same reason `settings.ts`/`refresh.ts`/`ai.ts`
 * are: that directory's rule is "every route reads and nothing more", checked
 * against the directory by `server-api.test.ts`, and applying or rejecting a
 * proposal is neither — it writes to `proposals`, to the audit log, and (for
 * the two Actual-backed types) to Actual itself. Reading the queue stays a GET
 * on `/api/insights` (`routes/api/insights.ts`), which is exactly the read
 * this file's two decisions make stale.
 *
 * Owner-only throughout: a viewer may see what the model would change, not
 * make it happen. No `aiRateLimit()` — neither endpoint calls a model, so the
 * global limit is the right bucket.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Db } from '../../db/index.ts'
import {
  applyProposal,
  loadProposal,
  rejectProposal,
  ProposalError,
  type ApplyResult,
  type ProposalRow,
} from '../../domain/ai/proposals.ts'
import { requireOwner } from '../auth/guard.ts'
import { conflict, notFound } from '../errors.ts'
import { parseBody } from '../validate.ts'
import { proposalBatchApplySchema, proposalDecisionSchema } from './api/schemas.ts'

/**
 * Loads the row for a 404, then re-checks the two things `applyProposal` and
 * `rejectProposal` also check for a 409 — not to skip their own checks (a
 * decision could still land between this read and that call), but so the
 * ordinary case answers with the right status rather than every refusal
 * collapsing to a 409 from `ProposalError`'s message.
 */
function requirePending(db: Db, id: string): ProposalRow {
  const row = loadProposal(db, id)
  if (row === null) throw notFound('No such proposal.')
  if (row.status !== 'pending') throw conflict(`This proposal is already ${row.status}.`)
  if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
    throw conflict('This proposal has expired.')
  }
  return row
}

const applyBatchRequest = z.strictObject({ ids: z.array(z.string().min(1)).min(1).max(50) })

/**
 * One id from a batch, applied on its own and reported rather than thrown —
 * the point of the endpoint is that one already-expired card in a ten-item
 * "apply selected" does not stop the other nine.
 */
async function applyOne(db: Db, id: string, userId: string): Promise<ApplyResult> {
  requirePending(db, id)
  return applyProposal(db, { id, userId })
}

export function registerProposalRoutes(app: FastifyInstance, db: Db): void {
  app.post('/api/proposals/:id/apply', async (request: FastifyRequest) => {
    const user = requireOwner(request)
    const { id } = request.params as { id: string }

    try {
      const result = await applyOne(db, id, user.id)
      return proposalDecisionSchema.parse({ id: result.id, status: 'applied' })
    } catch (error) {
      // Reached only if the row's state moved between `requirePending`'s read
      // and the write itself — the ordinary refusals are already 404/409 by then.
      if (error instanceof ProposalError) throw conflict(error.message)
      throw error
    }
  })

  app.post('/api/proposals/:id/reject', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const { id } = request.params as { id: string }
    requirePending(db, id)

    try {
      const row = rejectProposal(db, { id, userId: user.id })
      return proposalDecisionSchema.parse({ id: row.id, status: 'rejected' })
    } catch (error) {
      if (error instanceof ProposalError) throw conflict(error.message)
      throw error
    }
  })

  /**
   * "Apply selected", processed one at a time. Sequential rather than
   * `Promise.all`: `withActual` serialises Actual calls through its own queue
   * anyway, so parallelising here would only reorder which one waits, not make
   * the batch faster — and a per-id try/catch is simpler to reason about
   * sequentially than interleaved.
   */
  app.post('/api/proposals/apply-batch', async (request: FastifyRequest) => {
    const user = requireOwner(request)
    const { ids } = parseBody(applyBatchRequest, request.body)

    const results: { id: string; ok: boolean; reason: string | null }[] = []
    for (const id of ids) {
      try {
        await applyOne(db, id, user.id)
        results.push({ id, ok: true, reason: null })
      } catch (error) {
        results.push({
          id,
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return proposalBatchApplySchema.parse({ results })
  })
}
