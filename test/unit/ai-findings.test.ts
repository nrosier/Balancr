/**
 * The editor's two jobs: say each thing once, and put the important thing first.
 *
 * Both are invisible when they work and obvious when they do not, which is why
 * they are tested here rather than eyeballed on the insights page. The ordering
 * assertions deliberately spell out the whole expected sequence instead of
 * checking one pair: a cap that drops the wrong finding still leaves every
 * pairwise comparison correct.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_CAPS, dedupeSignals, rankSignals } from '../../src/domain/ai/findings.ts'
import type { FindingCode, Severity } from '../../src/domain/ai/codes.ts'
import type { Signal } from '../../src/domain/aggregate/overspend.ts'

interface SignalSpec {
  code: FindingCode
  category?: string | null
  severity?: Severity
  cents?: number
}

const signal = ({ code, category = 'cat-1', severity = 'warn', cents = 10_000 }: SignalSpec): Signal => ({
  code,
  categoryId: category,
  categoryName: category === null ? null : category.replace('cat-', 'Category '),
  severity,
  // `signalMagnitude` reads any key ending in `Cents`, so this is what breaks ties.
  metrics: { deltaBp: 1_000, baselineCents: cents },
})

const codes = (signals: readonly Signal[]): string[] => signals.map((s) => s.code)
const pairs = (signals: readonly Signal[]): string[] =>
  signals.map((s) => `${s.code}@${s.categoryId ?? 'household'}`)

describe('deduping', () => {
  it('keeps one signal per code and category', () => {
    const deduped = dedupeSignals([
      signal({ code: 'above_baseline' }),
      signal({ code: 'above_baseline' }),
    ])
    expect(deduped).toHaveLength(1)
  })

  it('keeps the same code for a different category', () => {
    // The common case, and the reason deduping on the code alone would be wrong:
    // four categories over their norm is four findings, not one.
    const deduped = dedupeSignals([
      signal({ code: 'above_baseline', category: 'cat-1' }),
      signal({ code: 'above_baseline', category: 'cat-2' }),
      signal({ code: 'above_baseline', category: 'cat-3' }),
    ])
    expect(deduped).toHaveLength(3)
  })

  it('keeps a different code for the same category', () => {
    // "Overspent, and not just this once" is two findings about one envelope, and
    // the pair is more informative than either alone.
    const deduped = dedupeSignals([
      signal({ code: 'over_available' }),
      signal({ code: 'above_baseline' }),
    ])
    expect(codes(deduped).sort()).toEqual(['above_baseline', 'over_available'])
  })

  it('keeps the most serious of a duplicate pair, whichever came first', () => {
    const alert = signal({ code: 'above_baseline', severity: 'alert' })
    const info = signal({ code: 'above_baseline', severity: 'info' })
    expect(dedupeSignals([info, alert])[0]?.severity).toBe('alert')
    expect(dedupeSignals([alert, info])[0]?.severity).toBe('alert')
  })

  it('breaks a tie on size rather than on input order', () => {
    // Otherwise a re-run that happens to iterate the other way changes the number
    // on the page without anything having changed in the budget.
    const small = signal({ code: 'above_baseline', cents: 1_000 })
    const large = signal({ code: 'above_baseline', cents: 90_000 })
    expect(dedupeSignals([small, large])[0]?.metrics.baselineCents).toBe(90_000)
    expect(dedupeSignals([large, small])[0]?.metrics.baselineCents).toBe(90_000)
  })

  it('treats every household signal as one group without merging them', () => {
    // They share a null category, so a naive key would collapse the savings rate
    // and the emergency fund into one finding.
    const deduped = dedupeSignals([
      signal({ code: 'savings_rate_low', category: null }),
      signal({ code: 'emergency_fund_short', category: null }),
      signal({ code: 'savings_rate_low', category: null, severity: 'info' }),
    ])
    expect(deduped).toHaveLength(2)
    expect(codes(deduped).sort()).toEqual(['emergency_fund_short', 'savings_rate_low'])
  })

  it('returns nothing for nothing', () => {
    expect(dedupeSignals([])).toEqual([])
  })
})

describe('hygiene comes first', () => {
  it('puts an uncategorised backlog above an alert about spending', () => {
    // The backlog is the reason not to trust the alert. Sorting by severity alone
    // buries it, which is the whole point of the exception.
    const ranked = rankSignals([
      signal({ code: 'over_available', category: 'cat-1', severity: 'alert', cents: 90_000 }),
      signal({ code: 'uncategorised_backlog', category: null, severity: 'warn' }),
    ])
    expect(codes(ranked)).toEqual(['uncategorised_backlog', 'over_available'])
  })

  it('orders the hygiene block among itself by severity, not by code', () => {
    const ranked = rankSignals([
      signal({ code: 'stale_prices', category: null, severity: 'info' }),
      signal({ code: 'recompute_mismatch', category: 'cat-9', severity: 'alert' }),
      signal({ code: 'unreconciled_account', category: 'acct-1', severity: 'warn' }),
    ])
    expect(codes(ranked)).toEqual(['recompute_mismatch', 'unreconciled_account', 'stale_prices'])
  })

  it('leaves the rest in severity order behind it', () => {
    const ranked = rankSignals([
      signal({ code: 'below_baseline', category: 'cat-1', severity: 'info' }),
      signal({ code: 'over_available', category: 'cat-2', severity: 'alert' }),
      signal({ code: 'burn_rate_over', category: 'cat-3', severity: 'warn' }),
      signal({ code: 'stale_prices', category: null, severity: 'info' }),
    ])
    expect(codes(ranked)).toEqual([
      'stale_prices',
      'over_available',
      'burn_rate_over',
      'below_baseline',
    ])
  })

  it('sorts equally serious findings by size', () => {
    const ranked = rankSignals([
      signal({ code: 'above_baseline', category: 'cat-small', cents: 4_000 }),
      signal({ code: 'above_baseline', category: 'cat-big', cents: 80_000 }),
      signal({ code: 'above_baseline', category: 'cat-mid', cents: 30_000 }),
    ])
    expect(ranked.map((s) => s.categoryId)).toEqual(['cat-big', 'cat-mid', 'cat-small'])
  })
})

describe('the per-category cap', () => {
  it('keeps two findings about one envelope and drops the third', () => {
    const ranked = rankSignals([
      signal({ code: 'over_available', severity: 'alert', cents: 50_000 }),
      signal({ code: 'above_baseline', severity: 'warn', cents: 40_000 }),
      signal({ code: 'burn_rate_over', severity: 'warn', cents: 30_000 }),
      signal({ code: 'below_baseline', severity: 'info', cents: 20_000 }),
    ])
    expect(codes(ranked)).toEqual(['over_available', 'above_baseline'])
  })

  it('drops the least important of them, not whichever arrived last', () => {
    const ranked = rankSignals([
      signal({ code: 'below_baseline', severity: 'info', cents: 90_000 }),
      signal({ code: 'burn_rate_over', severity: 'warn', cents: 10_000 }),
      signal({ code: 'over_available', severity: 'alert', cents: 10_000 }),
    ])
    expect(codes(ranked)).toEqual(['over_available', 'burn_rate_over'])
  })

  it('counts each category separately', () => {
    const ranked = rankSignals([
      signal({ code: 'over_available', category: 'cat-1' }),
      signal({ code: 'above_baseline', category: 'cat-1' }),
      signal({ code: 'burn_rate_over', category: 'cat-1' }),
      signal({ code: 'over_available', category: 'cat-2' }),
      signal({ code: 'above_baseline', category: 'cat-2' }),
    ])
    expect(ranked.filter((s) => s.categoryId === 'cat-1')).toHaveLength(2)
    expect(ranked.filter((s) => s.categoryId === 'cat-2')).toHaveLength(2)
  })

  it('does not apply to household findings, which are each about a different thing', () => {
    const household: FindingCode[] = [
      'savings_rate_low',
      'savings_rate_up',
      'emergency_fund_short',
      'net_worth_high',
      'income_change',
    ]
    const ranked = rankSignals(household.map((code) => signal({ code, category: null })))
    expect(ranked).toHaveLength(household.length)
  })

  it('shares a budget with the hygiene block, which is also per category', () => {
    // `recompute_mismatch` is a hygiene finding about a specific envelope, so it
    // spends one of that envelope's two slots. That is deliberate: three items
    // about one category is a wall whichever list they came from.
    const ranked = rankSignals([
      signal({ code: 'recompute_mismatch', category: 'cat-1', severity: 'alert' }),
      signal({ code: 'over_available', category: 'cat-1', severity: 'alert', cents: 90_000 }),
      signal({ code: 'above_baseline', category: 'cat-1', severity: 'warn', cents: 80_000 }),
    ])
    expect(codes(ranked)).toEqual(['recompute_mismatch', 'over_available'])
  })
})

describe('the total cap', () => {
  const many = (count: number): Signal[] =>
    Array.from({ length: count }, (_, i) =>
      signal({ code: 'above_baseline', category: `cat-${String(i).padStart(3, '0')}`, cents: 1_000 * (count - i) }),
    )

  it('stops at the cap', () => {
    expect(rankSignals(many(60))).toHaveLength(DEFAULT_CAPS.total)
  })

  it('keeps the largest, because the cap is applied after the sort', () => {
    const ranked = rankSignals(many(60))
    // `many` gives the first category the largest figure, so the kept set is the
    // first `total` of them and the tail is what falls off.
    expect(ranked.map((s) => s.categoryId)).toEqual(
      many(60)
        .slice(0, DEFAULT_CAPS.total)
        .map((s) => s.categoryId),
    )
  })

  it('leaves a short list alone', () => {
    expect(rankSignals(many(3))).toHaveLength(3)
  })

  it('is overridable, so a dry-run or an export can ask for everything', () => {
    const ranked = rankSignals(many(60), { perCategory: 2, total: 1_000 })
    expect(ranked).toHaveLength(60)
  })

  it('can be turned down to nothing without throwing', () => {
    expect(rankSignals(many(10), { perCategory: 2, total: 0 })).toEqual([])
  })
})

describe('a realistic month', () => {
  it('reads as hygiene, then the money, then the good news', () => {
    const ranked = rankSignals([
      signal({ code: 'below_baseline', category: 'cat-fuel', severity: 'info', cents: 6_000 }),
      signal({ code: 'savings_rate_up', category: null, severity: 'info' }),
      signal({ code: 'over_available', category: 'cat-groceries', severity: 'alert', cents: 8_000 }),
      signal({ code: 'above_baseline', category: 'cat-groceries', severity: 'warn', cents: 45_000 }),
      signal({ code: 'burn_rate_over', category: 'cat-groceries', severity: 'warn', cents: 61_000 }),
      signal({ code: 'emergency_fund_short', category: null, severity: 'alert' }),
      signal({ code: 'uncategorised_backlog', category: null, severity: 'warn' }),
      // The same finding twice, as a re-run that appended would produce.
      signal({ code: 'over_available', category: 'cat-groceries', severity: 'alert', cents: 8_000 }),
    ])
    expect(pairs(ranked)).toEqual([
      'uncategorised_backlog@household',
      'emergency_fund_short@household',
      'over_available@cat-groceries',
      'burn_rate_over@cat-groceries',
      'savings_rate_up@household',
      'below_baseline@cat-fuel',
    ])
  })

  it('changes nothing about the numbers it selects', () => {
    // The one guarantee this module owes the rest of the app: it is an editor, so
    // every kept signal is the object the producer emitted.
    const input = [signal({ code: 'above_baseline', cents: 45_000 })]
    expect(rankSignals(input)[0]).toBe(input[0])
  })
})
