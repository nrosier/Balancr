/**
 * A tax estimate as sentences, in both languages (#42).
 *
 * The estimate is the trustworthy part and this is the readable part, so what is under
 * test is neither arithmetic nor translation but the join: that a range reads as a range,
 * that a cap is mentioned when it bit, that the glossary supplies the tax's name in the
 * wording a broker statement uses, and that nothing gets rendered as a bare number when
 * the number is not known.
 *
 * The catalogue is asserted to contain no rate at all. That is the load-bearing test of
 * this file: a percentage copied into a translation is a rate that outlives the dated
 * file it came from, in the one place nobody thinks to check when the law changes.
 */
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { norm } from '../helpers/text.ts'
import { describeTaxEstimate } from '../../src/domain/tax/describe.ts'
import { estimateDividend, estimateTrade, type Trade } from '../../src/domain/tax/estimate.ts'
import { loadTaxRules } from '../../src/domain/tax/rules.ts'
import { initI18n, t } from '../../src/i18n/index.ts'

const rules = loadTaxRules('config/belgian-tax.yaml')

beforeAll(async () => {
  await initI18n()
})

/** A translator bound to one language, as the server binds it. */
const translator = (lang: string) => (key: string, vars = {}) => t(lang, key, vars)

const buy = (overrides: Partial<Trade> = {}): Trade => ({
  side: 'buy',
  on: '2026-06-01',
  consideration_cents: 100_000,
  instrument: { kind: 'fund', label: 'IWDA', distribution: 'accumulating', fsma_registered: true },
  ...overrides,
})

function render(trade: Trade, lang = 'en') {
  return describeTaxEstimate(estimateTrade(rules, trade), translator(lang), lang)
}

describe('a line with a certain amount', () => {
  it('reads as euros, a rate, a base and a source', () => {
    const text = render(buy())
    expect(text.lines).toHaveLength(1)
    const line = text.lines[0]
    expect(line?.term).toBe('Stock exchange tax (beurstaks / TOB)')
    expect(norm(line?.amount ?? '')).toBe('€ 13,20')
    expect(norm(line?.detail ?? '')).toContain('1,32% of € 1.000,00')
    expect(line?.detail).toContain('WDRT art. 1262')
    expect(line?.detail).toContain('checked 03/09/2026')
    expect(line?.todo).toBeUndefined()
    expect(line?.assumptions).toEqual([])
  })

  it('keeps the second decimal of a tax rate, against one decimal everywhere else', () => {
    // 0,12% and 1,32% are what a broker's own table says. At one decimal they become 0,1%
    // and 1,3%, and the eleven-fold difference stops being visible.
    const low = render(
      buy({
        instrument: {
          kind: 'fund',
          label: 'IWDA',
          distribution: 'accumulating',
          fsma_registered: false,
        },
      }),
    )
    expect(low.lines[0]?.detail).toContain('0,12%')
    expect(render(buy()).lines[0]?.detail).toContain('1,32%')
  })

  it('mentions the ceiling only when the ceiling decided the amount', () => {
    const capped = render(buy({ consideration_cents: 50_000_000 }))
    expect(norm(capped.lines[0]?.detail ?? '')).toContain('capped at € 4.000,00')
    expect(render(buy()).lines[0]?.detail).not.toContain('capped')
  })

  it('states the total as one amount', () => {
    expect(norm(render(buy()).total)).toBe('€ 13,20 in tax')
  })
})

describe('a line whose amount is not known', () => {
  const unrecorded = buy({
    instrument: { kind: 'fund', label: 'IWDA', distribution: 'accumulating' },
  })

  it('reads as a range rather than as either end of it', () => {
    const line = render(unrecorded).lines[0]
    expect(norm(line?.amount ?? '')).toBe('between € 1,20 and € 13,20')
    expect(norm(line?.amount ?? '')).not.toBe('€ 1,20')
  })

  it('says what to go and find out', () => {
    expect(render(unrecorded).lines[0]?.todo).toMatch(
      /registered for public distribution in Belgium/,
    )
    expect(render(unrecorded, 'nl').lines[0]?.todo).toMatch(/ingeschreven voor publieke distributie/)
  })

  it('has no rate or citation to show, and shows none', () => {
    expect(render(unrecorded).lines[0]?.detail).toBe('')
  })

  it('states the total as a range', () => {
    expect(norm(render(unrecorded).total)).toBe('Between € 1,20 and € 13,20 in tax')
  })

  it('states a floor when nothing bounds the amount at all', () => {
    const sale = render({
      side: 'sell',
      on: '2026-06-01',
      consideration_cents: 1_000_000,
      instrument: {
        kind: 'fund',
        label: 'Bond fund',
        distribution: 'accumulating',
        fsma_registered: false,
        debt_claims_percent: 100,
        debt_claims_assumed: true,
      },
    })
    expect(norm(sale.total)).toBe('At least € 12,00 in tax')
    const levy = sale.lines.find((line) => line.rule === 'reynders')
    expect(levy?.term).toBe('Reynders tax (Reynders-taks)')
    expect(levy?.amount).toBe('Not known yet')
    expect(levy?.detail).toContain('30% of an amount that is not known yet')
    expect(levy?.todo).toMatch(/interest component the fund publishes/)
    expect(levy?.assumptions).toEqual([
      "Assumes the fund's debt-claim share from its asset class, not from a published figure.",
    ])
  })
})

