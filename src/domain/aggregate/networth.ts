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

/** As a const array too, so the API schema's `z.enum` can share this vocabulary. */
export const EXCLUSION_REASONS = ['not_included', 'deduped', 'no_source_of_truth'] as const

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

/**
 * The five figures every consumer of net worth actually reads.
 *
 * Split out of `NetWorthResult` so a summary reconstructed from
 * `net_worth_snapshots` is the same type as a freshly computed one, rather than a
 * `NetWorthResult` with three fields faked. The household producers and the
 * redaction boundary take this; only the persistence layer needs the rest.
 */
export interface NetWorthSummary {
  date: string
  /** Everything counted, signed. */
  totalCents: number
  /** Checking, savings and cash — what an emergency fund is actually made of. */
  liquidCents: number
  investedCents: number
  /** Debt as a positive number, because "you owe 2 400" reads better negated. */
  debtCents: number
}

export interface NetWorthResult extends NetWorthSummary {
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

/**
 * Exported so a summary rebuilt from stored snapshots classifies accounts the
 * same way this module does. Two definitions of "liquid" that can disagree is
 * how an emergency-fund figure ends up differing between two pages.
 */
export const LIQUID: ReadonlySet<AccountKind> = new Set(['checking', 'savings', 'cash'])

/** The three `account_map` fields that decide inclusion, nothing else. */
export interface Includable {
  accountMapId: string
  includeInNetWorth: boolean
  dedupeGroup: string | null
  isSourceOfTruth: boolean
}

/**
 * Which accounts count and which don't, and why — from the mapping alone.
 *
 * No balance is read here: whether an account counts is a decision made in
 * `account_map`, not something a value can change. That's what lets Settings show
 * "why isn't this counted" without fetching Actual or Ghostfolio, and what lets
 * `computeNetWorth` and that screen agree by construction rather than by copying
 * the same three `if`s twice.
 */
export function resolveInclusion<T extends Includable>(
  accounts: readonly T[],
): { included: T[]; excluded: Map<string, ExclusionReason>; unresolvedGroups: string[] } {
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

  const excluded = new Map<string, ExclusionReason>()
  const kept: T[] = []
  for (const account of accounts) {
    if (!account.includeInNetWorth) {
      excluded.set(account.accountMapId, 'not_included')
      continue
    }
    if (account.dedupeGroup !== null) {
      if (unresolved.has(account.dedupeGroup)) {
        excluded.set(account.accountMapId, 'no_source_of_truth')
        continue
      }
      if (!account.isSourceOfTruth) {
        excluded.set(account.accountMapId, 'deduped')
        continue
      }
    }
    kept.push(account)
  }

  return { included: kept, excluded, unresolvedGroups }
}

export function computeNetWorth(date: string, accounts: readonly AccountValue[]): NetWorthResult {
  const {
    included: contributions,
    excluded: reasons,
    unresolvedGroups,
  } = resolveInclusion(accounts)
  const excluded: Exclusion[] = accounts
    .filter((account) => reasons.has(account.accountMapId))
    .map((account) => ({
      accountMapId: account.accountMapId,
      name: account.name,
      source: account.source,
      valueCents: account.valueCents,
      reason: reasons.get(account.accountMapId) as ExclusionReason,
      dedupeGroup: account.dedupeGroup,
    }))

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
