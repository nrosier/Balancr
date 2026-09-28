/**
 * `tagRegexPattern` reproduces Actual's own `hasTags`/`hasAnyTag` escaping (#663) — see
 * its doc comment in `queries.ts` for why the leading `#` has to be added back before
 * escaping. `fetchTagMonthlyTotals`'s transfer-boundary handling reuses
 * `boundaryCrossingTransferLegIds`/`transferFilter` unchanged, already covered in
 * `actual-transfer-reconciliation.test.ts` (#690), so it isn't repeated here.
 *
 * `fetchTagMonthlyTotals`'s own bulk-fetch-then-bucket shape (#691) is covered below,
 * against a mocked `withActual` the same way `actual-schedules.test.ts` mocks
 * `withActualBatch` — the point being tested is the JS-side bucketing, not IPC.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../../src/db/index.ts'

const withActualMock = vi.fn<(...args: unknown[]) => Promise<unknown>>()

vi.mock('../../src/adapters/actual/client.ts', () => ({
  withActual: (...args: unknown[]) => withActualMock(...args),
  withActualBatch: vi.fn(),
}))

const { fetchTagMonthlyTotals, tagRegexPattern } = await import('../../src/adapters/actual/queries.ts')

const DB_STUB = {} as Db
const TENANT_ID = 'tenant-tags'

/** No transfers crossing the boundary in range — the common case, one query fewer. */
const NO_CROSSING_TRANSFERS = { data: [] }

beforeEach(() => {
  withActualMock.mockReset()
})

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

describe('fetchTagMonthlyTotals (#691)', () => {
  it('issues exactly one query for the transactions regardless of tag count', async () => {
    withActualMock.mockResolvedValueOnce(NO_CROSSING_TRANSFERS).mockResolvedValueOnce({ data: [] })

    await fetchTagMonthlyTotals(DB_STUB, TENANT_ID, ['rental', 'maintenance', 'car'], '2026-01', '2026-12')

    // Once for the transfer-boundary lookup, once for the bulk notes fetch — never
    // once per tag, which is the whole point of the fix.
    expect(withActualMock).toHaveBeenCalledTimes(2)
  })

  it('returns nothing, and queries nothing, when no tags are registered', async () => {
    expect(await fetchTagMonthlyTotals(DB_STUB, TENANT_ID, [], '2026-01', '2026-12')).toEqual([])
    expect(withActualMock).not.toHaveBeenCalled()
  })

  it('buckets one fetched transaction into every tag its note matches, by month', async () => {
    withActualMock.mockResolvedValueOnce(NO_CROSSING_TRANSFERS).mockResolvedValueOnce({
      data: [
        { id: 't1', date: '2026-03-14', notes: '#rental payment', amount: -80_000, transferId: null, offBudget: false },
        {
          id: 't2',
          date: '2026-03-20',
          notes: '#maintenance #rental boiler',
          amount: -12_000,
          transferId: null,
          offBudget: false,
        },
        { id: 't3', date: '2026-04-02', notes: '#rental payment', amount: -80_000, transferId: null, offBudget: false },
        { id: 't4', date: '2026-04-05', notes: 'no tag here', amount: -5_000, transferId: null, offBudget: false },
      ],
    })

    const totals = await fetchTagMonthlyTotals(DB_STUB, TENANT_ID, ['rental', 'maintenance'], '2026-01', '2026-12')

    expect(totals).toEqual(
      expect.arrayContaining([
        { tag: 'rental', month: '2026-03', netCents: -92_000, txnCount: 2 },
        { tag: 'maintenance', month: '2026-03', netCents: -12_000, txnCount: 1 },
        { tag: 'rental', month: '2026-04', netCents: -80_000, txnCount: 1 },
      ]),
    )
    expect(totals).toHaveLength(3)
  })

  it('ignores a null-amount transaction as zero, same as the old per-tag $sum did', async () => {
    withActualMock.mockResolvedValueOnce(NO_CROSSING_TRANSFERS).mockResolvedValueOnce({
      data: [{ id: 't1', date: '2026-05-01', notes: '#rental', amount: null, transferId: null, offBudget: false }],
    })

    const totals = await fetchTagMonthlyTotals(DB_STUB, TENANT_ID, ['rental'], '2026-01', '2026-12')

    expect(totals).toEqual([{ tag: 'rental', month: '2026-05', netCents: 0, txnCount: 1 }])
  })

  it('counts a tagged boundary-crossing transfer once, at the on-budget leg\'s sign (#744)', async () => {
    // Actual's own `addTransfer` copies `notes` to the counterpart leg verbatim, so a
    // freshly tagged mortgage payment carries "#rental" on both the on-budget leg that
    // pays it and the off-budget loan leg that receives it. Summing both nets to zero.
    withActualMock.mockResolvedValueOnce(NO_CROSSING_TRANSFERS).mockResolvedValueOnce({
      data: [
        { id: 'onbudget', date: '2026-03-10', notes: '#rental', amount: -80_000, transferId: 'offbudget', offBudget: false },
        { id: 'offbudget', date: '2026-03-10', notes: '#rental', amount: 80_000, transferId: 'onbudget', offBudget: true },
      ],
    })

    const totals = await fetchTagMonthlyTotals(DB_STUB, TENANT_ID, ['rental'], '2026-01', '2026-12')

    expect(totals).toEqual([{ tag: 'rental', month: '2026-03', netCents: -80_000, txnCount: 1 }])
  })

  it('uses whichever leg of a crossing transfer actually carries the tag when only one does', async () => {
    withActualMock.mockResolvedValueOnce(NO_CROSSING_TRANSFERS).mockResolvedValueOnce({
      data: [
        { id: 'onbudget', date: '2026-03-10', notes: 'mortgage payment', amount: -80_000, transferId: 'offbudget', offBudget: false },
        { id: 'offbudget', date: '2026-03-10', notes: '#rental', amount: 80_000, transferId: 'onbudget', offBudget: true },
      ],
    })

    const totals = await fetchTagMonthlyTotals(DB_STUB, TENANT_ID, ['rental'], '2026-01', '2026-12')

    expect(totals).toEqual([{ tag: 'rental', month: '2026-03', netCents: 80_000, txnCount: 1 }])
  })

  it('does not treat a transfer between two on-budget accounts as a crossing pair', async () => {
    // Same `offBudget` on both legs — an ordinary internal transfer, not the boundary
    // crossing #744 is about. Each leg is independent, so a note on just one still counts.
    withActualMock.mockResolvedValueOnce(NO_CROSSING_TRANSFERS).mockResolvedValueOnce({
      data: [
        { id: 'a', date: '2026-03-10', notes: '#rental', amount: -5_000, transferId: 'b', offBudget: false },
        { id: 'b', date: '2026-03-10', notes: null, amount: 5_000, transferId: 'a', offBudget: false },
      ],
    })

    const totals = await fetchTagMonthlyTotals(DB_STUB, TENANT_ID, ['rental'], '2026-01', '2026-12')

    expect(totals).toEqual([{ tag: 'rental', month: '2026-03', netCents: -5_000, txnCount: 1 }])
  })
})
