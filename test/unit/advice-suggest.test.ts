/**
 * Suggestions, and the two gates around them (#41).
 *
 * The tests that matter here are the ones about restraint. A rebalancer is easy to write
 * and easy to write dangerously: it can name a fund nobody vetted, it can propose a €200
 * trade that costs more in beurstaks than the drift it corrects, and it can quote a size
 * that is wrong by a factor of three because it never asked where the money comes from.
 * Each of those has a test below, and each of them is a decision the module makes rather
 * than a coincidence of the arithmetic.
 *
 * Every case pins `asOf` and `on`. Freshness and which dated tax ruleset applies both
 * depend on the day, and a suite that reads the clock passes today and fails on a date
 * nobody chose.
 */
import { describe, expect, it } from 'vitest'
import { loadTaxRules } from '../../src/domain/tax/rules.ts'
import { fundSchema, type FundEntry } from '../../src/domain/universe/schema.ts'
import { EMPTY_UNIVERSE, type FundUniverse } from '../../src/domain/universe/universe.ts'
import { buildAdvice, type AdviceInput, type HeldPosition } from '../../src/domain/advice/suggest.ts'
import { PROFILE_PRESETS, riskProfileSchema } from '../../src/domain/advice/profile.ts'
import type { AllocationInput } from '../../src/domain/advice/drift.ts'

const RULES = loadTaxRules('config/belgian-tax.yaml')
const ON = '2026-09-03'
const ASOF = new Date('2026-09-03T09:00:00Z')
/** €100 000 invested, so a basis point is €10. */
const INVESTED = 10_000_000

function fund(overrides: Record<string, unknown> = {}): FundEntry {
  return fundSchema.parse({
    isin: 'IE00B4L5Y983',
    name: 'iShares Core MSCI World UCITS ETF USD (Acc)',
    asset_class: 'equity',
    region: 'world',
    currency: 'USD',
    ter_percent: 0.2,
    domicile: 'IE',
    distribution: 'accumulating',
    ucits: true,
    fsma_registered: true,
    source: 'https://www.ishares.com/example',
    last_verified: '2026-09-01',
    ...overrides,
  })
}

function universeOf(funds: readonly FundEntry[]): FundUniverse {
  return {
    path: '/tmp/fund-universe.yaml',
    funds,
    byIsin: new Map(funds.map((entry) => [entry.isin, entry])),
  }
}

const WORLD = fund()
const BONDS = fund({
  isin: 'IE00B4WXJJ64',
  name: 'iShares Core Euro Government Bond UCITS ETF (Acc)',
  asset_class: 'bond',
  currency: 'EUR',
  region: 'eurozone',
  ter_percent: 0.09,
})
const PROPERTY = fund({
  isin: 'IE00B1FZS350',
  name: 'iShares Developed Markets Property Yield UCITS ETF',
  asset_class: 'property',
  region: 'developed',
  ter_percent: 0.59,
})

const FULL = universeOf([WORLD, BONDS, PROPERTY])

function slice(key: string, shareBp: number): AllocationInput {
  return { key, valueCents: (INVESTED * shareBp) / 10_000, shareBp }
}

function advise(overrides: Partial<AdviceInput> = {}) {
  return buildAdvice({
    allocation: [slice('EQUITY', 6_500), slice('FIXED_INCOME', 3_000), slice('REAL_ESTATE', 500)],
    investedValueCents: INVESTED,
    profile: riskProfileSchema.parse({}),
    universe: FULL,
    rules: RULES,
    asOf: ASOF,
    on: ON,
    ...overrides,
  })
}

/**
 * Equity short of its floor with nothing overweight: the money has to come from cash.
 *
 * Bonds sit exactly on their 40% ceiling and property inside its band, which is what
 * makes this the cash case — one class outside, and no trade wanted the other way.
 */
