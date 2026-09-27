/**
 * Whether a self-reported property, loan or debt might be the same money as an
 * off-budget Actual account already counted in net worth (#689).
 *
 * `accounts.ts`'s dedupe machinery (`dedupeGroup`/`isSourceOfTruth`, `dedupeCandidates`)
 * only spans Actual↔Ghostfolio; nothing plays that role between an off-budget account and
 * Property/Loans/Debts, so a household that fills in both counts the same house or
 * mortgage twice — "wrong in the flattering direction and looks entirely plausible", the
 * same failure `dedupeCandidates`'s own doc comment names. This mirrors that function's
 * matching signals (normalised name equality/containment, balance agreement within a
 * tolerance) rather than reusing it directly: there is no `AccountMapRow` on the
 * property/loan/debt side, only a label and a value.
 *
 * Deliberately only a warning, never an automatic group: only the household knows
 * whether "House" the Actual account really is the property just entered.
 */
import { normaliseAccountName } from './accounts.ts'

export interface ReconciliationCandidate {
  kind: 'property' | 'loan' | 'debt'
  label: string
  valueCents: number
}

export interface ReconciliationAccount {
  accountId: string
  name: string
  balanceCents: number
}

export interface ReconciliationWarning {
  kind: 'property' | 'loan' | 'debt'
  label: string
  accountId: string
  accountName: string
}

/** Whole-word containment, so "cash" does not match "cashflow". Mirrors `accounts.ts`. */
function containsWords(haystack: string, needle: string): boolean {
  if (needle === '' || haystack === needle) return false
  return ` ${haystack} `.includes(` ${needle} `)
}

/**
 * Same tolerance `accounts.ts`'s `balanceTolerance` uses for an Actual↔Ghostfolio
 * mirror: a euro, or a tenth of a percent of the larger side, whichever is more
 * generous. Compared as magnitudes, unlike that function — an off-budget "Mortgage"
 * account is a negative balance and a self-reported outstanding balance is positive,
 * and they are the same money either way.
 */
function sameMoney(a: number, b: number): boolean {
  if (a === 0 || b === 0) return false
  const [x, y] = [Math.abs(a), Math.abs(b)]
  const tolerance = Math.max(100, Math.round(Math.max(x, y) / 1000))
  return Math.abs(x - y) <= tolerance
}

/**
 * Every candidate that shares a normalised name or an agreeing balance with an
 * off-budget account. Recall over precision, the same trade-off `dedupeCandidates`
 * makes and for the same reason: a missed warning leaves a double count invisible for
 * months, while a false one costs one glance at a name that turns out to be a
 * coincidence.
 */
export function findPossibleDoubleCounts(
  candidates: readonly ReconciliationCandidate[],
  offBudgetAccounts: readonly ReconciliationAccount[],
): ReconciliationWarning[] {
  const warnings: ReconciliationWarning[] = []

  for (const candidate of candidates) {
    const label = normaliseAccountName(candidate.label)

    for (const account of offBudgetAccounts) {
      const name = normaliseAccountName(account.name)
      const nameMatches =
        label !== '' &&
        (label === name || containsWords(name, label) || containsWords(label, name))
      const valueMatches = sameMoney(candidate.valueCents, account.balanceCents)

      if (nameMatches || valueMatches) {
        warnings.push({
          kind: candidate.kind,
          label: candidate.label,
          accountId: account.accountId,
          accountName: account.name,
        })
      }
    }
  }

  return warnings
}
