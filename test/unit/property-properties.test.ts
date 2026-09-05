/**
 * The stored properties/mortgages record (#227). Same load/save contract as
 * `benchmark/household.ts` and `ai/upcoming-note.ts`: reading degrades to the default
 * and never throws, writing validates and throws.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { settings } from '../../src/db/schema.ts'
import {
  DEFAULT_PROPERTIES,
  grossYieldBp,
  loadProperties,
  netCashFlowCents,
  outstandingBalanceCents,
  PROPERTY_KEY,
  propertyEquityCents,
  saveProperties,
  standardMonthlyPaymentCents,
  totalEquityCents,
  type Mortgage,
  type Property,
} from '../../src/domain/property/properties.ts'

const mortgage = (overrides: Partial<Mortgage> = {}): Mortgage => ({
  principalCents: 20_000_000,
  anchorDate: '2026-01-01',
  rateBp: 350,
  monthlyPaymentCents: 90_000,
  remainingTermMonths: 240,
  ...overrides,
})

const property = (overrides: Partial<Property> = {}): Property => ({
  id: 'home',
  kind: 'primary',
  label: 'Home',
  propertyValueCents: 40_000_000,
  rentCents: null,
  mortgage: mortgage(),
  ...overrides,
})

describe('the stored properties', () => {
  let ctx: ReturnType<typeof createTestDb>

  beforeEach(() => {
    ctx = createTestDb()
    applyMigrations(ctx.db as never)
  })

  const write = (valueJson: string): void => {
    ctx.db.insert(settings).values({ key: PROPERTY_KEY, valueJson }).run()
  }

  it('is an empty list until somebody writes one', () => {
    expect(loadProperties(ctx.db)).toEqual(DEFAULT_PROPERTIES)
    expect(DEFAULT_PROPERTIES.properties).toEqual([])
  })

  it('round-trips a full list', () => {
    const next = saveProperties(ctx.db, { properties: [property()] })
    expect(loadProperties(ctx.db)).toEqual(next)
  })

  it('round-trips a rental alongside a primary residence', () => {
    const next = saveProperties(ctx.db, {
      properties: [
        property(),
        property({ id: 'flat', kind: 'rental', label: 'Antwerp flat', rentCents: 90_000, mortgage: null }),
      ],
    })
    expect(loadProperties(ctx.db)).toEqual(next)
  })

  it('degrades to an empty list rather than throwing, for either kind of damage', () => {
    write('{ not json')
    expect(loadProperties(ctx.db)).toEqual(DEFAULT_PROPERTIES)

    ctx.db.delete(settings).run()
    write(JSON.stringify({ properties: [{ id: 'home', kind: 'castle' }] }))
    expect(loadProperties(ctx.db)).toEqual(DEFAULT_PROPERTIES)
  })

  it('refuses an out-of-range rate or term', () => {
    expect(() =>
      saveProperties(ctx.db, { properties: [property({ mortgage: mortgage({ rateBp: 5_001 }) })] }),
    ).toThrow()
    expect(() =>
      saveProperties(ctx.db, {
        properties: [property({ mortgage: mortgage({ remainingTermMonths: 601 }) })],
      }),
    ).toThrow()
  })

  it('refuses an unknown field', () => {
    expect(() =>
      saveProperties(ctx.db, { properties: [{ ...property(), extra: true } as never] }),
    ).toThrow()
  })

  it('refuses more than twenty properties', () => {
    const many = Array.from({ length: 21 }, (_, index) => property({ id: `p${index}` }))
    expect(() => saveProperties(ctx.db, { properties: many })).toThrow()
  })
})

describe('outstandingBalanceCents', () => {
  it('is zero with no mortgage at all', () => {
    expect(outstandingBalanceCents(null, '2026-06-01')).toBe(0)
  })

  it('pays down linearly at a zero rate', () => {
    const m = mortgage({
      anchorDate: '2026-01-01',
      principalCents: 120_000,
      rateBp: 0,
      monthlyPaymentCents: 10_000,
      remainingTermMonths: 12,
    })
    expect(outstandingBalanceCents(m, '2026-01-01')).toBe(120_000)
    expect(outstandingBalanceCents(m, '2026-04-01')).toBe(90_000)
    expect(outstandingBalanceCents(m, '2027-01-01')).toBe(0)
  })

  it('accrues interest before the payment each month', () => {
    // 1200bp = 1%/month exactly, so the arithmetic is easy to hand-check.
    const m = mortgage({
      anchorDate: '2026-01-01',
      principalCents: 100_000,
      rateBp: 1_200,
      monthlyPaymentCents: 5_000,
      remainingTermMonths: 12,
    })
    // month 1: 100_000 * 1.01 - 5_000 = 96_000
    expect(outstandingBalanceCents(m, '2026-02-01')).toBe(96_000)
    // month 2: 96_000 * 1.01 - 5_000 = 91_960
    expect(outstandingBalanceCents(m, '2026-03-01')).toBe(91_960)
  })

  it('floors at zero and stops once the term is exhausted', () => {
    const m = mortgage({
      anchorDate: '2026-01-01',
      principalCents: 10_000,
      rateBp: 0,
      monthlyPaymentCents: 10_000,
      remainingTermMonths: 1,
    })
    expect(outstandingBalanceCents(m, '2026-02-01')).toBe(0)
    expect(outstandingBalanceCents(m, '2030-01-01')).toBe(0)
  })
})

describe('standardMonthlyPaymentCents', () => {
  it('divides evenly at a zero rate', () => {
    expect(standardMonthlyPaymentCents(120_000, 0, 12)).toBe(10_000)
  })

  it('matches the standard annuity formula at a nonzero rate', () => {
    // 300 000,00 EUR at 3% APR over 240 months, cross-checked against the closed-form
    // annuity formula computed independently.
    expect(standardMonthlyPaymentCents(30_000_000, 300, 240)).toBe(166_379)
  })

  it('is zero over no term', () => {
    expect(standardMonthlyPaymentCents(100_000, 300, 0)).toBe(0)
  })
})

describe('propertyEquityCents', () => {
  it('is null when the property value is not tracked', () => {
    const p = property({ propertyValueCents: null, mortgage: mortgage({ anchorDate: '2026-01-01', principalCents: 10_000 }) })
    expect(propertyEquityCents(p, '2026-01-01')).toBeNull()
  })

  it('is value minus the outstanding balance', () => {
    const p = property({
      propertyValueCents: 100_000,
      mortgage: mortgage({
        anchorDate: '2026-01-01',
        principalCents: 40_000,
        rateBp: 0,
        monthlyPaymentCents: 0,
        remainingTermMonths: 12,
      }),
    })
    expect(propertyEquityCents(p, '2026-01-01')).toBe(60_000)
  })

  it('is the full value when there is no mortgage', () => {
    const p = property({ propertyValueCents: 100_000, mortgage: null })
    expect(propertyEquityCents(p, '2026-01-01')).toBe(100_000)
  })
})

describe('netCashFlowCents', () => {
  it('is null when the rent is not tracked', () => {
    expect(netCashFlowCents(property({ rentCents: null }))).toBeNull()
  })

  it('is rent minus the mortgage payment', () => {
    const p = property({ rentCents: 100_000, mortgage: mortgage({ monthlyPaymentCents: 90_000 }) })
    expect(netCashFlowCents(p)).toBe(10_000)
  })

  it('is the whole rent when there is no mortgage', () => {
    expect(netCashFlowCents(property({ rentCents: 100_000, mortgage: null }))).toBe(100_000)
  })
})

describe('grossYieldBp', () => {
  it('is null unless both rent and value are tracked', () => {
    expect(grossYieldBp(property({ rentCents: null, propertyValueCents: 100_000 }))).toBeNull()
    expect(grossYieldBp(property({ rentCents: 1_000, propertyValueCents: null }))).toBeNull()
  })

  it('annualizes rent over value', () => {
    // 1 000/month on a 200 000 property = 12 000/200 000 = 6.00% = 600bp.
    const p = property({ rentCents: 1_000, propertyValueCents: 200_000 })
    expect(grossYieldBp(p)).toBe(600)
  })
})

describe('totalEquityCents', () => {
  it('is null when nothing in the list tracks a value', () => {
    expect(totalEquityCents([property({ propertyValueCents: null })], '2026-01-01')).toBeNull()
  })

  it('sums equity across properties, skipping ones with no tracked value', () => {
    const tracked = property({
      propertyValueCents: 100_000,
      mortgage: mortgage({
        anchorDate: '2026-01-01',
        principalCents: 40_000,
        rateBp: 0,
        monthlyPaymentCents: 0,
        remainingTermMonths: 12,
      }),
    })
    const untracked = property({ id: 'other', propertyValueCents: null, mortgage: null })
    expect(totalEquityCents([tracked, untracked], '2026-01-01')).toBe(60_000)
  })
})