const UNDERWEIGHT = [slice('EQUITY', 5_000), slice('FIXED_INCOME', 4_000), slice('REAL_ESTATE', 1_000)]
/** Equity over its ceiling and bonds under their floor: the two fund each other. */
const LOPSIDED = [slice('EQUITY', 8_000), slice('FIXED_INCOME', 1_500), slice('REAL_ESTATE', 500)]

describe('buildAdvice', () => {
  it('suggests nothing when every class is inside its band', () => {
    const advice = advise()
    expect(advice.suggestions).toEqual([])
    expect(advice.skipped).toEqual([])
    expect(advice.drift.worstOutsideBp).toBe(0)
  })

  it('echoes the profile it judged against, so the page never has to look it up twice', () => {
    const advice = advise({ profile: riskProfileSchema.parse({ profile: 'growth' }) })
    expect(advice.profile).toBe('growth')
    expect(advice.isPreset).toBe(true)
    expect(advice.toleranceBp).toBe(100)
    expect(advice.minTradeCents).toBe(50_000)
    expect(advice.drift.lines[0]?.targetBp).toBe(PROFILE_PRESETS.growth.EQUITY.targetBp)
  })

  it('sizes a purchase from cash at the amount that actually lands on target', () => {
    const advice = advise({ allocation: UNDERWEIGHT })
    const [buy] = advice.suggestions
    expect(buy?.action).toBe('buy')
    expect(buy?.funding).toBe('cash')
    // €42 857,14, not the €15 000 the drift looks like: the purchase grows the base.
    expect(buy?.amountCents).toBe(4_285_714)
    expect(buy?.reason.gapCents).toBe(1_500_000)
  })

  it('sizes a matched pair at the gap, because the invested total does not move', () => {
    const advice = advise({ allocation: LOPSIDED });
    expect(advice.suggestions.map((s) => [s.action, s.assetClass, s.funding, s.amountCents])).toEqual([
      ['sell', 'EQUITY', 'paired', 1_500_000],
      ['buy', 'FIXED_INCOME', 'paired', 1_500_000],
    ])
  })

  it('carries the whole drift line as the reason, not a summary of it', () => {
    const advice = advise({ allocation: LOPSIDED })
    expect(advice.suggestions[0]?.reason).toEqual(
      advice.drift.lines.find((line) => line.assetClass === 'EQUITY'),
    )
  })

  it('leads with the worst drift', () => {
    const advice = advise({
      allocation: [slice('EQUITY', 9_000), slice('FIXED_INCOME', 1_000)],
    })
    // Equities 15% over their ceiling, bonds 10% under their floor.
    expect(advice.suggestions.map((s) => s.assetClass)).toEqual(['EQUITY', 'FIXED_INCOME'])
    expect(advice.suggestions[0]?.reason.outsideBp).toBeGreaterThan(
      advice.suggestions[1]?.reason.outsideBp ?? 0,
    )
  })
})

