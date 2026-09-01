import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { norm } from '../helpers/text.ts'
import {
  initI18n,
  missingVars,
  renderClarification,
  renderFinding,
  t,
} from '../../src/i18n/index.ts'
import { configureFormatting } from '../../src/i18n/format-config.ts'
import { formatMoney, formatBp } from '../../src/i18n/format.ts'
import {
  CLARIFICATION_CODES,
  FINDING_CODES,
  FINDING_SPECS,
  CLARIFICATION_SPECS,
} from '../../src/domain/ai/codes.ts'

const BELGIAN = { formatLocale: 'nl-BE', currency: 'EUR', timeZone: 'Europe/Brussels' }

beforeAll(async () => {
  await initI18n()
})

afterEach(() => {
  configureFormatting(BELGIAN)
})

describe('catalogues', () => {
  it('translates the same key in both languages', () => {
    expect(t('en', 'common:nav.overview')).toBe('Overview')
    expect(t('nl', 'common:nav.overview')).toBe('Overzicht')
  })

  it('throws on an unknown key rather than rendering the key as UI text', () => {
    expect(() => t('en', 'common:nav.nope')).toThrow(/missing translation/)
  })

  it('surfaces the Dutch financial term even in the English UI', () => {
    // The wording on the broker statement is what the user is cross-checking.
    expect(t('en', 'glossary:tob.term')).toContain('beurstaks')
    expect(t('en', 'glossary:roerendeVoorheffing.term')).toContain('roerende voorheffing')
  })

  it('pluralises by count in both languages', () => {
    expect(t('en', 'common:time.monthCount', { count: 1 })).toBe('1 month')
    expect(t('en', 'common:time.monthCount', { count: 6 })).toBe('6 months')
    expect(t('nl', 'common:time.monthCount', { count: 1 })).toBe('1 maand')
    expect(t('nl', 'common:time.monthCount', { count: 6 })).toBe('6 maanden')
  })
})

describe('finding rendering', () => {
  it('renders a finding with formatted money in both languages', () => {
    const vars = {
      category: 'Groceries',
      delta: formatBp(1800),
      baseline: formatMoney(45_000),
    }
    expect(norm(renderFinding('above_baseline', vars, 'en') ?? '')).toBe(
      'Groceries is 18% above your 12-month norm of € 450,00.',
    )
    expect(norm(renderFinding('above_baseline', vars, 'nl') ?? '')).toBe(
      'Groceries ligt 18% boven je 12-maandsgemiddelde van € 450,00.',
    )
  })

  it('returns null instead of leaking a raw placeholder', () => {
    const partial = { category: 'Groceries', delta: '18%' }
    expect(missingVars('above_baseline', partial)).toEqual(['baseline'])
    expect(renderFinding('above_baseline', partial, 'en')).toBeNull()
  })

  it('has a sentence for every code the model may emit, in every language', () => {
    // The runtime mirror of scripts/check-i18n.ts: a new code without a
    // translation fails here too, not only in CI.
    for (const lang of ['en', 'nl']) {
      for (const code of FINDING_CODES) {
        const vars = Object.fromEntries(FINDING_SPECS[code].vars.map((v) => [v, 'X']))
        const rendered = renderFinding(code, vars, lang)
        expect(rendered, `${code} [${lang}]`).toBeTruthy()
        expect(rendered, `${code} [${lang}]`).not.toContain('{{')
      }
      for (const code of CLARIFICATION_CODES) {
        const vars = Object.fromEntries(CLARIFICATION_SPECS[code].vars.map((v) => [v, 'X']))
        const rendered = renderClarification(code, vars, lang)
        expect(rendered, `${code} [${lang}]`).toBeTruthy()
        expect(rendered, `${code} [${lang}]`).not.toContain('{{')
      }
    }
  })
})

describe('injected formatting settings', () => {
  it('reconfiguring busts the cached Intl formatters', () => {
    // format.ts caches formatters, which bake in the locale they were built
    // with; the SPA sets its settings after the module has already been used.
    const belgian = formatMoney(123_456)
    configureFormatting({ formatLocale: 'en-US' })
    const american = formatMoney(123_456)
    expect(american).not.toBe(belgian)
    expect(norm(american)).toBe('€1,234.56')
    configureFormatting(BELGIAN)
    expect(formatMoney(123_456)).toBe(belgian)
  })
})
