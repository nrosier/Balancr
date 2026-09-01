/**
 * The ledger, the view over it, and the cost guard that reads the view.
 *
 * Three properties are the point of the whole design:
 *
 *  - The payload is stored **verbatim**, so the privacy claim is checkable by
 *    opening a row rather than by trusting this paragraph.
 *  - Cost is derived inside `recordRun`, so no call site can record a call as
 *    free by forgetting a field.
 *  - `ai_spend_monthly` sums the ledger and nothing else, so there is no second
 *    counter that can disagree about how much has been spent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { costMicroEur, eurToMicroEur } from '../../src/adapters/gemini/pricing.ts'
import {
  budgetEur,
  budgetState,
  checkBudget,
  loadSpendHistory,
  loadSpendMonth,
  spendMonthOf,
} from '../../src/domain/ai/budget.ts'
import {
  latestSuccessfulRun,
  loadRun,
  loadRunPayload,
  recentRuns,
  recordRun,
  type RecordRun,
  type RunStatus,
} from '../../src/domain/ai/runs.ts'
import { config } from '../../src/config.ts'

let ctx: ReturnType<typeof createTestDb>
let db: ReturnType<typeof createTestDb>['db']

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  db = ctx.db
})

const MODEL = 'gemini-3.7-flash'

const run = (overrides: Partial<RecordRun> = {}): RecordRun => ({
  kind: 'findings',
  model: MODEL,
  locale: 'en',
  payload: { month: '2026-03', categories: [{ label: 'c1', spentCents: 42_000 }] },
  status: 'ok',
  usage: { inputTokens: 3_000, outputTokens: 500, cachedTokens: 0 },
  ...overrides,
})

/**
 * A call that never went out, recorded the way a caller records one: no `usage`
 * field at all, rather than a zeroed one.
 */
const refused = (status: RunStatus): RecordRun => ({
  kind: 'findings',
  model: MODEL,
  locale: 'en',
  payload: { month: '2026-03' },
  status,
})

/** Backdates a row: the view groups by `created_at`, so months need placing. */
function backdate(id: string, when: Date): void {
  ctx.sqlite.prepare('update ai_runs set created_at = ? where id = ?').run(when.getTime(), id)
}

/** Places an already-recorded run in a month. */
function at(id: string, month: string): string {
  backdate(id, new Date(`${month}-15T12:00:00Z`))
  return id
}

/** A run recorded in a given month. */
const runIn = (month: string, overrides: Partial<RecordRun> = {}): string =>
  at(recordRun(db, run(overrides)), month)

describe('recordRun', () => {
  it('stores the payload verbatim, which is what makes the audit possible', () => {
    const payload = { month: '2026-03', categories: [{ label: 'c1', name: 'Groceries' }] }
    const id = recordRun(db, run({ payload }))

    // Not a summary, not a hash: the JSON, so a person can look for a payee.
    expect(loadRunPayload(db, id)).toEqual(payload)
    expect(loadRun(db, id)?.payloadJson).toBe(JSON.stringify(payload))
  })

  it('derives the cost from the model and the tokens', () => {
    const id = recordRun(db, run())
    expect(loadRun(db, id)?.costMicroEur).toBe(
      costMicroEur(MODEL, { inputTokens: 3_000, outputTokens: 500, cachedTokens: 0 }),
    )
  })

  it('records a refused run at zero cost, with the payload it would have sent', () => {
    // A missing answer that explains itself, rather than one that is just absent.
    const id = recordRun(db, refused('capped'))
    const row = loadRun(db, id)
    expect(row?.status).toBe('capped')
    expect(row?.costMicroEur).toBe(0)
    expect(row?.inputTokens).toBe(0)
    expect(loadRunPayload(db, id)).not.toBeNull()
  })

  it('prices an unknown model rather than treating it as free', () => {
    const id = recordRun(db, run({ model: 'gemini-9-something' }))
    expect(loadRun(db, id)?.costMicroEur).toBeGreaterThan(0)
  })

  it('accepts an override for a price we do not model', () => {
    const id = recordRun(db, run({ costMicroEurOverride: 4_242 }))
    expect(loadRun(db, id)?.costMicroEur).toBe(4_242)
  })

  it('keeps the error text on a failed run', () => {
    const id = recordRun(db, run({ status: 'error', error: 'model response was not JSON' }))
    expect(loadRun(db, id)?.error).toBe('model response was not JSON')
  })

  it('leaves promptId null for a run on the built-in prompt', () => {
    const id = recordRun(db, run())
    expect(loadRun(db, id)?.promptId).toBeNull()
  })
})

