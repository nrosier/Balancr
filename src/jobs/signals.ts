/**
 * The nightly pass that turns stored facts into findings.
 *
 * Reads SQLite and nothing else, with one exception: Actual's account list, for
 * `last_reconciled`. There is no honest way to store that — a reconciliation is
 * an event in Actual and the only place it exists is Actual — and it is one AQL
 * query rather than a budget download.
 *
 * Everything else comes from the fact tables the sync pass wrote, which is what
 * makes this pass cheap enough to run nightly and re-runnable after a mapping
 * correction without touching either source. Net worth is read from the *stored*
 * snapshot rather than recomputed here: the net-worth job runs earlier in the
 * same queue, and computing it again in this pass would mean two figures that
 * can disagree.
 *
 * Signals are facts about a month, so a re-run replaces that month wholesale;
 * `persistSignals` does that in one transaction.
 */
import { fetchAccounts } from '../adapters/actual/queries.ts'
import { config } from '../config.ts'
import type { Db } from '../db/index.ts'
import { loadFacts } from '../domain/aggregate/facts.ts'
import type { AccountReconciliation } from '../domain/aggregate/hygiene.ts'
import {
  latestStoredMonth,
  loadMismatches,
  loadTrailingTotals,
  loadUncategorised,
  storedMonths,
} from '../domain/aggregate/month-store.ts'
import { loadLatestNetWorth, loadNetWorthHistory } from '../domain/aggregate/networth-store.ts'
import { loadParams } from '../domain/aggregate/params.ts'
import { latestDriftPersistence } from '../domain/advice/latest.ts'
import type { DriftPersistence } from '../domain/advice/persistence.ts'
import { custodyContext, splitMonth } from '../domain/aggregate/custody-context.ts'
import { benchmarkContext, compareMonth } from '../domain/benchmark/context.ts'
import { computeSignals } from '../domain/aggregate/signals.ts'
import { persistSignals, staleMonths } from '../domain/aggregate/signals-store.ts'
import { latestSnapshotDate } from '../domain/portfolio/store.ts'
import { addMonths, dateIn, isDate, monthProgress } from '../util/month.ts'
import type { Job, JobContext, JobDetail } from './runner.ts'

/**
 * How many months this pass rejudges every night, regardless of whether anything
 * changed, counting back from the latest stored one.
 *
 * Two, not one. The month being judged is normally the current one, but on the
 * first night of a new month the month that just ended has never been seen in its
 * final state — its last few days of spend arrived after the previous run — and
 * nothing else would ever revisit it. Two months is also what makes a mid-month
 * correction to `category_meta` show up on last month's page.
 *
 * This floor stands independently of `staleMonths` (#162): a month can need
 * rejudging because its own facts just changed, or because it is one of these
 * two, and the two reasons don't overlap in general.
 */
const MONTHS_JUDGED = 2

/**
 * Actual's `last_reconciled` as a calendar date in the configured zone.
 *
 * Actual stores it as epoch milliseconds in a text column, which `daysBetween`
 * would read as a date far in the future. Both shapes are accepted because the
 * column is untyped and this is the kind of detail that changes between server
 * versions; anything else becomes null, i.e. "never reconciled", which
 * overstates the problem rather than hiding it.
 */
export function reconciledDate(raw: string | null, timeZone: string): string | null {
  if (raw === null) return null
  if (isDate(raw)) return raw
  if (/^\d+$/.test(raw)) {
    const instant = new Date(Number(raw))
    return Number.isNaN(instant.getTime()) ? null : dateIn(instant, timeZone)
  }
  return null
}

/** Actual's accounts in the shape the hygiene producer wants. */
export async function collectReconciliations(
  timeZone: string,
): Promise<AccountReconciliation[]> {
  return (await fetchAccounts()).map((account) => ({
    accountId: account.id,
    name: account.name,
    lastReconciled: reconciledDate(account.last_reconciled, timeZone),
    closed: account.closed,
  }))
}

/** Everything a month's signals depend on that is not the month itself. */
interface Shared {
  today: string
  accounts: readonly AccountReconciliation[]
  netWorth: ReturnType<typeof loadLatestNetWorth>
  netWorthHistory: readonly { date: string; totalCents: number }[]
  latestPortfolioSnapshot: string | null
  params: ReturnType<typeof loadParams>
  /**
   * The benchmark file, the household and the category mapping, read once for the
   * whole pass (#43). Shared rather than per month for the same reason the account
   * list is: none of the three is a fact about a particular month.
   */
  benchmark: ReturnType<typeof benchmarkContext>
  /**
   * Which categories are shared with a co-parent, and the share that is yours (#44).
   * Shared for the same reason: neither is a fact about a particular month.
   */
  custody: ReturnType<typeof custodyContext>
  /**
   * How long each portfolio class has been outside its band (#183), and the month it is
   * a statement about — the one the latest snapshot falls in.
   *
   * Both are needed, because they are two different facts: `persistence` is today's
   * reading, and `month` is where it belongs. A pass over twelve months would otherwise
   * have to guess, and the two obvious guesses are both wrong — attaching it to every
   * month claims the portfolio looked like this in each of them, and attaching it to the
   * newest month with *budget* facts puts a portfolio reading in September because Actual
   * has September transactions, while Ghostfolio last synced in July.
   */
  drift: DriftPersistence | null
  driftMonth: string | null
}

