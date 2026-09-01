/**
 * One net worth figure out of two systems that both think they know it.
 *
 * The problem this file exists for: an off-budget "Investments" account in Actual
 * and the same positions in Ghostfolio are the same money. Add them and net worth
 * is overstated by the size of the portfolio — the single most misleading number
 * this app could produce, because it is wrong in the flattering direction and
 * looks entirely plausible.
 *
 * The fix is `account_map.dedupe_group` plus `is_source_of_truth`: accounts that
 * represent the same holdings share a group, and exactly one row in that group
 * counts. Everything else in the group is reported as deduplicated rather than
 * silently dropped, so the settings page can show what was ignored and why.
 *
 * A group with *no* source of truth is worse than a duplicated one: net worth
 * comes out too low and nothing says so. That case is reported explicitly.
 *
 * Pure. The caller reads `account_map`, fetches balances, and passes both in.
 */
import type { AccountKind } from '../../db/schema.ts'

export interface AccountValue {
  /** `account_map.id`, so a snapshot row can point back at the mapping. */
  accountMapId: string
  source: 'actual' | 'ghostfolio'
  externalId: string
  name: string
  kind: AccountKind
  /** Signed: a credit card in the red is negative. */
  valueCents: number
  includeInNetWorth: boolean
  dedupeGroup: string | null
  isSourceOfTruth: boolean
}

export type ExclusionReason =
  /** `include_in_net_worth` is off for this account. */
  | 'not_included'
  /** Another account in its dedupe group is the source of truth. */
  | 'deduped'
  /** Its dedupe group has no source of truth, so nothing in it was counted. */
  | 'no_source_of_truth'

export interface Exclusion {
  accountMapId: string
  name: string
  source: 'actual' | 'ghostfolio'
  valueCents: number
  reason: ExclusionReason
  dedupeGroup: string | null
}

export interface NetWorthResult {
  date: string
  /** Everything counted, signed. */
  totalCents: number
  /** Checking, savings and cash — what an emergency fund is actually made of. */
  liquidCents: number
  investedCents: number
  /** Debt as a positive number, because "you owe 2 400" reads better negated. */
  debtCents: number
  /** One row per counted account, ready to become a `net_worth_snapshots` row. */
  contributions: AccountValue[]
  excluded: Exclusion[]
  /**
   * Dedupe groups that had no source of truth. Non-empty means `totalCents`
   * is an understatement and the mapping needs a decision — surfaced rather than
   * absorbed, because too-low net worth has no symptom.
   */
  unresolvedGroups: string[]
}

const LIQUID: ReadonlySet<AccountKind> = new Set(['checking', 'savings', 'cash'])

export function computeNetWorth(date: string, accounts: readonly AccountValue[]): NetWorthResult {
  const excluded: Exclusion[] = []
  const exclude = (account: AccountValue, reason: ExclusionReason): void => {
    excluded.push({
      accountMapId: account.accountMapId,
      name: account.name,
      source: account.source,
      valueCents: account.valueCents,
      reason,
      dedupeGroup: account.dedupeGroup,
    })
  }

  // Which dedupe groups have someone to speak for them. Computed over the
  // included accounts only: a group whose source of truth is itself excluded from
  // net worth is unresolved, not resolved-to-nothing.
  const included = accounts.filter((account) => account.includeInNetWorth)
  const resolved = new Set(
    included
      .filter((account) => account.dedupeGroup !== null && account.isSourceOfTruth)
      .map((account) => account.dedupeGroup as string),
  )
  const grouped = new Set(
    included.flatMap((account) => (account.dedupeGroup === null ? [] : [account.dedupeGroup])),
  )
  const unresolvedGroups = [...grouped].filter((group) => !resolved.has(group)).sort()
  const unresolved = new Set(unresolvedGroups)

  const contributions: AccountValue[] = []
  for (const account of accounts) {
    if (!account.includeInNetWorth) {
      exclude(account, 'not_included')
      continue
    }
    if (account.dedupeGroup !== null) {
      if (unresolved.has(account.dedupeGroup)) {
        exclude(account, 'no_source_of_truth')
        continue
      }
      if (!account.isSourceOfTruth) {
        exclude(account, 'deduped')
        continue
      }
    }
    contributions.push(account)
  }

  let totalCents = 0
  let liquidCents = 0
  let investedCents = 0
  let debtCents = 0
  for (const account of contributions) {
    totalCents += account.valueCents
    if (LIQUID.has(account.kind)) liquidCents += account.valueCents
    if (account.kind === 'investment') investedCents += account.valueCents
    // Any account in the red is debt, not just a card: an overdrawn current
    // account is money owed on exactly the same terms.
    if (account.valueCents < 0) debtCents += -account.valueCents
  }

  return {
    date,
    totalCents,
    liquidCents,
    investedCents,
    debtCents,
    contributions,
    excluded,
    unresolvedGroups,
  }
}
