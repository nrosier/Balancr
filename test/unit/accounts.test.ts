/**
 * `account_map` holds three judgement calls no sync may overwrite: `kind`,
 * `include_in_net_worth`, and the `dedupe_group`/`is_source_of_truth` pair that
 * keeps net worth from double counting. The tests below are mostly about what the
 * sync must *not* touch — a rename in Actual quietly resetting a dedupe decision
 * would overstate net worth by the size of the portfolio, and nothing on the
 * chart would say so.
 */
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { applyMigrations, migrationsFolder } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { accountMap } from '../../src/db/schema.ts'
import {
  accountMapBySource,
  applyDerivedFields,
  applyDerivedMirror,
  deriveMirrors,
  DECIDABLE_FIELDS,
  decidedFields,
  dedupeCandidates,
  defaultKind,
  dismissMirror,
  groupAccounts,
  loadAccountMap,
  normaliseAccountName,
  setDedupeGroup,
  setSourceOfTruth,
  syncAccountMap,
  ungroupAccount,
  unlinkGroup,
  updateAccountMap,
  type AccountBalance,
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

const ghostfolio = (id: string, name: string, holdsInvestments?: boolean): AccountSighting => ({
  source: 'ghostfolio',
  externalId: id,
  name,
  ...(holdsInvestments === undefined ? {} : { holdsInvestments }),
})

/** A Ghostfolio account the classifier read as a mirror of a bank balance. */
const mirror = (id: string, name: string): AccountSighting => ghostfolio(id, name, false)

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
  /** Sets the derived `kind` the way #124's classifier would have. */
  const asKind = (externalId: string, kind: 'cash' | 'investment' | 'savings'): string => {
    const row = rows().find((candidate) => candidate.externalId === externalId)
    expect(row).toBeDefined()
    updateAccountMap(ctx.db, row!.id, { kind })
    return row!.id
  }

  const idOf = (externalId: string): string => {
    const row = rows().find((candidate) => candidate.externalId === externalId)
    expect(row).toBeDefined()
    return row!.id
  }

  const balance = (externalId: string, valueCents: number, currency = 'EUR'): AccountBalance => ({
    accountMapId: idOf(externalId),
    valueCents,
    currency,
  })

  it('offers nothing for a brokerage account and four unrelated cash accounts', () => {
    // The reported case, verbatim: Equate+ is a share portfolio, and Monizze, Monizze
    // Ecocheques, Cash and Argenta Sparen are meal vouchers, eco vouchers, cash and a
    // savings account. The old cross join produced four suggestions and eight buttons
    // here, having compared nothing at all.
    syncAccountMap(ctx.db, [
      actual('a1', 'Monizze', true),
      actual('a2', 'Monizze Ecocheques', true),
      actual('a3', 'Cash', true),
      actual('a4', 'Argenta Sparen', true),
      ghostfolio('g1', 'Equate+'),
    ])

    expect(dedupeCandidates(loadAccountMap(ctx.db))).toEqual([])
  })

  it('pairs a Ghostfolio cash mirror with its Actual twin, on name and balance', () => {
    syncAccountMap(ctx.db, [
      actual('a1', 'Argenta Zichtrekening'),
      actual('a2', 'Beleggingen', true),
      mirror('g1', 'Argenta Zichtrekening'),
    ])
    asKind('g1', 'cash')

    const candidates = dedupeCandidates(loadAccountMap(ctx.db), [
      balance('g1', 148_233),
      balance('a1', 148_233),
    ])

    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.ghostfolio.externalId).toBe('g1')
    expect(candidates[0]!.actual.externalId).toBe('a1')
    // Strongest first, so the panel's sentence reads best evidence first.
    expect(candidates[0]!.signals).toEqual(['name', 'balance', 'currency'])
  })

  it('offers the on-budget current account, which the old filter excluded', () => {
    // `kind !== 'checking'` was written for an Actual "Investments" account mirroring
    // Ghostfolio positions. Under a tool that syncs banks *into* Ghostfolio the mirror
    // runs the other way, so the one family of correct suggestions was the one family
    // the function structurally could not make.
    syncAccountMap(ctx.db, [actual('a1', 'KBC Zichtrekening'), mirror('g1', 'KBC Zichtrekening')])
    asKind('g1', 'cash')

    const candidates = dedupeCandidates(loadAccountMap(ctx.db))

    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.actual.kind).toBe('checking')
  })

  it('keeps the better-scoring match when two Actual accounts are within tolerance', () => {
    syncAccountMap(ctx.db, [
      actual('a1', 'Spaarrekening'),
      actual('a2', 'Argenta Sparen'),
      mirror('g1', 'Argenta Sparen'),
    ])
    asKind('g1', 'cash')

    // Both agree on the balance; only one agrees on the name.
    const candidates = dedupeCandidates(loadAccountMap(ctx.db), [
      balance('g1', 50_000),
      balance('a1', 50_000),
      balance('a2', 50_000),
    ])

    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.actual.externalId).toBe('a2')
    expect(candidates[0]!.signals).toEqual(['name', 'balance', 'currency'])
  })

  it('offers nothing when the names differ and the balances differ', () => {
    syncAccountMap(ctx.db, [actual('a1', 'Argenta Sparen'), mirror('g1', 'KBC Zichtrekening')])
    asKind('g1', 'cash')

    const candidates = dedupeCandidates(loadAccountMap(ctx.db), [
      balance('g1', 50_000),
      balance('a1', 91_400),
    ])

    expect(candidates).toEqual([])
  })

  it('does not treat two empty accounts as agreeing', () => {
    // Zero is the most common balance in any dataset. Counting it as evidence would
    // pair every dormant account with every other one.
    syncAccountMap(ctx.db, [actual('a1', 'Argenta Sparen'), mirror('g1', 'KBC Zichtrekening')])
    asKind('g1', 'cash')

    expect(
      dedupeCandidates(loadAccountMap(ctx.db), [balance('g1', 0), balance('a1', 0)]),
    ).toEqual([])
  })

  it('does not pair a credit card in the red with savings of the same magnitude', () => {
    // Signed, not absolute: −800 and +800 are not the same money, and comparing
    // magnitudes would say they were.
    syncAccountMap(ctx.db, [actual('a1', 'Buffer'), mirror('g1', 'Kaart')])
    asKind('g1', 'cash')

    expect(
      dedupeCandidates(loadAccountMap(ctx.db), [balance('g1', -80_000), balance('a1', 80_000)]),
    ).toEqual([])
  })

  it('does not call a currency match on its own evidence', () => {
    syncAccountMap(ctx.db, [actual('a1', 'Argenta Sparen'), mirror('g1', 'KBC Zichtrekening')])
    asKind('g1', 'cash')

    expect(
      dedupeCandidates(loadAccountMap(ctx.db), [balance('g1', 12_300), balance('a1', 45_600)]),
    ).toEqual([])
  })

  it('will not pair a portfolio with a cash account, or the reverse', () => {
    // Same name on both sides, and still no suggestion: a Ghostfolio account holding
    // positions cannot be a copy of a bank balance whatever it is called.
    syncAccountMap(ctx.db, [actual('a1', 'Bolero'), ghostfolio('g1', 'Bolero')])
    asKind('a1', 'cash')

    expect(dedupeCandidates(loadAccountMap(ctx.db))).toEqual([])
  })

  it('matches on containment, whole words only', () => {
    syncAccountMap(ctx.db, [actual('a1', 'Argenta'), mirror('g1', 'Argenta Zichtrekening')])
    asKind('g1', 'cash')

    const candidates = dedupeCandidates(loadAccountMap(ctx.db))

    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.signals).toEqual(['nameContains'])
  })

  it('does not match a word that merely starts another', () => {
    syncAccountMap(ctx.db, [actual('a1', 'Cashflow'), mirror('g1', 'Cash')])
    asKind('g1', 'cash')

    expect(dedupeCandidates(loadAccountMap(ctx.db))).toEqual([])
  })

  it('says nothing once the accounts are grouped', () => {
    syncAccountMap(ctx.db, [actual('a2', 'Bolero', true), ghostfolio('g1', 'Bolero')])
    const [mirrorRow, truth] = rows()
    setDedupeGroup(ctx.db, 'broker', [mirrorRow!.id, truth!.id], truth!.id)

    expect(dedupeCandidates(loadAccountMap(ctx.db))).toEqual([])
  })

  it('says nothing about an account excluded from net worth', () => {
    syncAccountMap(ctx.db, [actual('a1', 'Argenta Sparen'), mirror('g1', 'Argenta Sparen')])
    asKind('g1', 'cash')
    updateAccountMap(ctx.db, idOf('g1'), { includeInNetWorth: false })

    expect(dedupeCandidates(loadAccountMap(ctx.db))).toEqual([])
  })

  it('says nothing about an Actual account excluded from net worth', () => {
    // Nothing is counted twice if only one side counts, so there is no group to propose.
    syncAccountMap(ctx.db, [actual('a1', 'Argenta Sparen'), mirror('g1', 'Argenta Sparen')])
    asKind('g1', 'cash')
    updateAccountMap(ctx.db, idOf('a1'), { includeInNetWorth: false })

    expect(dedupeCandidates(loadAccountMap(ctx.db))).toEqual([])
  })

  it('stops offering a dismissed account, even after a sync renames it', () => {
    syncAccountMap(ctx.db, [actual('a1', 'Argenta Sparen'), mirror('g1', 'Argenta Sparen')])
    asKind('g1', 'cash')
    expect(dedupeCandidates(loadAccountMap(ctx.db))).toHaveLength(1)

    dismissMirror(ctx.db, idOf('g1'))
    expect(dedupeCandidates(loadAccountMap(ctx.db))).toEqual([])

    // The rename is the point. A dismissal keyed on the pair would be identified by two
    // names, so renaming either side produces a pair that has never been dismissed and
    // the suggestion comes back — which is the defect being fixed.
    syncAccountMap(ctx.db, [actual('a1', 'Argenta Sparen'), mirror('g1', 'Argenta Spaarboekje')])
    expect(dedupeCandidates(loadAccountMap(ctx.db))).toEqual([])
  })
})

