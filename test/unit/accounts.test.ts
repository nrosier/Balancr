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
  DECIDABLE_FIELDS,
  decidedFields,
  dedupeCandidates,
  defaultKind,
  groupAccounts,
  loadAccountMap,
  setDedupeGroup,
  setSourceOfTruth,
  syncAccountMap,
  ungroupAccount,
  updateAccountMap,
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
