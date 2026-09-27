/**
 * `resolveYearAnchor` (#702) — the "Year" toggle in `PeriodPicker` never exercised
 * either documented fallback: the fixtures every integration test uses already have
 * the requested year's latest month sitting first in `storedMonths`, which is the one
 * branch that needs no fallback at all.
 */
import { describe, expect, it } from 'vitest'
import { resolveYearAnchor } from '../../src/server/routes/api/period.ts'

describe('resolveYearAnchor', () => {
  it('picks the latest stored month within the requested year', () => {
    // Newest-first, as `loadHistory`/`freshness` always hand it over.
    const months = ['2026-08', '2026-03', '2026-01', '2025-12', '2025-06']
    expect(resolveYearAnchor(months, '2026')).toBe('2026-08')
    expect(resolveYearAnchor(months, '2025')).toBe('2025-12')
  })

  it('falls back to December when the year has nothing stored at all', () => {
    const months = ['2026-08', '2025-12']
    expect(resolveYearAnchor(months, '2024')).toBe('2024-12')
  })

  it('falls back to December for an empty history', () => {
    expect(resolveYearAnchor([], '2026')).toBe('2026-12')
  })

  it('does not let a sparse year borrow a month from a neighbouring one', () => {
    // Only 2026-01 exists; 2025 must resolve to its own fallback, not spill over.
    expect(resolveYearAnchor(['2026-01'], '2025')).toBe('2025-12')
  })
})
