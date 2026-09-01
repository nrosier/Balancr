/**
 * `account_map`: the table that decides what net worth is made of.
 *
 * Every account either system knows about gets a row here, and three of its
 * columns are judgement calls only a human can make — `kind` (is this liquid?),
 * `include_in_net_worth`, and the `dedupe_group` / `is_source_of_truth` pair that
 * stops an Actual investment mirror and the same Ghostfolio positions being
 * counted twice. So the sync has one hard rule: **it may create rows and update
 * names, and it may never overwrite a decision.** A rename in Actual must not
 * silently undo the mapping that keeps net worth honest.
 *
 * New rows get a defensive default rather than a guess:
 *
 *  - **Ghostfolio** accounts are `investment` — that is what Ghostfolio is for.
 *  - **On-budget Actual** accounts are `checking`. Actual has no account-type
 *    field to read, but an on-budget account is one the bills are paid from, and
 *    every plausible answer (checking, savings, cash) is liquid either way.
 *  - **Off-budget Actual** accounts are `other`: neither liquid nor invested.
 *    This is the honest default, since an off-budget account is as likely to be a
 *    mortgage as a broker, and `other` counts toward the total without pretending
 *    to be an emergency fund. It is also exactly the set of accounts
 *    `dedupeCandidates` asks the user about.
 */
import { eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { accountMap } from '../../db/schema.ts'
import type { AccountKind } from '../../db/schema.ts'

export type AccountSource = 'actual' | 'ghostfolio'

/** An account as one of the source systems currently reports it. */
export interface AccountSighting {
  source: AccountSource
  externalId: string
  name: string
  /** Actual only: off-budget accounts are excluded from budget figures. */
  offBudget?: boolean
  closed?: boolean
}

export type AccountMapRow = typeof accountMap.$inferSelect

export interface AccountSyncResult {
  created: number
  /** Rows whose name changed. Nothing else is ever updated. */
  renamed: number
  /** Rows in the table that neither source reported this pass. */
  missing: AccountMapRow[]
}

/** The default `kind` for a newly sighted account. See the header for why. */
export function defaultKind(sighting: AccountSighting): AccountKind {
  if (sighting.source === 'ghostfolio') return 'investment'
  return sighting.offBudget ? 'other' : 'checking'
}

/**
 * Creates rows for new accounts and refreshes names. Decisions are untouched.
 *
 * `missing` is reported rather than deleted: a Ghostfolio outage that returns an
 * empty account list must not drop the mapping, and a deleted account's snapshot
 * history is still worth keeping. The settings page can offer the removal.
 */
export function syncAccountMap(
  db: Db,
  sightings: readonly AccountSighting[],
): AccountSyncResult {
  const result: AccountSyncResult = { created: 0, renamed: 0, missing: [] }

  db.transaction((tx) => {
    const existing = tx.select().from(accountMap).all()
    const bySource = new Map(existing.map((row) => [`${row.source}:${row.externalId}`, row]))
    const seen = new Set<string>()

    for (const sighting of sightings) {
      const key = `${sighting.source}:${sighting.externalId}`
      seen.add(key)
      const row = bySource.get(key)

      if (!row) {
        tx.insert(accountMap)
          .values({
            source: sighting.source,
            externalId: sighting.externalId,
            name: sighting.name,
            kind: defaultKind(sighting),
          })
          .run()
        result.created += 1
        continue
      }

      if (row.name !== sighting.name) {
        tx.update(accountMap)
          .set({ name: sighting.name })
          .where(eq(accountMap.id, row.id))
          .run()
        result.renamed += 1
      }
    }

    result.missing = existing.filter(
      (row) => !seen.has(`${row.source}:${row.externalId}`),
    )
  })

  return result
}

export function loadAccountMap(db: Db): AccountMapRow[] {
  return db.select().from(accountMap).all()
}

/** Rows for the given source, keyed by the id that source uses. */
export function accountMapBySource(
  rows: readonly AccountMapRow[],
  source: AccountSource,
): Map<string, AccountMapRow> {
  return new Map(
    rows.filter((row) => row.source === source).map((row) => [row.externalId, row]),
  )
}

export interface DedupeCandidate {
  ghostfolio: AccountMapRow
  /** Actual rows that could be the same money. Never more than a suggestion. */
  possibleMirrors: AccountMapRow[]
}

/**
 * Ghostfolio accounts that are probably also in Actual, and are not yet grouped.
 *
 * This exists because the default mapping double counts, and double counting is
 * wrong in the flattering direction: net worth comes out too high and looks
 * plausible. Nothing here changes a figure — it is the prompt that gets a human
 * to make the call, surfaced in the setup panel and logged when it first appears.
 *
 * The heuristic is deliberately loose (any ungrouped Actual account that is
 * off-budget or already marked `investment`), because a false suggestion costs
 * one dismissal and a missed one costs a wrong net worth for months.
 */
export function dedupeCandidates(rows: readonly AccountMapRow[]): DedupeCandidate[] {
  const ungrouped = rows.filter((row) => row.dedupeGroup === null)
  const mirrors = ungrouped.filter(
    (row) => row.source === 'actual' && row.kind !== 'checking' && row.kind !== 'credit',
  )
  if (mirrors.length === 0) return []

  return ungrouped
    .filter((row) => row.source === 'ghostfolio' && row.includeInNetWorth)
    .map((row) => ({ ghostfolio: row, possibleMirrors: mirrors }))
}

/** Marks rows as belonging to one group, with `sourceOfTruthId` the one that counts. */
export function setDedupeGroup(
  db: Db,
  group: string,
  accountMapIds: readonly string[],
  sourceOfTruthId: string,
): void {
  if (!accountMapIds.includes(sourceOfTruthId)) {
    // Refused rather than repaired: a group with no source of truth counts as
    // nothing at all, and net worth being too low has no visible symptom.
    throw new Error(
      `source of truth ${sourceOfTruthId} is not among the accounts being grouped`,
    )
  }
  db.transaction((tx) => {
    tx.update(accountMap)
      .set({ dedupeGroup: group, isSourceOfTruth: false })
      .where(inArray(accountMap.id, [...accountMapIds]))
      .run()
    tx.update(accountMap)
      .set({ isSourceOfTruth: true })
      .where(eq(accountMap.id, sourceOfTruthId))
      .run()
  })
}
