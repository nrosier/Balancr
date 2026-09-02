/**
 * The sync job's classification pass, which is where the two halves of #124 meet.
 *
 * `classify.ts` decides what an account is and `accounts.ts` decides what to do about
 * a pair of them; both are tested on their own. What is only true here is the
 * *order*: the mirror rule matches on `kind`, so a pass that grouped before it
 * relabelled would find no twins at all on a fresh database and the feature would
 * quietly do nothing. That, and the counts the job reports, which end up in the job
 * detail a person reads when net worth changes.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import pino from 'pino'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import {
  loadAccountMap,
  syncAccountMap,
  updateAccountMap,
  type AccountMapRow,
} from '../../src/domain/aggregate/accounts.ts'
import type { GhostfolioAccountEvidence } from '../../src/domain/aggregate/classify.ts'
import { classifyGhostfolio } from '../../src/jobs/sync.ts'

/** Silent: this file asserts on the database, and pino would only add noise. */
const log = pino({ level: 'silent' })

let ctx: ReturnType<typeof createTestDb>

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
})

const CURRENT_CENTS = 124_055

/** A copied bank balance: no activities, value equal to the balance. */
const mirrorEvidence: GhostfolioAccountEvidence = {
  externalId: 'g-current',
  name: 'Argenta zichtrekening',
  activitiesCount: 0,
  balanceCents: CURRENT_CENTS,
  valueCents: CURRENT_CENTS,
}

/** A real brokerage account. */
const brokerEvidence: GhostfolioAccountEvidence = {
  externalId: 'g-broker',
  name: 'Bolero',
  activitiesCount: 143,
  balanceCents: 21_000,
  valueCents: 4_890_000,
}

/**
 * The accounts as the sync inserts them, before any classification.
 *
 * `holdsInvestments` is deliberately left off the sightings so the rows land on the
 * insert-time default of `investment`, which is the state a first sync produces and
 * the state this pass has to correct.
 */
const seed = (): void => {
  syncAccountMap(ctx.db, [
    { source: 'actual', externalId: 'a-current', name: 'Argenta zichtrekening' },
    { source: 'ghostfolio', externalId: 'g-current', name: 'Argenta zichtrekening' },
    { source: 'ghostfolio', externalId: 'g-broker', name: 'Bolero' },
  ])
}

const byExternalId = (externalId: string): AccountMapRow => {
  const row = loadAccountMap(ctx.db).find((candidate) => candidate.externalId === externalId)
  if (row === undefined) throw new Error(`no row for ${externalId}`)
  return row
}

describe('classifyGhostfolio', () => {
  it('relabels the mirror, leaves the broker, and groups the pair in one pass', () => {
    seed()
    const result = classifyGhostfolio(ctx.db, [mirrorEvidence, brokerEvidence], log)

    expect(result).toEqual({ reclassified: 1, mirrored: 1 })
    expect(byExternalId('g-current').kind).toBe('cash')
    expect(byExternalId('g-broker').kind).toBe('investment')
    // Grouped with the Actual twin, which is the side that counts.
    const group = byExternalId('g-current').dedupeGroup
    expect(group).not.toBeNull()
    expect(byExternalId('a-current').dedupeGroup).toBe(group)
    expect(byExternalId('a-current').isSourceOfTruth).toBe(true)
    expect(byExternalId('g-current').isSourceOfTruth).toBe(false)
  })

  it('is quiet and idempotent the second time', () => {
    seed()
    classifyGhostfolio(ctx.db, [mirrorEvidence, brokerEvidence], log)
    const again = classifyGhostfolio(ctx.db, [mirrorEvidence, brokerEvidence], log)

    // Nothing changed, so nothing is reported: a job detail that claimed a
    // relabelling every night would make the one real one impossible to notice.
    expect(again).toEqual({ reclassified: 0, mirrored: 0 })
  })

  it('does not claim a relabelling it was refused', () => {
    // Someone has said this account holds positions. The pass still runs, still
    // stamps the row, and must not report a change it did not make.
    seed()
    updateAccountMap(ctx.db, byExternalId('g-current').id, { kind: 'investment' })
    const result = classifyGhostfolio(ctx.db, [mirrorEvidence, brokerEvidence], log)

    expect(result).toEqual({ reclassified: 0, mirrored: 0 })
    expect(byExternalId('g-current').kind).toBe('investment')
    // And no grouping, because a Ghostfolio account holding positions is not a
    // mirror of a bank balance — the decision propagates to the second half.
    expect(byExternalId('g-current').dedupeGroup).toBeNull()
  })

  it('stamps every account it looked at, whatever it concluded', () => {
    seed()
    classifyGhostfolio(ctx.db, [mirrorEvidence, brokerEvidence], log)

    // `classifiedAt` is how the panel says when a label was last derived, so it has
    // to move for the account that was already right as well.
    expect(byExternalId('g-broker').classifiedAt).not.toBeNull()
    expect(byExternalId('g-current').classifiedAt).not.toBeNull()
    // Actual is not classified by this pass; only grouped by it.
    expect(byExternalId('a-current').classifiedAt).not.toBeNull()
  })

  it('does nothing at all when Ghostfolio reported no accounts', () => {
    // An outage must not relabel or group anything: an empty evidence list is "no
    // news", and treating it as "no investments" would regroup the whole map.
    seed()
    expect(classifyGhostfolio(ctx.db, [], log)).toEqual({ reclassified: 0, mirrored: 0 })
    expect(byExternalId('g-current').kind).toBe('investment')
    expect(byExternalId('g-current').dedupeGroup).toBeNull()
  })

  it('ignores evidence for an account that is not in the map', () => {
    seed()
    const stranger: GhostfolioAccountEvidence = { ...mirrorEvidence, externalId: 'g-unknown' }

    expect(classifyGhostfolio(ctx.db, [stranger], log)).toEqual({ reclassified: 0, mirrored: 0 })
  })
})
