/**
 * The privacy guarantee. Treat this file as load-bearing.
 *
 * Two independent checks, because either alone is easy to fool:
 *
 *  1. **A denylist** built out of the fixture's own identifying text — account
 *     names carrying a bank and a card number, source ids, IBANs, ISINs, fund
 *     names, and the name and description of a sensitive category. Asserted absent
 *     from the serialised payload. This catches a value that leaked.
 *  2. **A key allowlist** (`PAYLOAD_KEYS`), asserted against the payload walked to
 *     any depth. This catches the field somebody adds later without deciding
 *     whether it is safe to send — which a denylist never would, because nobody
 *     thinks to add its values to the list.
 *
 * The denylist is built only from text the *sources* produce. A category name and
 * the user's own description of a non-sensitive category cross deliberately (see
 * the "a described category" block) — they exist so the assistant knows what an
 * envelope is for, and pretending to scrub text the user typed themselves would be
 * a guarantee this module cannot keep. Truncation is the mitigation there, and it
 * is tested.
 *
 * `AnalysisBundle` carries no payee, memo or transaction row at all, which is why
 * none appears below: the boundary starts upstream, at what the collector puts in
 * the bundle. Check 2 is what notices if that ever stops being true.
 */
import { describe, expect, it } from 'vitest'
import {
  GUESS_PAYLOAD_KEYS,
  NUDGE_PAYLOAD_KEYS,
  PAYLOAD_KEYS,
  PURPOSE_MAX_CHARS,
  redact,
  redactBudgetNudgeBatch,
  redactCategoryGuessBatch,
  type AnalysisBundle,
  type BundleCategory,
  type CategoryMetaRow,
  type GuessCandidateInput,
  type NudgeCandidateInput,
} from '../../src/domain/ai/redact.ts'
import type { AccountMapRow } from '../../src/domain/aggregate/accounts.ts'
import type { Signal } from '../../src/domain/aggregate/overspend.ts'
import type { MonthlyFact, MonthTotals } from '../../src/domain/aggregate/spend.ts'

/**
 * Strings that must never reach Gemini, planted throughout the fixture.
 *
 * Real-looking on purpose: an account name really is "KBC Zichtrekening ...6703"
 * in Actual, and the risk this module addresses is exactly that such text rides
 * along inside a field nobody thought about.
 */
const NEVER_SENT = [
  // A sensitive category: what it is, and who it is with.
  'Therapy — Dr. A. Vermeulen',
  'psychotherapy',
  'Alimentatie ex-partner',
  'alimony transfer March',
  // An excluded category (#278), whose class and amounts are withheld on top of
  // its name — so its own text belongs on the same list as the two above it.
  'Kliniek Sint-Amand — opname',
  'inpatient stay',
  'cat-withheld',
  // Account names, which carry the bank, the product and the last digits.
  'KBC Zichtrekening ...6703',
  'ARGENTA BANK CARD 6703',
  'Argenta spaarrekening',
  'Ghostfolio brokerage',
  // Identifiers. Rule 2 of the module: the payload carries no source-system id.
  'cat-therapy',
  'acct-current',
  'gf-brokerage',
  'a1b2c3d4-0000-4000-8000-000000000001',
  'BE68 5390 0754 7034',
]

/**
 * Identifying text the *bundle* cannot hold, let alone the payload.
 *
 * Instrument identity — ISIN, ticker, fund name — is the most identifying data in
 * the set, so it is excluded a layer earlier than this module:
 * `BundlePortfolio.holdingCount` is a number, and the collector never puts a
 * holding in the bundle at all. These are asserted absent from the **fixture**
 * rather than only from the payload, which is the stronger statement and the one
 * that fails the day a `holdings` field comes back.
 *
 * A schedule's payee is in the same class (#159). Actual's `getSchedules` returns a
 * `name`, a `payee` and an `account` beside the amount, and the committed figure needs
 * none of the three — so `fetchSchedules` parses with a plain `z.object`, Zod strips
 * them, and no type between the adapter and this file can carry them. Only aggregate
 * cent totals are stored. Listing the payees here asserts that structurally: the day
 * somebody adds `payee` to `ActualSchedule` to make a nicer screen, this fails.
 */
const NEVER_COLLECTED = [
  'IE00B4L5Y983',
  'BE6295424999',
  'IWDA.AS',
  'iShares Core MSCI World UCITS ETF',
  'Argenta Portfolio Defensive',
  // Schedule payees. A monthly direct debit names the merchant, and a bill's payee
  // is often more revealing than the transaction it settles.
  'NETFLIX INTERNATIONAL B.V.',
  'Dr. A. Vermeulen — maandelijkse sessie',
  'Huur — Immo Van Damme',
]

const fact = (overrides: Partial<MonthlyFact> = {}): MonthlyFact => ({
  month: '2026-08',
  categoryId: 'cat-groceries',
  categoryName: 'Groceries',
  isIncome: false,
  hidden: false,
  spentCents: 52_000,
  budgetedCents: 40_000,
  availableCents: -8_000,
  carryoverEnabled: true,
  txnCount: 23,
  recomputedSpentCents: 52_000,
  committedCents: 0,
  committedToDateCents: 0,
  committedApproximate: false,
  baseline: {
    baselineCents: 45_000,
    currentCents: 52_000,
    deltaBp: 1_555,
    monthsUsed: 12,
    windowMonths: 1,
    winsorEffectBp: -120,
  },
  dayCurve: null,
  ...overrides,
})

const meta = (overrides: Partial<CategoryMetaRow> = {}): CategoryMetaRow => ({
  categoryId: 'cat-groceries',
  nameSnapshot: 'Groceries',
  isIncome: false,
  hidden: false,
  userDescription: null,
  coicopCode: '01.1',
  nature: 'variable',
  expectedFrequency: 'monthly',
  custodyShared: false,
  sensitive: false,
  aiExcluded: false,
  confidence: 100,
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  ...overrides,
})

const account = (overrides: Partial<AccountMapRow> = {}): AccountMapRow => ({
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  source: 'actual',
  externalId: 'acct-current',
  name: 'KBC Zichtrekening ...6703',
  kind: 'checking',
  decidedFields: null,
  classifiedAt: null,
  includeInNetWorth: true,
  dedupeGroup: null,
  isSourceOfTruth: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
})

