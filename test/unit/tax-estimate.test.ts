/**
 * What a trade costs in Belgian tax, in euros (#42).
 *
 * Computed against the **shipped** rules file rather than a fixture, which is a
 * deliberate choice: these are the figures every container will show, the rates are the
 * thing most likely to be edited without much thought, and a euro amount that changes
 * belongs in a failing test rather than in an estimate. Editing a rate means editing an
 * expectation here — which is the moment to set `last_verified` and `status` too.
 *
 * Every case names its day, so a ruleset boundary is asserted rather than dated by
 * whenever the suite happens to run.
 */
import { describe, expect, it } from 'vitest'
import {
  beurstaks,
  estimateDividend,
  estimateTrade,
  meerwaarde,
  reynders,
  type TaxedInstrument,
  type Trade,
} from '../../src/domain/tax/estimate.ts'
import { taxedInstrumentFromFund } from '../../src/domain/tax/instrument.ts'
import { TaxRulesError, assertRulesInForceOn, loadTaxRules } from '../../src/domain/tax/rules.ts'
import { fundSchema } from '../../src/domain/universe/schema.ts'

const rules = loadTaxRules('config/belgian-tax.yaml')
const set2026 = assertRulesInForceOn(rules, '2026-06-01')
const set2018 = assertRulesInForceOn(rules, '2025-06-01')

function fund(extra: Partial<TaxedInstrument> = {}): TaxedInstrument {
  return { kind: 'fund', label: 'IWDA', distribution: 'accumulating', ...extra }
}

function buy(overrides: Partial<Trade> = {}): Trade {
  return {
    side: 'buy',
    on: '2026-06-01',
    consideration_cents: 100_000,
    instrument: fund({ fsma_registered: true }),
    ...overrides,
  }
}

describe('beurstaks on a purchase', () => {
  it('charges 1,32% on a Belgian-registered accumulating fund', () => {
    const line = beurstaks(set2026, buy())
    // € 13,20 on € 1.000 — the figure this whole feature exists to put on screen.
    expect(line.amount_cents).toBe(1_320)
    expect(line.basis?.tier).toBe('fund_accumulating_registered')
    expect(line.basis?.rate_bp).toBe(132)
    expect(line.basis?.base_cents).toBe(100_000)
    expect(line.basis?.capped).toBe(false)
    expect(line.basis?.status).toBe('transcribed')
    expect(line.basis?.effective_from).toBe('2026-01-01')
    expect(line.basis?.citation).toMatch(/WDRT art\. 1262/)
  })

  it('charges 0,12% on the same fund when it is not registered here', () => {
    const line = beurstaks(set2026, buy({ instrument: fund({ fsma_registered: false }) }))
    // € 1,20 against € 13,20: the factor of eleven that decides which share class to hold.
    expect(line.amount_cents).toBe(120)
    expect(line.basis?.tier).toBe('fund_accumulating_unregistered')
  })

  it('gives a range, not a number, when nobody recorded the registration', () => {
    const line = beurstaks(set2026, buy({ instrument: fund() }))
    expect(line.amount_cents).toBeNull()
    expect(line.bounds).toEqual({ min_cents: 120, max_cents: 1_320 })
    expect(line.unknown).toBe('fsma_registered')
    // No basis: two rates are in play, and showing either one's citation would suggest
    // the question had been settled.
    expect(line.basis).toBeNull()
  })

  it('does not quietly fall through to the low rate when the fact is missing', () => {
    // The bug worth a test of its own. Skipping an untestable tier and matching the
    // unconditional one would produce € 1,20 with every appearance of certainty — an
    // eleventh of what the trade may actually cost, in the direction that makes it look
    // cheap.
    const line = beurstaks(set2026, buy({ instrument: fund() }))
    expect(line.amount_cents).not.toBe(120)
    expect(line.basis?.tier).not.toBe('fund_default')
  })

  it('applies the per-transaction cap', () => {
    const line = beurstaks(set2026, buy({ consideration_cents: 50_000_000 }))
    // 1,32% of € 500.000 is € 6.600, over the € 4.000 ceiling.
    expect(line.amount_cents).toBe(400_000)
    expect(line.basis?.capped).toBe(true)
    expect(line.basis?.cap_cents).toBe(400_000)
  })

  it('distinguishes reaching the cap from being cut by it', () => {
    // Either side of the boundary: 1,32% of € 303.030,68 rounds to exactly € 4.000, and
    // one cent more of consideration rounds past it. Both amounts are € 4.000; only the
    // second is capped, and that is the difference between "this is the rate" and "this is
    // as much as the tax can be" on a line somebody reads.
    const at = beurstaks(set2026, buy({ consideration_cents: 30_303_068 }))
    expect(at.amount_cents).toBe(400_000)
    expect(at.basis?.capped).toBe(false)

    const over = beurstaks(set2026, buy({ consideration_cents: 30_303_069 }))
    expect(over.amount_cents).toBe(400_000)
    expect(over.basis?.capped).toBe(true)
  })

  it('charges 0,35% on a share and 0,12% on a bond', () => {
    const share = beurstaks(set2026, buy({ instrument: { kind: 'share', label: 'KBC' } }))
    expect(share.amount_cents).toBe(350)
    expect(share.basis?.tier).toBe('share_default')
    const bond = beurstaks(set2026, buy({ instrument: { kind: 'bond', label: 'OLO 2034' } }))
    expect(bond.amount_cents).toBe(120)
    expect(bond.basis?.tier).toBe('bond_default')
  })

  it('charges the low rate on a distributing fund', () => {
    const line = beurstaks(set2026, buy({ instrument: fund({ distribution: 'distributing' }) }))
    expect(line.amount_cents).toBe(120)
    expect(line.basis?.tier).toBe('fund_distributing')
  })

  it('is charged again on the way out', () => {
    const out = estimateTrade(rules, { ...buy(), side: 'sell' })
    expect(out.lines[0]?.rule).toBe('tob')
    expect(out.lines[0]?.amount_cents).toBe(1_320)
  })
})

