/**
 * The two endpoints that can spend money, and the only ones in the HTTP layer that
 * reach Gemini at all.
 *
 * Everything else Balancr serves comes out of SQLite, written by the nightly job —
 * which is what makes the monthly budget a limit rather than a hope. This file is
 * the deliberate exception, and it exists because the prompt editor cannot work
 * without it: the question "what would this version do to last month's data" has no
 * answer that does not involve a real call.
 *
 * So the exception is fenced on four sides:
 *
 *  - **Outside `routes/api/`**, whose no-upstream rule is checked against the
 *    directory rather than against anyone's memory.
 *  - **`aiRateLimit()`** on the run, a far stricter bucket than the global one.
 *    Authentik cannot protect a pre-paid key from a loop in a browser tab.
 *  - **Owner only.** A viewer may read the dashboard; spending the month's budget is
 *    not reading.
 *  - **The cost guard, unchanged.** A dry run is billed like any other run and its
 *    `ai_runs` row is written whatever happens, because an editor that did not count
 *    would be a way around the budget rather than a feature inside it.
 *
 * The estimate is free — no call, no row — and is what the button shows *before* it
 * is pressed.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import { estimateAnalysis, runAnalysis } from '../../domain/ai/analysis.ts'
import { loadPrompt, resolvePrompt } from '../../domain/ai/prompts.ts'
import { requireOwner, requireUser } from '../auth/guard.ts'
import { badRequest, conflict, notFound } from '../errors.ts'
import { aiRateLimit } from '../rate-limit.ts'
import { resolveMonth } from './api/budget.ts'
import { parseBody } from '../validate.ts'
import {
  aiDryRunSchema,
  aiEstimateSchema,
  monthKey,
  type AiDryRun,
  type AiEstimate,
} from './api/schemas.ts'

const dryRunRequest = z.strictObject({
  month: monthKey().optional(),
  /**
   * The version being tested, rather than whichever is active.
   *
   * The whole point of the button: answering with the active prompt would make it a
   * lie. Omitted means "what the nightly job would do", which is the other question
   * worth asking.
   */
  promptId: z.string().min(1).optional(),
  locale: z
    .string()
    .refine((value) => config.SUPPORTED_LOCALES.includes(value), {
      message: 'unsupported locale',
    })
    .optional(),
})

/**
 * The month to run against: the one asked for, or the latest that has facts.
 *
 * Not "last month" as a date calculation. On a deployment whose sync last ran in
 * March, last month is empty and the run would answer `no_facts` — which is true and
 * useless. The latest stored month is the one the dashboard is showing, so it is the
 * one whose findings a reviewer can recognise.
 *
 * `resolveMonth` is the read API's own, which is what makes a malformed month a 400
 * here too rather than a 500 out of a response schema. Nothing is stored at all only
 * before the first aggregation pass, and that is a 409: the request is fine, the
 * deployment is not ready, and answering it with this month's empty payload would
 * price a run against nothing.
 */
function monthToRun(db: Db, asked: unknown): string {
  const month = resolveMonth(db, asked)
  if (month === null) throw conflict('There is no aggregated month to run against yet.')
  return month
}

/**
 * The prompt version a dry run will use, refused here rather than deeper down.
 *
 * `runAnalysis` checks the same two things and throws a plain `Error` for both,
 * which the error handler can only turn into a 500. An id from a stale editor tab is
 * a 404, and a narrative prompt sent to the analysis pass is a 400 — the caller can
 * act on either.
 */
function dryRunPrompt(
  db: Db,
  locale: string,
  promptId: string | undefined,
): { id: string | null; version: number } {
  if (promptId === undefined) {
    const active = resolvePrompt(db, 'analysis.system', locale)
    return { id: active.id, version: active.version }
  }

  const row = loadPrompt(db, promptId)
  if (row === null) throw notFound('No such prompt version.')
  if (row.key !== 'analysis.system') {
    throw badRequest('That is not an analysis prompt.', { key: row.key })
  }
  return { id: row.id, version: row.version }
}

export function registerAiRoutes(app: FastifyInstance, db: Db): void {
  /**
   * What a run on this month would cost, having spent nothing to find out.
   *
   * A GET, under the global rate limit rather than the AI one: it builds the payload
   * and prices it locally, so a client that asks on every keystroke wastes CPU and
   * not money. Putting it in the AI bucket would let the estimate exhaust the
   * allowance for the run it is describing.
   */
  app.get('/api/ai/estimate', (request: FastifyRequest): AiEstimate => {
    const user = requireUser(request)
    const query = request.query as { month?: string } | undefined
    const month = monthToRun(db, query?.month)

    return aiEstimateSchema.parse(estimateAnalysis(db, { month, locale: user.locale }))
  })

  /**
   * A real analysis whose findings are thrown away.
   *
   * `persist: false` skips exactly what would outlive the request — the findings on
   * the insights page and the questions in the clarification queue — and nothing
   * else. The call, the grounding, the ledger row and the cost are the real ones,
   * because a dry run against a mock would answer a question nobody asked.
   *
   * A failed call answers 200 with `status: 'error'`. The tokens were spent whether
   * or not the answer parsed, and an editor that showed a red box with no cost would
   * hide the part that matters.
   */
  app.post('/api/ai/dry-run', { ...aiRateLimit() }, async (request: FastifyRequest) => {
    const user = requireOwner(request)
    const body = parseBody(dryRunRequest, request.body)
    const locale = body.locale ?? user.locale
    const month = monthToRun(db, body.month)
    const prompt = dryRunPrompt(db, locale, body.promptId)

    const outcome = await runAnalysis(db, {
      month,
      locale,
      persist: false,
      userId: user.id,
      ...(body.promptId === undefined ? {} : { promptId: body.promptId }),
    })

    const response: AiDryRun = aiDryRunSchema.parse({
      status: outcome.status,
      reason: outcome.reason,
      runId: outcome.runId,
      month: outcome.month,
      locale: outcome.locale,
      promptId: prompt.id,
      promptVersion: prompt.version,
      degraded: outcome.degraded,
      costMicroEur: outcome.costMicroEur,
      findings: outcome.findings.map((finding) => ({
        code: finding.code,
        categoryId: finding.categoryId,
        severity: finding.severity,
        negative: finding.negative,
        text: finding.text,
        confidence: finding.confidence,
        metrics: finding.metrics,
      })),
      clarifications: outcome.clarifications.map((question) => ({
        code: question.code,
        categoryId: question.categoryId,
        categoryName: question.categoryName,
        guess: question.guess,
      })),
      dropped: outcome.dropped,
    })
    return response
  })
}
