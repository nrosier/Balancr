/**
 * The collector is the first half of the privacy boundary: `redact.ts` decides
 * what leaves the machine, this decides what is available to leave. A field never
 * collected cannot leak, whatever a later change does downstream — so the tests
 * that matter most here are the ones about what is *absent*.
 *
 * The rest is about honesty of the figures: a month that has not been judged
 * returns null rather than a bundle of zeroes, the window the model sees is the
 * window the score was computed over, and nothing here recomputes a number that
 * another pass already owns.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { syncAccountMap } from '../../src/domain/aggregate/accounts.ts'
import { persistNetWorth } from '../../src/domain/aggregate/networth-store.ts'
import { persistSignals } from '../../src/domain/aggregate/signals-store.ts'
import type { RecomputeMismatch } from '../../src/domain/aggregate/spend.ts'
import { clean, fact, seedMonth, totals } from '../fixtures/month.ts'
import { collectBundle, collectPortfolio } from '../../src/domain/ai/bundle.ts'
import { PAYLOAD_KEYS, redact } from '../../src/domain/ai/redact.ts'
import type { HoldingSnapshot } from '../../src/domain/portfolio/snapshot.ts'
import {
  persistPortfolioMetrics,
  persistPortfolioSnapshots,
} from '../../src/domain/portfolio/store.ts'

let ctx: ReturnType<typeof createTestDb>

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
})

function holding(overrides: Partial<HoldingSnapshot> = {}): HoldingSnapshot {
  return {
    date: '2026-03-31',
    instrument: 'IE00B4L5Y983',
    symbol: 'IWDA.AS',
    isin: 'IE00B4L5Y983',
    name: 'iShares Core MSCI World UCITS ETF',
    quantity: '42.5',
    priceCents: 9_812,
    priceCurrency: 'EUR',
    valueCents: 417_010,
    currency: 'EUR',
    assetClass: 'EQUITY',
    assetSubClass: 'ETF',
    ...overrides,
  }
}

describe('collectBundle refuses to invent a month', () => {
  it('is null before the signals pass has judged the month', () => {
    // The hygiene row is the marker: `persistSignals` writes one even for a month
    // with nothing to report, so its absence means "not analysed", not "clean".
    seedMonth(ctx.db, '2026-03', { judged: false })
    expect(collectBundle(ctx.db, '2026-03')).toBeNull()
  })

  it('is null when the month has been judged but its totals are gone', () => {
    // A recompute that dropped the month, or a shortened history window. An
    // analysis of a month with no totals would be an analysis of zero, and the
    // model has no way to tell the difference.
    persistSignals(ctx.db, '2026-03', [], clean)
    expect(collectBundle(ctx.db, '2026-03')).toBeNull()
  })

  it('is null for a month nothing has ever touched', () => {
    expect(collectBundle(ctx.db, '2026-01')).toBeNull()
  })

  it('collects a month with no signals at all', () => {
    // A clean month is a legitimate analysis: "nothing is wrong" is an answer.
    seedMonth(ctx.db, '2026-03')
    const bundle = collectBundle(ctx.db, '2026-03')
    expect(bundle?.signals).toEqual([])
    expect(bundle?.hygiene.scoreBp).toBe(10_000)
  })
})

describe('collectBundle history', () => {
  it('ends at the month being analysed and does not repeat it', () => {
    for (const month of ['2026-01', '2026-02', '2026-03']) seedMonth(ctx.db, month)
    const bundle = collectBundle(ctx.db, '2026-03')
    expect(bundle?.totals.month).toBe('2026-03')
    expect(bundle?.totalsHistory.map((m) => m.month)).toEqual(['2026-01', '2026-02'])
  })

  it('stops at a gap rather than averaging across it', () => {
    // The same rule the signals pass follows, and for the same reason: the honest
    // answer to a hole in the history is a shorter window.
    for (const month of ['2026-01', '2026-03', '2026-04']) seedMonth(ctx.db, month)
    const bundle = collectBundle(ctx.db, '2026-04')
    expect(bundle?.totalsHistory.map((m) => m.month)).toEqual(['2026-03'])
  })

  it('analyses a month that is the only one there', () => {
    seedMonth(ctx.db, '2026-03')
    const bundle = collectBundle(ctx.db, '2026-03')
    expect(bundle?.totalsHistory).toEqual([])
    expect(bundle?.totals.month).toBe('2026-03')
  })

  it('analyses a past month with the window that ends at it', () => {
    // Asking for February in April must not hand the model March and April: a
    // trailing window is relative to the month being judged, not to today.
    for (const month of ['2026-01', '2026-02', '2026-03']) seedMonth(ctx.db, month)
    const bundle = collectBundle(ctx.db, '2026-02')
    expect(bundle?.totals.month).toBe('2026-02')
    expect(bundle?.totalsHistory.map((m) => m.month)).toEqual(['2026-01'])
  })
})

describe('collectBundle categories', () => {
  it('attaches the meta row to every category', () => {
    seedMonth(ctx.db, '2026-03')
    const bundle = collectBundle(ctx.db, '2026-03')
    expect(bundle?.categories.map((c) => c.fact.categoryId)).toEqual(['food', 'rent'])
    expect(bundle?.categories.every((c) => c.meta !== null)).toBe(true)
  })

  it('drops a hidden category with nothing in it', () => {
    // A budget accumulates retired envelopes. Forty empty ones cost tokens and
    // invite the model to remark on them.
    seedMonth(ctx.db, '2026-03', {
      facts: [
        fact('2026-03', 'food'),
        fact('2026-03', 'old-hobby', {
          hidden: true,
          spentCents: 0,
          budgetedCents: 0,
          availableCents: 0,
          txnCount: 0,
          recomputedSpentCents: 0,
        }),
      ],
    })
    expect(collectBundle(ctx.db, '2026-03')?.categories.map((c) => c.fact.categoryId)).toEqual([
      'food',
    ])
  })

  it('keeps a hidden category that saw money', () => {
    // Spending in an envelope that was retired is exactly the kind of thing worth
    // saying out loud.
    seedMonth(ctx.db, '2026-03', {
      facts: [
        fact('2026-03', 'food'),
        fact('2026-03', 'old-hobby', {
          hidden: true,
          spentCents: 4_500,
          budgetedCents: 0,
          txnCount: 1,
        }),
      ],
    })
    expect(collectBundle(ctx.db, '2026-03')?.categories).toHaveLength(2)
  })

  it('keeps a hidden category that was budgeted but not yet spent', () => {
    seedMonth(ctx.db, '2026-03', {
      facts: [
        fact('2026-03', 'old-hobby', {
          hidden: true,
          spentCents: 0,
          budgetedCents: 5_000,
          txnCount: 0,
        }),
      ],
    })
    expect(collectBundle(ctx.db, '2026-03')?.categories).toHaveLength(1)
  })
})

describe('collectBundle hygiene', () => {
  it('reads the stored score instead of recomputing it', () => {
    // One authority per figure: the signals pass computed the score over a
    // specific window, and a second opinion here would be a second authority for
    // the same number — visibly disagreeing with the page the user is reading.
    seedMonth(ctx.db, '2026-03', { signals: [] })
    persistSignals(ctx.db, '2026-03', [], {
      scoreBp: 7_250,
      deductions: [{ reason: 'uncategorised', bp: 2_750 }],
    })
    expect(collectBundle(ctx.db, '2026-03')?.hygiene.scoreBp).toBe(7_250)
  })

  it('sums the backlog over the whole window, not just the month', () => {
    // An uncategorised transaction from January is still uncategorised in March.
    // The backlog is one to-do list, which is why it is summed over the window.
    seedMonth(ctx.db, '2026-02', {
      uncategorised: [{ month: '2026-02', txnCount: 3, amountCents: -4_000 }],
    })
    seedMonth(ctx.db, '2026-03', {
      uncategorised: [{ month: '2026-03', txnCount: 2, amountCents: -1_500 }],
    })
    const hygiene = collectBundle(ctx.db, '2026-03')?.hygiene
    expect(hygiene?.uncategorisedCount).toBe(5)
    expect(hygiene?.uncategorisedCents).toBe(5_500)
  })

  it('sums magnitudes, so a refund does not cancel a charge', () => {
    seedMonth(ctx.db, '2026-02', {
      uncategorised: [{ month: '2026-02', txnCount: 1, amountCents: -8_000 }],
    })
    seedMonth(ctx.db, '2026-03', {
      uncategorised: [{ month: '2026-03', txnCount: 1, amountCents: 8_000 }],
    })
    expect(collectBundle(ctx.db, '2026-03')?.hygiene.uncategorisedCents).toBe(16_000)
  })

  it('counts drift for the analysed month only', () => {
    // Unlike the backlog: a recompute mismatch is a statement about one month's
    // arithmetic, and summing them would make an old fixed month look current.
    const mismatch = (month: string, id: string): RecomputeMismatch => ({
      month,
      categoryId: id,
      categoryName: id,
      actualCents: 10_000,
      recomputedCents: 9_500,
      differenceCents: 500,
    })
    seedMonth(ctx.db, '2026-02', { mismatches: [mismatch('2026-02', 'food')] })
    seedMonth(ctx.db, '2026-03', {
      mismatches: [mismatch('2026-03', 'food'), mismatch('2026-03', 'rent')],
    })
    expect(collectBundle(ctx.db, '2026-03')?.hygiene.mismatchCount).toBe(2)
  })
})

describe('collectPortfolio', () => {
  it('is null before the first snapshot', () => {
    expect(collectPortfolio(ctx.db)).toBeNull()
  })

  it('is null for a snapshot whose metrics were never written', () => {
    // The portfolio job wrote holdings and then failed. A holding count with no
    // value behind it would put a portfolio worth nothing in front of the model.
    persistPortfolioSnapshots(ctx.db, '2026-03-31', [holding()])
    expect(collectPortfolio(ctx.db)).toBeNull()
  })

  it('carries a count and the asset-class shares, and no instrument', () => {
    persistPortfolioSnapshots(ctx.db, '2026-03-31', [
      holding(),
      holding({ instrument: 'BE6295424999', symbol: null, isin: 'BE6295424999', name: 'Argenta Portfolio Defensive' }),
    ])
    persistPortfolioMetrics(ctx.db, {
      date: '2026-03-31',
      totalValueCents: 620_000,
      twrBp: 742,
      mwrBp: null,
      allocation: [
        { key: 'EQUITY', valueCents: 417_010, shareBp: 6_726 },
        { key: 'FIXED_INCOME', valueCents: 202_990, shareBp: 3_274 },
      ],
      driftJson: null,
      terAnnualCents: null,
    })

    const portfolio = collectPortfolio(ctx.db)
    expect(portfolio?.holdingCount).toBe(2)
    expect(portfolio?.metrics.totalValueCents).toBe(620_000)
    expect(portfolio?.metrics.allocation.map((s) => s.key)).toEqual(['EQUITY', 'FIXED_INCOME'])
    // The structural guarantee: the object has a number where a list of funds
    // would otherwise be, so there is no instrument for redaction to strip.
    expect(JSON.stringify(portfolio)).not.toContain('IE00B4L5Y983')
    expect(JSON.stringify(portfolio)).not.toContain('iShares')
  })

  it('takes the latest snapshot when there are several', () => {
    persistPortfolioSnapshots(ctx.db, '2026-02-28', [holding({ date: '2026-02-28' })])
    persistPortfolioSnapshots(ctx.db, '2026-03-31', [
      holding(),
      holding({ instrument: 'BE6295424999' }),
    ])
    for (const date of ['2026-02-28', '2026-03-31']) {
      persistPortfolioMetrics(ctx.db, {
        date,
        totalValueCents: 1,
        twrBp: null,
        mwrBp: null,
        allocation: [],
        driftJson: null,
        terAnnualCents: null,
      })
    }
    const portfolio = collectPortfolio(ctx.db)
    expect(portfolio?.metrics.date).toBe('2026-03-31')
    expect(portfolio?.holdingCount).toBe(2)
  })
})

describe('a collected bundle is safe to redact', () => {
  it('produces a payload with no key outside the reviewed set', () => {
    // The end-to-end version of the denylist test: everything above builds bundles
    // out of fixtures, this one builds a bundle out of the database and checks the
    // real collector's output against the real boundary. A field added to any fact
    // table and passed through by the collector fails here.
    syncAccountMap(ctx.db, [
      { source: 'actual', externalId: 'acc-1', name: 'KBC Zichtrekening 0123' },
      { source: 'ghostfolio', externalId: 'gf-1', name: 'Argenta Beleggingen' },
    ])
    seedMonth(ctx.db, '2026-02')
    seedMonth(ctx.db, '2026-03', {
      uncategorised: [{ month: '2026-03', txnCount: 2, amountCents: -1_500 }],
      signals: [
        {
          code: 'over_available',
          categoryId: 'food',
          categoryName: 'food',
          severity: 'alert',
          metrics: { overspendCents: 8_000 },
        },
        {
          code: 'unreconciled_account',
          categoryId: 'acc-1',
          categoryName: 'KBC Zichtrekening 0123',
          severity: 'warn',
          metrics: { days: 61, limitDays: 30 },
        },
      ],
    })
    persistNetWorth(ctx.db, {
      date: '2026-03-31',
      totalCents: 0,
      liquidCents: 0,
      investedCents: 0,
      debtCents: 0,
      contributions: [],
      excluded: [],
      unresolvedGroups: [],
    })
    persistPortfolioSnapshots(ctx.db, '2026-03-31', [holding()])
    persistPortfolioMetrics(ctx.db, {
      date: '2026-03-31',
      totalValueCents: 417_010,
      twrBp: 742,
      mwrBp: null,
      allocation: [{ key: 'EQUITY', valueCents: 417_010, shareBp: 10_000 }],
      driftJson: null,
      terAnnualCents: null,
    })

    const bundle = collectBundle(ctx.db, '2026-03')
    expect(bundle).not.toBeNull()
    const { payload } = redact(bundle as NonNullable<typeof bundle>)

    const keys = new Set<string>()
    const walk = (node: unknown, insideMetrics: boolean): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item, insideMetrics)
        return
      }
      if (node === null || typeof node !== 'object') return
      for (const [key, value] of Object.entries(node)) {
        // Metric names belong to whichever producer emitted the signal; the
        // redaction boundary asserts separately that they hold only numbers.
        if (!insideMetrics) keys.add(key)
        walk(value, insideMetrics || key === 'metrics')
      }
    }
    walk(payload, false)
    expect([...keys].filter((key) => !PAYLOAD_KEYS.includes(key))).toEqual([])

    // And the names that were in the database are not in what would be sent.
    const wire = JSON.stringify(payload)
    for (const secret of [
      'KBC Zichtrekening 0123',
      'Argenta Beleggingen',
      'IE00B4L5Y983',
      'IWDA.AS',
      'iShares Core MSCI World UCITS ETF',
      'acc-1',
      'gf-1',
    ]) {
      expect(wire).not.toContain(secret)
    }
    expect(payload.signals.map((s) => s.label)).toEqual(['c1', 'a1'])
  })
})
