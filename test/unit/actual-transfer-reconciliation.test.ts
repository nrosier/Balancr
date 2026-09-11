/**
 * `offBudgetTransferLegIds` and `transferFilter` — the two pure pieces behind
 * #333: a transfer that crosses the on-budget/off-budget boundary keeps its
 * category in Actual, so Balancr's own recomputed sum must count it too
 * instead of dropping every transfer as a same-side wash.
 */
import { describe, expect, it } from 'vitest'
import {
  offBudgetTransferLegIds,
  transferFilter,
  type TransferLeg,
} from '../../src/adapters/actual/queries.ts'

describe('offBudgetTransferLegIds', () => {
  it('keeps a leg whose counterpart is off-budget', () => {
    // Money moved from an on-budget account into an off-budget one — the case
    // #333 reported: the on-budget leg keeps its category in Actual and must
    // not be dropped from our own sum.
    const legs: TransferLeg[] = [{ id: 'leg-onbudget', transferId: 'leg-offbudget' }]
    const counterpartIsOffBudget = new Map([['leg-offbudget', true]])

    expect(offBudgetTransferLegIds(legs, counterpartIsOffBudget)).toEqual(['leg-onbudget'])
  })

  it('drops a leg whose counterpart is also on-budget', () => {
    // A credit-card payment between two on-budget accounts: Actual clears
    // both legs' category, and this must stay excluded as the wash it is.
    const legs: TransferLeg[] = [{ id: 'leg-a', transferId: 'leg-b' }]
    const counterpartIsOffBudget = new Map([['leg-b', false]])

    expect(offBudgetTransferLegIds(legs, counterpartIsOffBudget)).toEqual([])
  })

  it('drops a leg whose counterpart was not found', () => {
    // The counterpart lookup only covers ids seen in the leg query; a miss
    // (e.g. the counterpart transaction was deleted) must fail closed to the
    // old, safe behaviour rather than assume it crosses the boundary.
    const legs: TransferLeg[] = [{ id: 'leg-a', transferId: 'leg-missing' }]

    expect(offBudgetTransferLegIds(legs, new Map())).toEqual([])
  })

  it('ignores a non-transfer row', () => {
    const legs: TransferLeg[] = [{ id: 'leg-a', transferId: null }]

    expect(offBudgetTransferLegIds(legs, new Map([['leg-a', true]]))).toEqual([])
  })

  it('keeps only the crossing legs out of a mixed batch', () => {
    const legs: TransferLeg[] = [
      { id: 'leg-crossing', transferId: 'counterpart-offbudget' },
      { id: 'leg-wash', transferId: 'counterpart-onbudget' },
    ]
    const counterpartIsOffBudget = new Map([
      ['counterpart-offbudget', true],
      ['counterpart-onbudget', false],
    ])

    expect(offBudgetTransferLegIds(legs, counterpartIsOffBudget)).toEqual(['leg-crossing'])
  })
})

describe('transferFilter', () => {
  it('stays a plain null check when nothing needs to be kept', () => {
    // The common case (no crossing transfers in range) must not pay for the
    // $or it does not need, and must compile to the exact clause the old
    // unconditional filter used.
    expect(transferFilter([])).toEqual({ transfer_id: null })
  })

  it('widens to an $or that also admits the crossing legs by id', () => {
    expect(transferFilter(['leg-a', 'leg-b'])).toEqual({
      $or: [{ transfer_id: null }, { id: { $oneof: ['leg-a', 'leg-b'] } }],
    })
  })
})
