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
 */
import { config } from '../../../config.ts'
import type { Db } from '../../../db/index.ts'
import { latestStoredMonth } from '../../../domain/aggregate/month-store.ts'
import { loadSignals } from '../../../domain/aggregate/signals-store.ts'
import { budgetState } from '../../../domain/ai/budget.ts'
import { openQuestions } from '../../../domain/ai/clarify.ts'
import { latestNarrative } from '../../../domain/ai/narrative.ts'
import { pendingProposals, renderProposal } from '../../../domain/ai/proposals.ts'
import { insightsSchema, type Insights } from './schemas.ts'
import { freshness } from './freshness.ts'

export function buildInsights(db: Db, locale: string = config.DEFAULT_LOCALE): Insights {
  const month = latestStoredMonth(db)
  const narrative = latestNarrative(db, locale)
  const spend = budgetState(db)

  return insightsSchema.parse({
    freshness: freshness(db),
    month,
    signals: month === null ? [] : loadSignals(db, month),
    narrative:
      narrative === null
        ? null
        : {
            period: narrative.period,
            locale: narrative.locale,
            body: narrative.bodyMd,
            generatedAt: narrative.createdAt.toISOString(),
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
  })
}