describe('the universe gate', () => {
  it('names the cheapest fresh fund for the class, and says how many it chose from', () => {
    const cheaper = fund({ isin: 'IE00BK5BQT80', name: 'Vanguard FTSE All-World (Acc)', ter_percent: 0.12 })
    const advice = advise({ allocation: UNDERWEIGHT, universe: universeOf([WORLD, cheaper, BONDS]) })
    expect(advice.suggestions[0]?.fund).toEqual({
      isin: 'IE00BK5BQT80',
      name: 'Vanguard FTSE All-World (Acc)',
      terPercent: 0.12,
      alternatives: 2,
    })
  })

  it('breaks a tie on TER by ISIN, so the same file always suggests the same fund', () => {
    const twin = fund({ isin: 'IE00B3RBWM25', name: 'Another world tracker (Acc)' })
    const first = advise({ allocation: UNDERWEIGHT, universe: universeOf([WORLD, twin]) })
    const reversed = advise({ allocation: UNDERWEIGHT, universe: universeOf([twin, WORLD]) })
    expect(first.suggestions[0]?.fund?.isin).toBe('IE00B3RBWM25')
    expect(reversed.suggestions[0]?.fund?.isin).toBe('IE00B3RBWM25')
  })

  it('proposes nothing to buy rather than something unvetted when the universe is empty', () => {
    const advice = advise({ allocation: UNDERWEIGHT, universe: EMPTY_UNIVERSE })
    const [buy] = advice.suggestions
    expect(buy?.amountCents).toBe(4_285_714)
    expect(buy?.fund).toBeNull()
    expect(buy?.unavailable).toBe('no_fund_in_universe')
    // No fund means no instrument to price, so no cost is invented for one either.
    expect(buy?.tax).toBeNull()
  })

  it('treats a stale entry as no entry: the list needs an evening, not a trade', () => {
    const old = fund({ last_verified: '2025-01-01' })
    const advice = advise({ allocation: UNDERWEIGHT, universe: universeOf([old, BONDS]) })
    expect(advice.suggestions[0]?.unavailable).toBe('no_fund_in_universe')
  })

  it('does not reach for a fund of the wrong class to fill a band', () => {
    // Bonds and property in the file, an equity band to fill: nothing matches.
    const advice = advise({ allocation: UNDERWEIGHT, universe: universeOf([BONDS, PROPERTY]) })
    expect(advice.suggestions[0]?.assetClass).toBe('EQUITY')
    expect(advice.suggestions[0]?.fund).toBeNull()
  })
})

describe('what a sale comes out of', () => {
  const holdings: readonly HeldPosition[] = [
    { isin: 'IE00B4L5Y983', name: 'iShares Core MSCI World', assetClass: 'EQUITY', valueCents: 6_000_000 },
    { isin: 'IE00B3RBWM25', name: 'Vanguard FTSE All-World', assetClass: 'EQUITY', valueCents: 2_000_000 },
    { isin: 'IE00B4WXJJ64', name: 'iShares Euro Gov Bond', assetClass: 'FIXED_INCOME', valueCents: 1_500_000 },
  ]

  it('names the largest position in the class, and how many there are to choose from', () => {
    const advice = advise({ allocation: LOPSIDED, holdings })
    expect(advice.suggestions[0]?.position).toEqual({
      isin: 'IE00B4L5Y983',
      name: 'iShares Core MSCI World',
      valueCents: 6_000_000,
      alternatives: 2,
    })
  })

  it('says the class is not held rather than naming nothing silently', () => {
    const advice = advise({ allocation: LOPSIDED, holdings: [] })
    const sell = advice.suggestions[0]
    expect(sell?.position).toBeNull()
    expect(sell?.unavailable).toBe('not_held')
    // Still priced: the beurstaks on a sale does not depend on which fund it was.
    expect(sell?.tax).not.toBeNull()
  })
})

describe('the cost of acting', () => {
  it('prices a purchase at the registered accumulating rate', () => {
    const advice = advise({ allocation: UNDERWEIGHT })
    const tax = advice.suggestions[0]?.tax
    // 1,32% of € 42 857,14.
    expect(tax?.total_cents).toBe(56_571)
    expect(tax?.complete).toBe(true)
    expect(advice.suggestions[0]?.taxOmits).toEqual([])
  })

  it('says a sale estimate leaves capital gains out, because the cost base is unknown', () => {
    const advice = advise({ allocation: LOPSIDED })
    const sell = advice.suggestions[0]
    expect(sell?.action).toBe('sell')
    expect(sell?.taxOmits).toEqual(['capital_gains'])
    expect(sell?.tax?.lines.map((line) => line.rule)).toEqual(['tob'])
  })

  it('prices a sale of a held fund from the universe entry for it', () => {
    const holdings: readonly HeldPosition[] = [
      { isin: 'IE00B4L5Y983', name: 'iShares Core MSCI World', assetClass: 'EQUITY', valueCents: 8_000_000 },
    ]
    const advice = advise({ allocation: LOPSIDED, holdings })
    expect(advice.suggestions[0]?.tax?.total_cents).toBe(19_800)
  })

  it('returns a range for a sale of something nobody recorded the registration of', () => {
    const holdings: readonly HeldPosition[] = [
      { isin: null, name: 'Some fund from before Balancr', assetClass: 'EQUITY', valueCents: 8_000_000 },
    ]
    const advice = advise({ allocation: LOPSIDED, holdings })
    const tob = advice.suggestions[0]?.tax?.lines[0]
    expect(tob?.amount_cents).toBeNull()
    // The missing fact is the first one a tier turns on: a Ghostfolio position does not
    // say whether the share class accumulates, let alone whether it is FSMA-registered.
    expect(tob?.unknown).toBe('distribution')
    expect(tob?.bounds).toEqual({ min_cents: 1_800, max_cents: 19_800 })
    expect(advice.suggestions[0]?.tax?.complete).toBe(false)
  })

  it('still suggests the trade when there are no tax rules to price it with', () => {
    const advice = advise({ allocation: UNDERWEIGHT, rules: null })
    expect(advice.suggestions).toHaveLength(1)
    expect(advice.suggestions[0]?.tax).toBeNull()
  })
})