describe('loadRun and loadRunPayload', () => {
  it('returns null for an id that does not exist', () => {
    expect(loadRun(db, 'nope')).toBeNull()
    expect(loadRunPayload(db, 'nope')).toBeNull()
  })

  it('returns null rather than throwing on unreadable JSON', () => {
    // The audit view: a row whose payload cannot be parsed is itself the finding,
    // and it must not take the page down.
    const id = recordRun(db, run())
    ctx.sqlite.prepare('update ai_runs set payload_json = ? where id = ?').run('{oops', id)
    expect(loadRunPayload(db, id)).toBeNull()
  })
})

describe('latestSuccessfulRun', () => {
  it('is the newest ok run of that kind', () => {
    const older = recordRun(db, run())
    backdate(older, new Date('2026-03-01T00:00:00Z'))
    const newer = recordRun(db, run())
    backdate(newer, new Date('2026-03-02T00:00:00Z'))

    expect(latestSuccessfulRun(db, 'findings')?.id).toBe(newer)
  })

  it('ignores errored and capped runs, which have no usable output', () => {
    const good = recordRun(db, run())
    backdate(good, new Date('2026-03-01T00:00:00Z'))
    for (const status of ['error', 'capped', 'blocked'] as const) {
      const id = recordRun(db, run({ status }))
      backdate(id, new Date('2026-03-05T00:00:00Z'))
    }

    expect(latestSuccessfulRun(db, 'findings')?.id).toBe(good)
  })

  it('does not cross kinds', () => {
    recordRun(db, run({ kind: 'narrative' }))
    expect(latestSuccessfulRun(db, 'findings')).toBeNull()
  })

  it('is null on an empty ledger', () => {
    expect(latestSuccessfulRun(db, 'findings')).toBeNull()
  })
})

describe('recentRuns', () => {
  it('is newest first and honours the limit', () => {
    for (let day = 1; day <= 5; day += 1) {
      const id = recordRun(db, run())
      backdate(id, new Date(`2026-03-0${day}T00:00:00Z`))
    }

    const rows = recentRuns(db, 3)
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.createdAt.getTime())).toEqual([
      new Date('2026-03-05T00:00:00Z').getTime(),
      new Date('2026-03-04T00:00:00Z').getTime(),
      new Date('2026-03-03T00:00:00Z').getTime(),
    ])
  })

  it('includes every status, because the spend page shows refusals too', () => {
    recordRun(db, run({ status: 'capped' }))
    recordRun(db, run({ status: 'error' }))
    expect(recentRuns(db)).toHaveLength(2)
  })
})

describe('ai_spend_monthly', () => {
  it('is zeroes for a month with no runs, not a missing row', () => {
    expect(loadSpendMonth(db, '2026-03')).toEqual({
      month: '2026-03',
      runCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costMicroEur: 0,
    })
  })

  it('sums tokens and cost across the month', () => {
    runIn('2026-03')
    runIn('2026-03')

    const month = loadSpendMonth(db, '2026-03')
    expect(month.runCount).toBe(2)
    expect(month.inputTokens).toBe(6_000)
    expect(month.outputTokens).toBe(1_000)
    expect(month.costMicroEur).toBe(
      2 * costMicroEur(MODEL, { inputTokens: 3_000, outputTokens: 500, cachedTokens: 0 }),
    )
  })

  it('counts a run whatever its status', () => {
    // An errored run still cost money; a capped one costs zero. Summing the
    // column is therefore right in both directions, with no status filter.
    runIn('2026-03', { status: 'error' })
    at(recordRun(db, refused('capped')), '2026-03')

    const month = loadSpendMonth(db, '2026-03')
    expect(month.runCount).toBe(2)
    expect(month.costMicroEur).toBe(
      costMicroEur(MODEL, { inputTokens: 3_000, outputTokens: 500, cachedTokens: 0 }),
    )
  })

  it('separates months', () => {
    runIn('2026-02')
    runIn('2026-03')
    runIn('2026-03')

    expect(loadSpendMonth(db, '2026-02').runCount).toBe(1)
    expect(loadSpendMonth(db, '2026-03').runCount).toBe(2)
  })

  it('groups by the UTC month, the same rule spendMonthOf uses', () => {
    // 2026-03-01 00:30 Brussels is still February in UTC. The boundary hour is
    // the documented cost of a view SQLite can actually compute.
    const id = recordRun(db, run())
    backdate(id, new Date('2026-02-28T23:30:00Z'))

    expect(loadSpendMonth(db, '2026-02').runCount).toBe(1)
    expect(loadSpendMonth(db, '2026-03').runCount).toBe(0)
    expect(spendMonthOf(new Date('2026-02-28T23:30:00Z'))).toBe('2026-02')
  })

  it('lists history newest first', () => {
    runIn('2026-01')
    runIn('2026-02')
    runIn('2026-03')

    expect(loadSpendHistory(db).map((month) => month.month)).toEqual([
      '2026-03',
      '2026-02',
      '2026-01',
    ])
  })

  it('limits history to the most recent months', () => {
    runIn('2026-01')
    runIn('2026-02')
    runIn('2026-03')

    expect(loadSpendHistory(db, 2).map((month) => month.month)).toEqual(['2026-03', '2026-02'])
  })
})