const totals = (month: string): MonthTotals => ({
  month,
  incomeCents: 380_000,
  spentCents: 341_000,
  budgetedCents: 350_000,
  toBudgetCents: 9_000,
  fromLastMonthCents: 12_000,
  balanceCents: 39_000,
  savingsRateBp: 1_026,
  committedCents: 0,
  committedUnallocatedCents: 0,
  committedUnallocatedCount: 0,
  committedApproximate: false,
})

/** A sensitive category: a name that says what it is, a description that says who with. */
const THERAPY: BundleCategory = {
  fact: fact({
    categoryId: 'cat-therapy',
    categoryName: 'Therapy — Dr. A. Vermeulen',
    spentCents: 24_000,
    txnCount: 2,
  }),
  meta: meta({
    categoryId: 'cat-therapy',
    nameSnapshot: 'Therapy — Dr. A. Vermeulen',
    userDescription: 'Weekly sessions with Dr. A. Vermeulen, psychotherapy, partly reimbursed',
    coicopCode: '06.2',
    nature: 'fixed',
    sensitive: true,
  }),
}

/** The second kind of sensitive: not medical, and just as much nobody's business. */
const ALIMONY: BundleCategory = {
  fact: fact({
    categoryId: 'cat-alimony',
    categoryName: 'Alimentatie ex-partner',
    spentCents: 41_000,
    txnCount: 1,
  }),
  meta: meta({
    categoryId: 'cat-alimony',
    nameSnapshot: 'Alimentatie ex-partner',
    userDescription: 'Court-set amount, paid by alimony transfer March 2024 onward',
    coicopCode: null,
    nature: 'fixed',
    sensitive: true,
  }),
}

/**
 * The third state: an envelope that does not cross at all (#278).
 *
 * `sensitive` withholds the name and keeps the rest, which for a category like this
 * one is most of the disclosure: `06` is health whatever the label says, and a class
 * plus a monthly amount plus a transaction count is a readable account of something
 * nobody agreed to send. `aiExcluded` is the answer for those — no label, no class,
 * no amounts of its own, and no signal about it either.
 *
 * `sensitive` is true alongside it because that is what `saveAiVisibility` writes: the
 * weaker flag under the stronger one, so a path that reads only one column still
 * withholds. Keeping it false here would test a state the writer cannot produce.
 */
const WITHHELD: BundleCategory = {
  fact: fact({
    categoryId: 'cat-withheld',
    categoryName: 'Kliniek Sint-Amand — opname',
    spentCents: 31_000,
    budgetedCents: 30_000,
    txnCount: 3,
  }),
  meta: meta({
    categoryId: 'cat-withheld',
    nameSnapshot: 'Kliniek Sint-Amand — opname',
    userDescription: 'The inpatient stay, the self-paid part, and the appointments after it',
    coicopCode: '06.3',
    nature: 'fixed',
    sensitive: true,
    aiExcluded: true,
  }),
}

function bundle(overrides: Partial<AnalysisBundle> = {}): AnalysisBundle {
  return {
    month: '2026-08',
    locale: 'en',
    currency: 'EUR',
    categories: [
      {
        // `committedCents` non-zero, so the allowlist walk actually sees the field
        // the committed figure added (#159).
        fact: fact({ committedCents: 5_000, committedToDateCents: 12_000 }),
        // Crosses on purpose: this is the answer to "what is this budget for?"
        // that the clarification queue collected.
        meta: meta({ userDescription: 'Weekly shop and household basics, me and my daughter' }),
      },
      THERAPY,
      ALIMONY,
      WITHHELD,
      {
        fact: fact({ categoryId: 'cat-salary', categoryName: 'Salary', isIncome: true }),
        meta: meta({ categoryId: 'cat-salary', nature: 'income', coicopCode: null }),
      },
      // A category the sync has seen and nothing is known about yet.
      {
        fact: fact({ categoryId: 'cat-unknown', categoryName: 'Misc 2', baseline: null }),
        meta: null,
      },
    ],
    totals: totals('2026-08'),
    totalsHistory: [totals('2026-06'), totals('2026-07')],
    netWorth: {
      date: '2026-08-31',
      totalCents: 4_920_000,
      liquidCents: 900_000,
      investedCents: 4_200_000,
      debtCents: 180_000,
    },
    hygiene: {
      scoreBp: 8_450,
      uncategorisedCount: 31,
      uncategorisedCents: 47_500,
      mismatchCount: 1,
    },
    portfolio: {
      metrics: {
        date: '2026-08-31',
        totalValueCents: 4_200_000,
        investedValueCents: 4_200_000,
        cashValueCents: 0,
        twrBp: 742,
        mwrBp: null,
        allocation: [
          { key: 'EQUITY', valueCents: 3_600_000, shareBp: 8_571 },
          { key: 'FIXED_INCOME', valueCents: 600_000, shareBp: 1_429 },
        ],
        driftJson: null,
        terAnnualCents: null,
      },
      holdingCount: 2,
    },
    // Fully populated on purpose, and with every state represented: the allowlist walk
    // only sees a field that is actually present, so a `drift` with everything inside
    // its band would leave `outsideBp` and `monthsOutside` untested (#183).
    drift: {
      persistence: {
        lines: [
          {
            assetClass: 'EQUITY',
            valueCents: 3_600_000,
            shareBp: 8_571,
            minBp: 5_500,
            targetBp: 6_500,
            maxBp: 7_500,
            driftBp: -2_071,
            state: 'above',
            outsideBp: 1_071,
            gapCents: -449_820,
            monthsOutside: 3,
          },
          {
            assetClass: 'FIXED_INCOME',
            valueCents: 600_000,
            shareBp: 1_429,
            minBp: 2_000,
            targetBp: 3_000,
            maxBp: 4_000,
            driftBp: 1_571,
            state: 'below',
            outsideBp: 571,
            gapCents: 659_820,
            monthsOutside: 3,
          },
          {
            assetClass: 'REAL_ESTATE',
            valueCents: 0,
            shareBp: 0,
            minBp: 0,
            targetBp: 500,
            maxBp: 1_500,
            driftBp: 500,
            state: 'inside',
            outsideBp: 0,
            gapCents: 210_000,
            monthsOutside: 0,
          },
        ],
        profile: 'balanced',
        isPreset: true,
        monthsObserved: 4,
      },
      toleranceBp: 100,
      minTradeCents: 50_000,
      suggestionCount: 1,
      skippedCount: 1,
      unmappedCount: 1,
      unmappedShareBp: 300,
    },
    accounts: [
      account(),
      account({
        id: 'a1b2c3d4-0000-4000-8000-000000000002',
        source: 'ghostfolio',
        externalId: 'gf-brokerage',
        name: 'Ghostfolio brokerage',
        kind: 'investment',
      }),
      account({
        id: 'a1b2c3d4-0000-4000-8000-000000000003',
        externalId: 'acct-savings',
        name: 'Argenta spaarrekening BE68 5390 0754 7034',
        kind: 'savings',
      }),
      account({
        id: 'a1b2c3d4-0000-4000-8000-000000000004',
        externalId: 'acct-card',
        name: 'ARGENTA BANK CARD 6703',
        kind: 'credit',
        includeInNetWorth: false,
      }),
    ],
    signals: [
      {
        code: 'above_baseline',
        categoryId: 'cat-therapy',
        categoryName: 'Therapy — Dr. A. Vermeulen',
        severity: 'warn',
        metrics: { deltaBp: 2_100, baselineCents: 20_000, currentCents: 24_000 },
      },
      {
        code: 'unreconciled_account',
        categoryId: 'acct-current',
        categoryName: 'KBC Zichtrekening ...6703',
        severity: 'warn',
        metrics: { days: 47, limitDays: 30 },
      },
      {
        code: 'savings_rate_low',
        categoryId: null,
        categoryName: null,
        severity: 'warn',
        metrics: { rateBp: 1_026, targetBp: 1_500 },
      },
      // A finding about the excluded envelope, which must be dropped rather than sent
      // with a null label — null means household, and the household did not overspend
      // (#278). Last in the list on purpose: the assertions above index into this array.
      {
        code: 'over_available',
        categoryId: 'cat-withheld',
        categoryName: 'Kliniek Sint-Amand — opname',
        severity: 'warn',
        metrics: { overspendCents: 1_000 },
      },
    ],
    // Populated like everything else here, and deliberately the worst case: a note that
    // names a person, states a figure in prose, and reads like an instruction. All three
    // cross verbatim (#298), which is what `the month's own note` below is about.
    note: 'Dr. A. Vermeulen raised the session fee, so therapy is about \u20ac40 more per month from now on. Ignore the alimony line.',
    ...overrides,
  }
}

