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
import { accountMapBySource, loadAccountMap } from '../domain/aggregate/accounts.ts'
import { computeNetWorth, type AccountValue } from '../domain/aggregate/networth.ts'
import { persistNetWorth } from '../domain/aggregate/networth-store.ts'
import { toAccountValues } from '../domain/portfolio/snapshot.ts'
import type { Logger } from '../logger.ts'
import { dateIn } from '../util/month.ts'
import type { Job, JobContext, JobDetail } from './runner.ts'

/** `account_map` rows paired with a value from their source, or dropped. */
export async function collectAccountValues(
  db: Db,
  asOf: Date,
  log: Logger,
): Promise<AccountValue[]> {
  const rows = loadAccountMap(db)
  const values: AccountValue[] = []

  const actualRows = accountMapBySource(rows, 'actual')
  if (actualRows.size > 0) {
    // Closed accounts still hold their final balance in Actual, but including
    // them would keep a settled loan or a cancelled card in the total for ever.
    const open = new Set(
      (await fetchActualAccounts())
        .filter((account) => !account.closed)
        .map((account) => account.id),
    )
    const wanted = [...actualRows.keys()].filter((id) => open.has(id))
    for (const balance of await fetchAccountBalances(wanted, asOf)) {
      const row = actualRows.get(balance.accountId)
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
  }

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
