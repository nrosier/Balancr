/**
 * `tag_monthly_facts` is derived data, rebuilt on every sync — same idempotence
 * contract `facts.test.ts` holds `monthly_category_facts` to, mirrored here for the
 * tag tables (#663).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { tagMeta, tagMonthlyFacts } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import type { ActualTag, TagMonthTotal } from '../../src/adapters/actual/queries.ts'
import { loadTagTotals, persistTagFacts, syncTagMeta } from '../../src/domain/aggregate/tags.ts'
import { createSecondTenant } from '../helpers/second-tenant.ts'

function tag(id: string, overrides: Partial<ActualTag> = {}): ActualTag {
  return { id, tag: id, color: null, hidden: false, ...overrides }
}

function total(tagName: string, month: string, overrides: Partial<TagMonthTotal> = {}): TagMonthTotal {
  return { tag: tagName, month, netCents: -10_000, txnCount: 2, ...overrides }
}

let ctx: ReturnType<typeof createTestDb>
let TENANT_ID: string

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  TENANT_ID = getSoleTenantId(ctx.db)
})

describe('syncTagMeta', () => {
  it('upserts a tag on first sight', () => {
    syncTagMeta(ctx.db, TENANT_ID, [tag('t1', { tag: 'rental-a', color: '#ff0000' })])
    const row = ctx.db.select().from(tagMeta).where(eq(tagMeta.tagId, 't1')).get()
    expect(row).toMatchObject({ tag: 'rental-a', color: '#ff0000', hidden: false })
  })

  it('fully refreshes every column on a second sync — Actual owns all of it', () => {
    syncTagMeta(ctx.db, TENANT_ID, [tag('t1', { tag: 'rental-a', color: '#ff0000', hidden: false })])
    syncTagMeta(ctx.db, TENANT_ID, [tag('t1', { tag: 'rental-b', color: '#00ff00', hidden: true })])

    const row = ctx.db.select().from(tagMeta).where(eq(tagMeta.tagId, 't1')).get()
    expect(row).toMatchObject({ tag: 'rental-b', color: '#00ff00', hidden: true })
  })

  it('removes a tag deleted in Actual on the next sync (#733)', () => {
    syncTagMeta(ctx.db, TENANT_ID, [tag('t1'), tag('t2')])
    syncTagMeta(ctx.db, TENANT_ID, [tag('t2')])

    expect(ctx.db.select().from(tagMeta).where(eq(tagMeta.tagId, 't1')).get()).toBeUndefined()
    expect(ctx.db.select().from(tagMeta).where(eq(tagMeta.tagId, 't2')).get()).toBeDefined()
  })

  it('clears the table when every tag is gone (#733)', () => {
    syncTagMeta(ctx.db, TENANT_ID, [tag('t1')])
    syncTagMeta(ctx.db, TENANT_ID, [])

    expect(ctx.db.select().from(tagMeta).where(eq(tagMeta.tagId, 't1')).get()).toBeUndefined()
  })
})

describe('persistTagFacts', () => {
  const tagsById = new Map([['rental-a', 't1'], ['rental-b', 't2']])
  const activeTagIds = new Set(['t1', 't2'])

  it('is idempotent: the same input twice leaves the same data', () => {
    const totals = [total('rental-a', '2026-01'), total('rental-b', '2026-01')]
    expect(persistTagFacts(ctx.db, TENANT_ID, totals, tagsById, ['2026-01'], activeTagIds)).toEqual({
      written: 2,
      removed: 0,
    })
    const rows = () => ctx.db.select().from(tagMonthlyFacts).orderBy(tagMonthlyFacts.tagId).all()
    const first = rows()

    expect(persistTagFacts(ctx.db, TENANT_ID, totals, tagsById, ['2026-01'], activeTagIds)).toEqual({
      written: 2,
      removed: 0,
    })
    const withoutTimestamp = (all: ReturnType<typeof rows>) =>
      all.map(({ computedAt: _computedAt, ...rest }) => rest)
    expect(withoutTimestamp(rows())).toEqual(withoutTimestamp(first))
  })

  it('drops a total for a tag id not in the map, rather than guessing at one', () => {
    const totals = [total('unknown-tag', '2026-01')]
    expect(persistTagFacts(ctx.db, TENANT_ID, totals, tagsById, ['2026-01'], activeTagIds)).toEqual({
      written: 0,
      removed: 0,
    })
    expect(ctx.db.select().from(tagMonthlyFacts).all()).toEqual([])
  })

  it('removes a tag that no longer appears in a recomputed month', () => {
    persistTagFacts(
      ctx.db,
      TENANT_ID,
      [total('rental-a', '2026-01'), total('rental-b', '2026-01')],
      tagsById,
      ['2026-01'],
      activeTagIds,
    )
    expect(
      persistTagFacts(ctx.db, TENANT_ID, [total('rental-a', '2026-01')], tagsById, ['2026-01'], activeTagIds),
    ).toEqual({ written: 1, removed: 1 })
    expect(ctx.db.select().from(tagMonthlyFacts).all().map((row) => row.tagId)).toEqual(['t1'])
  })

  it('clears a month that legitimately ends up with no tagged transactions', () => {
    persistTagFacts(ctx.db, TENANT_ID, [total('rental-a', '2026-01')], tagsById, ['2026-01'], activeTagIds)
    expect(persistTagFacts(ctx.db, TENANT_ID, [], tagsById, ['2026-01'], activeTagIds)).toEqual({
      written: 0,
      removed: 1,
    })
    expect(ctx.db.select().from(tagMonthlyFacts).all()).toEqual([])
  })

  it('leaves months outside the recomputed window alone', () => {
    persistTagFacts(ctx.db, TENANT_ID, [total('rental-a', '2025-12')], tagsById, ['2025-12'], activeTagIds)
    persistTagFacts(ctx.db, TENANT_ID, [total('rental-a', '2026-01')], tagsById, ['2026-01'], activeTagIds)
    expect(persistTagFacts(ctx.db, TENANT_ID, [], tagsById, ['2026-01'], activeTagIds)).toEqual({
      written: 0,
      removed: 1,
    })
    expect(ctx.db.select().from(tagMonthlyFacts).all().map((row) => row.month)).toEqual(['2025-12'])
  })

  it('leaves a hidden tag\'s history alone instead of reading its absence from totals as staleness (#750)', () => {
    persistTagFacts(
      ctx.db,
      TENANT_ID,
      [total('rental-a', '2026-01'), total('rental-b', '2026-01')],
      tagsById,
      ['2026-01'],
      activeTagIds,
    )

    // rental-b was hidden between syncs: sync.ts stops asking Actual about it, so it
    // never appears in this pass's totals — indistinguishable from a real gap unless
    // the cleanup below is scoped to only the tags that were actually active this pass.
    expect(
      persistTagFacts(
        ctx.db,
        TENANT_ID,
        [total('rental-a', '2026-01')],
        tagsById,
        ['2026-01'],
        new Set(['t1']),
      ),
    ).toEqual({ written: 1, removed: 0 })
    expect(ctx.db.select().from(tagMonthlyFacts).all().map((row) => row.tagId).sort()).toEqual(['t1', 't2'])
  })

  it('leaves every row alone when nothing was active this pass', () => {
    persistTagFacts(
      ctx.db,
      TENANT_ID,
      [total('rental-a', '2026-01')],
      tagsById,
      ['2026-01'],
      activeTagIds,
    )
    expect(persistTagFacts(ctx.db, TENANT_ID, [], tagsById, ['2026-01'], new Set())).toEqual({
      written: 0,
      removed: 0,
    })
    expect(ctx.db.select().from(tagMonthlyFacts).all().map((row) => row.tagId)).toEqual(['t1'])
  })
})

describe('loadTagTotals', () => {
  const seed = (): void => {
    syncTagMeta(ctx.db, TENANT_ID, [tag('t1', { tag: 'rental-a', color: '#ff0000' })])
    const tagsById = new Map([['rental-a', 't1']])
    persistTagFacts(
      ctx.db,
      TENANT_ID,
      [
        total('rental-a', '2025-01', { netCents: -1_000 }),
        total('rental-a', '2025-06', { netCents: -2_000 }),
        total('rental-a', '2026-01', { netCents: -3_000 }),
        total('rental-a', '2026-02', { netCents: 500 }),
      ],
      tagsById,
      ['2025-01', '2025-06', '2026-01', '2026-02'],
      new Set(['t1']),
    )
  }

  it('sums every stored month for all-time', () => {
    seed()
    expect(loadTagTotals(ctx.db, TENANT_ID, '2026-02')[0]?.allTimeNetCents).toBe(-5_500)
  })

  it('sums only the 12 months ending at the anchor for rolling-12', () => {
    seed()
    // 2025-01 falls outside the 12 months ending 2026-02 (2025-03..2026-02);
    // 2025-06, 2026-01 and 2026-02 fall inside it.
    expect(loadTagTotals(ctx.db, TENANT_ID, '2026-02')[0]?.rolling12NetCents).toBe(-4_500)
  })

  it('sums only months sharing the anchor calendar year for this-year', () => {
    seed()
    expect(loadTagTotals(ctx.db, TENANT_ID, '2026-02')[0]?.thisYearNetCents).toBe(-2_500)
  })

  it('carries the raw series ascending, and the tag/color from tag_meta', () => {
    seed()
    const [row] = loadTagTotals(ctx.db, TENANT_ID, '2026-02')
    expect(row).toMatchObject({ tag: 'rental-a', color: '#ff0000' })
    expect(row?.byMonth.map((point) => point.month)).toEqual(['2025-01', '2025-06', '2026-01', '2026-02'])
  })

  it('excludes a hidden tag', () => {
    seed()
    ctx.db.update(tagMeta).set({ hidden: true }).where(eq(tagMeta.tagId, 't1')).run()
    expect(loadTagTotals(ctx.db, TENANT_ID, '2026-02')).toEqual([])
  })

  it('is empty before the first sync', () => {
    expect(loadTagTotals(ctx.db, TENANT_ID, '2026-02')).toEqual([])
  })

  it('still counts a fact older than the 24-month series window toward all-time (#692)', () => {
    // The three summary figures are summed in SQL over every stored row, unbounded;
    // only the `byMonth` series returned for the chart is capped. A month outside
    // that window must still move `allTimeNetCents` without appearing in `byMonth`.
    syncTagMeta(ctx.db, TENANT_ID, [tag('t1', { tag: 'rental-a' })])
    persistTagFacts(
      ctx.db,
      TENANT_ID,
      [total('rental-a', '2024-01', { netCents: -7_000 })],
      new Map([['rental-a', 't1']]),
      ['2024-01'],
      new Set(['t1']),
    )

    const [row] = loadTagTotals(ctx.db, TENANT_ID, '2026-02')

    expect(row?.allTimeNetCents).toBe(-7_000)
    expect(row?.byMonth).toEqual([])
  })

  it('gives a tag with meta but no facts all-zero totals and an empty series', () => {
    syncTagMeta(ctx.db, TENANT_ID, [tag('t1', { tag: 'rental-a' })])
    expect(loadTagTotals(ctx.db, TENANT_ID, '2026-02')).toEqual([
      {
        id: 't1',
        tag: 'rental-a',
        color: null,
        allTimeNetCents: 0,
        rolling12NetCents: 0,
        thisYearNetCents: 0,
        byMonth: [],
      },
    ])
  })
})

describe('tenant isolation (#699)', () => {
  it('keeps tag_meta and tag_monthly_facts scoped per tenant, even when the tag id collides', () => {
    const otherTenantId = createSecondTenant(ctx.db)

    syncTagMeta(ctx.db, TENANT_ID, [tag('t1', { tag: 'rental-a', color: '#ff0000' })])
    syncTagMeta(ctx.db, otherTenantId, [tag('t1', { tag: 'rental-b', color: '#00ff00' })])

    persistTagFacts(
      ctx.db,
      TENANT_ID,
      [total('rental-a', '2026-01', { netCents: -1_000 })],
      new Map([['rental-a', 't1']]),
      ['2026-01'],
      new Set(['t1']),
    )
    persistTagFacts(
      ctx.db,
      otherTenantId,
      [total('rental-b', '2026-01', { netCents: -9_000 })],
      new Map([['rental-b', 't1']]),
      ['2026-01'],
      new Set(['t1']),
    )

    expect(loadTagTotals(ctx.db, TENANT_ID, '2026-01')).toEqual([
      expect.objectContaining({ tag: 'rental-a', allTimeNetCents: -1_000 }),
    ])
    expect(loadTagTotals(ctx.db, otherTenantId, '2026-01')).toEqual([
      expect.objectContaining({ tag: 'rental-b', allTimeNetCents: -9_000 }),
    ])
  })
})
