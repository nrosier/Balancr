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
  fetchSchedules,
  type BudgetMonth,
} from '../adapters/actual/queries.ts'
import { fetchAccounts as fetchGhostfolioAccounts } from '../adapters/ghostfolio/client.ts'
import { toCents } from '../adapters/ghostfolio/types.ts'
import { config } from '../config.ts'
import type { Db } from '../db/index.ts'
import {
  accountMapBySource,
  applyDerivedFields,
  applyDerivedMirror,
  deriveMirrors,
  loadAccountMap,
  syncAccountMap,
  type AccountSighting,
} from '../domain/aggregate/accounts.ts'
import {
  ghostfolioKind,
  type GhostfolioAccountEvidence,
} from '../domain/aggregate/classify.ts'
import { FREQUENCY_WINDOW } from '../domain/aggregate/baseline.ts'
import { committedForMonth, emptyCommitted } from '../domain/aggregate/committed.ts'
import { loadFrequencies, persistFacts, syncCategoryMeta } from '../domain/aggregate/facts.ts'
import { persistMismatches, persistMonthTotals } from '../domain/aggregate/month-store.ts'
import { loadParams } from '../domain/aggregate/params.ts'
import { aggregateSpend } from '../domain/aggregate/spend.ts'
import type { Logger } from '../logger.ts'
import { addMonths, currentMonthIn, endOfMonth, startOfMonth, todayIn } from '../util/month.ts'
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
): Promise<{
  created: number
  renamed: number
  missing: number
  /** Rows whose derived `kind` changed this pass. */
  reclassified: number
  /** Pairs newly grouped as the same money. */
  mirrored: number
}> {
  const sightings: AccountSighting[] = (await fetchActualAccounts()).map((account) => ({
    source: 'actual' as const,
    externalId: account.id,
    name: account.name,
    offBudget: account.offbudget,
    closed: account.closed,
  }))

  const evidence: GhostfolioAccountEvidence[] = []
  try {
    for (const account of (await fetchGhostfolioAccounts()).accounts) {
      const seen: GhostfolioAccountEvidence = {
        externalId: account.id,
        name: account.name,
        activitiesCount: account.activitiesCount ?? null,
        // `balance` unconverted is the fallback rather than an error: on a
        // single-currency instance the two are the same number, and refusing to
        // classify at all would leave every account labelled invested.
        balanceCents: toCents(account.balanceInBaseCurrency ?? account.balance),
        valueCents: toCents(account.valueInBaseCurrency ?? account.balance),
      }
      evidence.push(seen)
      sightings.push({
        source: 'ghostfolio',
        externalId: account.id,
        name: account.name,
        holdsInvestments: ghostfolioKind(seen) === 'investment',
      })
    }
  } catch (error) {
    log.warn(
      { err: error },
      'Ghostfolio accounts unavailable; the existing mapping for them is kept',
    )
  }

  const result = syncAccountMap(db, sightings)
  const classified = classifyGhostfolio(db, evidence, log)
  return {
    created: result.created,
    renamed: result.renamed,
    missing: result.missing.length,
    ...classified,
  }
}

/**
 * Re-derives what Ghostfolio can tell us, for rows that already existed.
 *
 * `defaultKind` only runs on insert, so without this pass an account discovered
 * before the classifier existed would keep the label it was given then — which on
 * the reporting instance means six bank balances counted as investments and counted
 * twice. Everything here goes through `applyDerivedFields` and `applyDerivedMirror`,
 * so a person's answer is never overwritten, including the answer "these two
 * accounts are not the same".
 */
/**
 * Labels each Ghostfolio account from its own evidence, then groups the mirrors.
 *
 * Exported for the tests, because this is where the two halves of #124 meet: the
 * classifier has to have written `cash` before the mirror rule can recognise a twin,
 * and both have to go through the derived-write path so that a person's answer
 * survives. In one pass, in this order, or the feature does nothing on a fresh sync.
 */
