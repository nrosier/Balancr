/**
 * Two tenants, one database file — the shape every multi-tenant read and write
 * takes on SQLite (#376). Each block below seeds tenant A and tenant B with
 * distinct data through the same domain functions the routes and jobs call,
 * then asserts the two things a leak would break: a read for A never returns
 * B's row, and a write for A never touches B's row, even when A supplies B's
 * id by number, guess, or coincidence.
 *
 * Deliberately one representative `load`/`save`/`persist` pair per domain area
 * rather than every exported function — the tenant-scoping clause itself is
 * copy-pasted across each area's functions, so one proven pair per area is
 * what a regression would actually break.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { initI18n } from '../../src/i18n/index.ts'
import { createSecondTenant } from '../helpers/second-tenant.ts'
import {
  loadAccountMap,
  syncAccountMap,
  updateAccountMap,
} from '../../src/domain/aggregate/accounts.ts'
import { loadMonthTotals, persistMonthTotals } from '../../src/domain/aggregate/month-store.ts'
import { loadHygiene, loadSignals, persistSignals } from '../../src/domain/aggregate/signals-store.ts'
import { loadNetWorthHistory, persistNetWorth } from '../../src/domain/aggregate/networth-store.ts'
import type { AccountValue } from '../../src/domain/aggregate/networth.ts'
import {
  loadPortfolioMetrics,
  metricsDates,
  persistPortfolioMetrics,
} from '../../src/domain/portfolio/store.ts'
import { loadHousehold, saveHousehold } from '../../src/domain/benchmark/household.ts'
import {
  loadReferenceOverride,
  saveReferenceOverride,
} from '../../src/domain/benchmark/reference.ts'
import {
  createDebt,
  deleteDebt,
  listDebts,
  loadDebt,
  updateDebt,
} from '../../src/domain/debt/debts.ts'
import {
  createLoan,
  deleteLoan,
  listLoans,
  loadLoan,
  updateLoan,
} from '../../src/domain/loan/loans.ts'
import { loadProperties, saveProperties } from '../../src/domain/property/properties.ts'
import { loadProfile, saveProfile } from '../../src/domain/advice/profile.ts'
import { persistFacts, syncCategoryMeta } from '../../src/domain/aggregate/facts.ts'
import {
  answerClarification,
  dismissClarification,
  enqueueClarifications,
  openQuestionCount,
  openQuestions,
} from '../../src/domain/ai/clarify.ts'
import {
  applyProposal,
  createProposal,
  loadProposal,
  pendingProposals,
} from '../../src/domain/ai/proposals.ts'
import { loadRun, loadRunPayload, recentRuns, recordRun } from '../../src/domain/ai/runs.ts'
import { deleteDigestPdf, loadDigestPdf, saveDigestPdf } from '../../src/domain/digest/storage.ts'
import { fact, totals } from '../fixtures/month.ts'

const MONTH = '2026-08'

let ctx: ReturnType<typeof createTestDb>
let db: Db
let tenantA: string
let tenantB: string

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  db = ctx.db
  tenantA = getSoleTenantId(db)
  tenantB = createSecondTenant(db, 'Second')
})

describe('account map', () => {
  it('never returns another tenant\'s accounts, and a rename never reaches them', () => {
    syncAccountMap(db, tenantA, [{ source: 'actual', externalId: 'acct-1', name: 'A checking' }])
    syncAccountMap(db, tenantB, [{ source: 'actual', externalId: 'acct-1', name: 'B checking' }])

    const rowsA = loadAccountMap(db, tenantA)
    const rowsB = loadAccountMap(db, tenantB)
    expect(rowsA).toHaveLength(1)
    expect(rowsB).toHaveLength(1)
    expect(rowsA[0]?.name).toBe('A checking')
    expect(rowsB[0]?.name).toBe('B checking')

    // Same externalId, different tenant: A's id must not reach B's row.
    const bId = rowsB[0]?.id as string
    const result = updateAccountMap(db, tenantA, bId, { kind: 'credit' })
    expect(result).toBeNull()
    expect(loadAccountMap(db, tenantB)[0]?.kind).not.toBe('credit')
  })
})

describe('month totals', () => {
  it('keeps one tenant\'s totals byte-for-byte unchanged by the other\'s write', () => {
    persistMonthTotals(db, tenantA, [totals(MONTH, { incomeCents: 400_000 })], [])
    persistMonthTotals(db, tenantB, [totals(MONTH, { incomeCents: 100_000 })], [])

    persistMonthTotals(db, tenantA, [totals(MONTH, { incomeCents: 450_000 })], [])

    expect(loadMonthTotals(db, tenantA, [MONTH])[0]?.incomeCents).toBe(450_000)
    expect(loadMonthTotals(db, tenantB, [MONTH])[0]?.incomeCents).toBe(100_000)
  })
})

describe('signals and hygiene', () => {
  it('isolates a month\'s signals and score per tenant', () => {
    const factsA = [fact(MONTH, 'food')]
    const factsB = [fact(MONTH, 'rent')]
    syncCategoryMeta(db, tenantA, factsA)
    syncCategoryMeta(db, tenantB, factsB)
    persistFacts(db, tenantA, factsA, [MONTH])
    persistFacts(db, tenantB, factsB, [MONTH])

    persistSignals(
      db,
      tenantA,
      MONTH,
      [
        {
          code: 'above_baseline',
          categoryId: 'food',
          categoryName: 'food',
          severity: 'warn',
          metrics: { deltaBp: 100, spentCents: 1_000, baselineCents: 900 },
        },
      ],
      { scoreBp: 9_000, deductions: [] },
    )
    persistSignals(db, tenantB, MONTH, [], { scoreBp: 10_000, deductions: [] })

    expect(loadSignals(db, tenantA, MONTH)).toHaveLength(1)
    expect(loadSignals(db, tenantB, MONTH)).toHaveLength(0)
    expect(loadHygiene(db, tenantA, MONTH)?.scoreBp).toBe(9_000)
    expect(loadHygiene(db, tenantB, MONTH)?.scoreBp).toBe(10_000)
  })
})

describe('net worth', () => {
  it('sums only the writing tenant\'s own account contributions', () => {
    syncAccountMap(db, tenantA, [{ source: 'actual', externalId: 'a1', name: 'A' }])
    syncAccountMap(db, tenantB, [{ source: 'actual', externalId: 'b1', name: 'B' }])
    const idA = loadAccountMap(db, tenantA)[0]?.id as string
    const idB = loadAccountMap(db, tenantB)[0]?.id as string

    const contribution = (accountMapId: string, valueCents: number): AccountValue => ({
      accountMapId,
      source: 'actual',
      externalId: 'x',
      name: 'x',
      kind: 'checking',
      valueCents,
      includeInNetWorth: true,
      dedupeGroup: null,
      isSourceOfTruth: true,
    })

    persistNetWorth(db, tenantA, {
      date: '2026-08-31',
      totalCents: 500_000,
      liquidCents: 500_000,
      investedCents: 0,
      debtCents: 0,
      contributions: [contribution(idA, 500_000)],
      excluded: [],
      unresolvedGroups: [],
    })
    persistNetWorth(db, tenantB, {
      date: '2026-08-31',
      totalCents: 200_000,
      liquidCents: 200_000,
      investedCents: 0,
      debtCents: 0,
      contributions: [contribution(idB, 200_000)],
      excluded: [],
      unresolvedGroups: [],
    })

    expect(loadNetWorthHistory(db, tenantA)).toEqual([{ date: '2026-08-31', totalCents: 500_000 }])
    expect(loadNetWorthHistory(db, tenantB)).toEqual([{ date: '2026-08-31', totalCents: 200_000 }])
  })
})

describe('portfolio metrics', () => {
  it('keeps each tenant\'s snapshot date and metrics separate', () => {
    persistPortfolioMetrics(db, tenantA, {
      date: '2026-08-31',
      totalValueCents: 100_000,
      investedValueCents: 100_000,
      cashValueCents: 0,
      twrBp: 100,
      mwrBp: null,
      allocation: [],
      driftJson: null,
      terAnnualCents: null,
    })
    persistPortfolioMetrics(db, tenantB, {
      date: '2026-07-31',
      totalValueCents: 50_000,
      investedValueCents: 50_000,
      cashValueCents: 0,
      twrBp: 50,
      mwrBp: null,
      allocation: [],
      driftJson: null,
      terAnnualCents: null,
    })

    expect(metricsDates(db, tenantA)).toEqual(new Set(['2026-08-31']))
    expect(metricsDates(db, tenantB)).toEqual(new Set(['2026-07-31']))
    expect(loadPortfolioMetrics(db, tenantA, '2026-07-31')).toBeNull()
    expect(loadPortfolioMetrics(db, tenantB, '2026-08-31')).toBeNull()
  })
})

describe('household and benchmark reference', () => {
  it('saves each tenant\'s household and reference override independently', () => {
    saveHousehold(db, tenantA, { members: [{ birthYear: 2018 }] })
    saveHousehold(db, tenantB, { members: [] })

    expect(loadHousehold(db, tenantA).members).toHaveLength(1)
    expect(loadHousehold(db, tenantB).members).toHaveLength(0)

    saveReferenceOverride(db, tenantA, {
      meanMonthlyCents: 250_000,
      equivalentAdultsBp: 13_000,
      citation: 'Statbel household budget survey',
    })

    expect(loadReferenceOverride(db, tenantA)?.meanMonthlyCents).toBe(250_000)
    expect(loadReferenceOverride(db, tenantB)).toBeNull()
  })
})

describe('properties', () => {
  it('keeps one tenant\'s properties out of the other\'s list', () => {
    saveProperties(db, tenantA, {
      properties: [
        {
          id: 'home-a',
          kind: 'primary',
          label: 'Home',
          propertyValueCents: 30_000_000,
          rentCents: null,
          mortgages: [],
        },
      ],
    })
    saveProperties(db, tenantB, { properties: [] })

    expect(loadProperties(db, tenantA).properties).toHaveLength(1)
    expect(loadProperties(db, tenantB).properties).toHaveLength(0)
  })
})

describe('loans', () => {
  const input = {
    kind: 'car' as const,
    label: 'Car',
    openingDate: '2026-01-01',
    principalCents: 1_500_000,
    anchorDate: '2026-01-01',
    rateBp: 0,
    monthlyPaymentCents: 100_000,
    remainingTermMonths: 60,
    originalPrincipalCents: null,
    extraMonthlyPaymentCents: null,
  }

  it("never reads, edits or deletes another tenant's loan by id (#441)", () => {
    const loanA = createLoan(db, tenantA, input)
    createLoan(db, tenantB, { ...input, label: 'B car', principalCents: 900_000 })

    expect(listLoans(db, tenantA).map((row) => row.label)).toEqual(['Car'])
    expect(listLoans(db, tenantB).map((row) => row.label)).toEqual(['B car'])

    // A's id supplied with B's tenant: no row to read, none to write, none to delete —
    // and A's own row untouched by all three attempts.
    expect(loadLoan(db, tenantB, loanA.id)).toBeNull()
    expect(updateLoan(db, tenantB, loanA.id, { ...input, principalCents: 1 })).toBeNull()
    expect(deleteLoan(db, tenantB, loanA.id)).toBe(false)

    expect(loadLoan(db, tenantA, loanA.id)?.principalCents).toBe(1_500_000)
    expect(listLoans(db, tenantB)).toHaveLength(1)
  })
})

describe('debts', () => {
  const input = {
    kind: 'creditCard' as const,
    label: 'Card',
    balanceCents: 200_000,
    minimumPaymentCents: 10_000,
    aprBp: 1_800,
  }

  it("never reads, edits or deletes another tenant's debt by id (#442)", () => {
    const debtA = createDebt(db, tenantA, input)
    createDebt(db, tenantB, { ...input, label: 'B card', balanceCents: 90_000 })

    expect(listDebts(db, tenantA).map((row) => row.label)).toEqual(['Card'])
    expect(listDebts(db, tenantB).map((row) => row.label)).toEqual(['B card'])

    // A's id supplied with B's tenant: no row to read, none to write, none to delete —
    // and A's own row untouched by all three attempts.
    expect(loadDebt(db, tenantB, debtA.id)).toBeNull()
    expect(updateDebt(db, tenantB, debtA.id, { ...input, balanceCents: 1 })).toBeNull()
    expect(deleteDebt(db, tenantB, debtA.id)).toBe(false)

    expect(loadDebt(db, tenantA, debtA.id)?.balanceCents).toBe(200_000)
    expect(listDebts(db, tenantB)).toHaveLength(1)
  })
})

describe('risk profile', () => {
  it('keeps one tenant\'s saved profile from leaking into the other\'s default', () => {
    saveProfile(db, tenantA, { profile: 'growth' })

    expect(loadProfile(db, tenantA).profile).toBe('growth')
    expect(loadProfile(db, tenantB).profile).not.toBe('growth')
  })
})

describe('clarification queue', () => {
  it('refuses to answer or dismiss another tenant\'s clarification', () => {
    const factsA = [fact(MONTH, 'food')]
    persistMonthTotals(db, tenantA, [totals(MONTH, { spentCents: 20_000 })], [])
    syncCategoryMeta(db, tenantA, factsA)
    persistFacts(db, tenantA, factsA, [MONTH])

    enqueueClarifications(db, tenantA, {
      month: MONTH,
      candidates: [{ code: 'nature_unknown', categoryId: 'food', guess: 'variable' }],
    })

    expect(openQuestionCount(db, tenantA)).toBe(1)
    expect(openQuestionCount(db, tenantB)).toBe(0)

    const question = openQuestions(db, tenantA)[0]
    if (question === undefined) throw new Error('the fixture did not enqueue a question')

    expect(() => answerClarification(db, tenantB, { id: question.id, value: 'variable' })).toThrow()
    expect(() => dismissClarification(db, tenantB, { id: question.id })).toThrow()
    expect(openQuestionCount(db, tenantA)).toBe(1)
  })
})

describe('AI proposals', () => {
  it('never loads or applies another tenant\'s proposal by id', async () => {
    const factsA = [fact(MONTH, 'food')]
    syncCategoryMeta(db, tenantA, factsA)
    persistFacts(db, tenantA, factsA, [MONTH])

    const proposal = await createProposal(db, tenantA, {
      type: 'category_meta.set',
      targetRef: 'food',
      payload: { userDescription: 'Weekly groceries run' },
    })

    expect(loadProposal(db, tenantB, proposal.id)).toBeNull()
    expect(pendingProposals(db, tenantB)).toHaveLength(0)
    expect(pendingProposals(db, tenantA)).toHaveLength(1)

    await expect(applyProposal(db, tenantB, { id: proposal.id })).rejects.toThrow()
    expect(loadProposal(db, tenantA, proposal.id)?.status).toBe('pending')
  })
})

describe('AI runs', () => {
  it('never loads, reads, or lists another tenant\'s run (#377)', () => {
    const runId = recordRun(db, tenantA, {
      kind: 'findings',
      provider: 'gemini-aistudio',
      model: 'gemini-3.7-flash',
      locale: 'en',
      payload: { month: MONTH },
      payloadHash: 'hash-a',
      status: 'ok',
    })

    expect(loadRun(db, tenantB, runId)).toBeNull()
    expect(loadRunPayload(db, tenantB, runId)).toBeNull()
    expect(recentRuns(db, tenantB, 50)).toHaveLength(0)

    expect(loadRun(db, tenantA, runId)?.id).toBe(runId)
    expect(loadRunPayload(db, tenantA, runId)).toEqual({ month: MONTH })
    expect(recentRuns(db, tenantA, 50)).toHaveLength(1)
  })
})

describe('digest PDFs (#600)', () => {
  it('never returns, overwrites or deletes another tenant\'s stored digest', () => {
    saveDigestPdf(db, tenantA, '2026-08', Buffer.from('%PDF-a'))
    saveDigestPdf(db, tenantB, '2026-08', Buffer.from('%PDF-b'))

    expect(loadDigestPdf(db, tenantB)?.pdfBytes.toString()).toBe('%PDF-b')

    // A re-save under the other tenant's id is the same failure mode a wrong
    // WHERE clause would produce: the tenantId column is the primary key, so this
    // must land as B's own row rather than overwriting A's.
    saveDigestPdf(db, tenantB, '2026-09', Buffer.from('%PDF-b2'))
    expect(loadDigestPdf(db, tenantA)?.pdfBytes.toString()).toBe('%PDF-a')
    expect(loadDigestPdf(db, tenantB)?.pdfBytes.toString()).toBe('%PDF-b2')

    deleteDigestPdf(db, tenantB)
    expect(loadDigestPdf(db, tenantB)).toBeNull()
    expect(loadDigestPdf(db, tenantA)?.pdfBytes.toString()).toBe('%PDF-a')
  })
})
