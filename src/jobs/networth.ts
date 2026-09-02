/**
 * One net-worth snapshot per local day, out of both sources.
 *
 * The balances come from each system's own function — Actual's
 * `getAccountBalance`, Ghostfolio's account value — never from a sum of our own.
 * Two implementations of "what is this account worth" that can disagree is the
 * problem, not the fix, and this figure is the one a user will check against the
 * other tool's dashboard first.
 *
 * An account in `account_map` that neither source reported this pass is skipped,
 * not zeroed: a Ghostfolio outage must not draw a cliff on the net-worth chart.
 * `computeNetWorth` then decides what actually counts, and this job persists only
 * what it counted.
 */
import { fetchAccountBalances, fetchAccounts as fetchActualAccounts } from '../adapters/actual/queries.ts'
import { fetchAccounts as fetchGhostfolioAccounts } from '../adapters/ghostfolio/client.ts'
import { config } from '../config.ts'
import type { Db } from '../db/index.ts'
import {
  accountMapBySource,
  loadAccountMap,
  type AccountMapRow,
} from '../domain/aggregate/accounts.ts'
import { computeNetWorth, type AccountValue } from '../domain/aggregate/networth.ts'
import { persistNetWorth } from '../domain/aggregate/networth-store.ts'
import { toAccountValues } from '../domain/portfolio/snapshot.ts'
import type { Logger } from '../logger.ts'
import { dateIn } from '../util/month.ts'
import type { Job, JobContext, JobDetail } from './runner.ts'

/**
 * The Actual accounts a valuation covers, resolved once.
 *
 * Split out so the historical backfill values *the same accounts* as the nightly
 * pass. Which accounts count is a decision — see the closed-account filter below —
 * and a second copy of it would let today's net worth and last March's disagree about
 * what net worth is made of, which is precisely the step in the chart this whole
 * feature exists to avoid.
 */
export interface ActualScope {
  /** `account_map` rows for Actual, keyed by Actual's own id. */
  rows: Map<string, AccountMapRow>
  /** Mapped and open, so this is what gets a balance asked for it. */
  ids: string[]
}

export async function actualScope(rows: readonly AccountMapRow[]): Promise<ActualScope> {
  const mapped = accountMapBySource(rows, 'actual')
  if (mapped.size === 0) return { rows: mapped, ids: [] }

  // Closed accounts still hold their final balance in Actual, but including
  // them would keep a settled loan or a cancelled card in the total for ever.
  //
  // The backfill inherits this rather than deciding again, and for history the
  // trade-off is real: a card closed last March held a genuine balance in February,
  // and leaving it out understates that month. Including it would carry its final
  // balance through every month since, and — worse — would make the reconstructed
  // series disagree with the nightly figure at the exact point they meet. A shorter
  // truth beats a longer one with a step in it.
  const open = new Set(
    (await fetchActualAccounts()).filter((account) => !account.closed).map((account) => account.id),
  )
  return { rows: mapped, ids: [...mapped.keys()].filter((id) => open.has(id)) }
}

/**
 * Every account in `scope` valued at `asOf`, as `AccountValue`s.
 *
 * The mapping's `dedupeGroup` and `isSourceOfTruth` are carried across untouched;
 * `computeNetWorth` is what decides which of them count. Two places building these
 * rows would be two places to forget a flag, which is why the backfill calls this one
 * rather than assembling its own.
 */
export async function actualValuesAt(
  scope: ActualScope,
  asOf: Date,
): Promise<AccountValue[]> {
  if (scope.ids.length === 0) return []
  const values: AccountValue[] = []
  for (const balance of await fetchAccountBalances(scope.ids, asOf)) {
    const row = scope.rows.get(balance.accountId)
    if (!row) continue
    values.push({
      accountMapId: row.id,
      source: 'actual',
      externalId: row.externalId,
      name: row.name,
      kind: row.kind,
      valueCents: balance.balanceCents,
      includeInNetWorth: row.includeInNetWorth,
      dedupeGroup: row.dedupeGroup,
      isSourceOfTruth: row.isSourceOfTruth,
    })
  }
  return values
}

/**
 * Every mapped account paired with a value from its source, or dropped.
 *
 * Exported for the history backfill, which needs today's picture of both sources to
 * decide which rows count before it goes looking for their past.
 */
export async function collectAccountValues(
  db: Db,
  asOf: Date,
  log: Logger,
): Promise<AccountValue[]> {
  const rows = loadAccountMap(db)
  const values: AccountValue[] = []

  values.push(...(await actualValuesAt(await actualScope(rows), asOf)))

  const ghostfolioRows = accountMapBySource(rows, 'ghostfolio')
  if (ghostfolioRows.size > 0) {
    try {
      for (const account of toAccountValues(await fetchGhostfolioAccounts())) {
        const row = ghostfolioRows.get(account.externalId)
        if (!row) continue
        values.push({
          accountMapId: row.id,
          source: 'ghostfolio',
          externalId: row.externalId,
          name: row.name,
          kind: row.kind,
          valueCents: account.valueCents,
          // Ghostfolio's own exclusion flag and ours are ANDed: either tool
          // saying "leave this out" is honoured, so a decision already made over
          // there does not have to be made again here.
          includeInNetWorth: row.includeInNetWorth && !account.excluded,
          dedupeGroup: row.dedupeGroup,
          isSourceOfTruth: row.isSourceOfTruth,
        })
      }
    } catch (error) {
      log.warn(
        { err: error },
        'Ghostfolio accounts unavailable; this snapshot covers Actual only',
      )
    }
  }

  return values
}

async function run({ db, now, log }: JobContext): Promise<JobDetail> {
  const date = dateIn(now, config.TZ)
  const values = await collectAccountValues(db, now, log)
  const result = computeNetWorth(date, values)
  const stored = persistNetWorth(db, result)

  if (result.unresolvedGroups.length > 0) {
    // Logged at warn because the figure is an understatement and nothing on the
    // chart would show it. The settings page asks for the decision; this line is
    // what makes it visible before anyone opens the page.
    log.warn(
      { groups: result.unresolvedGroups },
      'dedupe groups with no source of truth — net worth excludes them entirely',
    )
  }

  return {
    date,
    accounts: stored.written,
    accountsRemoved: stored.removed,
    excluded: result.excluded.length,
    unresolvedGroups: result.unresolvedGroups.length,
    totalCents: result.totalCents,
    liquidCents: result.liquidCents,
    investedCents: result.investedCents,
    debtCents: result.debtCents,
  }
}

export const netWorthJob: Job = {
  name: 'networth',
  // Daily rather than hourly: this is a point-in-time series and one row per day
  // is the whole shape of it. Re-running is safe — the upsert corrects the day.
  schedule: { kind: 'daily', hour: config.JOBS_NIGHTLY_HOUR },
  run,
}
