/**
 * The digest's net worth chart (#52) and its point cap (#609): `loadNetWorthHistory`
 * is deliberately unbounded — `overview.ts` and `jobs/signals.ts` both need the full
 * series — so the cap belongs here, at the one caller feeding a 500x220px SVG that
 * cannot show more than a couple hundred points usefully.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { netWorthSnapshots } from '../../src/db/schema.ts'
import { loadAccountMap, syncAccountMap } from '../../src/domain/aggregate/accounts.ts'
import { netWorthTrendOption } from '../../src/domain/digest/charts.ts'
import { initI18n } from '../../src/i18n/index.ts'

let ctx: ReturnType<typeof createTestDb>
let db: Db
let tenantId: string
let accountMapId: string

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  ctx = createTestDb()
  db = ctx.db
  applyMigrations(db as never)
  tenantId = getSoleTenantId(db)
  syncAccountMap(db, tenantId, [{ source: 'actual', externalId: 'a1', name: 'Zichtrekening' }])
  accountMapId = loadAccountMap(db, tenantId)[0]!.id
})

function seedDailySnapshots(days: number): void {
  for (let i = 0; i < days; i++) {
    const date = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10)
    db.insert(netWorthSnapshots).values({ tenantId, date, accountMapId, valueCents: 100_000 + i }).run()
  }
}

describe('netWorthTrendOption', () => {
  it('is null with no history', () => {
    expect(netWorthTrendOption(db, tenantId, 'en')).toBeNull()
  })

  it('plots every point under the cap', () => {
    seedDailySnapshots(24)
    const option = netWorthTrendOption(db, tenantId, 'en') as { series: { data: number[] }[] }
    expect(option.series[0]!.data).toHaveLength(24)
  })

  it('downsamples a series past the cap, keeping the last point (#609)', () => {
    seedDailySnapshots(900)
    const option = netWorthTrendOption(db, tenantId, 'en') as { series: { data: number[] }[] }
    const data = option.series[0]!.data

    expect(data.length).toBeLessThanOrEqual(180)
    expect(data.at(-1)).toBe(100_000 + 899)
  })
})