describe('capital gains', () => {
  const sale = (overrides: Partial<Trade> = {}): Trade => ({
    ...buy(),
    side: 'sell',
    consideration_cents: 5_000_000,
    gain_cents: 1_500_000,
    ...overrides,
  })

  it('taxes the gain above the yearly exempt tranche', () => {
    const line = meerwaarde(set2026, sale())
    // € 15.000 gain, € 10.000 exempt, 10% of the rest: € 500.
    expect(line?.amount_cents).toBe(50_000)
    expect(line?.basis?.base_cents).toBe(500_000)
    expect(line?.basis?.rate_bp).toBe(1_000)
  })

  it('says that it assumed the whole tranche was still available', () => {
    expect(meerwaarde(set2026, sale())?.assumptions).toEqual(['full_annual_exemption'])
  })

  it('uses what is left of the tranche when the caller knows', () => {
    const line = meerwaarde(set2026, sale({ exemption_remaining_cents: 0 }))
    expect(line?.amount_cents).toBe(150_000)
    expect(line?.assumptions).toEqual([])
  })

  it('taxes nothing when the gain fits inside the tranche', () => {
    expect(meerwaarde(set2026, sale({ gain_cents: 900_000 }))?.amount_cents).toBe(0)
  })

  it('does not turn a loss into a refund', () => {
    const line = meerwaarde(set2026, sale({ gain_cents: -400_000 }))
    expect(line?.amount_cents).toBe(0)
    expect(line?.basis?.base_cents).toBe(0)
  })

  it('was nothing before 2026, and says so with a citation rather than silence', () => {
    const line = meerwaarde(set2018, sale({ on: '2025-06-01' }))
    expect(line?.amount_cents).toBe(0)
    expect(line?.basis?.rate_bp).toBe(0)
    expect(line?.basis?.citation).toMatch(/normaal beheer van privévermogen/)
    // Nothing was assumed that changes the answer under a zero rate.
    expect(line?.assumptions).toEqual([])
  })

  it('is left out entirely when the gain is not known', () => {
    // Absent rather than explicitly undefined: `exactOptionalPropertyTypes` makes those
    // two different things, and the one under test is a caller that never knew the cost
    // base — a position transferred in from another broker, typically.
    const unknown: Trade = { ...buy(), side: 'sell', consideration_cents: 5_000_000 }
    expect(meerwaarde(set2026, unknown)).toBeNull()
  })
})

