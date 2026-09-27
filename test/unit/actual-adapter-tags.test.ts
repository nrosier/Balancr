/**
 * `tagRegexPattern` reproduces Actual's own `hasTags`/`hasAnyTag` escaping (#663) — see
 * its doc comment in `queries.ts` for why the leading `#` has to be added back before
 * escaping. `fetchTagMonthlyTotals`'s transfer-boundary handling reuses
 * `offBudgetTransferLegIds`/`transferFilter` unchanged, already covered in
 * `actual-transfer-reconciliation.test.ts`, so it isn't repeated here.
 */
import { describe, expect, it } from 'vitest'
import { tagRegexPattern } from '../../src/adapters/actual/queries.ts'

describe('tagRegexPattern', () => {
  it('escapes regex-special characters exactly like Actual does', () => {
    expect(tagRegexPattern('lunch')).toBe('(?<!#)#lunch([\\s#]|$)')
    expect(tagRegexPattern('a.b')).toBe('(?<!#)#a\\.b([\\s#]|$)')
    expect(tagRegexPattern('a+b')).toBe('(?<!#)#a\\+b([\\s#]|$)')
    expect(tagRegexPattern('cost$')).toBe('(?<!#)#cost[$]([\\s#]|$)')
    expect(tagRegexPattern('(x)')).toBe('(?<!#)#\\(x\\)([\\s#]|$)')
    expect(tagRegexPattern('rental')).toBe('(?<!#)#rental([\\s#]|$)')
  })

  it('matches a tag written as Actual writes it, bounded by whitespace or another tag', () => {
    const re = new RegExp(tagRegexPattern('rental'))
    expect(re.test('#rental payment')).toBe(true)
    expect(re.test('note #rental')).toBe(true)
    expect(re.test('#maintenance #rental')).toBe(true)
    expect(re.test('#rental')).toBe(true)
  })

  it('does not match a longer tag that merely starts with the same word', () => {
    const re = new RegExp(tagRegexPattern('rental'))
    expect(re.test('#rental2')).toBe(false)
    expect(re.test('text #rentalcar')).toBe(false)
  })

  it('does not match notes with no tag at all', () => {
    expect(new RegExp(tagRegexPattern('rental')).test('no tag here')).toBe(false)
  })

  it('respects Actual\'s doubled-# escape convention for a literal, non-tag "#word"', () => {
    expect(new RegExp(tagRegexPattern('rental')).test('##rental')).toBe(false)
  })
})
