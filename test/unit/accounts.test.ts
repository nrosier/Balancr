/**
 * `account_map` holds three judgement calls no sync may overwrite: `kind`,
 * `include_in_net_worth`, and the `dedupe_group`/`is_source_of_truth` pair that
 * keeps net worth from double counting. The tests below are mostly about what the
 * sync must *not* touch — a rename in Actual quietly resetting a dedupe decision
 * would overstate net worth by the size of the portfolio, and nothing on the
 * chart would say so.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { accountMap } from '../../src/db/schema.ts'
import {
  accountMapBySource,
  dedupeCandidates,
  defaultKind,
  loadAccountMap,
  setDedupeGroup,
  syncAccountMap,
  type AccountSighting,
} from '../../src/domain/aggregate/accounts.ts'

let ctx: ReturnType<typeof createTestDb>

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
})

const actual = (id: string, name: string, offBudget = false): AccountSighting => ({
  source: 'actual',
  externalId: id,
  name,
  offBudget,
})

const ghostfolio = (id: string, name: string): AccountSighting => ({
  source: 'ghostfolio',
  externalId: id,
  name,
})

const rows = () => loadAccountMap(ctx.db).sort((a, b) => a.externalId.localeCompare(b.externalId))

describe('defaultKind', () => {
  it('calls a Ghostfolio account an investment', () => {
    expect(defaultKind(ghostfolio('g1', 'Bolero'))).toBe('investment')
  })

  it('calls an on-budget Actual account checking, because it pays the bills', () => {
    expect(defaultKind(actual('a1', 'Zichtrekening'))).toBe('checking')
  })

  it('calls an off-budget Actual account other, not investment', () => {
    // As likely to be a mortgage as a broker. `other` counts toward the total
    // without pretending to be part of the emergency fund.
    expect(defaultKind(actual('a2', 'Beleggingen', true))).toBe('other')
  })
})

describe('syncAccountMap', () => {
  it('creates a row per sighting with the defaulted kind', () => {
    const result = syncAccountMap(ctx.db, [
      actual('a1', 'Zichtrekening'),
      actual('a2', 'Beleggingen', true),
      ghostfolio('g1', 'Bolero'),
    ])

    expect(result).toMatchObject({ created: 3, renamed: 0 })
    expect(result.missing).toEqual([])
    expect(rows().map((row) => [row.externalId, row.kind])).toEqual([
      ['a1', 'checking'],
      ['a2', 'other'],
      ['g1', 'investment'],
    ])
  })

  it('is idempotent: a second identical pass changes nothing', () => {
    syncAccountMap(ctx.db, [actual('a1', 'Zichtrekening')])
    const first = rows()[0]

    const again = syncAccountMap(ctx.db, [actual('a1', 'Zichtrekening')])

    expect(again).toMatchObject({ created: 0, renamed: 0 })
    expect(rows()[0]).toEqual(first)
  })

  it('separates the two sources: the same external id is two accounts', () => {
    // Actual and Ghostfolio ids come from different systems and can collide.
    const result = syncAccountMap(ctx.db, [actual('same', 'Actual side'), ghostfolio('same', 'GF side')])
    expect(result.created).toBe(2)
  })

  it('updates a name and nothing else', () => {
    syncAccountMap(ctx.db, [actual('a1', 'Beleggingen', true)])
    const created = rows()[0]!
    ctx.db
      .update(accountMap)
      .set({ kind: 'investment', includeInNetWorth: false })
      .where(eq(accountMap.id, created.id))
      .run()

    const result = syncAccountMap(ctx.db, [actual('a1', 'Beleggingsrekening', true)])

    expect(result).toMatchObject({ created: 0, renamed: 1 })
    expect(rows()[0]).toMatchObject({
      name: 'Beleggingsrekening',
      kind: 'investment',
      includeInNetWorth: false,
    })
  })

  it('keeps a dedupe decision across a rename', () => {
    // The regression this whole module exists to prevent.
    syncAccountMap(ctx.db, [actual('a1', 'Beleggingen', true), ghostfolio('g1', 'Bolero')])
    const [mirror, truth] = rows()
    setDedupeGroup(ctx.db, 'broker', [mirror!.id, truth!.id], truth!.id)

    syncAccountMap(ctx.db, [actual('a1', 'Beleggingen (oud)', true), ghostfolio('g1', 'Bolero NV')])

    expect(rows().map((row) => [row.name, row.dedupeGroup, row.isSourceOfTruth])).toEqual([
      ['Beleggingen (oud)', 'broker', false],
      ['Bolero NV', 'broker', true],
    ])
  })

  it('reports an unseen account instead of deleting it', () => {
    // A Ghostfolio outage returning an empty list must not drop the mapping, and
    // a closed account's snapshot history is still worth keeping.
    syncAccountMap(ctx.db, [actual('a1', 'Zichtrekening'), ghostfolio('g1', 'Bolero')])

    const result = syncAccountMap(ctx.db, [actual('a1', 'Zichtrekening')])

    expect(result.missing.map((row) => row.externalId)).toEqual(['g1'])
    expect(rows()).toHaveLength(2)
  })
})

describe('accountMapBySource', () => {
  it('keys each source by the id that source uses', () => {
    syncAccountMap(ctx.db, [actual('a1', 'Zichtrekening'), ghostfolio('g1', 'Bolero')])
    const all = loadAccountMap(ctx.db)

    expect([...accountMapBySource(all, 'actual').keys()]).toEqual(['a1'])
    expect([...accountMapBySource(all, 'ghostfolio').keys()]).toEqual(['g1'])
  })
})

describe('dedupeCandidates', () => {
  it('pairs an ungrouped Ghostfolio account with the plausible Actual mirrors', () => {
    syncAccountMap(ctx.db, [
      actual('a1', 'Zichtrekening'),
      actual('a2', 'Beleggingen', true),
      ghostfolio('g1', 'Bolero'),
    ])

    const candidates = dedupeCandidates(loadAccountMap(ctx.db))

    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.ghostfolio.externalId).toBe('g1')
    // The on-budget current account is not offered: it is where the bills are
    // paid from, not a mirror of a broker.
    expect(candidates[0]!.possibleMirrors.map((row) => row.externalId)).toEqual(['a2'])
  })

  it('says nothing once the decision is made', () => {
    syncAccountMap(ctx.db, [actual('a2', 'Beleggingen', true), ghostfolio('g1', 'Bolero')])
    const [mirror, truth] = rows()
    setDedupeGroup(ctx.db, 'broker', [mirror!.id, truth!.id], truth!.id)

    expect(dedupeCandidates(loadAccountMap(ctx.db))).toEqual([])
  })

  it('says nothing when there is no plausible mirror at all', () => {
    syncAccountMap(ctx.db, [actual('a1', 'Zichtrekening'), ghostfolio('g1', 'Bolero')])
    expect(dedupeCandidates(loadAccountMap(ctx.db))).toEqual([])
  })
})

describe('setDedupeGroup', () => {
  it('marks exactly one row as the source of truth', () => {
    syncAccountMap(ctx.db, [
      actual('a1', 'Beleggingen', true),
      actual('a2', 'Pensioensparen', true),
      ghostfolio('g1', 'Bolero'),
    ])
    const all = rows()
    setDedupeGroup(ctx.db, 'broker', all.map((row) => row.id), all[2]!.id)

    expect(rows().map((row) => [row.externalId, row.isSourceOfTruth])).toEqual([
      ['a1', false],
      ['a2', false],
      ['g1', true],
    ])
  })

  it('refuses a source of truth that is not in the group', () => {
    // Refused rather than repaired: a group with nobody to speak for it counts as
    // nothing at all, and net worth being too low has no visible symptom.
    syncAccountMap(ctx.db, [actual('a1', 'Beleggingen', true), ghostfolio('g1', 'Bolero')])
    const all = rows()

    expect(() => setDedupeGroup(ctx.db, 'broker', [all[0]!.id], all[1]!.id)).toThrow(
      /not among the accounts being grouped/,
    )
    expect(rows().every((row) => row.dedupeGroup === null)).toBe(true)
  })
})