describe('the Reynders levy', () => {
  const sale = (instrument: TaxedInstrument, overrides: Partial<Trade> = {}): Trade => ({
    ...buy(),
    side: 'sell',
    consideration_cents: 1_000_000,
    instrument,
    ...overrides,
  })

  it('does not apply to an equity fund, and does not appear as a zero', () => {
    expect(reynders(set2026, sale(fund({ debt_claims_percent: 0 })))).toBeNull()
  })

  it('does not apply at or below the threshold', () => {
    expect(reynders(set2026, sale(fund({ debt_claims_percent: 10 })))).toBeNull()
    expect(reynders(set2026, sale(fund({ debt_claims_percent: 11 })))).not.toBeNull()
  })

  it('names the figure to look up rather than inventing a base', () => {
    const line = reynders(set2026, sale(fund({ debt_claims_percent: 100 })))
    expect(line?.amount_cents).toBeNull()
    expect(line?.unknown).toBe('interest_component')
    expect(line?.basis?.rate_bp).toBe(3_000)
    expect(line?.bounds).toBeUndefined()
  })

  it('charges 30% of the interest component when the fund publishes one', () => {
    const line = reynders(
      set2026,
      sale(fund({ debt_claims_percent: 100 }), { interest_component_cents: 30_000 }),
    )
    expect(line?.amount_cents).toBe(9_000)
    expect(line?.basis?.base_cents).toBe(30_000)
  })

  it('records when the debt-claim share was inferred rather than published', () => {
    const inferred = reynders(
      set2026,
      sale(fund({ debt_claims_percent: 100, debt_claims_assumed: true })),
    )
    expect(inferred?.assumptions).toEqual(['debt_claims_from_asset_class'])
    const published = reynders(set2026, sale(fund({ debt_claims_percent: 100 })))
    expect(published?.assumptions).toEqual([])
  })
})

describe('roerende voorheffing', () => {
  it('withholds 30% of a gross distribution', () => {
    const estimate = estimateDividend(rules, { gross_cents: 25_000, on: '2026-06-01' })
    expect(estimate.lines).toHaveLength(1)
    expect(estimate.lines[0]?.rule).toBe('roerendeVoorheffing')
    expect(estimate.lines[0]?.amount_cents).toBe(7_500)
    expect(estimate.total_cents).toBe(7_500)
    expect(estimate.complete).toBe(true)
  })
})

describe('a whole trade', () => {
  it('charges only the beurstaks on a purchase', () => {
    const estimate = estimateTrade(rules, buy())
    expect(estimate.lines.map((line) => line.rule)).toEqual(['tob'])
    expect(estimate.total_cents).toBe(1_320)
    expect(estimate.complete).toBe(true)
    expect(estimate.effective_from).toBe('2026-01-01')
  })

  it('adds the levy and the gains tax on a sale, in that order', () => {
    const estimate = estimateTrade(rules, {
      side: 'sell',
      on: '2026-06-01',
      consideration_cents: 1_000_000,
      gain_cents: 50_000,
      interest_component_cents: 30_000,
      exemption_remaining_cents: 0,
      instrument: fund({ fsma_registered: false, debt_claims_percent: 100 }),
    })
    expect(estimate.lines.map((line) => line.rule)).toEqual(['tob', 'reynders', 'meerwaarde'])
    // € 12,00 beurstaks + € 90,00 Reynders + € 50,00 gains tax.
    expect(estimate.total_cents).toBe(1_200 + 9_000 + 5_000)
    expect(estimate.complete).toBe(true)
  })

  it('reports a floor, a range, and a total, and never mixes them up', () => {
    const certain = estimateTrade(rules, buy())
    expect([certain.total_cents, certain.total_min_cents, certain.total_max_cents]).toEqual([
      1_320, 1_320, 1_320,
    ])

    // A missing fact that only chooses between known rates: bounded on both sides.
    const bounded = estimateTrade(rules, buy({ instrument: fund() }))
    expect(bounded.total_cents).toBe(0)
    expect(bounded.total_min_cents).toBe(120)
    expect(bounded.total_max_cents).toBe(1_320)
    expect(bounded.complete).toBe(false)

    // A missing base, which nothing bounds: a floor and no ceiling.
    const floored = estimateTrade(rules, {
      side: 'sell',
      on: '2026-06-01',
      consideration_cents: 1_000_000,
      instrument: fund({ fsma_registered: false, debt_claims_percent: 100 }),
    })
    expect(floored.total_cents).toBe(1_200)
    expect(floored.total_min_cents).toBe(1_200)
    expect(floored.total_max_cents).toBeNull()
    expect(floored.complete).toBe(false)
  })

  it('reports only the rules it actually used as transcribed', () => {
    expect(estimateTrade(rules, buy()).transcribed).toEqual(['tob'])
    expect(estimateDividend(rules, { gross_cents: 100, on: '2026-06-01' }).transcribed).toEqual([
      'roerendeVoorheffing',
    ])
  })

  it('taxes the same sale differently on either side of 2026', () => {
    const trade = {
      side: 'sell' as const,
      consideration_cents: 5_000_000,
      gain_cents: 1_500_000,
      instrument: fund({ fsma_registered: true, debt_claims_percent: 0 }),
    }
    const after = estimateTrade(rules, { ...trade, on: '2026-01-01' })
    const before = estimateTrade(rules, { ...trade, on: '2025-12-31' })
    expect(after.total_cents - before.total_cents).toBe(50_000)
    expect(after.effective_from).toBe('2026-01-01')
    expect(before.effective_from).toBe('2018-01-01')
  })

  it('refuses a day the file says nothing about', () => {
    expect(() => estimateTrade(rules, buy({ on: '2001-01-01' }))).toThrow(TaxRulesError)
  })
})