describe('assumptions and caveats', () => {
  it('repeats the exemption assumption on the gains line', () => {
    const sale = render({
      side: 'sell',
      on: '2026-06-01',
      consideration_cents: 5_000_000,
      gain_cents: 1_500_000,
      instrument: {
        kind: 'fund',
        label: 'IWDA',
        distribution: 'accumulating',
        fsma_registered: true,
        debt_claims_percent: 0,
      },
    })
    const gains = sale.lines.find((line) => line.rule === 'meerwaarde')
    expect(gains?.term).toBe('Capital gains tax (meerwaardebelasting)')
    expect(norm(gains?.amount ?? '')).toBe('€ 500,00')
    expect(gains?.assumptions).toEqual([
      "Assumes none of this year's exempt tranche has been used yet.",
    ])
  })

  it('warns that the shipped rates are transcribed, naming the ones in play', () => {
    const caveat = render(buy()).caveat ?? ''
    expect(caveat).toMatch(/transcribed from published guidance/)
    expect(caveat).toContain('Stock exchange tax (beurstaks / TOB)')
    // Only the rules used: a purchase says nothing about withholding tax.
    expect(caveat).not.toContain('roerende voorheffing')
  })

  it('lists several rules the way the language joins a list', () => {
    const threeRules = {
      side: 'sell',
      on: '2026-06-01',
      consideration_cents: 1_000_000,
      gain_cents: 50_000,
      interest_component_cents: 30_000,
      instrument: {
        kind: 'fund',
        label: 'Bond fund',
        distribution: 'accumulating',
        fsma_registered: false,
        debt_claims_percent: 100,
      },
    } satisfies Trade
    // Not ' , ' three times: the list joiner is the language's, so English gets "A, B and
    // C" and Dutch "A, B en C" without either being spelled out here.
    expect(render(threeRules).caveat).toMatch(/TOB\), Reynders tax \(Reynders-taks\) and Capital/)
    expect(render(threeRules, 'nl').caveat).toMatch(/Beurstaks \(TOB\), Reynders-taks en Meerwaardebelasting/)
  })
})

describe('Dutch', () => {
  it('renders the whole estimate, with Belgian formatting either way', () => {
    const text = render(buy(), 'nl')
    expect(text.lines[0]?.term).toBe('Beurstaks (TOB)')
    expect(norm(text.lines[0]?.amount ?? '')).toBe('€ 13,20')
    expect(norm(text.lines[0]?.detail ?? '')).toContain('1,32% van € 1.000,00')
    expect(text.lines[0]?.detail).toContain('gecontroleerd op 03/09/2026')
    expect(norm(text.total)).toBe('€ 13,20 belasting')
    expect(text.caveat).toMatch(/door niemand tegen de wettekst gecontroleerd/)
  })

  it('names the withholding tax as a statement does', () => {
    const text = describeTaxEstimate(
      estimateDividend(rules, { gross_cents: 25_000, on: '2026-06-01' }),
      translator('nl'),
      'nl',
    )
    expect(text.lines[0]?.term).toBe('Roerende voorheffing')
    expect(norm(text.lines[0]?.amount ?? '')).toBe('€ 75,00')
  })
})

describe('the catalogue', () => {
  it('contains no tax rate, in either language', () => {
    // Every percentage a user sees comes from the dated rules file, through `formatBp`. A
    // rate written into a translation is one the next government makes wrong, in the last
    // place anybody looks.
    for (const lang of ['en', 'nl']) {
      const text = readFileSync(`src/i18n/locales/${lang}/portfolio.json`, 'utf8')
      const tax = JSON.stringify(JSON.parse(text).tax)
      expect(tax).not.toMatch(/\d+[.,]?\d*\s?%/)
      expect(tax).not.toMatch(/0[.,]12|1[.,]32|0[.,]35/)
    }
  })
})
