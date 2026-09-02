/**
 * Which Ghostfolio accounts are portfolios and which are mirrors of a bank balance.
 *
 * The problem: a tool like ghostbudget syncs bank accounts *into* Ghostfolio, so
 * Ghostfolio holds real positions and a copy of the current-account balances Actual
 * already reports. Adding both counts that money twice — on the reporting instance
 * roughly a third of net worth, entered once from each source — and calls it
 * invested, which it is not.
 *
 * Ghostfolio can already tell them apart, so this is derived rather than asked for.
 * Two independent signals, and on the live instance they agree unanimously across
 * seven accounts (six cash, one portfolio):
 *
 *  - **`activitiesCount`** — orders recorded against the account. A mirror has a
 *    balance and no activities, because its maintainer writes balances rather than
 *    trades. The strongest signal, and the reason it is checked first.
 *  - **`value` exceeding `balance`** — value includes positions, balance is only
 *    cash, so a value above the balance means something is held. Both sides are
 *    taken in the base currency: comparing a converted value against an
 *    unconverted balance would read a foreign-currency cash account as a portfolio
 *    purely because of the exchange rate.
 *
 * Neither is authoritative. "Activities" is a Ghostfolio implementation detail, and
 * a brokerage account can genuinely have none — so the answer is written as a
 * *derived* value that any human answer overrides permanently, never as a decision.
 * `applyDerivedFields` is what enforces that.
 */
import type { AccountKind } from '../../db/schema.ts'

export interface GhostfolioAccountEvidence {
  externalId: string
  name: string
  /**
   * Null when the instance does not report the field, which is a different answer
   * from zero and is treated as one: absent means the strongest signal is simply
   * unavailable, not that the account has never traded.
   */
  activitiesCount: number | null
  /** Cash in the account, base currency. */
  balanceCents: number
  /** Cash plus positions, base currency. */
  valueCents: number
}

/**
 * True when the evidence says this account holds something other than cash.
 *
 * Deliberately not symmetric: either signal firing is enough. A false "investment"
 * costs a category label on a settings page; a false "cash" is what gets an account
 * grouped away as a duplicate, and losing money from net worth is the quiet failure
 * this whole file exists to avoid.
 */
export function holdsInvestments(evidence: GhostfolioAccountEvidence): boolean {
  if (evidence.activitiesCount !== null && evidence.activitiesCount > 0) return true
  return evidence.valueCents > evidence.balanceCents
}

/**
 * The `kind` to derive for a Ghostfolio account.
 *
 * `cash` rather than `checking`, because what this account *is* — a mirror of a bank
 * balance held at a broker — is knowable and which kind of bank account it mirrors
 * is not. Both are liquid, so net worth's liquid/invested split reads the same
 * either way; guessing `checking` would be a specific claim with nothing behind it.
 */
export function ghostfolioKind(evidence: GhostfolioAccountEvidence): AccountKind {
  return holdsInvestments(evidence) ? 'investment' : 'cash'
}
