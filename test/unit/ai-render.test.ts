/**
 * Every code in the vocabulary must produce a real sentence in both languages.
 *
 * The point of iterating `FINDING_CODES` rather than testing a handful of codes
 * is that the failure mode is invisible otherwise: a code added to
 * `FINDING_SPECS` with no entry in `NUMERIC_VARS` compiles fine (the mapped type
 * catches that one), but a code whose metric keys do not match what its producer
 * actually emits renders as `null` and the finding simply never appears. Nobody
 * notices a finding that is missing.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { norm } from '../helpers/text.ts'
import { FINDING_CODES, FINDING_SPECS, type FindingCode } from '../../src/domain/ai/codes.ts'
import { findingVars, renderSignal, renderSignals } from '../../src/domain/ai/render.ts'
import type { Signal } from '../../src/domain/aggregate/overspend.ts'
import { initI18n } from '../../src/i18n/index.ts'

beforeAll(async () => {
  await initI18n()
})

/**
 * Every metric key any producer emits, with a plausible value.
 *
 * One bag for all codes: each code's mapping reads only the keys it declares, so
 * a superset exercises them all, and a key that no mapping reads is dead weight
 * that shows up as a `null` render.
 */
const ALL_METRICS: Record<string, number> = {
  // overspend
  spentCents: 52_000,
  assignedCents: 40_000,
  overAssignedCents: 12_000,
  availableCents: -8_000,
  overspendCents: 8_000,
  baselineCents: 45_000,
  currentCents: 53_100,
  excessCents: 8_100,
  savedCents: 8_100,
  benchmarkCents: 41_000,
  committedCents: 41_250,
  committedShortfallCents: 1_250,
  deltaBp: 1_800,
  windowMonths: 12,
  // trajectory
  amountCents: 74_900,
  monthsUsed: 11,
  months: 4,
  projectedCents: 61_000,
  projectedOverrunCents: 21_000,
  monthProgressBp: 6_000,
  changeCents: -25_000,
  // household
  rateBp: 900,
  targetBp: 1_500,
  shortfallBp: 600,
  incomeCents: 380_000,
  monthsBp: 24_000,
  targetMonthsBp: 30_000,
  liquidCents: 900_000,
  typicalSpendCents: 375_000,
  shortfallCents: 225_000,
  previousHighCents: 4_800_000,
  gainCents: 120_000,
  // custody (#44): what was paid on shared costs, what is borne, and the share applied
  offsetCents: 26_000,
  paidCents: 52_000,
  borneCents: 26_000,
  shareBp: 5_000,
  // drift (#183): a class outside its band, and how long for
  monthsOutside: 3,
  minBp: 2_000,
  maxBp: 7_500,
  // hygiene
  count: 1_312,
  differenceCents: -1_450,
  actualCents: 52_000,
  recomputedCents: 50_550,
  days: 47,
  limitDays: 30,
}

/** Codes whose `categoryName` is a closed-set id, and the id to test each one with. */
const NAMES_AN_ID: Partial<Record<FindingCode, string>> = {
  above_benchmark: 'housing',
  drift_above_band: 'EQUITY',
  drift_below_band: 'FIXED_INCOME',
}

const signal = (code: FindingCode, overrides: Partial<Signal> = {}): Signal => ({
  code,
  categoryId: 'cat-1',
  // Three codes carry an id in the name field rather than a name, and every one of them
  // is *translated* rather than printed: `above_benchmark` one of the ten benchmark group
  // ids (#43), the two drift codes one of the four asset classes (#183). A category name
  // in there is a missing translation, which is exactly what it should be.
  categoryName: NAMES_AN_ID[code] ?? 'Groceries',
  severity: 'warn',
  metrics: ALL_METRICS,
  ...overrides,
})