describe('dismissMirror', () => {
  it('decides dedupeGroup without grouping anything', () => {
    syncAccountMap(ctx.db, [mirror('g1', 'Argenta Sparen')])
    const [row] = rows()

    const after = dismissMirror(ctx.db, row!.id)

    expect(after).not.toBeNull()
    // The account keeps counting for itself. A dismissal that quietly dropped it from
    // net worth would be the very error the panel exists to prevent.
    expect(after!.dedupeGroup).toBeNull()
    expect(after!.isSourceOfTruth).toBe(true)
    expect([...decidedFields(after!)]).toEqual(['dedupeGroup'])
  })

  it('refuses on an account that is in a group, rather than freezing it', () => {
    syncAccountMap(ctx.db, [actual('a1', 'Bolero', true), ghostfolio('g1', 'Bolero')])
    const [a1, g1] = rows()
    setDedupeGroup(ctx.db, 'broker', [a1!.id, g1!.id], a1!.id)

    // `ungroupAccount` is the operation there, and it records the same decision while
    // also breaking the group.
    expect(dismissMirror(ctx.db, g1!.id)).toBeNull()
  })

  it('is a no-op the second time', () => {
    syncAccountMap(ctx.db, [mirror('g1', 'Argenta Sparen')])
    const [row] = rows()

    dismissMirror(ctx.db, row!.id)
    const after = dismissMirror(ctx.db, row!.id)

    expect(after).not.toBeNull()
    expect([...decidedFields(after!)]).toEqual(['dedupeGroup'])
  })

  it('says nothing happened for an id it does not know', () => {
    expect(dismissMirror(ctx.db, 'nope')).toBeNull()
  })

  it('leaves a derived mirror alone once it has been dismissed', () => {
    // The two halves of the fix meeting: a dismissal must also stop the automatic
    // grouper, or the next sync regroups what a person just said was not a duplicate.
    syncAccountMap(ctx.db, [actual('a1', 'Argenta Sparen'), mirror('g1', 'Argenta Sparen')])
    const g1 = rows().find((row) => row.externalId === 'g1')
    updateAccountMap(ctx.db, g1!.id, { kind: 'cash' })
    dismissMirror(ctx.db, g1!.id)

    const [pair] = deriveMirrors(loadAccountMap(ctx.db))
    expect(pair).toBeDefined()
    expect(applyDerivedMirror(ctx.db, pair!)).toBeNull()
    expect(loadAccountMap(ctx.db).every((row) => row.dedupeGroup === null)).toBe(true)
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

/**
 * Provenance (#132).
 *
 * The bug this closes is not a wrong number, it is a missing distinction: `kind`
 * says `savings` and nothing records whether a rule said so or a person did. That
 * made a better classifier unbuildable, because `defaultKind` runs only on insert
 * and so can never reach an existing account — and building one that wrote
 * unconditionally would have erased the manual exclusions that are the only thing
 * currently keeping net worth right on the reporting instance.
 */
describe('decided fields', () => {
  const one = () => rows()[0]

  const seed = (sighting: AccountSighting = actual('a1', 'Current')): string => {
    syncAccountMap(ctx.db, [sighting])
    const row = one()
    if (row === undefined) throw new Error('the sighting produced no row')
    return row.id
  }

  it('starts empty, because a fresh insert is a rule speaking and not a person', () => {
    seed()
    expect([...decidedFields(one() ?? { decidedFields: null })]).toEqual([])
    expect(one()?.classifiedAt ?? null).toBeNull()
  })

  it('records the fields a PATCH named', () => {
    const id = seed()
    updateAccountMap(ctx.db, id, { kind: 'savings' })
    expect([...decidedFields(one() ?? { decidedFields: null })]).toEqual(['kind'])

    updateAccountMap(ctx.db, id, { includeInNetWorth: false })
    expect([...decidedFields(one() ?? { decidedFields: null })].sort()).toEqual([
      'includeInNetWorth',
      'kind',
    ])
  })

  it('records a field set to the value a rule would have chosen anyway', () => {
    // The point is not that the answer differs. It is that a person answered: saying
    // "yes, this really is a current account" has to survive a rule that later
    // decides otherwise, or confirming a guess is worth less than never looking.
    const id = seed()
    expect(one()?.kind).toBe('checking')
    updateAccountMap(ctx.db, id, { kind: 'checking' })
    expect([...decidedFields(one() ?? { decidedFields: null })]).toEqual(['kind'])
  })

  it('leaves provenance alone when the patch is empty, since that is a read', () => {
    const id = seed()
    updateAccountMap(ctx.db, id, { kind: 'savings' })
    updateAccountMap(ctx.db, id, {})
    expect([...decidedFields(one() ?? { decidedFields: null })]).toEqual(['kind'])
  })

  it('survives a sync, which is the whole point', () => {
    const id = seed()
    updateAccountMap(ctx.db, id, { kind: 'savings', includeInNetWorth: false })
    syncAccountMap(ctx.db, [actual('a1', 'Current account renamed')])

    expect(one()?.name).toBe('Current account renamed')
    expect(one()?.kind).toBe('savings')
    expect(one()?.includeInNetWorth).toBe(false)
    expect([...decidedFields(one() ?? { decidedFields: null })].sort()).toEqual([
      'includeInNetWorth',
      'kind',
    ])
  })
})

describe('grouping records provenance too', () => {
  it('marks both halves of a grouping decision', () => {
    syncAccountMap(ctx.db, [actual('a1', 'Mirror'), ghostfolio('g1', 'Bolero')])
    const [a, g] = rows()
    if (a === undefined || g === undefined) throw new Error('expected two rows')
    groupAccounts(ctx.db, [a.id, g.id], g.id)

    for (const row of rows()) {
      expect([...decidedFields(row)].sort()).toEqual(['dedupeGroup', 'isSourceOfTruth'])
    }
  })

  it('marks the whole group when one row is named the source of truth', () => {
    // Choosing one is simultaneously deciding the others are not, so a rule that
    // flipped a loser back would undo half of one answer.
    syncAccountMap(ctx.db, [actual('a1', 'Mirror'), ghostfolio('g1', 'Bolero')])
    const [a, g] = rows()
    if (a === undefined || g === undefined) throw new Error('expected two rows')
    setDedupeGroup(ctx.db, 'grp', [a.id, g.id], g.id)
    // Provenance is clean at this point: `setDedupeGroup` is also what a matcher
    // would call, so it is `setSourceOfTruth` that has to record the answer.
    setSourceOfTruth(ctx.db, a.id)

    for (const row of rows()) {
      expect([...decidedFields(row)]).toContain('isSourceOfTruth')
    }
  })

  it('treats ungrouping as a decision, not as an absence of one', () => {
    // "These two are not the same account" is worth exactly as much as the opposite,
    // and is the answer #131's dismissal has to be able to store.
    syncAccountMap(ctx.db, [actual('a1', 'Mirror'), ghostfolio('g1', 'Bolero')])
    const [a, g] = rows()
    if (a === undefined || g === undefined) throw new Error('expected two rows')
    groupAccounts(ctx.db, [a.id, g.id], g.id)
    ungroupAccount(ctx.db, a.id)

    const after = rows()[0]
    expect(after?.dedupeGroup).toBeNull()
    expect(after?.isSourceOfTruth).toBe(true)
    expect([...decidedFields(after ?? { decidedFields: null })].sort()).toEqual([
      'dedupeGroup',
      'isSourceOfTruth',
    ])
  })
})

describe('unlinkGroup', () => {
  // `ungroupAccount` frees only the row named, which is right when a group has three
  // or more members but is the exact footgun for the common case of two: freeing the
  // source-of-truth side alone leaves its twin as the sole member of a group with no
  // source of truth, and its money silently stops counting. The settings panel shows
  // a pair as one block with one "Unlink" button, so unlinking has to mean the whole
  // pair, symmetrically, whichever id the button happens to carry.
  it('separates both members of a pair, whichever id is passed', () => {
    syncAccountMap(ctx.db, [actual('a1', 'Mirror'), ghostfolio('g1', 'Bolero')])
    const [a, g] = rows()
    if (a === undefined || g === undefined) throw new Error('expected two rows')
    groupAccounts(ctx.db, [a.id, g.id], g.id)

    const after = unlinkGroup(ctx.db, a.id)

    expect(after.map((row) => row.id).sort()).toEqual([a.id, g.id].sort())
    for (const row of rows()) {
      expect(row.dedupeGroup).toBeNull()
      expect(row.isSourceOfTruth).toBe(true)
      expect([...decidedFields(row)].sort()).toEqual(['dedupeGroup', 'isSourceOfTruth'])
    }
  })

  it('gives the same result unlinking from the source-of-truth side', () => {
    syncAccountMap(ctx.db, [actual('a1', 'Mirror'), ghostfolio('g1', 'Bolero')])
    const [a, g] = rows()
    if (a === undefined || g === undefined) throw new Error('expected two rows')
    groupAccounts(ctx.db, [a.id, g.id], g.id)

    unlinkGroup(ctx.db, g.id)

    for (const row of rows()) {
      expect(row.dedupeGroup).toBeNull()
      expect(row.isSourceOfTruth).toBe(true)
    }
  })

  it('separates every member of a group larger than two', () => {
    syncAccountMap(ctx.db, [
      actual('a1', 'Mirror'),
      ghostfolio('g1', 'Bolero'),
      ghostfolio('g2', 'Bolero (copy)'),
    ])
    const [a, g1, g2] = rows()
    if (a === undefined || g1 === undefined || g2 === undefined) {
      throw new Error('expected three rows')
    }
    groupAccounts(ctx.db, [a.id, g1.id, g2.id], g1.id)

    const after = unlinkGroup(ctx.db, g2.id)

    expect(after).toHaveLength(3)
    for (const row of rows()) {
      expect(row.dedupeGroup).toBeNull()
      expect(row.isSourceOfTruth).toBe(true)
    }
  })

  it('does nothing to an account that was never grouped', () => {
    syncAccountMap(ctx.db, [actual('a1', 'Mirror')])
    const [a] = rows()
    if (a === undefined) throw new Error('expected a row')

    expect(unlinkGroup(ctx.db, a.id)).toEqual([])
    expect(rows()[0]?.dedupeGroup).toBeNull()
  })

  it('does nothing for an unknown id', () => {
    expect(unlinkGroup(ctx.db, 'does-not-exist')).toEqual([])
  })
})

describe('applyDerivedFields', () => {
  const seedOne = (): string => {
    syncAccountMap(ctx.db, [actual('a1', 'Current')])
    const row = rows()[0]
    if (row === undefined) throw new Error('the sighting produced no row')
    return row.id
  }

  it('writes a derived value to a field nobody has decided', () => {
    const id = seedOne()
    applyDerivedFields(ctx.db, id, { kind: 'savings' })
    expect(rows()[0]?.kind).toBe('savings')
  })

  it('refuses to overwrite a decided field', () => {
    const id = seedOne()
    updateAccountMap(ctx.db, id, { kind: 'cash' })
    applyDerivedFields(ctx.db, id, { kind: 'savings' })
    expect(rows()[0]?.kind).toBe('cash')
  })

  it('does not make a derived value a decision, so a better rule can still improve it', () => {
    const id = seedOne()
    applyDerivedFields(ctx.db, id, { kind: 'savings' })
    expect([...decidedFields(rows()[0] ?? { decidedFields: null })]).toEqual([])
    applyDerivedFields(ctx.db, id, { kind: 'cash' })
    expect(rows()[0]?.kind).toBe('cash')
  })

  it('writes the fields it may and skips the ones it may not, in one call', () => {
    // The exclusion is the field that matters on the reporting instance: six accounts
    // are held out of net worth by hand, and a classifier that re-derived inclusion
    // would put them all back and overstate net worth with nothing on screen saying so.
    const id = seedOne()
    updateAccountMap(ctx.db, id, { includeInNetWorth: false })
    applyDerivedFields(ctx.db, id, { kind: 'savings', includeInNetWorth: true })

    expect(rows()[0]?.kind).toBe('savings')
    expect(rows()[0]?.includeInNetWorth).toBe(false)
  })

  it('stamps the run even when every field it offered was refused', () => {
    // "The rule looked and had nothing to add" and "the rule has never run" are
    // different states, and only the timestamp can tell them apart. Without it, a
    // fully-decided account is indistinguishable from one the classifier skipped.
    const id = seedOne()
    updateAccountMap(ctx.db, id, { kind: 'cash' })
    const at = new Date('2026-09-03T10:00:00.000Z')
    applyDerivedFields(ctx.db, id, { kind: 'savings' }, at)

    expect(rows()[0]?.kind).toBe('cash')
    expect(rows()[0]?.classifiedAt?.toISOString()).toBe(at.toISOString())
  })

  it('returns null for an account that does not exist', () => {
    expect(applyDerivedFields(ctx.db, crypto.randomUUID(), { kind: 'cash' })).toBeNull()
  })
})

describe('decidedFields tolerates an unreadable column', () => {
  // Written by a migration and by earlier code, so it can hold anything. Throwing
  // here would fail the settings page over a provenance record, which is worse than
  // having no provenance record — and reading it as undecided errs towards a rule
  // overwriting something a person can see and set again, rather than freezing the
  // row against every future improvement with nothing explaining why.
  it.each([
    ['null', null],
    ['empty', ''],
    ['not JSON', '{oops'],
    ['not an array', '{"kind":true}'],
    ['unknown names', '["kind","nonsense",7,null]'],
  ])('reads %s as no decisions but for what it recognises', (_label, stored) => {
    const got = [...decidedFields({ decidedFields: stored })]
    expect(got.every((field) => (DECIDABLE_FIELDS as readonly string[]).includes(field))).toBe(true)
    if (stored === '["kind","nonsense",7,null]') expect(got).toEqual(['kind'])
    else expect(got).toEqual([])
  })
})

describe('the 0008 backfill', () => {
  /**
   * Runs the shipped statement, not a paraphrase of it. By the time a test database
   * exists the migration has already run, so the only way to exercise the inference
   * is to null the column back out and replay the exact SQL — worth the awkwardness,
   * because this statement runs once, unattended, over rows nobody can reconstruct,
   * and the first draft of it emptied every one of them.
   */
  const backfill = (): void => {
    const source = readFileSync(`${migrationsFolder}/0008_wild_legion.sql`, 'utf8')
    const statement = source
      .split('--> statement-breakpoint')
      .map((part) => part.trim())
      // The statement carries the long comment explaining the inference; SQLite is
      // happy to execute it with that attached, so it stays as shipped.
      .find((part) => part.includes('UPDATE `account_map` SET `decided_fields`'))
    if (statement === undefined) throw new Error('0008 no longer contains the backfill')
    ctx.db.run(sql.raw(statement))
  }

  const preMigration = (row: {
    externalId: string
    source: 'actual' | 'ghostfolio'
    kind: string
    includeInNetWorth?: boolean
    dedupeGroup?: string
    isSourceOfTruth?: boolean
  }): void => {
    ctx.db
      .insert(accountMap)
      .values({
        source: row.source,
        externalId: row.externalId,
        name: row.externalId,
        kind: row.kind as never,
        includeInNetWorth: row.includeInNetWorth ?? true,
        isSourceOfTruth: row.isSourceOfTruth ?? true,
        ...(row.dedupeGroup === undefined ? {} : { dedupeGroup: row.dedupeGroup }),
        decidedFields: null,
      })
      .run()
  }

  const inferred = (externalId: string): readonly string[] => {
    const row = rows().find((candidate) => candidate.externalId === externalId)
    if (row === undefined) throw new Error(`no row ${externalId}`)
    return [...decidedFields(row)]
  }

  it('infers nothing from a row that still looks like its defaults', () => {
    preMigration({ externalId: 'g-default', source: 'ghostfolio', kind: 'investment' })
    preMigration({ externalId: 'a-default', source: 'actual', kind: 'checking' })
    preMigration({ externalId: 'a-offbudget', source: 'actual', kind: 'other' })
    backfill()

    expect(inferred('g-default')).toEqual([])
    // 'checking' and 'other' are the vague ones #124 exists to sharpen, so leaving
    // them undecided is the point rather than a gap.
    expect(inferred('a-default')).toEqual([])
    expect(inferred('a-offbudget')).toEqual([])
  })

  it('preserves a manual exclusion, which is what net worth depends on', () => {
    preMigration({
      externalId: 'a-excluded',
      source: 'actual',
      kind: 'checking',
      includeInNetWorth: false,
    })
    backfill()
    expect(inferred('a-excluded')).toEqual(['includeInNetWorth'])
  })

  it('infers a hand-set kind on either source', () => {
    preMigration({ externalId: 'a-cash', source: 'actual', kind: 'cash' })
    preMigration({ externalId: 'g-savings', source: 'ghostfolio', kind: 'savings' })
    backfill()
    expect(inferred('a-cash')).toEqual(['kind'])
    expect(inferred('g-savings')).toEqual(['kind'])
  })

  it('infers a grouping from either half of it', () => {
    preMigration({
      externalId: 'a-mirror',
      source: 'actual',
      kind: 'other',
      dedupeGroup: 'grp',
      isSourceOfTruth: false,
    })
    preMigration({
      externalId: 'g-truth',
      source: 'ghostfolio',
      kind: 'investment',
      dedupeGroup: 'grp',
    })
    backfill()

    expect([...inferred('a-mirror')].sort()).toEqual(['dedupeGroup', 'isSourceOfTruth'])
    // The winner's `is_source_of_truth: true` is indistinguishable from untouched,
    // so only the group membership is recoverable. Documented in the migration.
    expect(inferred('g-truth')).toEqual(['dedupeGroup'])
  })

  it('leaves every row with readable JSON rather than a null', () => {
    preMigration({ externalId: 'g-default', source: 'ghostfolio', kind: 'investment' })
    preMigration({ externalId: 'a-cash', source: 'actual', kind: 'cash' })
    backfill()

    for (const row of rows()) {
      expect(row.decidedFields).toMatch(/^\[.*\]$/)
      expect(() => JSON.parse(row.decidedFields ?? '')).not.toThrow()
    }
  })
})

/**
 * The mirror rule: one Ghostfolio cash account, one Actual account, one name.
 *
 * Both halves of the asymmetry are asserted here, because they are the whole design.
 * A pair that should have matched and did not leaves net worth too big, which anyone
 * looking at the chart will notice. A pair that matched wrongly drops an account out
 * of net worth entirely, and a total that is too small looks exactly like a total
 * that was always that size. So every case below that is *refused* is refused on
 * purpose, and the refusal is the assertion.
 */
describe('deriveMirrors', () => {
  const derive = (): ReturnType<typeof deriveMirrors> => deriveMirrors(loadAccountMap(ctx.db))

  const idOf = (externalId: string): string => {
    const row = rows().find((candidate) => candidate.externalId === externalId)
    if (row === undefined) throw new Error(`no row for ${externalId}`)
    return row.id
  }

  it('pairs a Ghostfolio cash account with the Actual account of the same name', () => {
    syncAccountMap(ctx.db, [actual('a1', 'Argenta zichtrekening'), mirror('g1', 'Argenta zichtrekening')])

    expect(derive()).toEqual([
      { actualId: idOf('a1'), ghostfolioId: idOf('g1'), matchedOn: 'argenta zichtrekening' },
    ])
  })

  it('matches through case, diacritics and punctuation', () => {
    // One tool's em dash is the other's space, and Dutch account names carry
    // diacritics that survive one export and not the other.
    syncAccountMap(ctx.db, [actual('a1', 'Argenta — Zichtrekening'), mirror('g1', 'argenta zichtrekéning')])

    expect(derive().map((pair) => pair.matchedOn)).toEqual(['argenta zichtrekening'])
  })

  it('leaves a Ghostfolio account that holds positions alone', () => {
    // The names agreeing is not evidence of anything here: a brokerage account and the
    // off-budget Actual account tracking it are the same money, but grouping them is
    // #131's question and needs the balances to agree, not just the labels.
    syncAccountMap(ctx.db, [actual('a1', 'Bolero'), ghostfolio('g1', 'Bolero', true)])

    expect(derive()).toEqual([])
  })

  it('refuses a name two Actual accounts share', () => {
    // Grouping the Ghostfolio row against either one would be a coin flip, and the
    // wrong call silently removes an account's balance from net worth.
    syncAccountMap(ctx.db, [actual('a1', 'Spaarrekening'), actual('a2', 'spaarrekening'), mirror('g1', 'Spaarrekening')])

    expect(derive()).toEqual([])
  })

  it('refuses a name two Ghostfolio accounts share', () => {
    syncAccountMap(ctx.db, [actual('a1', 'Spaarrekening'), mirror('g1', 'Spaarrekening'), mirror('g2', 'spaarrekening ')])

    expect(derive()).toEqual([])
  })

  it('says nothing about a Ghostfolio account with no twin', () => {
    // It keeps counting, which is right: on a deployment where a bank exists in
    // Ghostfolio only, excluding it would lose the money.
    syncAccountMap(ctx.db, [actual('a1', 'Current'), mirror('g1', 'Revolut')])

    expect(derive()).toEqual([])
  })

  it('ignores a name that normalises to nothing', () => {
    // An account called "—" matches every other account called "-", and the empty
    // string is not a name two tools agreed on.
    syncAccountMap(ctx.db, [actual('a1', '—'), mirror('g1', '-')])

    expect(normaliseAccountName('—')).toBe('')
    expect(derive()).toEqual([])
  })

  it('skips rows that are already grouped, however they got that way', () => {
    syncAccountMap(ctx.db, [actual('a1', 'Argenta'), mirror('g1', 'Argenta')])
    setDedupeGroup(ctx.db, 'grp', [idOf('a1')], idOf('a1'))

    expect(derive()).toEqual([])
  })

  it('orders pairs by the name they matched on, so a log reads the same twice', () => {
    syncAccountMap(ctx.db, [
      actual('a1', 'Zichtrekening'),
      mirror('g1', 'Zichtrekening'),
      actual('a2', 'Argenta'),
      mirror('g2', 'Argenta'),
    ])

    expect(derive().map((pair) => pair.matchedOn)).toEqual(['argenta', 'zichtrekening'])
  })
})

describe('applyDerivedMirror', () => {
  const seedPair = (): { actualId: string; ghostfolioId: string } => {
    syncAccountMap(ctx.db, [actual('a1', 'Argenta'), mirror('g1', 'Argenta')])
    const [mirrorPair] = deriveMirrors(loadAccountMap(ctx.db))
    if (mirrorPair === undefined) throw new Error('the fixture produced no pair')
    return { actualId: mirrorPair.actualId, ghostfolioId: mirrorPair.ghostfolioId }
  }

  const byId = (id: string) => {
    const row = loadAccountMap(ctx.db).find((candidate) => candidate.id === id)
    if (row === undefined) throw new Error(`no row for ${id}`)
    return row
  }

  it('groups the pair and makes Actual the side that counts', () => {
    const { actualId, ghostfolioId } = seedPair()
    const group = applyDerivedMirror(ctx.db, { actualId, ghostfolioId, matchedOn: 'argenta' })

    expect(group).not.toBeNull()
    // Actual, because that is where the account is reconciled against statements —
    // Ghostfolio's copy is whatever the syncing tool last wrote.
    expect(byId(actualId).isSourceOfTruth).toBe(true)
    expect(byId(ghostfolioId).isSourceOfTruth).toBe(false)
    expect(byId(actualId).dedupeGroup).toBe(group)
    expect(byId(ghostfolioId).dedupeGroup).toBe(group)
  })

  it('records no decision, so a better rule may revise it', () => {
    const { actualId, ghostfolioId } = seedPair()
    applyDerivedMirror(ctx.db, { actualId, ghostfolioId, matchedOn: 'argenta' })

    for (const id of [actualId, ghostfolioId]) {
      expect([...decidedFields(byId(id))]).toEqual([])
      expect(byId(id).classifiedAt).not.toBeNull()
    }
  })

  it('leaves a pair alone once a person has ungrouped either half', () => {
    // The stored dismissal. Without this the next sync regroups what was just taken
    // apart, and the panel becomes a fight the job always wins.
    const { actualId, ghostfolioId } = seedPair()
    applyDerivedMirror(ctx.db, { actualId, ghostfolioId, matchedOn: 'argenta' })
    ungroupAccount(ctx.db, ghostfolioId)
    // Both are loose again, so the rule would match them a second time.
    ungroupAccount(ctx.db, actualId)

    expect(deriveMirrors(loadAccountMap(ctx.db))).toHaveLength(1)
    expect(applyDerivedMirror(ctx.db, { actualId, ghostfolioId, matchedOn: 'argenta' })).toBeNull()
    expect(byId(actualId).dedupeGroup).toBeNull()
    expect(byId(ghostfolioId).dedupeGroup).toBeNull()
  })

  it('refuses rather than half-grouping when one row has gone', () => {
    // A group of one whose source of truth sits outside it counts for nothing, so the
    // pair is written together or not at all.
    const { actualId } = seedPair()
    const missing = applyDerivedMirror(ctx.db, {
      actualId,
      ghostfolioId: 'a-row-that-never-existed',
      matchedOn: 'argenta',
    })

    expect(missing).toBeNull()
    expect(byId(actualId).dedupeGroup).toBeNull()
    expect(byId(actualId).isSourceOfTruth).toBe(true)
  })

  it('is a no-op the second time, because the pair is now grouped', () => {
    const { actualId, ghostfolioId } = seedPair()
    const first = applyDerivedMirror(ctx.db, { actualId, ghostfolioId, matchedOn: 'argenta' })
    const second = applyDerivedMirror(ctx.db, { actualId, ghostfolioId, matchedOn: 'argenta' })

    expect(second).toBeNull()
    expect(byId(actualId).dedupeGroup).toBe(first)
    // And the rule no longer proposes it, which is what keeps the job's log quiet.
    expect(deriveMirrors(loadAccountMap(ctx.db))).toEqual([])
  })
})