/**
 * Judges one month, or returns null when it has no facts.
 *
 * The uncategorised backlog and the drift rows are read over the same window the
 * household producers use, so the hygiene score for a month is about the data
 * behind *that* month. A backlog cleared in September must not still be
 * deducted from August's score, and September's must not be charged to August.
 */
export function judgeMonth(
  db: Db,
  month: string,
  monthElapsed: number,
  shared: Shared,
): { signals: number; scoreBp: number } | null {
  const totalsHistory = loadTrailingTotals(db, month, config.JOBS_HISTORY_MONTHS)
  if (totalsHistory.length === 0) return null

  const window = totalsHistory.map((totals) => totals.month)
  const facts = loadFacts(db, month)
  const result = computeSignals({
    month,
    today: shared.today,
    monthProgress: monthElapsed,
    facts,
    totalsHistory,
    netWorth: shared.netWorth,
    netWorthHistory: shared.netWorthHistory,
    uncategorised: loadUncategorised(db, window),
    // Per month, unlike the backlog: a `recompute_mismatch` names the category and
    // the month whose sum disagrees, and showing twenty-four months of them on one
    // page would bury the one that appeared last night.
    mismatches: loadMismatches(db, [month]),
    accounts: shared.accounts,
    latestPortfolioSnapshot: shared.latestPortfolioSnapshot,
    benchmark: compareMonth(shared.benchmark, month, facts),
    custody: splitMonth(shared.custody, month, facts),
    drift: month === shared.driftMonth ? shared.drift : null,
    params: shared.params,
  })

  // The fingerprint that was true for this exact run (#162), so a later pass
  // can tell whether the month needs rejudging without recomputing anything.
  const factsHash = totalsHistory.find((totals) => totals.month === month)?.factsHash ?? null
  const stored = persistSignals(db, month, result.signals, result.hygiene, factsHash)
  return { signals: stored.signals, scoreBp: result.hygiene.scoreBp }
}

async function run({ db, now, log }: JobContext): Promise<JobDetail> {
  const latest = latestStoredMonth(db)
  if (latest === null) {
    // Before the first sync there is nothing to judge, which is a state to report
    // rather than fail on: the ops table should say "ok, 0 months", not "error".
    log.warn('no stored month totals yet; the sync job has not produced facts')
    return { months: 0, signals: 0 }
  }

  const params = loadParams(db)
  const latestSnapshot = latestSnapshotDate(db)
  const shared: Shared = {
    today: dateIn(now, config.TZ),
    accounts: await collectReconciliations(config.TZ),
    netWorth: loadLatestNetWorth(db),
    netWorthHistory: loadNetWorthHistory(db),
    latestPortfolioSnapshot: latestSnapshot,
    params,
    benchmark: benchmarkContext(db),
    custody: custodyContext(db),
    drift: latestDriftPersistence(db, params.drift.persistentMonths),
    // The snapshot's own month, not the newest month of budget facts: see `Shared`.
    driftMonth: latestSnapshot === null ? null : latestSnapshot.slice(0, 7),
  }

  // The floor (always judged) union'd with every month whose fact fingerprint
  // has moved since it was last judged (#162) — an edit landed in a month
  // outside the floor, and nothing else would ever revisit it.
  const floor: string[] = []
  for (let back = MONTHS_JUDGED - 1; back >= 0; back -= 1) floor.push(addMonths(latest, -back))
  const judgedMonths = [...new Set([...floor, ...staleMonths(db, storedMonths(db))])].sort()

  let months = 0
  let signals = 0
  let scoreBp: number | null = null
  // Ascending, so `scoreBp` in the detail ends up being the latest month's — the
  // one an operator reading the ops table is asking about.
  for (const month of judgedMonths) {
    const judged = judgeMonth(db, month, monthProgress(month, now, config.TZ), shared)
    if (judged === null) continue
    months += 1
    signals += judged.signals
    scoreBp = judged.scoreBp
  }

  return {
    latestMonth: latest,
    months,
    signals,
    hygieneScoreBp: scoreBp,
    netWorthDate: shared.netWorth?.date ?? null,
    accounts: shared.accounts.length,
  }
}

export const signalsJob: Job = {
  name: 'signals',
  // Nightly, after the sync and the net-worth pass have run in the same queue.
  // Not on the sync interval: a signal is a judgement about a month, and
  // recomputing it hourly would only churn the same rows.
  schedule: { kind: 'daily', hour: config.JOBS_NIGHTLY_HOUR },
  run,
}
