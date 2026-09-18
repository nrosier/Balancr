/**
 * The stored properties/mortgages record (#227). Same load/save contract as
 * `benchmark/household.ts` and `ai/upcoming-note.ts`: reading degrades to the default
 * and never throws, writing validates and throws.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { settings } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import {
  DEFAULT_PROPERTIES,
  earliestAnchorDate,
  grossYieldBp,
  loadProperties,
  MAX_MORTGAGES_PER_PROPERTY,
  netCashFlowCents,
  outstandingBalanceCents,
  paidOffBp,
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
  originalPrincipalCents: null,
  ...overrides,
})

const property = (overrides: Partial<Property> = {}): Property => ({
  id: 'home',
  kind: 'primary',
  label: 'Home',
  propertyValueCents: 40_000_000,
  rentCents: null,
  mortgages: [mortgage()],
  ...overrides,
})

describe('the stored properties', () => {
  let ctx: ReturnType<typeof createTestDb>
  let TENANT_ID: string

  beforeEach(() => {
    ctx = createTestDb()
    applyMigrations(ctx.db as never)
    TENANT_ID = getSoleTenantId(ctx.db)
  })

  const write = (valueJson: string): void => {
    ctx.db.insert(settings).values({ tenantId: TENANT_ID, key: PROPERTY_KEY, valueJson }).run()
  }

  it('is an empty list until somebody writes one', () => {
    expect(loadProperties(ctx.db, TENANT_ID)).toEqual(DEFAULT_PROPERTIES)
    expect(DEFAULT_PROPERTIES.properties).toEqual([])
  })

  it('round-trips a full list', () => {
    const next = saveProperties(ctx.db, TENANT_ID, { properties: [property()] })
    expect(loadProperties(ctx.db, TENANT_ID)).toEqual(next)
  })

  it('round-trips a rental alongside a primary residence', () => {
    const next = saveProperties(ctx.db, TENANT_ID, {
      properties: [
        property(),
        property({ id: 'flat', kind: 'rental', label: 'Antwerp flat', rentCents: 90_000, mortgages: [] }),
      ],
    })
    expect(loadProperties(ctx.db, TENANT_ID)).toEqual(next)
  })

  it('round-trips an owned property that is neither primary nor rental', () => {
    const next = saveProperties(ctx.db, TENANT_ID, {
      properties: [
        property({ id: 'cottage', kind: 'owned', label: 'Family cottage', mortgages: [] }),
      ],
    })
    expect(loadProperties(ctx.db, TENANT_ID)).toEqual(next)
  })

  it('round-trips a property with more than one mortgage (#393)', () => {
    const next = saveProperties(ctx.db, TENANT_ID, {
      properties: [
        property({
          mortgages: [mortgage(), mortgage({ anchorDate: '2026-02-01', principalCents: 5_000_000 })],
        }),
      ],
    })
    expect(loadProperties(ctx.db, TENANT_ID)).toEqual(next)
    expect(loadProperties(ctx.db, TENANT_ID).properties[0]?.mortgages).toHaveLength(2)
  })

  it('degrades to an empty list rather than throwing, for either kind of damage', () => {
    write('{ not json')
    expect(loadProperties(ctx.db, TENANT_ID)).toEqual(DEFAULT_PROPERTIES)

    ctx.db.delete(settings).run()
    write(JSON.stringify({ properties: [{ id: 'home', kind: 'castle' }] }))
    expect(loadProperties(ctx.db, TENANT_ID)).toEqual(DEFAULT_PROPERTIES)
  })

  it('refuses an out-of-range rate or term', () => {
    expect(() =>
      saveProperties(ctx.db, TENANT_ID, { properties: [property({ mortgages: [mortgage({ rateBp: 5_001 })] })] }),
    ).toThrow()
    expect(() =>
      saveProperties(ctx.db, TENANT_ID, {
        properties: [property({ mortgages: [mortgage({ remainingTermMonths: 601 })] })],
      }),
    ).toThrow()
  })

  it('refuses an unknown field', () => {
    expect(() =>
      saveProperties(ctx.db, TENANT_ID, { properties: [{ ...property(), extra: true } as never] }),
    ).toThrow()
  })

  it('refuses more than twenty properties', () => {
    const many = Array.from({ length: 21 }, (_, index) => property({ id: `p${index}` }))
    expect(() => saveProperties(ctx.db, TENANT_ID, { properties: many })).toThrow()
  })

  it('refuses more than three mortgages on one property (#393)', () => {
    const tooMany = Array.from({ length: MAX_MORTGAGES_PER_PROPERTY + 1 }, () => mortgage())
    expect(() =>
      saveProperties(ctx.db, TENANT_ID, { properties: [property({ mortgages: tooMany })] }),
    ).toThrow()
  })

  it('migrates a property stored before mortgages became a list (#393)', () => {
    write(
      JSON.stringify({
        properties: [
          { id: 'home', kind: 'primary', label: 'Home', propertyValueCents: 40_000_000, rentCents: null, mortgage: mortgage() },
          { id: 'cottage', kind: 'owned', label: 'Cottage', propertyValueCents: 10_000_000, rentCents: null, mortgage: null },
        ],
      }),
    )
    const loaded = loadProperties(ctx.db, TENANT_ID)
    expect(loaded.properties[0]?.mortgages).toEqual([mortgage()])
    expect(loaded.properties[1]?.mortgages).toEqual([])
  })
})

describe('outstandingBalanceCents', () => {
  it('is zero with no mortgage at all', () => {
    expect(outstandingBalanceCents([], '2026-06-01')).toBe(0)
  })

  it('pays down linearly at a zero rate', () => {
    const m = mortgage({
      anchorDate: '2026-01-01',
      principalCents: 120_000,
      rateBp: 0,
      monthlyPaymentCents: 10_000,
      remainingTermMonths: 12,
    })
    expect(outstandingBalanceCents([m], '2026-01-01')).toBe(120_000)
    expect(outstandingBalanceCents([m], '2026-04-01')).toBe(90_000)
    expect(outstandingBalanceCents([m], '2027-01-01')).toBe(0)
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
    expect(outstandingBalanceCents([m], '2026-02-01')).toBe(96_000)
    // month 2: 96_000 * 1.01 - 5_000 = 91_960
    expect(outstandingBalanceCents([m], '2026-03-01')).toBe(91_960)
  })

  it('floors at zero and stops once the term is exhausted', () => {
    const m = mortgage({
      anchorDate: '2026-01-01',
      principalCents: 10_000,
      rateBp: 0,
      monthlyPaymentCents: 10_000,
      remainingTermMonths: 1,
    })
    expect(outstandingBalanceCents([m], '2026-02-01')).toBe(0)
    expect(outstandingBalanceCents([m], '2030-01-01')).toBe(0)
  })

  it('sums the balance across more than one mortgage (#393)', () => {
    const first = mortgage({
      anchorDate: '2026-01-01',
      principalCents: 120_000,
      rateBp: 0,
      monthlyPaymentCents: 10_000,
      remainingTermMonths: 12,
    })
    const second = mortgage({
      anchorDate: '2026-01-01',
      principalCents: 60_000,
      rateBp: 0,
      monthlyPaymentCents: 5_000,
      remainingTermMonths: 12,
    })
    // 90_000 (first, after 3 months) + 45_000 (second, after 3 months) = 135_000.
    expect(outstandingBalanceCents([first, second], '2026-04-01')).toBe(135_000)
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

describe('paidOffBp (#392, #393)', () => {
  it('is null with no mortgage at all', () => {
    expect(paidOffBp([], '2026-06-01')).toBeNull()
  })

  it('is null when the original amount was never entered', () => {
    const m = mortgage({ originalPrincipalCents: null })
    expect(paidOffBp([m], '2026-01-01')).toBeNull()
  })

  it('is null when the original amount is zero', () => {
    const m = mortgage({ originalPrincipalCents: 0 })
    expect(paidOffBp([m], '2026-01-01')).toBeNull()
  })

  it('is the share of the original amount no longer owed', () => {
    const m = mortgage({
      anchorDate: '2026-01-01',
      principalCents: 120_000,
      originalPrincipalCents: 240_000,
      rateBp: 0,
      monthlyPaymentCents: 10_000,
      remainingTermMonths: 12,
    })
    // At the anchor: 120 000 / 240 000 owed => half paid off already.
    expect(paidOffBp([m], '2026-01-01')).toBe(5_000)
    // Three months on, at 10 000/month with no interest: 90 000 owed of 240 000.
    expect(paidOffBp([m], '2026-04-01')).toBe(6_250)
  })

  it('is null when only some of several mortgages have an original amount on file', () => {
    const withOriginal = mortgage({ originalPrincipalCents: 240_000 })
    const withoutOriginal = mortgage({ originalPrincipalCents: null })
    expect(paidOffBp([withOriginal, withoutOriginal], '2026-01-01')).toBeNull()
  })

  it('combines outstanding and original across every mortgage once all have one', () => {
    const first = mortgage({
      anchorDate: '2026-01-01',
      principalCents: 120_000,
      originalPrincipalCents: 240_000,
      rateBp: 0,
      monthlyPaymentCents: 0,
      remainingTermMonths: 12,
    })
    const second = mortgage({
      anchorDate: '2026-01-01',
      principalCents: 60_000,
      originalPrincipalCents: 60_000,
      rateBp: 0,
      monthlyPaymentCents: 0,
      remainingTermMonths: 12,
    })
    // (120_000 + 60_000) owed of (240_000 + 60_000) original => 60% owed, 40% paid off.
    expect(paidOffBp([first, second], '2026-01-01')).toBe(4_000)
  })
})

describe('earliestAnchorDate (#393)', () => {
  it('is null with no mortgage at all', () => {
    expect(earliestAnchorDate([])).toBeNull()
  })

  it('is the one anchor date with a single mortgage', () => {
    expect(earliestAnchorDate([mortgage({ anchorDate: '2026-03-01' })])).toBe('2026-03-01')
  })

  it('picks the earliest across several mortgages, regardless of order', () => {
    const dates = [
      mortgage({ anchorDate: '2026-03-01' }),
      mortgage({ anchorDate: '2026-01-01' }),
      mortgage({ anchorDate: '2026-02-01' }),
    ]
    expect(earliestAnchorDate(dates)).toBe('2026-01-01')
  })
})

describe('propertyEquityCents', () => {
  it('is null when the property value is not tracked', () => {
    const p = property({ propertyValueCents: null, mortgages: [mortgage({ anchorDate: '2026-01-01', principalCents: 10_000 })] })
    expect(propertyEquityCents(p, '2026-01-01')).toBeNull()
  })

  it('is value minus the outstanding balance', () => {
    const p = property({
      propertyValueCents: 100_000,
      mortgages: [
        mortgage({
          anchorDate: '2026-01-01',
          principalCents: 40_000,
          rateBp: 0,
          monthlyPaymentCents: 0,
          remainingTermMonths: 12,
        }),
      ],
    })
    expect(propertyEquityCents(p, '2026-01-01')).toBe(60_000)
  })

  it('is the full value when there is no mortgage', () => {
    const p = property({ propertyValueCents: 100_000, mortgages: [] })
    expect(propertyEquityCents(p, '2026-01-01')).toBe(100_000)
  })

  it('is value minus the summed balance across more than one mortgage', () => {
    const p = property({
      propertyValueCents: 100_000,
      mortgages: [
        mortgage({ anchorDate: '2026-01-01', principalCents: 20_000, rateBp: 0, monthlyPaymentCents: 0, remainingTermMonths: 12 }),
        mortgage({ anchorDate: '2026-01-01', principalCents: 10_000, rateBp: 0, monthlyPaymentCents: 0, remainingTermMonths: 12 }),
      ],
    })
    expect(propertyEquityCents(p, '2026-01-01')).toBe(70_000)
  })
})

describe('netCashFlowCents', () => {
  it('is null when the rent is not tracked', () => {
    expect(netCashFlowCents(property({ rentCents: null }))).toBeNull()
  })

  it('is rent minus the mortgage payment', () => {
    const p = property({ rentCents: 100_000, mortgages: [mortgage({ monthlyPaymentCents: 90_000 })] })
    expect(netCashFlowCents(p)).toBe(10_000)
  })

  it('is the whole rent when there is no mortgage', () => {
    expect(netCashFlowCents(property({ rentCents: 100_000, mortgages: [] }))).toBe(100_000)
  })

  it('is rent minus the summed payment across more than one mortgage', () => {
    const p = property({
      rentCents: 100_000,
      mortgages: [mortgage({ monthlyPaymentCents: 60_000 }), mortgage({ monthlyPaymentCents: 20_000 })],
    })
    expect(netCashFlowCents(p)).toBe(20_000)
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
      mortgages: [
        mortgage({
          anchorDate: '2026-01-01',
          principalCents: 40_000,
          rateBp: 0,
          monthlyPaymentCents: 0,
          remainingTermMonths: 12,
        }),
      ],
    })
    const untracked = property({ id: 'other', propertyValueCents: null, mortgages: [] })
    expect(totalEquityCents([tracked, untracked], '2026-01-01')).toBe(60_000)
  })
})
