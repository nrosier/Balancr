/**
 * Signals are facts about a month, which makes replacement — not merging — the
 * contract: a finding that has stopped being true has to disappear, and
 * "yesterday it said groceries were over" is not something to keep on a page.
 *
 * The other thing tested here is that nothing stored can come back malformed. The
 * rows outlive the code that wrote them: a metric stored as a string, or a code
 * dropped from the vocabulary in a later version, must not make an old month
 * unopenable.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { monthlyHygiene, monthlySignals } from '../../src/db/schema.ts'
import { persistMonthTotals } from '../../src/domain/aggregate/month-store.ts'
import type { HygieneScore } from '../../src/domain/aggregate/hygiene.ts'
import type { Signal } from '../../src/domain/aggregate/overspend.ts'
import type { MonthTotals } from '../../src/domain/aggregate/spend.ts'
import {
  loadHygiene,
  loadSignals,
  persistSignals,
  staleMonths,
} from '../../src/domain/aggregate/signals-store.ts'

let ctx: ReturnType<typeof createTestDb>

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
})

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    code: 'over_available',
    categoryId: 'food',
    categoryName: 'Food',
    severity: 'alert',
    metrics: { overspendCents: 8_000 },
    ...overrides,
  }
}

const clean: HygieneScore = { scoreBp: 10_000, deductions: [] }

function totals(month: string, overrides: Partial<MonthTotals> = {}): MonthTotals {
  return {
    month,
    incomeCents: 380_000,
    spentCents: 341_000,
    budgetedCents: 350_000,
    toBudgetCents: 9_000,
    fromLastMonthCents: 12_000,
    balanceCents: 39_000,
    savingsRateBp: 1_026,
    committedCents: 0,
    committedUnallocatedCents: 0,
    committedUnallocatedCount: 0,
    committedApproximate: false,
    ...overrides,
  }
}

describe('persistSignals', () => {
  it('round-trips a signal, metrics included', () => {
    expect(persistSignals(ctx.db, '2026-03', [signal()], clean)).toEqual({ signals: 1 })
    expect(loadSignals(ctx.db, '2026-03')).toEqual([signal()])
  })

  it('keeps a household signal, whose subject is nothing', () => {
    // The key column holds `''` rather than NULL, because SQLite treats NULLs as
    // distinct in a unique index and two household signals of the same code would
    // both be stored. What comes back must still be null, not the empty string.
    const household = signal({
      code: 'savings_rate_low',
      categoryId: null,
      categoryName: null,
      severity: 'warn',
      metrics: { rateBp: 263, targetBp: 1_500 },
    })
    persistSignals(ctx.db, '2026-03', [household], clean)
    expect(loadSignals(ctx.db, '2026-03')).toEqual([household])
  })

  it('stores two stale accounts as two rows, not one', () => {
    // The reason `unreconciled_account` carries the account id as its subject: a
    // shared key would collapse these into a single row on insert.
    const rows = [
      signal({ code: 'unreconciled_account', categoryId: 'a1', categoryName: 'Current', severity: 'warn', metrics: { days: 60, limitDays: 30 } }),
      signal({ code: 'unreconciled_account', categoryId: 'a2', categoryName: 'Savings', severity: 'warn', metrics: { days: -1, limitDays: 30 } }),
    ]
    expect(persistSignals(ctx.db, '2026-03', rows, clean)).toEqual({ signals: 2 })
    expect(loadSignals(ctx.db, '2026-03')).toHaveLength(2)
  })

  it('stores two over-threshold benchmark groups as two rows, not one', () => {
    // `above_benchmark` has no `categoryId` — it's household-level, one row per
    // Statbel group (#43) — so the group has to be the subject or two groups
    // over threshold in the same month collide on `(month, code, '')` and the
    // insert throws, which is exactly what happened in production.
    const rows = [
      signal({
        code: 'above_benchmark',
        categoryId: null,
        categoryName: 'transport',
        severity: 'info',
        metrics: { deltaBp: 3_500 },
      }),
      signal({
        code: 'above_benchmark',
        categoryId: null,
        categoryName: 'recreation',
        severity: 'info',
        metrics: { deltaBp: 2_800 },
      }),
    ]
    expect(persistSignals(ctx.db, '2026-03', rows, clean)).toEqual({ signals: 2 })
    expect(loadSignals(ctx.db, '2026-03')).toHaveLength(2)
  })

  it('replaces the month wholesale on a re-run', () => {
    persistSignals(ctx.db, '2026-03', [signal(), signal({ code: 'over_assigned', severity: 'warn' })], clean)
    persistSignals(ctx.db, '2026-03', [signal()], clean)
    expect(loadSignals(ctx.db, '2026-03').map((s) => s.code)).toEqual(['over_available'])
  })

  it('leaves other months alone', () => {
    persistSignals(ctx.db, '2026-02', [signal()], clean)
    persistSignals(ctx.db, '2026-03', [], clean)
    expect(loadSignals(ctx.db, '2026-02')).toHaveLength(1)
    expect(loadSignals(ctx.db, '2026-03')).toHaveLength(0)
  })

  it('clears a month that now has nothing to report', () => {
    persistSignals(ctx.db, '2026-03', [signal()], clean)
    expect(persistSignals(ctx.db, '2026-03', [], clean)).toEqual({ signals: 0 })
    expect(loadSignals(ctx.db, '2026-03')).toEqual([])
  })

  it('writes the hygiene row even for a month with no signals', () => {
    // The row's presence is what tells a later pass the month has been judged, so
    // a clean month must still produce one.
    persistSignals(ctx.db, '2026-03', [], clean)
    expect(loadHygiene(ctx.db, '2026-03')).toEqual(clean)
  })

  it('updates the score in place rather than accumulating rows', () => {
    persistSignals(ctx.db, '2026-03', [], { scoreBp: 8_000, deductions: [{ reason: 'x', bp: 2_000 }] })
    persistSignals(ctx.db, '2026-03', [], clean)
    expect(ctx.db.select().from(monthlyHygiene).all()).toHaveLength(1)
    expect(loadHygiene(ctx.db, '2026-03')?.scoreBp).toBe(10_000)
  })
})

describe('loadSignals is defensive about what it reads', () => {
  it('is empty for a month that has never been judged', () => {
    expect(loadSignals(ctx.db, '2026-03')).toEqual([])
    expect(loadHygiene(ctx.db, '2026-03')).toBeNull()
  })

  it('drops a row whose code is no longer in the vocabulary', () => {
    persistSignals(ctx.db, '2026-03', [signal()], clean)
    ctx.db
      .update(monthlySignals)
      .set({ code: 'retired_code' })
      .where(eq(monthlySignals.month, '2026-03'))
      .run()
    // Removing a code from `FINDING_CODES` must not make an old month unopenable.
    expect(loadSignals(ctx.db, '2026-03')).toEqual([])
  })

  it('drops a row whose metrics are not readable', () => {
    persistSignals(ctx.db, '2026-03', [signal()], clean)
    ctx.db
      .update(monthlySignals)
      .set({ metricsJson: 'not json' })
      .where(eq(monthlySignals.month, '2026-03'))
      .run()
    expect(loadSignals(ctx.db, '2026-03')).toEqual([])
  })

  it('keeps only the finite numbers in a metrics object', () => {
    // `JSON.stringify` turns Infinity into null, and a hand-edited row could hold
    // anything. A metric that is not a number is not a metric.
    persistSignals(ctx.db, '2026-03', [signal()], clean)
    ctx.db
      .update(monthlySignals)
      .set({ metricsJson: '{"overspendCents":8000,"note":"high","ratio":null}' })
      .where(eq(monthlySignals.month, '2026-03'))
      .run()
    expect(loadSignals(ctx.db, '2026-03')[0]?.metrics).toEqual({ overspendCents: 8_000 })
  })
})

describe('loadHygiene is defensive too', () => {
  it('round-trips the deductions that explain the score', () => {
    const score: HygieneScore = {
      scoreBp: 6_500,
      deductions: [
        { reason: 'uncategorised', bp: 2_000 },
        { reason: 'stale_prices', bp: 1_500 },
      ],
    }
    persistSignals(ctx.db, '2026-03', [], score)
    expect(loadHygiene(ctx.db, '2026-03')).toEqual(score)
  })

  it('keeps the score when the breakdown is unreadable', () => {
    // A score with an unexplainable breakdown is still the score that was
    // computed; throwing here would lose the number as well as the reason.
    persistSignals(ctx.db, '2026-03', [], { scoreBp: 6_500, deductions: [] })
    ctx.db
      .update(monthlyHygiene)
      .set({ deductionsJson: '{oops' })
      .where(eq(monthlyHygiene.month, '2026-03'))
      .run()
    expect(loadHygiene(ctx.db, '2026-03')).toEqual({ scoreBp: 6_500, deductions: [] })
  })

  it('drops a deduction entry that is not one', () => {
    persistSignals(ctx.db, '2026-03', [], { scoreBp: 6_500, deductions: [] })
    ctx.db
      .update(monthlyHygiene)
      .set({ deductionsJson: '[{"reason":"uncategorised","bp":2000},{"reason":7},null]' })
      .where(eq(monthlyHygiene.month, '2026-03'))
      .run()
    expect(loadHygiene(ctx.db, '2026-03')?.deductions).toEqual([
      { reason: 'uncategorised', bp: 2_000 },
    ])
  })
})

describe('staleMonths (#162)', () => {
  it('is empty for no months', () => {
    expect(staleMonths(ctx.db, [])).toEqual([])
  })

  it('ignores a month whose judged hash still matches its facts', () => {
    persistMonthTotals(ctx.db, [totals('2026-03')], [], new Map([['2026-03', 'hash-a']]))
    persistSignals(ctx.db, '2026-03', [], clean, 'hash-a')
    expect(staleMonths(ctx.db, ['2026-03'])).toEqual([])
  })

  it('picks up a month whose facts moved since it was judged', () => {
    persistMonthTotals(ctx.db, [totals('2026-03')], [], new Map([['2026-03', 'hash-a']]))
    persistSignals(ctx.db, '2026-03', [], clean, 'hash-a')
    // An edit lands after judgement, so the next sync writes a new hash.
    persistMonthTotals(ctx.db, [totals('2026-03')], [], new Map([['2026-03', 'hash-b']]))
    expect(staleMonths(ctx.db, ['2026-03'])).toEqual(['2026-03'])
  })

  it('includes a month with a fact hash but no hygiene row yet', () => {
    persistMonthTotals(ctx.db, [totals('2026-03')], [], new Map([['2026-03', 'hash-a']]))
    expect(staleMonths(ctx.db, ['2026-03'])).toEqual(['2026-03'])
  })

  it('leaves out a month with no stored fact hash at all', () => {
    // No fingerprint passed in — same as a totals row from before this column
    // existed, or a sync that never computed one. Nothing to compare against.
    persistMonthTotals(ctx.db, [totals('2026-03')], [])
    expect(staleMonths(ctx.db, ['2026-03'])).toEqual([])
  })

  it('leaves out a month that has never been synced at all', () => {
    expect(staleMonths(ctx.db, ['2026-03'])).toEqual([])
  })

  it('only reports the months asked about', () => {
    persistMonthTotals(
      ctx.db,
      [totals('2026-02'), totals('2026-03')],
      [],
      new Map([
        ['2026-02', 'hash-a'],
        ['2026-03', 'hash-a'],
      ]),
    )
    // Both are equally stale (no hygiene row), but only 2026-03 was asked for.
    expect(staleMonths(ctx.db, ['2026-03'])).toEqual(['2026-03'])
  })
})