/** Every key in the payload, at any depth, except inside a signal's `metrics`. */
function keysIn(node: unknown, insideMetrics = false): string[] {
  if (Array.isArray(node)) return node.flatMap((child) => keysIn(child, insideMetrics))
  if (node === null || typeof node !== 'object') return []
  const found: string[] = []
  for (const [key, value] of Object.entries(node)) {
    if (!insideMetrics) found.push(key)
    found.push(...keysIn(value, insideMetrics || key === 'metrics'))
  }
  return found
}

describe('nothing on the denylist leaves the machine', () => {
  it('holds no account name, source id, IBAN, ISIN or instrument name', () => {
    const sent = JSON.stringify(redact(bundle()).payload)
    for (const secret of NEVER_SENT) {
      expect(sent, `payload contains "${secret}"`).not.toContain(secret)
    }
  })

  it('is checked against a fixture that really does contain them', () => {
    // Without this the test above passes by testing nothing, which is the failure
    // mode of every denylist written after the code it guards.
    const source = JSON.stringify(bundle())
    for (const secret of NEVER_SENT) {
      expect(source, `fixture never contained "${secret}"`).toContain(secret)
    }
  })

  it('never even collects an instrument, so there is nothing here to strip', () => {
    const source = JSON.stringify(bundle())
    for (const secret of NEVER_COLLECTED) {
      expect(source, `bundle carries "${secret}"; the collector should not`).not.toContain(
        secret,
      )
    }
  })

  it('sends a transaction count and nothing else about transactions', () => {
    const payload = redact(bundle()).payload
    expect(JSON.stringify(payload)).not.toMatch(/payee|memo|iban|isin|symbol/i)
    // A count is the point: the shape of the month without any of its rows.
    expect(payload.categories.find((c) => c.name === 'Groceries')?.txnCount).toBe(23)
  })
})

describe('the payload has no field nobody decided to send', () => {
  it('uses only keys on the allowlist', () => {
    const unexpected = [...new Set(keysIn(redact(bundle()).payload))].filter(
      (key) => !PAYLOAD_KEYS.includes(key),
    )
    expect(unexpected, 'new payload field: decide whether it is safe to send').toEqual([])
  })

  it('carries nothing but finite numbers in a signal metrics bag', () => {
    // The one object the key walk cannot check, because its keys are metric names
    // chosen by whichever producer emitted the signal.
    for (const signal of redact(bundle()).payload.signals) {
      for (const value of Object.values(signal.metrics)) {
        expect(typeof value).toBe('number')
        expect(Number.isFinite(value)).toBe(true)
      }
    }
  })

  it('drops a metric that is not a finite number rather than forwarding it', () => {
    const dirty = {
      code: 'above_baseline',
      categoryId: 'cat-groceries',
      categoryName: 'Groceries',
      severity: 'warn',
      // A `Record<string, number>` that has been through JSON at some point.
      metrics: { deltaBp: 1_800, note: 'DELHAIZE 2340 ANTWERPEN', ratio: Infinity },
    } as unknown as Signal
    const metrics = redact(bundle({ signals: [dirty] })).payload.signals[0]?.metrics
    expect(metrics).toEqual({ deltaBp: 1_800 })
  })

  it('exercises every optional field, so the allowlist is not passing by omission', () => {
    const keys = new Set(keysIn(redact(bundle()).payload))
    const optional = [
      'name',
      'purpose',
      'coicop',
      'nature',
      'frequency',
      'custodyShared',
      'baselineCents',
      'deltaBp',
      'baselineMonths',
      'committedCents',
    ]
    for (const field of optional) {
      expect(keys.has(field), `fixture never produced "${field}"`).toBe(true)
    }
  })
})