export function classifyGhostfolio(
  db: Db,
  evidence: readonly GhostfolioAccountEvidence[],
  log: Logger,
): { reclassified: number; mirrored: number } {
  if (evidence.length === 0) return { reclassified: 0, mirrored: 0 }

  const byExternalId = accountMapBySource(loadAccountMap(db), 'ghostfolio')
  let reclassified = 0
  for (const seen of evidence) {
    const row = byExternalId.get(seen.externalId)
    if (row === undefined) continue
    const kind = ghostfolioKind(seen)
    // Counted from the row that came back, not from what was offered: a field a
    // person has decided is refused, and `applyDerivedFields` still returns the row
    // — so comparing against the intent would report relabellings that never
    // happened, on exactly the accounts someone had already corrected by hand.
    const after = applyDerivedFields(db, row.id, { kind })
    if (after !== null && after.kind !== row.kind) reclassified += 1
  }

  // Read again: the mirror rule matches on `kind`, so it has to see the labels the
  // pass above just wrote rather than the ones it started from.
  const mirrors = deriveMirrors(loadAccountMap(db))
  let mirrored = 0
  for (const mirror of mirrors) {
    if (applyDerivedMirror(db, mirror) === null) continue
    mirrored += 1
    // At info, not debug: this removes an account from net worth, and a total that
    // dropped needs a line somebody can find that says which account and why.
    log.info(
      { matchedOn: mirror.matchedOn },
      'Ghostfolio cash grouped with its Actual twin; Actual counts',
    )
  }

  return { reclassified, mirrored }
}

async function run({ db, log }: JobContext): Promise<JobDetail> {
  await syncActual()

  const params = loadParams(db)
  const available = await fetchBudgetMonths()
  const currentMonth = currentMonthIn(config.TZ)
  const { load, targets } = planMonths(
    available,
    currentMonth,
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

  // What is still to come this month (#159). Read here rather than inside
  // `aggregateSpend` for the reason every clock-dependent figure is: the
  // aggregator is pure and this is a function of today. Only the current month
  // gets one — a past month's committed figure is zero by definition, and the
  // schedules for a future month are not what `targets` is about.
  const committed = targets.includes(currentMonth)
    ? committedForMonth({
        schedules: await fetchSchedules(),
        month: currentMonth,
        today: todayIn(config.TZ),
      })
    : emptyCommitted(currentMonth)

  const aggregate = aggregateSpend({
    history,
    recomputed,
    frequencies: loadFrequencies(db),
    targetMonths: targets,
    committed,
    params,
  })

  // Categories before facts: `loadFrequencies` above read the previous pass's
  // rows, so a category seen for the first time today gets its row now and is
  // classifiable by the next pass.
  const categories = syncCategoryMeta(db, aggregate.facts)
  const facts = persistFacts(db, aggregate.facts, targets)
  // Month totals cover the target months, so the uncategorised backlog stored
  // here is the backlog over the months this install reports on
  // (`JOBS_HISTORY_MONTHS`). Buckets from the extra months loaded purely to feed a
  // baseline are dropped: there is no month row to hang them on, and a to-do list
  // reaching further back than any page shows is not a to-do list.
  const months = persistMonthTotals(db, aggregate.totals, aggregate.uncategorised)
  const drift = persistMismatches(db, aggregate.mismatches, targets)
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
    accountsReclassified: accounts.reclassified,
    accountsMirrored: accounts.mirrored,
    totals: months,
    uncategorisedTxns: aggregate.uncategorised.reduce((sum, b) => sum + b.txnCount, 0),
    committedCents: committed.totalCents,
    committedUnallocatedCents: committed.unallocatedCents,
    committedOccurrences:
      committed.unallocatedCount +
      [...committed.categories.values()].reduce(
        (sum, category) => sum + category.occurrences,
        0,
      ),
    mismatches: drift.mismatches,
  }
}

export const syncJob: Job = {
  name: 'sync',
  schedule: { kind: 'interval', minutes: config.JOBS_SYNC_INTERVAL_MINUTES },
  run,
}
