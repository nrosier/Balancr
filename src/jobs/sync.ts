/**
 * The pass that pulls from both sources and rebuilds the computed facts.
 *
 * One job rather than four, because these four steps are only meaningful
 * together: aggregation reads the budget history the sync downloaded, and the
 * baseline reads the frequencies `syncCategoryMeta` keeps current. Splitting them
 * would produce a state where the facts are from 03:00 and the categories from
 * yesterday, and no reader could tell.
 *
 * Read-only against Actual, by construction: `client.ts` exports no write method,
 * so there is nothing here that could mutate a budget even by mistake.
 */
import { syncActual } from '../adapters/actual/client.ts'
import {
  fetchAccounts as fetchActualAccounts,
  fetchBudgetMonth,
  fetchBudgetMonths,
  fetchRecomputedSpend,
  type BudgetMonth,
} from '../adapters/actual/queries.ts'
import { fetchAccounts as fetchGhostfolioAccounts } from '../adapters/ghostfolio/client.ts'
import { config } from '../config.ts'
import type { Db } from '../db/index.ts'
import { syncAccountMap, type AccountSighting } from '../domain/aggregate/accounts.ts'
import { FREQUENCY_WINDOW } from '../domain/aggregate/baseline.ts'
import { loadFrequencies, persistFacts, syncCategoryMeta } from '../domain/aggregate/facts.ts'
import { loadParams } from '../domain/aggregate/params.ts'
import { aggregateSpend } from '../domain/aggregate/spend.ts'
import type { Logger } from '../logger.ts'
import { addMonths, currentMonthIn, endOfMonth, startOfMonth } from '../util/month.ts'
import type { Job, JobContext, JobDetail } from './runner.ts'

/**
 * The widest per-observation window any frequency asks for, in months.
 *
 * An annual category's observation *is* a rolling twelve-month sum, and the
 * baseline wants `windowMonths` of those observations from *before* the month
 * being judged. Both have to fit, so history reaches back
 * `windowMonths + WIDEST_WINDOW - 1` months before the first target — the minus
 * one because the target month is itself the last month of its own observation.
 *
 * Fetch fewer and every annual baseline comes back null. That failure is silent,
 * which is why the arithmetic is spelled out here and asserted in the tests.
 */
const WIDEST_WINDOW = Math.max(...Object.values(FREQUENCY_WINDOW))

/** Months of history a baseline of `windowMonths` observations needs. */
export function historyDepth(baselineWindowMonths: number): number {
  return baselineWindowMonths + WIDEST_WINDOW - 1
}

/** Months to load, and the subset to emit facts for. */
export function planMonths(
  available: readonly string[],
  currentMonth: string,
  targetCount: number,
  baselineWindowMonths: number,
): { load: string[]; targets: string[] } {
  // Ascending and capped at the current month: Actual lists budget months a year
  // into the future, and a future month has no spend to judge — including one
  // would emit facts claiming every category is far under its norm.
  const known = [...available].sort().filter((month) => month <= currentMonth)
  if (known.length === 0) return { load: [], targets: [] }

  const targets = known.slice(-targetCount)
  const firstTarget = targets[0] as string
  const wanted = addMonths(firstTarget, -historyDepth(baselineWindowMonths))
  // Clamped to what Actual has: asking for months before the budget existed
  // would break the density assertion `aggregateSpend` relies on.
  const load = known.filter((month) => month >= wanted)

  return { load, targets }
}

async function fetchHistory(months: readonly string[]): Promise<BudgetMonth[]> {
  const out: BudgetMonth[] = []
  // Sequential on purpose: every call goes through the Actual serialiser anyway,
  // so `Promise.all` over 36 months would buy nothing and only make the order of
  // a failure unpredictable.
  for (const month of months) out.push(await fetchBudgetMonth(month))
  return out
}

/**
 * Both sources' accounts into `account_map`.
 *
 * A Ghostfolio failure must not lose the Actual half. The mapping carries the
 * dedupe decisions that keep net worth honest, and syncing from a partial
 * sighting list would report every unseen account as missing — so a Ghostfolio
 * outage is logged and skipped rather than aborting the pass.
 */
async function syncAccounts(
  db: Db,
  log: Logger,
): Promise<{ created: number; renamed: number; missing: number }> {
  const sightings: AccountSighting[] = (await fetchActualAccounts()).map((account) => ({
    source: 'actual' as const,
    externalId: account.id,
    name: account.name,
    offBudget: account.offbudget,
    closed: account.closed,
  }))

  try {
    for (const account of (await fetchGhostfolioAccounts()).accounts) {
      sightings.push({
        source: 'ghostfolio',
        externalId: account.id,
        name: account.name,
      })
    }
  } catch (error) {
    log.warn(
      { err: error },
      'Ghostfolio accounts unavailable; the existing mapping for them is kept',
    )
  }

  const result = syncAccountMap(db, sightings)
  return {
    created: result.created,
    renamed: result.renamed,
    missing: result.missing.length,
  }
}

async function run({ db, log }: JobContext): Promise<JobDetail> {
  await syncActual()

  const params = loadParams(db)
  const available = await fetchBudgetMonths()
  const { load, targets } = planMonths(
    available,
    currentMonthIn(config.TZ),
    config.JOBS_HISTORY_MONTHS,
    params.baseline.windowMonths,
  )

  if (targets.length === 0) {
    // An empty budget is a legitimate state — a freshly created Actual file — and
    // must not read as a failure in the ops table.
    log.warn('Actual reports no budget months at or before the current month')
    return { months: 0, facts: 0 }
  }

  const history = await fetchHistory(load)
  const recomputed = await fetchRecomputedSpend(
    startOfMonth(load[0] as string),
    endOfMonth(load[load.length - 1] as string),
  )

  const aggregate = aggregateSpend({
    history,
    recomputed,
    frequencies: loadFrequencies(db),
    targetMonths: targets,
    params,
  })

  // Categories before facts: `loadFrequencies` above read the previous pass's
  // rows, so a category seen for the first time today gets its row now and is
  // classifiable by the next pass.
  const categories = syncCategoryMeta(db, aggregate.facts)
  const facts = persistFacts(db, aggregate.facts, targets)
  const accounts = await syncAccounts(db, log)

  return {
    months: targets.length,
    historyMonths: load.length,
    facts: facts.written,
    factsRemoved: facts.removed,
    categories,
    accountsCreated: accounts.created,
    accountsRenamed: accounts.renamed,
    accountsMissing: accounts.missing,
    uncategorisedTxns: aggregate.uncategorised.reduce((sum, b) => sum + b.txnCount, 0),
    mismatches: aggregate.mismatches.length,
  }
}

export const syncJob: Job = {
  name: 'sync',
  schedule: { kind: 'interval', minutes: config.JOBS_SYNC_INTERVAL_MINUTES },
  run,
}