describe('a sensitive category', () => {
  const sensitive = (categoryId: string) => {
    const { payload, labelFor } = redact(bundle())
    return payload.categories.find((c) => c.label === labelFor.get(categoryId))
  }

  it('crosses as a label with no name and no purpose', () => {
    for (const categoryId of ['cat-therapy', 'cat-alimony']) {
      const sent = sensitive(categoryId)
      expect(sent?.label, categoryId).toMatch(/^c\d+$/)
      expect(sent?.name, categoryId).toBeUndefined()
      expect(sent?.purpose, categoryId).toBeUndefined()
    }
  })

  it('keeps the class and nature, so the model can still reason about the amount', () => {
    const sent = sensitive('cat-therapy')
    expect(sent?.coicop).toBe('06.2')
    expect(sent?.nature).toBe('fixed')
    expect(sent?.frequency).toBe('monthly')
    expect(sent?.spentCents).toBe(24_000)
    expect(sent?.txnCount).toBe(2)
  })

  it('is not identifiable through a signal about it either', () => {
    const signal = redact(bundle()).payload.signals[0]
    expect(signal?.code).toBe('above_baseline')
    expect(signal?.label).toMatch(/^c\d+$/)
    expect(JSON.stringify(signal)).not.toContain('Vermeulen')
  })
})

