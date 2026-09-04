/**
 * `GET /api/insights` — what the AI layer concluded, and what it wants to know.
 *
 * Served entirely from what the nightly job already stored. Opening this page
 * never calls Gemini, which is the whole reason the AI budget is a limit rather
 * than a hope: the expensive work happens once, on a schedule, and every read
 * afterwards is free.
 *
 * Two things here are text, and both are deliberate exceptions rather than
 * oversights. The monthly narrative is free prose by design — it is the one output
 * where a list of codes would be worse than a paragraph — and it is generated per
 * locale and cached, so switching language shows a cached translation or nothing,
 * never a surprise model call. The clarification cards and proposal diffs are
 * rendered from the local catalogue, where the labels and the real category names
 * live; the model never saw the name of a sensitive category, so it could not have
 * written them.
 *
 * Everything else is codes and integers.
 *
 * `ai` says whether a model can run here at all. Three of the five sections below it
 * are the AI layer's output, and on a deployment with no key they are empty arrays that
 * look exactly like "nothing to report" — so the flag is what lets the page explain
 * itself rather than draw four blank cards (#165). The deterministic `signals` are
 * unaffected either way, which is the whole point.
 *
 * The ledger is here too, and it is the part that makes the rest of the page
 * checkable: `runs` lists every attempt with its cost and status, and one of them
 * can be opened to read the payload it was prepared with, byte for byte. The
 * payloads are not inlined — see `aiRunSchema` — because a page that costs ten
 * times as much to load is a page somebody eventually stops loading.
 *
 * Takes `?month=YYYY-MM` since #158, exactly as `/api/budget` does and through the same
 * `resolveMonth`, so the two pickers cannot disagree about what a month means or which
 * ones exist. **Three of the six sections narrow with it and two deliberately do not**,
 * and the split is the one judgement in this file:
 *
 *  - `signals`, `narrative` and `runs` are *about* a month. Each is stored under one, and
 *    reading July's page should show what was found in July, what was written about July
 *    and what it cost — not August's findings under July's heading, which is what the
 *    narrative did before this endpoint took a month at all.
 *  - `questions` and `proposals` are **standing work**, and stay whole. Both are queues of
 *    things nobody has answered yet, and neither has a month of its own: a proposal
 *    carries a target and a nullable run, a clarification card carries a category.
 *    Filtering them through the run that happened to raise them would file an unanswered
 *    question from July under July — the one month nobody has a reason to open again — and
 *    it would be gone from every other view with nothing to say it existed. A queue that
 *    hides its backlog unless you guess the right month is not a queue.
 *
 * The page says which is which, because a section that ignores the picker above it has to
 * explain itself or it reads as a bug.
 */
import { config } from '../../../config.ts'
import type { Db } from '../../../db/index.ts'
import { storedMonths } from '../../../domain/aggregate/month-store.ts'
import { loadSignals } from '../../../domain/aggregate/signals-store.ts'
import { aiAvailability } from '../../../domain/ai/availability.ts'
import { budgetState } from '../../../domain/ai/budget.ts'
import { openQuestions } from '../../../domain/ai/clarify.ts'
import { loadNarrative, renderNarrative } from '../../../domain/ai/narrative.ts'
import { pendingProposals, renderProposal } from '../../../domain/ai/proposals.ts'
import { loadRun, loadRunPayload, recentRuns, type AiRunRow } from '../../../domain/ai/runs.ts'
import { resolveMonth } from './budget.ts'
import {
  aiRunPayloadSchema,
  insightsSchema,
  type AiRun,
  type AiRunPayload,
  type Insights,
} from './schemas.ts'
import { freshness } from './freshness.ts'

export interface InsightsOptions {
  /** `?month=`, unvalidated. A malformed value is a 400, as on `/api/budget`. */
  month?: unknown
  locale?: string
  /**
   * Whether this reader may start a run. Drawn from the session's role by the caller,
   * because a route knows who is asking and this function does not.
   */
  owner?: boolean
}

