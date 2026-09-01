import { describe, expect, it } from 'vitest'
import {
  addMonths,
  currentMonthIn,
  daysInMonth,
  endOfMonth,
  isDate,
  isMonth,
  monthOf,
  monthProgress,
  monthRange,
  monthsBefore,
  monthsBetween,
  startOfMonth,
  todayIn,
} from '../../src/util/month.ts'

describe('validation', () => {
  it('rejects anything that is not a real YYYY-MM', () => {
    // Total on purpose: a silently shifted month moves an entire baseline window
    // by one, and nothing downstream would notice.
    for (const bad of ['2026-13', '2026-00', '2026-1', '26-01', '2026/01', '']) {
      expect(isMonth(bad), bad).toBe(false)
      expect(() => addMonths(bad, 1), bad).toThrow(/invalid month/)
      expect(() => startOfMonth(bad), bad).toThrow(/invalid month/)
    }
    expect(isMonth('2026-01')).toBe(true)
    expect(isMonth('2026-12')).toBe(true)
  })

  it('rejects an impossible day', () => {
    expect(isDate('2026-02-32')).toBe(false)
    expect(isDate('2026-02-00')).toBe(false)
    expect(() => monthOf('2026-02-32')).toThrow(/invalid date/)
    expect(monthOf('2026-08-17')).toBe('2026-08')
  })
})

describe('month arithmetic', () => {
  it('counts days, including leap years', () => {
    expect(daysInMonth('2026-02')).toBe(28)
    expect(daysInMonth('2024-02')).toBe(29)
    expect(daysInMonth('2026-04')).toBe(30)
    expect(daysInMonth('2026-12')).toBe(31)
    expect(endOfMonth('2024-02')).toBe('2024-02-29')
    expect(endOfMonth('2026-09')).toBe('2026-09-30')
  })

  it('crosses year boundaries in both directions', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(addMonths('2026-12', 1)).toBe('2027-01')
    expect(addMonths('2026-06', -18)).toBe('2024-12')
    expect(addMonths('2026-06', 0)).toBe('2026-06')
  })

  it('measures and enumerates spans inclusively', () => {
    expect(monthsBetween('2026-01', '2026-03')).toBe(2)
    expect(monthsBetween('2026-03', '2026-01')).toBe(-2)
    expect(monthsBetween('2025-11', '2026-02')).toBe(3)
    expect(monthRange('2025-11', '2026-02')).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ])
    expect(monthRange('2026-02', '2026-02')).toEqual(['2026-02'])
    expect(monthRange('2026-02', '2026-01')).toEqual([])
  })

  it('excludes the target month from its own baseline window', () => {
    // The whole point: a norm containing the month being judged flattens exactly
    // the signal we are looking for.
    expect(monthsBefore('2026-03', 3)).toEqual(['2025-12', '2026-01', '2026-02'])
    expect(monthsBefore('2026-03', 1)).toEqual(['2026-02'])
    expect(monthsBefore('2026-03', 0)).toEqual([])
    expect(monthsBefore('2026-03', -1)).toEqual([])
  })
})

describe('wall-clock behaviour', () => {
  // 00:30 UTC on 1 September is 02:30 CEST — already September in Brussels, and
  // still August to anything reasoning in UTC. Every burn-rate projection
  // depends on getting this the local way round.
  const justAfterMidnightCest = new Date('2026-09-01T00:30:00Z')

  it('treats a Brussels-local month change as the month change', () => {
    expect(monthProgress('2026-08', justAfterMidnightCest, 'Europe/Brussels')).toBe(1)

    const progress = monthProgress('2026-09', justAfterMidnightCest, 'Europe/Brussels')
    expect(progress).toBeGreaterThan(0)
    // 2h30 into a 30-day month.
    expect(progress).toBeCloseTo(2.5 / 24 / 30, 6)
  })

  it('clamps past and future months so callers need no special cases', () => {
    expect(monthProgress('2025-01', justAfterMidnightCest, 'Europe/Brussels')).toBe(1)
    expect(monthProgress('2027-01', justAfterMidnightCest, 'Europe/Brussels')).toBe(0)
  })

  it('reaches but never exceeds 1 at the end of a month', () => {
    // 23:59 CEST on 30 September.
    const lastMinute = new Date('2026-09-30T21:59:00Z')
    const progress = monthProgress('2026-09', lastMinute, 'Europe/Brussels')
    expect(progress).toBeLessThanOrEqual(1)
    expect(progress).toBeGreaterThan(0.99)
  })

  it('reads the date in the configured zone, not the host zone', () => {
    // Kiritimati is UTC+14 and Honolulu UTC-10: the same instant is two
    // different dates, which is what makes an implicit host timezone a bug.
    const today = todayIn('Europe/Brussels')
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(isDate(today)).toBe(true)
    expect(currentMonthIn('Europe/Brussels')).toBe(today.slice(0, 7))
    expect(todayIn('Pacific/Kiritimati') >= todayIn('Pacific/Honolulu')).toBe(true)
  })
})