describe('an excluded category (#278)', () => {
  /** The bundle without its one excluded envelope: the pre-feature payload. */
  const nothingExcluded = () =>
    bundle({
      categories: bundle().categories.filter((c) => c.fact.categoryId !== 'cat-withheld'),
      signals: bundle().signals.filter((s) => s.categoryId !== 'cat-withheld'),
    })

  it('contributes no entry, no label and no id mapping', () => {
    const { payload, labelFor, categoryIdFor } = redact(bundle())
    expect(labelFor.has('cat-withheld')).toBe(false)
    expect([...categoryIdFor.values()]).not.toContain('cat-withheld')
    // Nothing of it under any label, which is the assertion the denylist cannot make:
    // a name it happened to share with another envelope would pass a string search.
    expect(payload.categories.map((c) => c.name)).toEqual([
      // `cat-alimony` and `cat-therapy` are sensitive, so they have no name at all.
      undefined,
      'Groceries',
      'Salary',
      undefined,
      'Misc 2',
    ])
    expect(payload.categories.map((c) => c.coicop)).not.toContain('06.3')
  })

  it('leaves the labels contiguous over the gap it makes', () => {
    // `cat-withheld` sorts between `cat-therapy` and nothing, but the point holds
    // wherever it lands: a hole in `c1`…`cN` would itself say an envelope was withheld
    // and how many, which is the one thing the block below is allowed to say.
    const payload = redact(bundle()).payload
    expect(payload.categories.map((c) => c.label)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
  })

  it('declares itself as a count and three figures, and nothing else', () => {
    const excluded = redact(bundle()).payload.excluded
    expect(excluded).toEqual({
      count: 1,
      spentCents: 31_000,
      budgetedCents: 30_000,
      incomeCents: 0,
    })
  })

  it('is still inside the month totals, so the figures reconcile', () => {
    // The deliberate half of the design: nothing is recomputed to hide the envelope,
    // because a month whose totals do not add up is worse than a labelled one. So the
    // sum of what was sent plus what was withheld is the total that was also sent, and
    // the block is what makes that difference read as a decision rather than an error.
    const payload = redact(
      bundle({
        categories: [
          { fact: fact({ spentCents: 52_000 }), meta: meta() },
          WITHHELD,
          {
            fact: fact({
              categoryId: 'cat-salary',
              categoryName: 'Salary',
              isIncome: true,
              spentCents: 380_000,
            }),
            meta: meta({ categoryId: 'cat-salary', nature: 'income' }),
          },
        ],
        totals: { ...totals('2026-08'), spentCents: 83_000, incomeCents: 380_000 },
        signals: [],
      }),
    ).payload
    const listed = payload.categories
      .filter((category) => !category.income)
      .reduce((sum, category) => sum + category.spentCents, 0)
    expect(listed).toBe(52_000)
    expect(payload.totals.spentCents).toBe(83_000)
    expect(listed + (payload.excluded?.spentCents ?? 0)).toBe(payload.totals.spentCents)
  })

  it('drops a finding about it rather than sending it as the household own', () => {
    // `toSignal` reads a missing label as household level, so an unlabelled
    // `over_available` would report one envelope's overspend as the whole month's.
    const payload = redact(bundle()).payload
    expect(payload.signals.map((s) => s.code)).toEqual([
      'above_baseline',
      'unreconciled_account',
      'savings_rate_low',
    ])
    for (const signal of payload.signals) {
      if (signal.label === null) expect(signal.code).toBe('savings_rate_low')
    }
  })

  it('counts an excluded income envelope under incomeCents, not under spentCents', () => {
    const payload = redact(
      bundle({
        categories: [
          {
            fact: fact({
              categoryId: 'cat-side',
              categoryName: 'Side work',
              isIncome: true,
              spentCents: 60_000,
              budgetedCents: 0,
            }),
            meta: meta({ categoryId: 'cat-side', nature: 'income', sensitive: true, aiExcluded: true }),
          },
          WITHHELD,
        ],
        signals: [],
      }),
    ).payload
    expect(payload.categories).toEqual([])
    expect(payload.excluded).toEqual({
      count: 2,
      spentCents: 31_000,
      budgetedCents: 30_000,
      incomeCents: 60_000,
    })
  })

  it('sends null, and none of the block keys, when nothing is excluded', () => {
    const payload = redact(nothingExcluded()).payload
    expect(payload.excluded).toBeNull()
    expect(keysIn(payload)).not.toContain('count')
    expect(payload.categories.map((c) => c.label)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
  })

  it('is not what sensitive means: a sensitive envelope still crosses', () => {
    // The two flags are stored separately and the pair is written together. This is the
    // assertion that says they are not the same question: `cat-therapy` is sensitive and
    // present, `cat-withheld` is both and absent.
    const { payload, labelFor } = redact(bundle())
    expect(labelFor.has('cat-therapy')).toBe(true)
    expect(payload.categories.find((c) => c.label === labelFor.get('cat-therapy'))?.spentCents).toBe(
      24_000,
    )
  })
})

describe('a described category', () => {
  it('sends the name and the description that explains it', () => {
    // Deliberate, and the reason the redaction is worth doing at all: the model
    // needs to know that "Misc 2" is the school trip envelope. What it must not
    // get is anything the *source* wrote.
    const sent = redact(bundle()).payload.categories.find((c) => c.name === 'Groceries')
    expect(sent?.purpose).toBe('Weekly shop and household basics, me and my daughter')
  })

  it('truncates a description long enough to be a pasted statement', () => {
    // The mitigation for the one field a whole bank statement could land in.
    const pasted = 'DELHAIZE 2340 ANTWERPEN 12,40 EUR '.repeat(40)
    const sent = redact(
      bundle({ categories: [{ fact: fact(), meta: meta({ userDescription: pasted }) }] }),
    ).payload.categories[0]
    expect(sent?.purpose?.length).toBe(PURPOSE_MAX_CHARS + 1)
    expect(sent?.purpose?.endsWith('…')).toBe(true)
  })

  it('omits a purpose that is only whitespace instead of sending an empty string', () => {
    const sent = redact(
      bundle({ categories: [{ fact: fact(), meta: meta({ userDescription: '   \n ' }) }] }),
    ).payload.categories[0]
    expect(sent?.purpose).toBeUndefined()
  })

  it('sends no meta fields at all for a category the sync has not described yet', () => {
    const { payload, labelFor } = redact(bundle())
    const sent = payload.categories.find((c) => c.label === labelFor.get('cat-unknown'))
    expect(sent?.name).toBe('Misc 2')
    expect(sent?.coicop).toBeUndefined()
    expect(sent?.nature).toBeUndefined()
    expect(sent?.frequency).toBeUndefined()
    expect(sent?.custodyShared).toBeUndefined()
    // No baseline either, so its absence is visible rather than implied as zero.
    expect(sent?.baselineCents).toBeUndefined()
  })
})

describe('labels', () => {
  it('go to every category and account, sensitive or not', () => {
    const payload = redact(bundle()).payload
    expect(payload.categories.map((c) => c.label)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
    expect(payload.accounts.map((a) => a.label)).toEqual(['a1', 'a2', 'a3', 'a4'])
  })

  it('are stable whatever order the bundle arrives in', () => {
    // Assigned in id order rather than bundle order, so a stored payload still
    // reads against today's data and the stable half of the prompt stays cacheable.
    const forward = bundle()
    const reversed = bundle({
      categories: [...forward.categories].reverse(),
      accounts: [...forward.accounts].reverse(),
    })
    const labels = (b: AnalysisBundle) => {
      const { labelFor } = redact(b)
      return ['cat-therapy', 'cat-alimony', 'acct-current', 'gf-brokerage'].map((id) =>
        labelFor.get(id),
      )
    }
    expect(labels(reversed)).toEqual(labels(forward))
  })

  it('map back to real ids, so a finding can be attached to its category', () => {
    const { payload, categoryIdFor } = redact(bundle())
    for (const category of payload.categories) {
      expect(categoryIdFor.get(category.label)).toMatch(/^cat-/)
    }
  })

  it('resolve an account signal, whose id is an account and not a category', () => {
    const { payload, labelFor } = redact(bundle())
    const signal = payload.signals.find((s) => s.code === 'unreconciled_account')
    expect(signal?.label).toBe(labelFor.get('acct-current'))
    expect(signal?.label).toMatch(/^a\d+$/)
  })

  it('leave a household signal unlabelled rather than inventing one', () => {
    const signal = redact(bundle()).payload.signals.find((s) => s.code === 'savings_rate_low')
    expect(signal?.label).toBeNull()
  })

  it('are null for a signal about something the bundle does not contain', () => {
    // A bug worth finding, and it has to surface as a missing label rather than as
    // a name that went around the boundary.
    const orphan: Signal = {
      code: 'above_baseline',
      categoryId: 'cat-gone',
      categoryName: 'Deleted category',
      severity: 'info',
      metrics: { deltaBp: 100 },
    }
    const payload = redact(bundle({ signals: [orphan] })).payload
    expect(payload.signals[0]?.label).toBeNull()
    expect(JSON.stringify(payload)).not.toContain('Deleted category')
  })
})

describe('the portfolio crosses as a shape, not as holdings', () => {
  it('sends the total, the return and the asset-class shares', () => {
    const sent = redact(bundle()).payload.portfolio
    expect(sent?.totalValueCents).toBe(4_200_000)
    expect(sent?.twrBp).toBe(742)
    expect(sent?.holdingCount).toBe(2)
    // Both halves of the total, because `twrBp` is a return over all of it while the
    // allocation covers the invested part only — without the split the model cannot
    // tell a portfolio that is up 7,4% from one that is half cash and up 15%.
    expect(sent?.investedValueCents).toBe(4_200_000)
    expect(sent?.cashValueCents).toBe(0)
    expect(sent?.allocation.map((a) => a.assetClass)).toEqual(['EQUITY', 'FIXED_INCOME'])
    expect(sent?.allocation.map((a) => a.shareBp)).toEqual([8_571, 1_429])
  })

  it('carries a holding count and no per-holding key', () => {
    // The instruments are gone one layer earlier than this module: the bundle
    // holds a number, so there is nothing here to strip. What is worth asserting
    // is that the shape stayed a shape — a `holdings` or `positions` key
    // appearing under `portfolio` would mean the boundary moved back downstream.
    const sent = redact(bundle()).payload.portfolio
    expect(Object.keys(sent ?? {}).sort()).toEqual([
      'allocation',
      'cashValueCents',
      'date',
      'holdingCount',
      'investedValueCents',
      'totalValueCents',
      'twrBp',
    ])
    for (const slice of sent?.allocation ?? []) {
      expect(Object.keys(slice).sort()).toEqual(['assetClass', 'shareBp', 'valueCents'])
    }
  })

  it('is null when there is no snapshot, rather than a zeroed portfolio', () => {
    expect(redact(bundle({ portfolio: null })).payload.portfolio).toBeNull()
  })
})

describe('the drift crosses as bands and counts, not as trades', () => {
  it('sends the profile, so the narrative can say what the bands are', () => {
    const sent = redact(bundle()).payload.drift
    expect(sent?.profile).toBe('balanced')
    expect(sent?.isPreset).toBe(true)
    expect(sent?.monthsObserved).toBe(4)
    expect(sent?.toleranceBp).toBe(100)
    expect(sent?.minTradeCents).toBe(50_000)
  })

  it('sends one line per class, with how long it has been outside its band', () => {
    const sent = redact(bundle()).payload.drift
    expect(sent?.lines.map((line) => line.assetClass)).toEqual([
      'EQUITY',
      'FIXED_INCOME',
      'REAL_ESTATE',
    ])
    const equity = sent?.lines[0]
    expect(equity?.state).toBe('above')
    expect(equity?.shareBp).toBe(8_571)
    expect(equity?.maxBp).toBe(7_500)
    // The count is the only figure here the portfolio page does not already show, and
    // the whole reason the block exists: it is what separates a market that moved from
    // a rebalance nobody did (#183).
    expect(equity?.monthsOutside).toBe(3)
  })

  it('carries no field on a line nobody decided to send', () => {
    // A `DriftLine` is copied field by field rather than spread, so a field added to it
    // downstream reaches Gemini only if somebody puts it here. The instruments the drift
    // was computed from — the suggestions especially, which name a fund to buy — are the
    // reason: they hang off the same advice object one layer up.
    //
    // Two of the line's own fields are out on top of that, and not by omission: the
    // class's `valueCents` is already in the `portfolio` block, and `driftBp` is the
    // distance from *target* where `outsideBp` is the distance past the edge. Sending
    // both invites a sentence about whichever is larger.
    const sent = redact(bundle()).payload.drift
    for (const line of sent?.lines ?? []) {
      expect(Object.keys(line).sort()).toEqual([
        'assetClass',
        'gapCents',
        'maxBp',
        'minBp',
        'monthsOutside',
        'outsideBp',
        'shareBp',
        'state',
        'targetBp',
      ])
    }
  })

  it('reduces the trades to counts, naming no instrument to buy or sell', () => {
    // `buildAdvice` produces suggestions with a symbol, a name and a quantity, and a
    // skipped list saying which fund was below the minimum trade. Both are real content
    // about a holding, so what crosses is how many there were.
    const sent = redact(bundle()).payload.drift
    expect(sent?.suggestionCount).toBe(1)
    expect(sent?.skippedCount).toBe(1)
    // Unmapped positions are worse still: the entry *is* Ghostfolio's own string for an
    // instrument it could not classify. A count and a share is all of it that survives.
    expect(sent?.unmappedCount).toBe(1)
    expect(sent?.unmappedShareBp).toBe(300)
  })

  it('is null when there is no portfolio to measure against a profile', () => {
    expect(redact(bundle({ drift: null })).payload.drift).toBeNull()
  })
})

describe('net worth crosses as a total, not as accounts', () => {
  it('drops contributions and exclusions, which are per-account', () => {
    const sent = redact(bundle()).payload.netWorth
    expect(sent?.totalCents).toBe(4_920_000)
    expect(sent?.liquidCents).toBe(900_000)
    expect(sent?.investedCents).toBe(4_200_000)
    expect(sent?.debtCents).toBe(180_000)
    const json = JSON.stringify(sent)
    expect(json).not.toContain('KBC')
    expect(json).not.toContain('contributions')
    expect(json).not.toContain('excluded')
  })

  it('is null when no balances were collected', () => {
    expect(redact(bundle({ netWorth: null })).payload.netWorth).toBeNull()
  })
})

describe('accounts cross as kinds', () => {
  it('sends source, kind and whether it counts, and no name', () => {
    const sent = redact(bundle()).payload.accounts
    expect(sent.map((a) => a.kind)).toEqual(['credit', 'checking', 'savings', 'investment'])
    expect(sent.map((a) => a.source)).toEqual(['actual', 'actual', 'actual', 'ghostfolio'])
    // `inNetWorth` is the reason accounts are sent at all: a card left out of the
    // total explains a net worth figure that looks too flattering.
    expect(sent.map((a) => a.inNetWorth)).toEqual([false, true, true, true])
  })
})

describe('the month itself', () => {
  it('sends the totals and the trailing history the model needs for a trend', () => {
    const payload = redact(bundle()).payload
    expect(payload.month).toBe('2026-08')
    expect(payload.locale).toBe('en')
    expect(payload.currency).toBe('EUR')
    expect(payload.totals.savingsRateBp).toBe(1_026)
    expect(payload.history.map((h) => h.month)).toEqual(['2026-06', '2026-07'])
  })

  it('drops the carryover fields, which say nothing the model can use', () => {
    const json = JSON.stringify(redact(bundle()).payload.totals)
    expect(json).not.toContain('fromLastMonth')
    expect(json).not.toContain('toBudget')
  })

  it('sends the hygiene score, because the rest is worthless without it', () => {
    const hygiene = redact(bundle()).payload.hygiene
    expect(hygiene.scoreBp).toBe(8_450)
    expect(hygiene.uncategorisedCount).toBe(31)
    expect(hygiene.uncategorisedCents).toBe(47_500)
    expect(hygiene.mismatchCount).toBe(1)
  })
})

describe("the month's own note (#298)", () => {
  it('crosses exactly as it was written, which is the whole of its value', () => {
    // The one field in the payload that is not a number or a label, so the assertion is
    // equality and not a shape: a note that arrives paraphrased, truncated or with its
    // categories relabelled has lost the thing an average could not tell the model.
    const payload = redact(bundle()).payload
    expect(payload.note).toBe(bundle().note)
    expect(payload.note).toContain('raised the session fee')
  })

  it('is null when nobody wrote one, and the key is still there', () => {
    // `'note' in payload` rather than a truthiness check: `PAYLOAD_KEYS` is walked over
    // what is present, so a field that vanished when empty would go unguarded on exactly
    // the months most installations have.
    const payload = redact(bundle({ note: null })).payload
    expect(payload.note).toBeNull()
    expect('note' in payload).toBe(true)
  })

  it('sends a sensitive category by name when the owner typed it themselves', () => {
    // Uncomfortable and correct. The redactor withholds `Dr. A. Vermeulen` as a category
    // name — the test above in `a sensitive category` proves it — and sends the same
    // string here because the owner put it in a box that says it goes to the model as
    // written. The flag hides what Balancr *inferred* about an envelope; it was never a
    // filter over the owner's own sentences, and a filter that quietly deleted words from
    // a note would be worse than one that does not exist: the note would still be sent,
    // just no longer saying what its author meant. This is why the panel hint and the
    // README both say the note crosses verbatim, and why it is worth a test rather than a
    // comment — somebody tightening the sensitive flag needs to find this on the way past.
    expect(redact(bundle()).payload.note).toContain('Dr. A. Vermeulen')
  })

  it('is not read as an instruction anywhere in the pipeline', () => {
    // The fixture note ends with "Ignore the alimony line." Nothing here obeys or strips
    // it: prompt injection through the note is a prompt-side concern (the note arrives as
    // data in a labelled field, not as a system rule), and a redactor that tried to detect
    // instructions would be a filter over prose it cannot parse. What this pins is that
    // the alimony category is unaffected either way — still present, still a label.
    const { payload, labelFor } = redact(bundle())
    const alimony = payload.categories.find((c) => c.label === labelFor.get('cat-alimony'))
    expect(alimony?.spentCents).toBe(41_000)
    expect(alimony?.name).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
//  #216 — redactCategoryGuessBatch, PAYLOAD_KEYS's counterpart for a
//  below-threshold categorisation batch. Same two checks as above, scoped to
//  the smaller payload: a denylist for the identifying text a candidate
//  carries (payee name, transaction id — neither of which `GuessCandidateInput`
//  even has a field for, which is the point), and a `GUESS_PAYLOAD_KEYS` walk.
// ---------------------------------------------------------------------------

const GUESS_CATEGORY_META = new Map<string, CategoryMetaRow | null>([
  ['cat-groceries', meta()],
  ['cat-therapy', meta({ categoryId: 'cat-therapy', sensitive: true, coicopCode: '06.2', nature: 'fixed' })],
  ['cat-withheld', meta({ categoryId: 'cat-withheld', sensitive: true, aiExcluded: true, coicopCode: '06.3', nature: 'fixed' })],
  ['cat-unknown', null],
])

const GUESS_CATEGORY_NAME = new Map<string, string>([
  ['cat-groceries', 'Groceries'],
  ['cat-therapy', 'Therapy — Dr. A. Vermeulen'],
  ['cat-withheld', 'Kliniek Sint-Amand — opname'],
])

function guessCandidate(overrides: Partial<GuessCandidateInput> = {}): GuessCandidateInput {
  return {
    transactionId: 'txn-secret-123',
    amountCents: -4_200,
    history: [
      { categoryId: 'cat-groceries', count: 3 },
      { categoryId: 'cat-therapy', count: 1 },
    ],
    ...overrides,
  }
}

function guessBatch(candidates: readonly GuessCandidateInput[] = [guessCandidate()]) {
  return redactCategoryGuessBatch(candidates, GUESS_CATEGORY_META, GUESS_CATEGORY_NAME, 'en')
}

describe('redactCategoryGuessBatch sends only an opaque batch', () => {
  it('uses only keys on GUESS_PAYLOAD_KEYS', () => {
    const unexpected = [...new Set(keysIn(guessBatch().payload))].filter(
      (key) => !GUESS_PAYLOAD_KEYS.includes(key),
    )
    expect(unexpected, 'new guess payload field: decide whether it is safe to send').toEqual([])
  })

  it('never carries the transaction id, only the opaque clientId', () => {
    const { payload } = guessBatch()
    expect(payload.candidates[0]?.clientId).toBe('t1')
    expect(JSON.stringify(payload)).not.toContain('txn-secret-123')
  })

  it('maps the clientId back to the real transaction id after the call returns', () => {
    const { transactionIdFor } = guessBatch()
    expect(transactionIdFor.get('t1')).toBe('txn-secret-123')
  })

  it('never has a field for a payee name in the first place', () => {
    // `GuessCandidateInput` has no `payeeName`/`payeeId` field at all — this is
    // the structural guarantee, not something redaction has to remember to strip.
    const candidate = guessCandidate()
    expect(Object.keys(candidate)).toEqual(['transactionId', 'amountCents', 'history'])
  })

  it('labels a sensitive category with no name, but keeps its coicop and nature', () => {
    const { payload, categoryIdFor } = guessBatch()
    const therapy = payload.categories.find((c) => categoryIdFor.get(c.label) === 'cat-therapy')
    expect(therapy?.name).toBeUndefined()
    expect(therapy?.coicop).toBe('06.2')
    expect(therapy?.nature).toBe('fixed')
    expect(JSON.stringify(payload)).not.toContain('Vermeulen')
  })

  it('sends the name of a non-sensitive category', () => {
    const { payload, categoryIdFor } = guessBatch()
    const groceries = payload.categories.find((c) => categoryIdFor.get(c.label) === 'cat-groceries')
    expect(groceries?.name).toBe('Groceries')
  })

  it('gives the same label to a category shared across two candidates', () => {
    const { payload } = guessBatch([
      guessCandidate({ transactionId: 'txn-a', history: [{ categoryId: 'cat-groceries', count: 2 }] }),
      guessCandidate({ transactionId: 'txn-b', history: [{ categoryId: 'cat-groceries', count: 5 }] }),
    ])
    const [labelA] = payload.candidates[0]!.history.map((h) => h.label)
    const [labelB] = payload.candidates[1]!.history.map((h) => h.label)
    expect(labelA).toBe(labelB)
  })

  it('drops an excluded category from the vocabulary and from every history (#278)', () => {
    const { payload, categoryIdFor } = guessBatch([
      guessCandidate({
        history: [
          { categoryId: 'cat-groceries', count: 3 },
          { categoryId: 'cat-withheld', count: 5 },
        ],
      }),
    ])
    expect([...categoryIdFor.values()]).toEqual(['cat-groceries'])
    expect(payload.candidates[0]?.history.map((h) => h.count)).toEqual([3])
    expect(payload.candidates[0]?.history.map((h) => h.label)).toEqual(['c1'])
    expect(JSON.stringify(payload)).not.toContain('06.3')
  })

  it('drops a candidate whose only history is excluded, rather than sending it bare', () => {
    // A candidate with an empty history is not a cheaper question, it is a worse one:
    // it invites a guess at whichever categories *are* visible. The cost — that
    // transaction never being proposed into the excluded envelope — is what the flag
    // asked for, and the deterministic payee-majority route still handles it locally.
    const { payload, transactionIdFor } = guessBatch([
      guessCandidate({ transactionId: 'txn-a', history: [{ categoryId: 'cat-withheld', count: 4 }] }),
      guessCandidate({ transactionId: 'txn-b', history: [{ categoryId: 'cat-groceries', count: 2 }] }),
    ])
    // `t1`, not `t2`: the ids are contiguous over what was sent, or the gap would say
    // a candidate was removed and the model would be answering about a list it cannot see.
    expect(payload.candidates.map((c) => c.clientId)).toEqual(['t1'])
    expect(transactionIdFor.get('t1')).toBe('txn-b')
    expect(transactionIdFor.has('t2')).toBe(false)
    expect(JSON.stringify(payload)).not.toContain('txn-a')
  })

  it('sends no batch at all when every candidate is excluded', () => {
    const { payload } = guessBatch([
      guessCandidate({ history: [{ categoryId: 'cat-withheld', count: 4 }] }),
    ])
    expect(payload.candidates).toEqual([])
    expect(payload.categories).toEqual([])
  })

  it('falls back to no name or class for a category the sync knows nothing about', () => {
    const { payload, categoryIdFor } = guessBatch([
      guessCandidate({ history: [{ categoryId: 'cat-unknown', count: 1 }] }),
    ])
    const unknown = payload.categories.find((c) => categoryIdFor.get(c.label) === 'cat-unknown')
    expect(unknown?.name).toBeUndefined()
    expect(unknown?.coicop).toBeUndefined()
    expect(unknown?.nature).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
//  #217 — redactBudgetNudgeBatch, PAYLOAD_KEYS's counterpart for a batch of
//  pending budget-amount candidates read alongside the owner's own note.
// ---------------------------------------------------------------------------

const NUDGE_CATEGORY_META = new Map<string, CategoryMetaRow | null>([
  ['cat-groceries', meta()],
  ['cat-therapy', meta({ categoryId: 'cat-therapy', sensitive: true, nameSnapshot: 'Therapy — Dr. A. Vermeulen' })],
  ['cat-withheld', meta({ categoryId: 'cat-withheld', sensitive: true, aiExcluded: true })],
])

function nudgeCandidate(overrides: Partial<NudgeCandidateInput> = {}): NudgeCandidateInput {
  return {
    categoryId: 'cat-groceries',
    suggestedCents: 15_000,
    currentCents: 12_000,
    baselineCents: 11_000,
    ...overrides,
  }
}

function nudgeBatch(
  candidates: readonly NudgeCandidateInput[] = [nudgeCandidate()],
  note = 'Dentist bill in March, about 150 euros.',
) {
  return redactBudgetNudgeBatch(candidates, NUDGE_CATEGORY_META, '2026-03', 'en', note)
}

describe('redactBudgetNudgeBatch sends only an opaque batch', () => {
  it('uses only keys on NUDGE_PAYLOAD_KEYS', () => {
    const unexpected = [...new Set(keysIn(nudgeBatch().payload))].filter(
      (key) => !NUDGE_PAYLOAD_KEYS.includes(key),
    )
    expect(unexpected, 'new nudge payload field: decide whether it is safe to send').toEqual([])
  })

  it('passes the note through as the owner wrote it', () => {
    const { payload } = nudgeBatch([nudgeCandidate()], 'Car insurance renews in November.')
    expect(payload.note).toBe('Car insurance renews in November.')
  })

  it('labels a sensitive category with no name, but keeps its amounts', () => {
    const { payload, categoryIdFor } = nudgeBatch([
      nudgeCandidate({ categoryId: 'cat-therapy', suggestedCents: 8_000, currentCents: 6_000 }),
    ])
    const therapy = payload.candidates.find((c) => categoryIdFor.get(c.label) === 'cat-therapy')
    expect(therapy?.name).toBeUndefined()
    expect(therapy?.suggestedCents).toBe(8_000)
    expect(therapy?.currentCents).toBe(6_000)
    expect(JSON.stringify(payload)).not.toContain('Vermeulen')
  })

  it('sends the name of a non-sensitive category', () => {
    const { payload, categoryIdFor } = nudgeBatch()
    const groceries = payload.candidates.find((c) => categoryIdFor.get(c.label) === 'cat-groceries')
    expect(groceries?.name).toBe('Groceries')
  })

  it('omits baselineCents when the category has no baseline yet', () => {
    const { payload } = nudgeBatch([nudgeCandidate({ baselineCents: null })])
    expect(payload.candidates[0]?.baselineCents).toBeUndefined()
  })

  it('assigns labels in sorted-category-id order', () => {
    const { payload, categoryIdFor } = nudgeBatch([
      nudgeCandidate({ categoryId: 'cat-therapy' }),
      nudgeCandidate({ categoryId: 'cat-groceries' }),
    ])
    expect(categoryIdFor.get(payload.candidates[0]!.label)).toBe('cat-groceries')
    expect(categoryIdFor.get(payload.candidates[1]!.label)).toBe('cat-therapy')
  })

  it('drops an excluded candidate before labelling, so the labels stay contiguous (#278)', () => {
    // The amount for an excluded envelope is left to the deterministic rule that
    // proposed it. Nothing about it goes out with the note.
    const { payload, categoryIdFor } = nudgeBatch([
      nudgeCandidate({ categoryId: 'cat-withheld', suggestedCents: 31_000 }),
      nudgeCandidate({ categoryId: 'cat-groceries' }),
    ])
    expect(payload.candidates.map((c) => c.label)).toEqual(['c1'])
    expect(categoryIdFor.get('c1')).toBe('cat-groceries')
    expect(JSON.stringify(payload)).not.toContain('31000')
  })
})
