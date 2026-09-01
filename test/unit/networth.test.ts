import { describe, expect, it } from 'vitest'
import { computeNetWorth, type AccountValue } from '../../src/domain/aggregate/networth.ts'

/** A counted, included, ungrouped account unless the test says otherwise. */
function account(overrides: Partial<AccountValue> & { id: string }): AccountValue {
  return {
    accountMapId: overrides.id,
    source: overrides.source ?? 'actual',
    externalId: overrides.externalId ?? `ext-${overrides.id}`,
    name: overrides.name ?? overrides.id,
    kind: overrides.kind ?? 'checking',
    valueCents: overrides.valueCents ?? 0,
    includeInNetWorth: overrides.includeInNetWorth ?? true,
    dedupeGroup: overrides.dedupeGroup ?? null,
    isSourceOfTruth: overrides.isSourceOfTruth ?? true,
  }
}

describe('computeNetWorth dedupe', () => {
  it('counts one side of a dedupe group and reports the other as deduped', () => {
    // The whole reason this file exists: Actual's off-budget "Investments"
    // mirror and Ghostfolio's positions are the same money. Adding both
    // overstates net worth by the size of the portfolio.
    const result = computeNetWorth('2026-03-01', [
      account({ id: 'cash', kind: 'checking', valueCents: 250_000 }),
      account({
        id: 'actual-inv',
        name: 'Investments (Actual)',
        kind: 'investment',
        valueCents: 4_000_000,
        dedupeGroup: 'broker-1',
        isSourceOfTruth: false,
      }),
      account({
        id: 'gf-inv',
        source: 'ghostfolio',
        name: 'Broker',
        kind: 'investment',
        valueCents: 4_120_000,
        dedupeGroup: 'broker-1',
        isSourceOfTruth: true,
      }),
    ])

    expect(result.totalCents).toBe(250_000 + 4_120_000)
    expect(result.investedCents).toBe(4_120_000)
    expect(result.contributions.map((entry) => entry.accountMapId)).toEqual(['cash', 'gf-inv'])
    // Reported, not silently dropped: the settings page has to be able to show
    // what was ignored and why.
    expect(result.excluded).toEqual([
      {
        accountMapId: 'actual-inv',
        name: 'Investments (Actual)',
        source: 'actual',
        valueCents: 4_000_000,
        reason: 'deduped',
        dedupeGroup: 'broker-1',
      },
    ])
    expect(result.unresolvedGroups).toEqual([])
  })

  it('counts nothing from a group with no source of truth, and says so', () => {
    // Worse than double counting, because too-low net worth has no symptom.
    const result = computeNetWorth('2026-03-01', [
      account({ id: 'cash', valueCents: 100_000 }),
      account({ id: 'a', kind: 'investment', valueCents: 900_000, dedupeGroup: 'broker-1', isSourceOfTruth: false }),
      account({ id: 'b', kind: 'investment', valueCents: 910_000, dedupeGroup: 'broker-1', isSourceOfTruth: false }),
    ])

    expect(result.totalCents).toBe(100_000)
    expect(result.unresolvedGroups).toEqual(['broker-1'])
    expect(result.excluded.map((entry) => [entry.accountMapId, entry.reason])).toEqual([
      ['a', 'no_source_of_truth'],
      ['b', 'no_source_of_truth'],
    ])
  })

  it('treats a group whose source of truth is itself excluded as unresolved', () => {
    // Resolution is computed over included accounts only. Otherwise switching
    // `include_in_net_worth` off on the source of truth would quietly zero the
    // group while every other member stayed marked as merely deduped.
    const result = computeNetWorth('2026-03-01', [
      account({
        id: 'truth',
        kind: 'investment',
        valueCents: 900_000,
        dedupeGroup: 'broker-1',
        includeInNetWorth: false,
      }),
      account({ id: 'mirror', kind: 'investment', valueCents: 890_000, dedupeGroup: 'broker-1', isSourceOfTruth: false }),
    ])

    expect(result.totalCents).toBe(0)
    expect(result.unresolvedGroups).toEqual(['broker-1'])
    expect(result.excluded.map((entry) => [entry.accountMapId, entry.reason])).toEqual([
      ['truth', 'not_included'],
      ['mirror', 'no_source_of_truth'],
    ])
  })

  it('lists unresolved groups in a stable order', () => {
    const result = computeNetWorth('2026-03-01', [
      account({ id: 'z', valueCents: 1, dedupeGroup: 'zeta', isSourceOfTruth: false }),
      account({ id: 'a', valueCents: 1, dedupeGroup: 'alpha', isSourceOfTruth: false }),
      account({ id: 'a2', valueCents: 1, dedupeGroup: 'alpha', isSourceOfTruth: false }),
    ])
    expect(result.unresolvedGroups).toEqual(['alpha', 'zeta'])
  })
})

describe('computeNetWorth classification', () => {
  it('splits liquid, invested and debt out of the same total', () => {
    const result = computeNetWorth('2026-03-01', [
      account({ id: 'current', kind: 'checking', valueCents: 180_000 }),
      account({ id: 'buffer', kind: 'savings', valueCents: 500_000 }),
      account({ id: 'wallet', kind: 'cash', valueCents: 4_000 }),
      account({ id: 'broker', kind: 'investment', valueCents: 3_000_000 }),
      account({ id: 'card', kind: 'credit', valueCents: -74_000 }),
    ])

    expect(result.totalCents).toBe(180_000 + 500_000 + 4_000 + 3_000_000 - 74_000)
    // An emergency fund is made of these three and nothing else.
    expect(result.liquidCents).toBe(684_000)
    expect(result.investedCents).toBe(3_000_000)
    // Positive, because "you owe 740,00" reads better than a negated negative.
    expect(result.debtCents).toBe(74_000)
  })

  it('counts an overdrawn current account as debt as well as liquid', () => {
    // Money owed on exactly the same terms as a card, and still the account the
    // rent leaves from, so it is both.
    const result = computeNetWorth('2026-03-01', [
      account({ id: 'current', kind: 'checking', valueCents: -30_000 }),
    ])
    expect(result.debtCents).toBe(30_000)
    expect(result.liquidCents).toBe(-30_000)
    expect(result.totalCents).toBe(-30_000)
  })

  it('excludes an account that opts out, without touching the rest', () => {
    const result = computeNetWorth('2026-03-01', [
      account({ id: 'current', valueCents: 100_000 }),
      account({ id: 'mortgage-escrow', kind: 'other', valueCents: -50_000, includeInNetWorth: false }),
    ])
    expect(result.totalCents).toBe(100_000)
    expect(result.debtCents).toBe(0)
    expect(result.excluded.map((entry) => entry.reason)).toEqual(['not_included'])
  })

  it('carries the date and copes with no accounts at all', () => {
    const result = computeNetWorth('2026-03-01', [])
    expect(result).toEqual({
      date: '2026-03-01',
      totalCents: 0,
      liquidCents: 0,
      investedCents: 0,
      debtCents: 0,
      contributions: [],
      excluded: [],
      unresolvedGroups: [],
    })
  })
})