describe('budgetState', () => {
  const now = new Date('2026-03-15T03:00:00Z')

  it('reports an untouched month as fully available', () => {
    const state = budgetState(db, now)
    expect(state.month).toBe('2026-03')
    expect(state.spentMicroEur).toBe(0)
    expect(state.budgetMicroEur).toBe(eurToMicroEur(config.GEMINI_MONTHLY_BUDGET_EUR))
    expect(state.remainingMicroEur).toBe(state.budgetMicroEur)
    expect(state.usedBp).toBe(0)
    expect(state.exceeded).toBe(false)
  })

  it('measures spend against the budget in basis points', () => {
    runIn('2026-03', { costMicroEurOverride: eurToMicroEur(3.75) })

    const state = budgetState(db, now)
    expect(state.spentMicroEur).toBe(eurToMicroEur(3.75))
    // 3.75 of 15 euro.
    expect(state.usedBp).toBe(2_500)
    expect(state.remainingMicroEur).toBe(eurToMicroEur(11.25))
    expect(state.exceeded).toBe(false)
  })

  it('clamps an overspend rather than reporting a negative remainder', () => {
    runIn('2026-03', { costMicroEurOverride: eurToMicroEur(20) })

    const state = budgetState(db, now)
    expect(state.remainingMicroEur).toBe(0)
    expect(state.usedBp).toBe(10_000)
    expect(state.exceeded).toBe(true)
  })

  it('is exceeded exactly at the budget, not one micro-euro past it', () => {
    runIn('2026-03', { costMicroEurOverride: eurToMicroEur(config.GEMINI_MONTHLY_BUDGET_EUR) })
    expect(budgetState(db, now).exceeded).toBe(true)
  })

  it("ignores another month's spend", () => {
    runIn('2026-02', { costMicroEurOverride: eurToMicroEur(20) })
    expect(budgetState(db, now).exceeded).toBe(false)
  })

  it('converts to euros for a banner', () => {
    runIn('2026-03', { costMicroEurOverride: eurToMicroEur(2.5) })
    expect(budgetEur(budgetState(db, now))).toEqual({ spent: 2.5, budget: 15 })
  })
})

describe('checkBudget', () => {
  const now = new Date('2026-03-15T03:00:00Z')

  it('allows a call inside the budget', () => {
    const decision = checkBudget(db, eurToMicroEur(0.02), now)
    expect(decision).toMatchObject({ allowed: true, reason: 'ok' })
  })

  it('refuses once the month is spent, with a code rather than a sentence', () => {
    runIn('2026-03', { costMicroEurOverride: eurToMicroEur(15) })

    const decision = checkBudget(db, 0, now)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('month_budget_exceeded')
    // The state travels with the decision: the banner shows the figures.
    expect(decision.state.spentMicroEur).toBe(eurToMicroEur(15))
  })

  it('refuses an estimate larger than what is left, not just larger than the budget', () => {
    // A month at 95% must not be allowed to start a run costing half the budget.
    runIn('2026-03', { costMicroEurOverride: eurToMicroEur(14.5) })

    const decision = checkBudget(db, eurToMicroEur(1), now)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('estimate_exceeds_remaining')
  })

  it('allows an estimate that exactly fits', () => {
    runIn('2026-03', { costMicroEurOverride: eurToMicroEur(14) })
    expect(checkBudget(db, eurToMicroEur(1), now).allowed).toBe(true)
  })

  it('allows a call with no estimate given', () => {
    expect(checkBudget(db, undefined, now).allowed).toBe(true)
  })
})

describe('a zero budget', () => {
  it('means no AI spend at all, from the first call', async () => {
    // The honest reading of GEMINI_MONTHLY_BUDGET_EUR=0. Treating it as unlimited
    // is the one interpretation that could produce a bill nobody asked for, so it
    // is worth a module reload to pin.
    vi.resetModules()
    vi.stubEnv('GEMINI_MONTHLY_BUDGET_EUR', '0')
    try {
      const fresh = await import('../../src/domain/ai/budget.ts')
      const state = fresh.budgetState(db as never, new Date('2026-03-15T03:00:00Z'))
      expect(state.budgetMicroEur).toBe(0)
      expect(state.exceeded).toBe(true)
      // Not NaN, which is what a naive percentage of zero would give.
      expect(state.usedBp).toBe(10_000)
      expect(fresh.checkBudget(db as never, 0, new Date('2026-03-15T03:00:00Z')).reason).toBe(
        'month_budget_exceeded',
      )
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
})
