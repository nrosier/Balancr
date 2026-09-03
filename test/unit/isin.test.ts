/**
 * ISIN validation (#40).
 *
 * The check digit is the only field in a hand-typed fund universe that can be verified
 * without a network, so these are the vectors that decide whether a mistyped
 * instrument is caught at load time or discovered by an order.
 *
 * Real ISINs, deliberately: a fabricated string with a hand-computed check digit tests
 * the arithmetic against itself, while `US0378331005` and `IE00B4L5Y983` test it
 * against the world. The mutations below are the mistakes people actually make —
 * a transposed pair, one wrong character, a dropped one.
 */
import { describe, expect, it } from 'vitest'
import { isValidIsin, isinCheckDigit, isinProblem, normaliseIsin } from '../../src/domain/universe/isin.ts'

/** Known-good ISINs from four issuers and two country prefixes. */
const REAL = [
  'US0378331005', // Apple
  'IE00B4L5Y983', // iShares Core MSCI World (Acc)
  'IE00B5BMR087', // iShares Core S&P 500 (Acc)
  'IE00BK5BQT80', // Vanguard FTSE All-World (Acc)
  'IE00BKM4GZ66', // iShares Core MSCI EM IMI (Acc)
  'LU0290358497', // Xtrackers EUR Overnight Rate Swap
  'LU0908500753', // Amundi Stoxx Europe 600 Acc
]

describe('isValidIsin', () => {
  it.each(REAL)('accepts %s', (isin) => {
    expect(isValidIsin(isin)).toBe(true)
  })

  it('accepts the spellings a factsheet and a spreadsheet produce', () => {
    // Both are the same instrument, and a universe that treats them as different keys
    // would silently hold one fund twice.
    expect(isValidIsin('ie00b4l5y983')).toBe(true)
    expect(isValidIsin('IE00 B4L5 Y983')).toBe(true)
    expect(isValidIsin(' IE00-B4L5-Y983 ')).toBe(true)
  })

  it('rejects a transposed pair', () => {
    // The mistake the check digit exists for: every transposition of two unequal
    // adjacent digits changes the Luhn sum.
    expect(isValidIsin('IE00B4L5Y938')).toBe(false)
  })

  it('rejects one wrong character', () => {
    expect(isValidIsin('IE00B4L5Y984')).toBe(false)
    expect(isValidIsin('IE00B4L5X983')).toBe(false)
  })

  it('rejects the wrong length', () => {
    expect(isValidIsin('IE00B4L5Y98')).toBe(false)
    expect(isValidIsin('IE00B4L5Y9833')).toBe(false)
    expect(isValidIsin('')).toBe(false)
  })

  it('rejects a shape that is not two letters, nine alphanumerics and a digit', () => {
    // A ticker is not an ISIN, and neither is a CUSIP with a letter check character.
    expect(isValidIsin('IWDA')).toBe(false)
    expect(isValidIsin('0E00B4L5Y983')).toBe(false)
    expect(isValidIsin('IE00B4L5Y98X')).toBe(false)
  })
})

describe('isinCheckDigit', () => {
  it('computes the published digit', () => {
    expect(isinCheckDigit('US037833100')).toBe(5)
    expect(isinCheckDigit('IE00B4L5Y98')).toBe(3)
    expect(isinCheckDigit('LU029035849')).toBe(7)
  })

  it('returns null rather than a digit for something that is not eleven characters', () => {
    // A caller must not be able to read "unparseable" as "check digit zero".
    expect(isinCheckDigit('IE00B4L5Y9')).toBeNull()
    expect(isinCheckDigit('IE00B4L5Y983')).toBeNull()
    expect(isinCheckDigit('ie00b4l5y98')).toBeNull()
  })
})

describe('normaliseIsin', () => {
  it('uppercases and strips the separators people paste', () => {
    expect(normaliseIsin(' ie00 b4l5-y983 ')).toBe('IE00B4L5Y983')
  })

  it('returns null when nothing is left', () => {
    expect(normaliseIsin('   ')).toBeNull()
    expect(normaliseIsin('--')).toBeNull()
  })
})

describe('isinProblem', () => {
  it('says which mistake it was, because the fix differs', () => {
    expect(isinProblem('IE00B4L5Y98')).toBe('is 11 characters, not 12')
    expect(isinProblem('IE00B4L5Y984')).toContain('check digit is 3')
    expect(isinProblem('IE00B4L5Y98X')).toBe('is not two letters, nine alphanumerics and a digit')
    expect(isinProblem('  ')).toBe('is empty')
  })

  it('says nothing about a valid one', () => {
    expect(isinProblem('IE00B4L5Y983')).toBeNull()
  })
})
