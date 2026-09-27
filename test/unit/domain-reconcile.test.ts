/**
 * `findPossibleDoubleCounts` (#689) — pure matching, no database. The route-level
 * behaviour (which candidates get built from properties/loans/debts) is covered in
 * `server-api.test.ts`'s "reconciliation warnings" describe block instead, since that
 * is where the candidate-building lives.
 */
import { describe, expect, it } from 'vitest'
import {
  findPossibleDoubleCounts,
  type ReconciliationAccount,
  type ReconciliationCandidate,
} from '../../src/domain/aggregate/reconcile.ts'

function candidate(overrides: Partial<ReconciliationCandidate> = {}): ReconciliationCandidate {
  return { kind: 'property', label: 'House', valueCents: 40_000_000, ...overrides }
}

function account(overrides: Partial<ReconciliationAccount> = {}): ReconciliationAccount {
  return { accountId: 'acct-1', name: 'House', balanceCents: 40_000_000, ...overrides }
}

describe('findPossibleDoubleCounts', () => {
  it('matches on a normalised name, diacritics and casing included', () => {
    const warnings = findPossibleDoubleCounts(
      [candidate({ label: 'Zichtrekening', valueCents: 12_345 })],
      [account({ name: 'zichtrekening', balanceCents: -99_999 })],
    )
    expect(warnings).toEqual([
      { kind: 'property', label: 'Zichtrekening', accountId: 'acct-1', accountName: 'zichtrekening' },
    ])
  })

  it('matches when the account name is one word inside a longer label', () => {
    const warnings = findPossibleDoubleCounts(
      [candidate({ label: 'Antwerp House mortgage', valueCents: 1 })],
      [account({ name: 'Mortgage', balanceCents: -1 })],
    )
    expect(warnings).toHaveLength(1)
  })

  it('does not match a bare substring that is not a whole word', () => {
    const warnings = findPossibleDoubleCounts(
      [candidate({ label: 'Cash', valueCents: 500 })],
      [account({ name: 'Cashflow buffer', balanceCents: 50_000 })],
    )
    expect(warnings).toEqual([])
  })

  it('matches on balance agreement alone, sign ignored', () => {
    const warnings = findPossibleDoubleCounts(
      [candidate({ label: 'Car loan', valueCents: 900_000 })],
      [account({ name: 'Savings pot', balanceCents: -900_000 })],
    )
    expect(warnings).toEqual([
      { kind: 'property', label: 'Car loan', accountId: 'acct-1', accountName: 'Savings pot' },
    ])
  })

  it('tolerates a small drift in balance, a euro floor or 0.1%, whichever is larger', () => {
    const withinTolerance = findPossibleDoubleCounts(
      [candidate({ label: 'Foo', valueCents: 40_000_000 })],
      [account({ name: 'Bar', balanceCents: -39_999_500 })],
    )
    expect(withinTolerance).toHaveLength(1)

    const outsideTolerance = findPossibleDoubleCounts(
      [candidate({ label: 'Foo', valueCents: 40_000_000 })],
      [account({ name: 'Bar', balanceCents: -39_950_000 })],
    )
    expect(outsideTolerance).toEqual([])
  })

  it('never matches a zero balance on either side, name aside', () => {
    const warnings = findPossibleDoubleCounts(
      [candidate({ label: 'Foo', valueCents: 0 })],
      [account({ name: 'Bar', balanceCents: 0 })],
    )
    expect(warnings).toEqual([])
  })

  it('answers no warnings for an unrelated name and value', () => {
    const warnings = findPossibleDoubleCounts(
      [candidate({ label: 'Antwerp flat', valueCents: 25_000_000 })],
      [account({ name: 'Checking', balanceCents: 1_240_000 })],
    )
    expect(warnings).toEqual([])
  })

  it('checks every candidate against every account', () => {
    const warnings = findPossibleDoubleCounts(
      [
        candidate({ kind: 'loan', label: 'Car loan', valueCents: 900_000 }),
        candidate({ kind: 'debt', label: 'Credit card', valueCents: 120_000 }),
      ],
      [account({ accountId: 'acct-car', name: 'Car loan', balanceCents: -900_000 })],
    )
    expect(warnings).toEqual([
      { kind: 'loan', label: 'Car loan', accountId: 'acct-car', accountName: 'Car loan' },
    ])
  })
})
