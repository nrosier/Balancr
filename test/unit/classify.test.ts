/**
 * The rule that decides which Ghostfolio accounts are portfolios.
 *
 * The fixture is the reporting instance's own seven accounts, reduced to the two
 * fields the rule reads and with the names replaced: six bank accounts a syncing
 * tool writes balances into, one real brokerage account. On that instance the two
 * signals agree unanimously, which is why the rule can be derived at all — so the
 * cases worth writing down are the ones where they *disagree*, and each of those has
 * a defensible answer that the asymmetry in `holdsInvestments` is there to give.
 */
import { describe, expect, it } from 'vitest'
import {
  ghostfolioKind,
  holdsInvestments,
  type GhostfolioAccountEvidence,
} from '../../src/domain/aggregate/classify.ts'

/** Cents, so the fixture reads in euro. */
const eur = (amount: number): number => Math.round(amount * 100)

const evidence = (
  externalId: string,
  activitiesCount: number | null,
  balance: number,
  value: number,
): GhostfolioAccountEvidence => ({
  externalId,
  name: externalId,
  activitiesCount,
  balanceCents: eur(balance),
  valueCents: eur(value),
})

/**
 * The seven live shapes: a mirror has activities of zero and a value equal to its
 * balance, because its maintainer writes balances rather than trades. The portfolio
 * has both signals firing.
 */
const LIVE: readonly GhostfolioAccountEvidence[] = [
  evidence('current', 0, 1_240.55, 1_240.55),
  evidence('joint', 0, 3_010.0, 3_010.0),
  evidence('savings', 0, 12_500.0, 12_500.0),
  evidence('buffer', 0, 4_000.0, 4_000.0),
  evidence('kids', 0, 850.25, 850.25),
  // Overdrawn, which is still cash: a negative balance equal to the value.
  evidence('card', 0, -320.4, -320.4),
  evidence('broker', 143, 210.0, 48_900.0),
]

describe('the live instance', () => {
  it('calls six of the seven accounts cash and one a portfolio', () => {
    const kinds = LIVE.map((account) => [account.externalId, ghostfolioKind(account)] as const)
    expect(kinds).toEqual([
      ['current', 'cash'],
      ['joint', 'cash'],
      ['savings', 'cash'],
      ['buffer', 'cash'],
      ['kids', 'cash'],
      ['card', 'cash'],
      ['broker', 'investment'],
    ])
  })

  it('is not fooled by size: the largest mirror is still a mirror', () => {
    // € 12.500 in a savings account is more than the broker holds in cash, and a rule
    // that leaned on the amount would get this one backwards.
    expect(ghostfolioKind(evidence('savings', 0, 12_500, 12_500))).toBe('cash')
  })
})

describe('when the two signals disagree', () => {
  it('believes activities over a value that has not caught up', () => {
    // A brokerage account that has traded but whose positions are priced at nothing
    // yet — a fresh account, or a price fetch that has not run. Activities decide.
    expect(holdsInvestments(evidence('fresh', 3, 500, 500))).toBe(true)
  })

  it('believes a value above the balance even with no activities recorded', () => {
    // Positions imported rather than traded, or an instance that does not count
    // orders per account. The money is visibly not all cash.
    expect(holdsInvestments(evidence('imported', 0, 100, 9_000))).toBe(true)
  })

  it('reads an empty account as cash rather than as an empty portfolio', () => {
    // Nothing to go on, and `cash` is the answer that lets the mirror rule look for a
    // twin. Being wrong here costs a label, and only until the first trade.
    expect(ghostfolioKind(evidence('empty', 0, 0, 0))).toBe('cash')
  })

  it('reads a value below the balance as cash, not as a loss', () => {
    // Ghostfolio can report a value under the balance while a transfer settles. It is
    // still an account holding only cash.
    expect(holdsInvestments(evidence('settling', 0, 1_000, 900))).toBe(false)
  })
})

describe('when the instance says nothing about activities', () => {
  it('falls back to the value comparison rather than guessing', () => {
    expect(holdsInvestments(evidence('quiet-mirror', null, 2_000, 2_000))).toBe(false)
    expect(holdsInvestments(evidence('quiet-broker', null, 200, 40_000))).toBe(true)
  })

  it('treats absent as different from zero, since zero is a claim', () => {
    // Both have a value equal to the balance, so both read as cash — the assertion is
    // that the null path is reached at all rather than throwing or short-circuiting.
    expect(ghostfolioKind(evidence('null-activities', null, 500, 500))).toBe('cash')
    expect(ghostfolioKind(evidence('zero-activities', 0, 500, 500))).toBe('cash')
  })
})

describe('negative money', () => {
  it('does not call an overdraft an investment', () => {
    // The trap: -100 > -320 is true, so a rule comparing magnitudes or forgetting the
    // sign would read a card whose value moved toward zero as holding positions.
    expect(holdsInvestments(evidence('card', 0, -320, -320))).toBe(false)
    expect(ghostfolioKind(evidence('card', 0, -320, -320))).toBe('cash')
  })

  it('still says investment when an overdrawn account holds something', () => {
    // A margin account: owed cash, real positions. Both figures negative would be
    // cash; a value above the balance is not.
    expect(ghostfolioKind(evidence('margin', 0, -1_000, 20_000))).toBe('investment')
  })
})