describe('a universe fund as the tax rules see it', () => {
  const entry = (overrides: Record<string, unknown> = {}) =>
    fundSchema.parse({
      isin: 'IE00B4L5Y983',
      name: 'iShares Core MSCI World UCITS ETF USD (Acc)',
      asset_class: 'equity',
      region: 'world',
      currency: 'USD',
      ter_percent: 0.2,
      domicile: 'IE',
      distribution: 'accumulating',
      ucits: true,
      source: 'https://www.ishares.com/example',
      last_verified: '2026-09-01',
      ...overrides,
    })

  it('passes the accumulating class through rather than assuming it', () => {
    expect(taxedInstrumentFromFund(entry()).distribution).toBe('accumulating')
    expect(taxedInstrumentFromFund(entry()).kind).toBe('fund')
    expect(taxedInstrumentFromFund(entry()).label).toMatch(/iShares Core MSCI World/)
  })

  it('leaves an unrecorded registration unset, so the estimate can say so', () => {
    expect(taxedInstrumentFromFund(entry()).fsma_registered).toBeUndefined()
    expect(taxedInstrumentFromFund(entry({ fsma_registered: false })).fsma_registered).toBe(false)
    expect(taxedInstrumentFromFund(entry({ fsma_registered: true })).fsma_registered).toBe(true)
  })

  it('infers the debt-claim share from the asset class, and marks it as inferred', () => {
    const equity = taxedInstrumentFromFund(entry())
    expect(equity.debt_claims_percent).toBe(0)
    expect(equity.debt_claims_assumed).toBe(true)

    const bonds = taxedInstrumentFromFund(entry({ asset_class: 'bond', region: 'eurozone' }))
    expect(bonds.debt_claims_percent).toBe(100)
    expect(bonds.debt_claims_assumed).toBe(true)

    const cash = taxedInstrumentFromFund(entry({ asset_class: 'cash', region: 'eurozone' }))
    expect(cash.debt_claims_percent).toBe(100)
  })

  it('prefers a published figure, and then claims nothing', () => {
    const mixed = taxedInstrumentFromFund(entry({ debt_claims_percent: 40 }))
    expect(mixed.debt_claims_percent).toBe(40)
    expect(mixed.debt_claims_assumed).toBeUndefined()
  })

  it('makes an equity tracker with no recorded registration a range, end to end', () => {
    const estimate = estimateTrade(rules, {
      side: 'buy',
      on: '2026-06-01',
      consideration_cents: 100_000,
      instrument: taxedInstrumentFromFund(entry()),
    })
    expect(estimate.lines.map((line) => line.rule)).toEqual(['tob'])
    expect(estimate.total_min_cents).toBe(120)
    expect(estimate.total_max_cents).toBe(1_320)
  })
})
