/**
 * The nightly AI pass: the only thing in the app that spends money.
 *
 * It exists so that opening a page never triggers a model call. Everything the
 * Insights view shows — the ranked findings, the month's narrative, the
 * clarification queue — is written here, hours earlier, and read from SQLite.
 * That is what makes the page fast, what makes the cost predictable, and what
 * makes a page load impossible to turn into a bill.
 *
 * Four rules, each with a failure behind it:
 *
 *  - **Local work first.** Expiring stale proposals costs nothing and must happen
 *    on a night when Gemini is unreachable too, so it runs before any call.
 *  - **An unavailable model means off, not failed.** No key, `AI_ENABLED=false` or a
 *    budget of zero: the job records the reason and reports `ok`. A user who set the
 *    budget to nothing does not want a `capped` ledger row every 24 hours telling
 *    them so, and an instance that never bought a key does not want a red row for a
 *    dependency it deliberately does not have (#165).
 *  - **The finished month is analysed once more, then left alone.** Its last days
 *    of spend arrived after the previous night's run, so the figures it was judged
 *    on were never its final ones — but re-analysing a closed month every night for
 *    ever is paying repeatedly for an answer that cannot change.
 *  - **A provider fault fails the job; a month-shaped one does not.** `capped` and
 *    `no_facts` are states to report. A call that could not be made or an answer
 *    that could not be parsed is a broken integration, and the `jobs` row is where
 *    "no findings for four days" is supposed to become visible.
 *
 * Reads SQLite and calls Gemini. Unlike every other job here it touches neither
 * Actual nor Ghostfolio: it works entirely from what the earlier jobs stored,
 * which is also why it is last in the registry.
 */
import { config } from '../config.ts'
import type { Db } from '../db/index.ts'
import { latestStoredMonth } from '../domain/aggregate/month-store.ts'
import { runAnalysis, type AnalysisOutcome } from '../domain/ai/analysis.ts'
import { aiAvailability } from '../domain/ai/availability.ts'
import { spendMonthOf } from '../domain/ai/budget.ts'
import { runNarrative, type NarrativeOutcome } from '../domain/ai/narrative.ts'
import { expireProposals } from '../domain/ai/proposals.ts'
import { addMonths, dateIn } from '../util/month.ts'
import type { Job, JobContext, JobDetail } from './runner.ts'

/**
 * How many nights into a new month the month that just ended is re-analysed.
 *
 * Three, so a container that was off for a weekend still catches up, and no more,
 * because the answer stops changing once the last transactions have landed. A
 * correction made later is picked up by re-running the pass by hand rather than by
 * paying for a re-analysis of a closed month every night for ever.
 */
export const CATCHUP_NIGHTS = 3

/** The reasons that mean the integration is broken rather than the month unusual. */
const PROVIDER_FAULTS = new Set(['call_failed', 'bad_response', 'empty_response'])

/**
 * The months this pass analyses, newest last.
 *
 * The latest stored month is normally the current one. The month before it is
 * added only during the first nights of a new month — see `CATCHUP_NIGHTS`. On a
 * database whose latest month is already in the past (a container that was off for
 * a while, an archived budget) nothing is added: re-analysing a long-closed month
 * because today happens to be the 2nd would be paying for the wrong month.
 */
export function monthsToAnalyse(latest: string, now: Date, timeZone: string): string[] {
  const today = dateIn(now, timeZone)
  const dayOfMonth = Number(today.slice(8, 10))
  const previous = addMonths(latest, -1)
  const isCurrentMonth = latest === today.slice(0, 7)

  return isCurrentMonth && dayOfMonth <= CATCHUP_NIGHTS ? [previous, latest] : [latest]
}

/**
 * The month the narrative describes: the last one that has fully ended.
 *
 * A narrative about a month still in progress would be written from a third of the
 * facts and cached under that month's key, and the cache is what keeps the
 * expensive model to once per month.
 */
export function narrativePeriod(now: Date): string {
  return addMonths(spendMonthOf(now), -1)
}

async function run({ db, now, log }: JobContext): Promise<JobDetail> {
  // First, because it is free and correct even on a night with no network.
  const expired = expireProposals(db, now)

  // One check for all three ways the layer can be off, so the ops row names the
  // variable to change rather than saying "0 findings" for the third night running.
  // `ok`, not an error: an instance with no key is correctly configured, and a red
  // job row every night would train its owner to ignore the column.
  const availability = aiAvailability()
  if (!availability.enabled) {
    log.info({ expired, reason: availability.reason }, 'the AI layer is off; nothing to run')
    return {
      enabled: false,
      reason: availability.reason,
      expired,
      months: 0,
      findings: 0,
      queued: 0,
    }
  }

  const latest = latestStoredMonth(db)
  if (latest === null) {
    // Before the first sync there is nothing to analyse. A state to report, not a
    // failure: the ops table should say "ok, 0 months".
    log.warn('no stored month totals yet; the sync job has not produced facts')
    return { enabled: true, expired, months: 0, findings: 0, queued: 0 }
  }

  const analyses: AnalysisOutcome[] = []
  for (const month of monthsToAnalyse(latest, now, config.TZ)) {
    analyses.push(await runAnalysis(db, { month, now, userId: null }))
  }

  // The narrative comes after the analysis on purpose: it reads the same month's
  // facts, and if the budget only stretches to one call tonight, the ranked
  // findings are worth more than the prose.
  const narrative: NarrativeOutcome = await runNarrative(db, {
    period: narrativePeriod(now),
    now,
    userId: null,
  })

  // The latest month is the one a page is about, so its status is the one the ops
  // table reports; an older catch-up month failing is in the ledger.
  const current = analyses.at(-1)
  const detail: JobDetail = {
    enabled: true,
    expired,
    months: analyses.length,
    findings: analyses.reduce((sum, outcome) => sum + outcome.findings.length, 0),
    queued: analyses.reduce((sum, outcome) => sum + outcome.queued, 0),
    dropped: analyses.reduce((sum, outcome) => sum + outcome.dropped.length, 0),
    analysisMonth: current?.month ?? null,
    analysisStatus: current?.status ?? null,
    analysisReason: current?.reason ?? null,
    degraded: current?.degraded ?? false,
    narrativePeriod: narrative.period,
    narrativeStatus: narrative.status,
    costMicroEur:
      analyses.reduce((sum, outcome) => sum + outcome.costMicroEur, 0) + narrative.costMicroEur,
  }

  const fault = [...analyses, narrative].find((outcome) => PROVIDER_FAULTS.has(outcome.reason))
  if (fault !== undefined) {
    // Logged before throwing, because the throw only leaves a message behind and
    // the counts above are what says how much of the pass did land.
    log.info(detail, 'AI pass finished with a provider fault')
    throw new Error(`the model call did not succeed: ${fault.reason}`)
  }

  return detail
}

export const aiJob: Job = {
  name: 'ai',
  // Nightly, last in the queue: it reads the signals the earlier jobs wrote.
  schedule: { kind: 'daily', hour: config.JOBS_NIGHTLY_HOUR },
  run,
}