export function buildInsights(db: Db, options: InsightsOptions = {}): Insights {
  const locale = options.locale ?? config.DEFAULT_LOCALE
  const month = resolveMonth(db, options.month)
  // Per month and per locale, unlike before, when it was the newest narrative in this
  // language whatever month it described. That was a real hazard rather than a
  // simplification: on the 3rd of September the page printed August's review with no
  // period beside it, and there was no way to ask for July's. The cost is that a month
  // with no narrative now says so — which is the truth, and the button beside it is #158.
  const narrative = month === null ? null : loadNarrative(db, month, locale)
  const spend = budgetState(db)

  return insightsSchema.parse({
    freshness: freshness(db),
    ai: aiAvailability(),
    owner: options.owner ?? false,
    month,
    months: storedMonths(db),
    signals: month === null ? [] : loadSignals(db, month),
    narrative:
      narrative === null
        ? null
        : {
            period: narrative.period,
            locale: narrative.locale,
            // Rendered, not stored: `bodyMd` still has the model's labels in it.
            html: renderNarrative(db, narrative),
            generatedAt: narrative.createdAt.toISOString(),
            model: loadRun(db, narrative.runId)?.model ?? null,
          },
    questions: openQuestions(db, locale).map((card) => ({
      id: card.id,
      categoryId: card.categoryId,
      categoryName: card.categoryName,
      code: card.code,
      question: card.question,
      guess: card.guess,
      guessLabel: card.guessLabel,
      choices: card.choices,
      materialityBp: card.materialityBp,
      createdAt: card.createdAt.toISOString(),
    })),
    proposals: pendingProposals(db).map((row) => {
      const card = renderProposal(db, row, locale)
      return {
        id: card.id,
        type: card.type,
        targetRef: card.targetRef,
        targetName: card.targetName,
        fields: card.fields,
        createdAt: card.createdAt.toISOString(),
        expiresAt: card.expiresAt?.toISOString() ?? null,
      }
    }),
    // Reported on every read rather than only once exceeded, so the number is
    // visible before it becomes a banner.
    spend: {
      month: spend.month,
      spentMicroEur: spend.spentMicroEur,
      budgetMicroEur: spend.budgetMicroEur,
      usedBp: spend.usedBp,
      exceeded: spend.exceeded,
    },
    // Twenty rather than the ledger's default fifty: this is the tail of the page,
    // read to answer "what happened last night", and the monthly totals that answer
    // "what has this cost" are on the settings screen.
    //
    // Scoped to the month, plus every run that was about no month at all — a chat turn,
    // or a call that failed before it knew. See `recentRuns`: those rows belong under
    // whatever is on screen rather than under nothing.
    runs: (month === null ? recentRuns(db, 20) : recentRuns(db, 20, month)).map(wireRun),
  })
}

/** One ledger row, minus `payloadJson` and `promptId`. */
function wireRun(row: AiRunRow): AiRun {
  return {
    id: row.id,
    kind: row.kind,
    model: row.model,
    locale: row.locale,
    status: row.status,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedTokens: row.cachedTokens,
    costMicroEur: row.costMicroEur,
    durationMs: row.durationMs,
    error: row.error,
    period: row.period,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * One run with its payload, or null for an id that is not in the ledger.
 *
 * The row comes back alongside the payload rather than being looked up separately
 * by the client. Which model, which language and how much it cost are what a payload
 * has to be read against — the same bundle sent to Flash and to Pro is two different
 * facts — and a client stitching the two together from the list it already has would
 * be guessing that the list has not changed since it loaded.
 */
export function buildRunPayload(db: Db, id: string): AiRunPayload | null {
  const row = loadRun(db, id)
  if (row === null) return null

  return aiRunPayloadSchema.parse({
    ...wireRun(row),
    // `null` for a row whose JSON will not parse. That is the audit view's own
    // finding to report, not a 500: the row exists and the rest of it is readable.
    payload: loadRunPayload(db, id),
  })
}
