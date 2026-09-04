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
  PAYLOAD_KEYS,
  PURPOSE_MAX_CHARS,
  redact,
  type AnalysisBundle,
  type BundleCategory,
  type CategoryMetaRow,
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
    ],
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