describe('the thresholds', () => {
  it('leaves a share barely outside its band alone, and says why', () => {
    // Equity 0,5% past its ceiling against a 1% tolerance: a day of prices, not a trade.
    const advice = advise({
      allocation: [slice('EQUITY', 7_550), slice('FIXED_INCOME', 1_950), slice('REAL_ESTATE', 500)],
    })
    expect(advice.suggestions).toEqual([])
    expect(advice.skipped).toEqual([
      { assetClass: 'EQUITY', outsideBp: 50, amountCents: 1_050_000, reason: 'inside_tolerance' },
      { assetClass: 'FIXED_INCOME', outsideBp: 50, amountCents: 1_050_000, reason: 'inside_tolerance' },
    ])
    // The band is still shown as breached: the page says so, and now it can say why not.
    expect(advice.drift.lines[0]?.state).toBe('above')
  })

  it('refuses a correction too small to be worth the beurstaks, quoting what it would be', () => {
    const advice = advise({
      allocation: [slice('EQUITY', 7_700), slice('FIXED_INCOME', 1_800), slice('REAL_ESTATE', 500)],
      profile: riskProfileSchema.parse({ toleranceBp: 100, minTradeCents: 2_000_000 }),
    })
    expect(advice.suggestions).toEqual([])
    expect(advice.skipped.map((row) => [row.assetClass, row.reason, row.amountCents])).toEqual([
      ['EQUITY', 'below_min_trade', 1_200_000],
      ['FIXED_INCOME', 'below_min_trade', 1_200_000],
    ])
  })

  it('lets a tolerance of zero act on any breach at all', () => {
    const advice = advise({
      allocation: [slice('EQUITY', 7_550), slice('FIXED_INCOME', 1_950), slice('REAL_ESTATE', 500)],
      profile: riskProfileSchema.parse({ toleranceBp: 0 }),
    })
    expect(advice.suggestions.map((s) => s.assetClass)).toEqual(['EQUITY', 'FIXED_INCOME'])
  })

  it('keeps a purchase paired with a sale that was itself suppressed', () => {
    // The sale is too small to bother with; the money for the purchase is still coming
    // from it and not from cash, so the purchase keeps the paired size.
    const advice = advise({
      allocation: [slice('EQUITY', 7_600), slice('FIXED_INCOME', 1_000), slice('REAL_ESTATE', 1_400)],
      profile: riskProfileSchema.parse({ minTradeCents: 1_500_000 }),
    })
    const [buy] = advice.suggestions
    expect(buy?.action).toBe('buy')
    expect(buy?.funding).toBe('paired')
    expect(buy?.amountCents).toBe(2_000_000)
    expect(advice.skipped.map((row) => row.assetClass)).toEqual(['EQUITY'])
  })
})
