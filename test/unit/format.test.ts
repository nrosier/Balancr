import { norm } from '../helpers/text.ts'
import { describe, expect, it } from 'vitest'
import {
  firstDayOfWeek,
  formatBp,
  formatDate,
  formatList,
  formatMonth,
  formatMonthShort,
  formatMoney,
  formatMoneyCompact,
  parseMoneyToCents,
} from '../../src/i18n/format.ts'


describe('money formatting is Belgian in every UI language', () => {
  it('renders comma decimals and dot thousands', () => {
    expect(norm(formatMoney(123_456))).toBe('€ 1.234,56')
    expect(norm(formatMoney(-123_456))).toBe('€ -1.234,56')
    expect(norm(formatMoney(0))).toBe('€ 0,00')
  })

  it('takes no language argument at all', () => {
    // The regression this guards: deriving money format from the UI language.
    // Intl with `en-BE` yields "€1,234.56" — English conventions — which would
    // stop matching the user's bank statements the moment they picked English.
    expect(formatMoney.length).toBeLessThanOrEqual(2)
    const enBe = new Intl.NumberFormat('en-BE', {
      style: 'currency',
      currency: 'EUR',
    }).format(1234.56)
    expect(norm(enBe)).toBe('€1,234.56')
    expect(norm(formatMoney(123_456))).not.toBe(norm(enBe))
  })

  it('renders a foreign currency in Belgian conventions, symbol and all', () => {
    // A holding's quote is in the instrument's own currency while its value is
    // already converted, so one row can carry two. The separators stay Belgian —
    // the currency changes, the formatting locale does not.
    expect(norm(formatMoney(123_456, { currency: 'USD' }))).toBe('US$ 1.234,56')
    expect(norm(formatMoney(123_456, { currency: 'GBP' }))).toBe('£ 1.234,56')
    // A code with no symbol prints as the code, which is still unambiguous.
    expect(norm(formatMoney(123_456, { currency: 'SEK' }))).toBe('SEK 1.234,56')
  })

  it('does not let the first currency rendered stick to every later one', () => {
    // The regression: `Intl` formatters are cached and bake in the currency they
    // were built with, so a cache key that omits it would render every row after the
    // first with the first row's symbol — the same figure, silently mislabelled.
    expect(norm(formatMoney(100_000, { currency: 'USD' }))).toBe('US$ 1.000,00')
    expect(norm(formatMoney(100_000))).toBe('€ 1.000,00')
    expect(norm(formatMoney(100_000, { currency: 'USD' }))).toBe('US$ 1.000,00')
    expect(norm(formatMoney(100_000, { currency: 'EUR' }))).toBe('€ 1.000,00')
  })

  it('ignores the currency when the amount is bare, since there is no symbol', () => {
    expect(norm(formatMoney(123_456, { bare: true, currency: 'USD' }))).toBe('1.234,56')
  })

  it('supports bare, whole and signed variants for chart labels and deltas', () => {
    expect(norm(formatMoney(123_456, { bare: true }))).toBe('1.234,56')
    expect(norm(formatMoney(123_456, { whole: true }))).toBe('€ 1.235')
    expect(norm(formatMoney(123_456, { signed: true }))).toBe('+€ 1.234,56')
    expect(norm(formatMoney(-123_456, { signed: true }))).toBe('€ -1.234,56')
  })

  it('compacts large values', () => {
    // nl-BE compact uses "K" for thousands but "mln." for millions, which is
    // visually inconsistent — prefer formatMoney({whole:true}) on chart axes.
    expect(norm(formatMoneyCompact(123_456_700))).toBe('€ 1,2 mln.')
    expect(norm(formatMoneyCompact(1_234_500))).toBe('€ 12,3K')
  })
})

describe('parseMoneyToCents accepts what a Belgian user actually types', () => {
  it('parses Belgian notation', () => {
    expect(parseMoneyToCents('1.234,56')).toBe(123_456)
    expect(parseMoneyToCents('1,50')).toBe(150)
    expect(parseMoneyToCents('1.234')).toBe(123_400) // dot is thousands here
  })

  it('parses plain and English notation', () => {
    expect(parseMoneyToCents('1234.56')).toBe(123_456)
    expect(parseMoneyToCents('1234')).toBe(123_400)
  })

  it('handles currency symbols, spaces and negatives', () => {
    expect(parseMoneyToCents('€ 1.234,56')).toBe(123_456)
    expect(parseMoneyToCents('-1.234,56')).toBe(-123_456)
    expect(parseMoneyToCents('(1.234,56)')).toBe(-123_456)
  })

  it('never silently returns 0 on junk — the parseFloat trap', () => {
    // parseFloat('1.234,56') === 1.234 -> 123 cents instead of 123456.
    expect(Number.parseFloat('1.234,56')).toBe(1.234)
    expect(parseMoneyToCents('1.234,56')).toBe(123_456)

    expect(parseMoneyToCents('abc')).toBeNull()
    expect(parseMoneyToCents('')).toBeNull()
    expect(parseMoneyToCents('12,3456')).toBeNull()
  })

  it('round-trips through formatMoney', () => {
    for (const cents of [0, 1, 99, 100, 123_456, -123_456, 999_999_99]) {
      expect(parseMoneyToCents(formatMoney(cents))).toBe(cents)
    }
  })
})

describe('names follow the UI language, patterns do not', () => {
  it('translates month names', () => {
    expect(formatMonth('2026-03', 'en')).toBe('March 2026')
    expect(formatMonth('2026-03', 'nl')).toBe('maart 2026')
  })

  it('translates short month names for dense axes', () => {
    expect(formatMonthShort('2026-03', 'en')).toMatch(/^Mar/)
    expect(formatMonthShort('2026-03', 'nl')).toMatch(/^mrt/)
  })

  it('formats dates as dd/MM/yyyy with a four-digit year', () => {
    // `dateStyle: 'short'` gives a 2-digit year under en-BE; explicit parts do not.
    expect(formatDate('2026-03-09')).toBe('09/03/2026')
    expect(formatDate('2026-12-31')).toBe('31/12/2026')
  })

  it('starts the week on Monday in both languages', () => {
    expect(firstDayOfWeek('en')).toBe(1)
    expect(firstDayOfWeek('nl')).toBe(1)
  })

  it('rejects invalid dates rather than rendering Invalid Date', () => {
    expect(() => formatDate('not-a-date')).toThrow(/invalid date/)
  })
})

describe('formatList joins in the interface language', () => {
  it('uses the conjunction of the language, not of the format locale', () => {
    // The one place the language beats FORMAT_LOCALE. Numbers and dates stay Belgian
    // because they are checked against Belgian documents; "and" is a word in a
    // sentence, and an English sentence joined with "en" is simply broken.
    expect(formatList(['a', 'b', 'c'], 'en')).toBe('a, b and c')
    expect(formatList(['a', 'b', 'c'], 'nl')).toBe('a, b en c')
  })

  it('reads naturally at one and two items', () => {
    expect(formatList(['a'], 'en')).toBe('a')
    expect(formatList(['a', 'b'], 'en')).toBe('a and b')
    expect(formatList(['a', 'b'], 'nl')).toBe('a en b')
  })

  it('makes nothing out of nothing', () => {
    expect(formatList([], 'en')).toBe('')
  })
})

describe('basis points', () => {
  it('renders as percent', () => {
    expect(norm(formatBp(1800))).toBe('18%')
    expect(norm(formatBp(1850))).toBe('18,5%')
    expect(norm(formatBp(1800, { signed: true }))).toBe('+18%')
    expect(norm(formatBp(-1800))).toBe('-18%')
  })
})