describe('the whole vocabulary renders', () => {
  for (const code of FINDING_CODES) {
    it(`${code} renders in both languages`, () => {
      for (const lang of ['en', 'nl']) {
        const rendered = renderSignal(signal(code), lang)
        expect(rendered, `${code} [${lang}] did not render`).not.toBeNull()
        const text = norm(rendered?.text ?? '')
        // A rendered sentence with a `{{var}}` left in it means the catalogue and
        // the spec disagree about a variable name.
        expect(text).not.toMatch(/\{\{/)
        expect(text.length).toBeGreaterThan(0)
      }
    })

    it(`${code} supplies every variable its spec declares`, () => {
      const vars = findingVars(signal(code), 'en')
      for (const name of FINDING_SPECS[code].vars) {
        expect(vars[name], `${code} has no {{${name}}}`).toBeDefined()
      }
    })
  }
})

describe('numbers are written the Belgian way', () => {
  it('formats money and percentages through format.ts, in both languages', () => {
    const rendered = renderSignal(signal('above_baseline'), 'en')
    // English UI, Belgian numbers: `€ 450,00` and `18%`, never `450.00`.
    expect(norm(rendered?.text ?? '')).toBe(
      'Groceries is 18% above your 12-month norm of € 450,00.',
    )
    // Same figures, Dutch words: the number formatting does not follow the UI
    // language, because the documents being cross-checked are always Belgian.
    expect(norm(renderSignal(signal('above_baseline'), 'nl')?.text ?? '')).toBe(
      'Groceries ligt 18% boven je 12-maandsgemiddelde van € 450,00.',
    )
  })

  it('separates thousands in a plain count', () => {
    // 1312 uncategorised transactions is `1.312`, not `1312` and not `1,312`.
    expect(norm(renderSignal(signal('uncategorised_backlog'), 'en')?.text ?? '')).toContain('1.312')
  })

  it('keeps a fractional month readable', () => {
    // 24 000 bp is 2,4 months of buffer. It must not arrive as `2.4`, and the
    // target beside it must not be read on the savings-rate scale — hence
    // `targetMonthsBp` rather than a second meaning for `targetBp`.
    const text = norm(renderSignal(signal('emergency_fund_short'), 'en')?.text ?? '')
    expect(text).toBe('Your buffer covers 2,4 months, short of the 3 months you aim for.')
    expect(text).not.toContain('2.4')
  })

  it('drops the sign where the sentence already carries the direction', () => {
    const below = signal('below_baseline', { metrics: { ...ALL_METRICS, deltaBp: -1_800 } })
    // "18% below your usual level", not "−18% below".
    expect(norm(renderSignal(below, 'en')?.text ?? '')).toBe(
      'Groceries is 18% below your usual level.',
    )
  })

  it('keeps the sign where it is the point', () => {
    const down = signal('income_change', { metrics: { ...ALL_METRICS, deltaBp: -1_200 } })
    const up = signal('income_change', { metrics: { ...ALL_METRICS, deltaBp: 1_200 } })
    expect(norm(renderSignal(down, 'en')?.text ?? '')).toContain('-12%')
    expect(norm(renderSignal(up, 'en')?.text ?? '')).toContain('+12%')
  })

  it('states a difference without claiming a direction it does not know', () => {
    // `differenceCents` is signed so the drift is visible in the metrics; the
    // sentence says "is €14,50 away from Actual's", which a minus would break.
    expect(norm(renderSignal(signal('recompute_mismatch'), 'en')?.text ?? '')).toContain('€ 14,50')
  })
})

describe('an account that was never reconciled', () => {
  const never = (overrides: Partial<Signal> = {}) =>
    signal('unreconciled_account', {
      categoryId: 'acct-1',
      categoryName: 'KBC current account',
      metrics: { days: -1, limitDays: 30 },
      ...overrides,
    })

  it('says so, rather than reporting -1 days', () => {
    const en = norm(renderSignal(never(), 'en')?.text ?? '')
    expect(en).toBe('KBC current account has never been reconciled.')
    expect(en).not.toContain('-1')
    expect(norm(renderSignal(never(), 'nl')?.text ?? '')).toContain('nog nooit')
  })

  it('is still an unreconciled_account, so nothing downstream needs a special case', () => {
    expect(renderSignal(never())?.code).toBe('unreconciled_account')
  })

  it('reports a real duration normally', () => {
    expect(norm(renderSignal(never({ metrics: { days: 47, limitDays: 30 } }), 'en')?.text ?? '')).toBe(
      'KBC current account has not been reconciled in 47 days.',
    )
  })
})

describe('rendering carries the finding through', () => {
  it('keeps the metrics, severity and sign of the signal', () => {
    const rendered = renderSignal(signal('over_available', { severity: 'alert' }))
    expect(rendered?.severity).toBe('alert')
    expect(rendered?.negative).toBe(true)
    expect(rendered?.categoryId).toBe('cat-1')
    expect(rendered?.metrics.overspendCents).toBe(8_000)
  })

  it('marks good news as such, so the UI can style it apart', () => {
    expect(renderSignal(signal('savings_rate_up'))?.negative).toBe(false)
    expect(renderSignal(signal('net_worth_high'))?.negative).toBe(false)
  })

  it('returns null for a signal missing a number rather than a sentence with a hole', () => {
    const bare = signal('above_baseline', { metrics: {} })
    expect(renderSignal(bare)).toBeNull()
  })

  it('drops what it cannot render and keeps the rest in order', () => {
    const rendered = renderSignals([
      signal('above_baseline', { metrics: {} }),
      signal('over_available'),
      signal('savings_rate_low', { categoryId: null, categoryName: null }),
    ])
    expect(rendered.map((r) => r.code)).toEqual(['over_available', 'savings_rate_low'])
  })

  it('renders a household finding that has no category name', () => {
    const household = signal('savings_rate_low', { categoryId: null, categoryName: null })
    expect(renderSignal(household, 'en')).not.toBeNull()
    expect(renderSignal(household, 'nl')).not.toBeNull()
  })

  it('prints the paid figure beside the offset in the custody finding (#44)', () => {
    // Both numbers or neither: "€ 260 is the co-parent's" is not a claim anybody can
    // check until the € 520 it came out of is in the same sentence. The share is there
    // for the same reason — it is what makes the arithmetic visible rather than magic.
    const custody = signal('custody_offset', { categoryId: null, categoryName: null })
    expect(norm(renderSignal(custody, 'en')?.text ?? '')).toBe(
      "You paid € 520,00 on shared costs; at a 50% share, € 260,00 of that is the co-parent's.",
    )
    expect(norm(renderSignal(custody, 'nl')?.text ?? '')).toContain('\u20ac 520,00')
    // Good news by declaration: paying a bill that gets split is not an overrun, and the
    // insights page styles it apart from one.
    expect(renderSignal(custody)?.negative).toBe(false)
  })

  it('translates the benchmark group a benchmark finding names (#43)', () => {
    // The one finding whose name field is not a name: `overspend.ts` puts one of the ten
    // benchmark group ids in `categoryName`, and `housing` is a key rather than a word
    // anybody wants to read. The loop above cannot catch this — it names a category, so
    // the sentence renders with a raw key in it and nothing complains.
    const benchmark = signal('above_benchmark', { categoryId: null, categoryName: 'housing' })
    expect(norm(renderSignal(benchmark, 'en')?.text ?? '')).toContain(
      'Housing, water and energy',
    )
    expect(norm(renderSignal(benchmark, 'nl')?.text ?? '')).toContain('Huisvesting')
    // And no key survives into either sentence, which is the failure this guards.
    for (const lang of ['en', 'nl']) {
      expect(renderSignal(benchmark, lang)?.text ?? '').not.toMatch(/benchmark\.group\./)
    }
  })
})
