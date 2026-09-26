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
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { importEnvIntegrationsOnce } from '../../src/db/tenant-integrations.ts'
import { costMicroEur, eurToMicroEur } from '../../src/adapters/ai/pricing.ts'
import {
  budgetEur,
  budgetState,
  checkBudget,
  loadSpendHistory,
  loadSpendMonth,
  spendMonthOf,
} from '../../src/domain/ai/budget.ts'
import {
  clearStaleRunData,
  countRunsSince,
  findReusableRun,
  latestSuccessfulRun,
  loadRun,
  loadRunPayload,
  recentRuns,
  recordRun,
  type RecordRun,
  type ReuseKey,
  type RunStatus,
} from '../../src/domain/ai/runs.ts'
import { eq } from 'drizzle-orm'
import { config } from '../../src/config.ts'
import { aiRuns, prompts, tenantIntegrations } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { createSecondTenant } from '../helpers/second-tenant.ts'

let ctx: ReturnType<typeof createTestDb>
let db: ReturnType<typeof createTestDb>['db']
let tenantId: string

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  db = ctx.db
  importEnvIntegrationsOnce(db as never)
  tenantId = getSoleTenantId(db)
})

const MODEL = 'gemini-3.7-flash'
const PROVIDER = 'gemini-aistudio' as const

const run = (overrides: Partial<RecordRun> = {}): RecordRun => ({
  kind: 'findings',
  provider: PROVIDER,
  model: MODEL,
  locale: 'en',
  payload: { month: '2026-03', categories: [{ label: 'c1', spentCents: 42_000 }] },
  payloadHash: 'hash-default',
  status: 'ok',
  usage: { inputTokens: 3_000, outputTokens: 500, cachedTokens: 0, cacheWriteTokens: 0 },
  ...overrides,
})

/**
 * A call that never went out, recorded the way a caller records one: no `usage`
 * field at all, rather than a zeroed one.
 */
const refused = (status: RunStatus): RecordRun => ({
  kind: 'findings',
  provider: PROVIDER,
  model: MODEL,
  locale: 'en',
  payload: { month: '2026-03' },
  payloadHash: 'hash-default',
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
  at(recordRun(db, tenantId, run(overrides)), month)

/** A run for an explicitly chosen tenant, used by isolation regressions. */
const runFor = (runTenantId: string, month: string, overrides: Partial<RecordRun> = {}): string =>
  at(recordRun(db, runTenantId, run(overrides)), month)

describe('recordRun', () => {
  it('stores the payload verbatim, which is what makes the audit possible', () => {
    const payload = { month: '2026-03', categories: [{ label: 'c1', name: 'Groceries' }] }
    const id = recordRun(db, tenantId, run({ payload }))

    // Not a summary, not a hash: the JSON, so a person can look for a payee.
    expect(loadRunPayload(db, tenantId, id)).toEqual(payload)
    expect(loadRun(db, tenantId, id)?.payloadJson).toBe(JSON.stringify(payload))
  })

  it('stores provider identity and cache-write usage on the ledger row', () => {
    const id = recordRun(
      db,
      tenantId,
      run({
        provider: 'gemini-vertex',
        usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 10, cacheWriteTokens: 30 },
      }),
    )

    expect(loadRun(db, tenantId, id)).toMatchObject({
      provider: 'gemini-vertex',
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 10,
      cacheWriteTokens: 30,
    })
  })

  it('derives the cost from the model and the tokens', () => {
    const id = recordRun(db, tenantId, run())
    expect(loadRun(db, tenantId, id)?.costMicroEur).toBe(
      costMicroEur(PROVIDER, MODEL, { inputTokens: 3_000, outputTokens: 500, cachedTokens: 0, cacheWriteTokens: 0 }),
    )
  })

  it('records a refused run at zero cost, with the payload it would have sent', () => {
    // A missing answer that explains itself, rather than one that is just absent.
    const id = recordRun(db, tenantId, refused('capped'))
    const row = loadRun(db, tenantId, id)
    expect(row?.status).toBe('capped')
    expect(row?.costMicroEur).toBe(0)
    expect(row?.inputTokens).toBe(0)
    expect(loadRunPayload(db, tenantId, id)).not.toBeNull()
  })

  it('prices an unknown model rather than treating it as free', () => {
    const id = recordRun(db, tenantId, run({ model: 'gemini-9-something' }))
    expect(loadRun(db, tenantId, id)?.costMicroEur).toBeGreaterThan(0)
  })

  it('accepts an override for a price we do not model', () => {
    const id = recordRun(db, tenantId, run({ costMicroEurOverride: 4_242 }))
    expect(loadRun(db, tenantId, id)?.costMicroEur).toBe(4_242)
  })

  it('keeps the error text on a failed run', () => {
    const id = recordRun(db, tenantId, run({ status: 'error', error: 'model response was not JSON' }))
    expect(loadRun(db, tenantId, id)?.error).toBe('model response was not JSON')
  })

  it('leaves promptId null for a run on the built-in prompt', () => {
    const id = recordRun(db, tenantId, run())
    expect(loadRun(db, tenantId, id)?.promptId).toBeNull()
  })

  it('stores the exact request and response text verbatim (#497)', () => {
    const id = recordRun(
      db,
      tenantId,
      run({ requestText: 'system + instruction + data, exactly as sent', responseText: '{"findings":[]}' }),
    )
    const row = loadRun(db, tenantId, id)
    expect(row?.requestText).toBe('system + instruction + data, exactly as sent')
    expect(row?.responseText).toBe('{"findings":[]}')
  })

  it('defaults request and response text to null (#497)', () => {
    const id = recordRun(db, tenantId, run())
    const row = loadRun(db, tenantId, id)
    expect(row?.requestText).toBeNull()
    expect(row?.responseText).toBeNull()
  })
})

describe('loadRun and loadRunPayload', () => {
  it('returns null for an id that does not exist', () => {
    expect(loadRun(db, tenantId, 'nope')).toBeNull()
    expect(loadRunPayload(db, tenantId, 'nope')).toBeNull()
  })

  it('returns null rather than throwing on unreadable JSON', () => {
    // The audit view: a row whose payload cannot be parsed is itself the finding,
    // and it must not take the page down.
    const id = recordRun(db, tenantId, run())
    ctx.sqlite.prepare('update ai_runs set payload_json = ? where id = ?').run('{oops', id)
    expect(loadRunPayload(db, tenantId, id)).toBeNull()
  })

  it("does not return another tenant's run (#377)", () => {
    const otherTenantId = createSecondTenant(db)
    const id = recordRun(db, tenantId, run())

    expect(loadRun(db, otherTenantId, id)).toBeNull()
    expect(loadRunPayload(db, otherTenantId, id)).toBeNull()
  })
})

describe('latestSuccessfulRun', () => {
  it('is the newest ok run of that kind', () => {
    const older = recordRun(db, tenantId, run())
    backdate(older, new Date('2026-03-01T00:00:00Z'))
    const newer = recordRun(db, tenantId, run())
    backdate(newer, new Date('2026-03-02T00:00:00Z'))

    expect(latestSuccessfulRun(db, tenantId, 'findings')?.id).toBe(newer)
  })

  it('ignores errored and capped runs, which have no usable output', () => {
    const good = recordRun(db, tenantId, run())
    backdate(good, new Date('2026-03-01T00:00:00Z'))
    for (const status of ['error', 'capped', 'blocked'] as const) {
      const id = recordRun(db, tenantId, run({ status }))
      backdate(id, new Date('2026-03-05T00:00:00Z'))
    }

    expect(latestSuccessfulRun(db, tenantId, 'findings')?.id).toBe(good)
  })

  it('does not cross kinds', () => {
    recordRun(db, tenantId, run({ kind: 'narrative' }))
    expect(latestSuccessfulRun(db, tenantId, 'findings')).toBeNull()
  })

  it('is null on an empty ledger', () => {
    expect(latestSuccessfulRun(db, tenantId, 'findings')).toBeNull()
  })

  it("does not cross tenants (#377)", () => {
    const otherTenantId = createSecondTenant(db)
    recordRun(db, tenantId, run())
    expect(latestSuccessfulRun(db, otherTenantId, 'findings')).toBeNull()
  })
})

describe('findReusableRun', () => {
  let promptA: string
  let promptB: string

  beforeEach(() => {
    promptA = db
      .insert(prompts)
      .values({ tenantId, key: 'analysis.system', locale: 'en', version: 1, body: 'a' })
      .returning({ id: prompts.id })
      .get()!.id
    promptB = db
      .insert(prompts)
      .values({ tenantId, key: 'analysis.system', locale: 'en', version: 2, body: 'b' })
      .returning({ id: prompts.id })
      .get()!.id
  })

  const key = (overrides: Partial<ReuseKey> = {}): ReuseKey => ({
    kind: 'findings',
    period: '2026-03',
    locale: 'en',
    payloadHash: 'hash-a',
    promptId: promptA,
    model: MODEL,
    ...overrides,
  })

  /** A source run matching `key()` exactly, unless told otherwise. */
  const source = (overrides: Partial<RecordRun> = {}): RecordRun =>
    run({
      kind: 'findings',
      period: '2026-03',
      locale: 'en',
      payloadHash: 'hash-a',
      promptId: promptA,
      model: MODEL,
      status: 'ok',
      ...overrides,
    })

  it('matches a run agreeing on every field of the key', () => {
    const id = recordRun(db, tenantId, source())
    expect(findReusableRun(db, tenantId, key())?.id).toBe(id)
  })

  it('keeps reusable runs scoped between Gemini, OpenAI-compatible and Anthropic', () => {
    const providers = ['gemini-aistudio', 'openai-compatible', 'anthropic'] as const
    const ids = new Map(providers.map((provider) => [provider, recordRun(db, tenantId, source({ provider }))]))

    for (const provider of providers) {
      db.update(tenantIntegrations)
        .set({ aiProvider: provider })
        .where(eq(tenantIntegrations.tenantId, tenantId))
        .run()
      expect(findReusableRun(db, tenantId, key())?.id).toBe(ids.get(provider))
    }
  })

  it.each([
    ['kind', { kind: 'narrative' as const }],
    ['period', { period: '2026-04' }],
    ['locale', { locale: 'nl' }],
    ['payloadHash', { payloadHash: 'hash-b' }],
    ['model', { model: 'gemini-3.1-pro-preview' }],
  ] as const)('misses when %s differs', (_field, override) => {
    recordRun(db, tenantId, source(override))
    expect(findReusableRun(db, tenantId, key())).toBeNull()
  })

  it('matches a stored snapshot beyond the alias it was asked for (#606)', () => {
    // `source().model` is the exact answer Google gave; `key().model` is the
    // configured alias — the whole reason this is a prefix match rather than
    // equality.
    const id = recordRun(db, tenantId, source({ model: `${MODEL}-002` }))
    expect(findReusableRun(db, tenantId, key())?.id).toBe(id)
  })

  it('misses when promptId differs', () => {
    recordRun(db, tenantId, source({ promptId: promptB }))
    expect(findReusableRun(db, tenantId, key())).toBeNull()
  })

  it('matches a null promptId only against a null promptId', () => {
    recordRun(db, tenantId, source({ promptId: null }))
    expect(findReusableRun(db, tenantId, key({ promptId: null }))).not.toBeNull()
    expect(findReusableRun(db, tenantId, key())).toBeNull()
  })

  it.each(['capped', 'error', 'blocked', 'reused'] as const)(
    'never treats a %s run as a source',
    (status) => {
      recordRun(db, tenantId, source({ status }))
      expect(findReusableRun(db, tenantId, key())).toBeNull()
    },
  )

  it('returns the newest match when several agree', () => {
    const older = recordRun(db, tenantId, source())
    backdate(older, new Date('2026-03-01T00:00:00Z'))
    const newer = recordRun(db, tenantId, source())
    backdate(newer, new Date('2026-03-05T00:00:00Z'))

    expect(findReusableRun(db, tenantId, key())?.id).toBe(newer)
  })

  it('is null on an empty ledger', () => {
    expect(findReusableRun(db, tenantId, key())).toBeNull()
  })
})

describe('recentRuns', () => {
  it('is newest first and honours the limit', () => {
    for (let day = 1; day <= 5; day += 1) {
      const id = recordRun(db, tenantId, run())
      backdate(id, new Date(`2026-03-0${day}T00:00:00Z`))
    }

    const rows = recentRuns(db, tenantId, 3)
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.createdAt.getTime())).toEqual([
      new Date('2026-03-05T00:00:00Z').getTime(),
      new Date('2026-03-04T00:00:00Z').getTime(),
      new Date('2026-03-03T00:00:00Z').getTime(),
    ])
  })

  it('includes every status, because the spend page shows refusals too', () => {
    recordRun(db, tenantId, run({ status: 'capped' }))
    recordRun(db, tenantId, run({ status: 'error' }))
    expect(recentRuns(db, tenantId)).toHaveLength(2)
  })

  it('scoped to a month, keeps that month and every run about no month at all (#158)', () => {
    const august = recordRun(db, tenantId, run({ period: '2026-08' }))
    const july = recordRun(db, tenantId, run({ period: '2026-07' }))
    const chat = recordRun(db, tenantId, run({ period: null }))

    const rows = recentRuns(db, tenantId, 50, '2026-08').map((row) => row.id)
    expect(rows).toContain(august)
    expect(rows).toContain(chat)
    expect(rows).not.toContain(july)
  })

  it('leaves every run in when no period is asked for, the spend page ledger', () => {
    recordRun(db, tenantId, run({ period: '2026-08' }))
    recordRun(db, tenantId, run({ period: '2026-07' }))
    recordRun(db, tenantId, run({ period: null }))
    expect(recentRuns(db, tenantId, 50)).toHaveLength(3)
  })

  it('scoped to a year, keeps every month in it and every run about no month at all (#345)', () => {
    const august2026 = recordRun(db, tenantId, run({ period: '2026-08' }))
    const january2026 = recordRun(db, tenantId, run({ period: '2026-01' }))
    const august2025 = recordRun(db, tenantId, run({ period: '2025-08' }))
    const chat = recordRun(db, tenantId, run({ period: null }))

    const rows = recentRuns(db, tenantId, 50, { kind: 'year', value: '2026' }).map((row) => row.id)
    expect(rows).toContain(august2026)
    expect(rows).toContain(january2026)
    expect(rows).toContain(chat)
    expect(rows).not.toContain(august2025)
  })

  it('accepts a month via the same {kind, value} shape as a plain string', () => {
    const august = recordRun(db, tenantId, run({ period: '2026-08' }))
    const july = recordRun(db, tenantId, run({ period: '2026-07' }))

    const rows = recentRuns(db, tenantId, 50, { kind: 'month', value: '2026-08' }).map(
      (row) => row.id,
    )
    expect(rows).toContain(august)
    expect(rows).not.toContain(july)
  })

  it('does not cross tenants (#377)', () => {
    const otherTenantId = createSecondTenant(db)
    recordRun(db, tenantId, run())
    expect(recentRuns(db, otherTenantId, 50)).toHaveLength(0)
  })

  it('pages backwards from a cursor, picking up exactly where the prior page stopped (#502)', () => {
    const ids: string[] = []
    for (let day = 1; day <= 5; day += 1) {
      const id = recordRun(db, tenantId, run())
      backdate(id, new Date(`2026-03-0${day}T00:00:00Z`))
      ids.push(id)
    }
    const [, , third, , fifth] = ids as [string, string, string, string, string]

    const firstPage = recentRuns(db, tenantId, 2)
    expect(firstPage.map((row) => row.id)).toEqual([fifth, ids[3]])

    const last = firstPage[firstPage.length - 1]!
    const secondPage = recentRuns(db, tenantId, 2, undefined, {
      createdAt: last.createdAt,
      seq: last.seq,
    })
    expect(secondPage.map((row) => row.id)).toEqual([third, ids[1]])
  })

  it('breaks a tie on the same millisecond by insertion order, not id (#510)', () => {
    // `id` is a random UUID with no relation to insertion order — before #510, two
    // runs sharing a millisecond broke their tie on it, making "newest first" a coin
    // flip. `seq` is assigned in strict insertion order (#514), so `b` (recorded
    // second) must always come first.
    const same = new Date('2026-03-10T00:00:00Z')
    const a = recordRun(db, tenantId, run())
    const b = recordRun(db, tenantId, run())
    backdate(a, same)
    backdate(b, same)

    const [newest, oldest] = recentRuns(db, tenantId, 2)
    expect(newest!.id).toBe(b)
    expect(oldest!.id).toBe(a)

    const nextPage = recentRuns(db, tenantId, 2, undefined, {
      createdAt: newest!.createdAt,
      seq: newest!.seq,
    })
    expect(nextPage.map((row) => row.id)).toEqual([oldest!.id])
  })
})

describe('clearStaleRunData (#503, #539)', () => {
  const CUTOFF = new Date('2026-03-01T00:00:00Z')

  it('nulls the text and payload on a run older than the cutoff', () => {
    const id = recordRun(
      db,
      tenantId,
      run({ requestText: 'the request', responseText: 'the response' }),
    )
    backdate(id, new Date('2026-02-01T00:00:00Z'))

    expect(clearStaleRunData(db, tenantId, CUTOFF)).toBe(1)

    const row = loadRun(db, tenantId, id)
    expect(row?.requestText).toBeNull()
    expect(row?.responseText).toBeNull()
    expect(row?.payloadJson).toBeNull()
    expect(loadRunPayload(db, tenantId, id)).toBeNull()
  })

  it('leaves a recent run’s text and payload untouched', () => {
    const id = recordRun(
      db,
      tenantId,
      run({ requestText: 'the request', responseText: 'the response' }),
    )
    backdate(id, new Date('2026-03-15T00:00:00Z'))

    expect(clearStaleRunData(db, tenantId, CUTOFF)).toBe(0)

    const row = loadRun(db, tenantId, id)
    expect(row?.requestText).toBe('the request')
    expect(row?.responseText).toBe('the response')
    expect(loadRunPayload(db, tenantId, id)).not.toBeNull()
  })

  it('keeps payloadHash on a cleared row, so a later attempt can still find it (#160)', () => {
    const id = recordRun(db, tenantId, run({ payloadHash: 'hash-abc' }))
    backdate(id, new Date('2026-01-15T00:00:00Z'))

    clearStaleRunData(db, tenantId, CUTOFF)

    expect(loadRun(db, tenantId, id)?.payloadHash).toBe('hash-abc')
  })

  it('leaves cost, status and period on the cleared row untouched', () => {
    const id = recordRun(
      db,
      tenantId,
      run({
        requestText: 'the request',
        responseText: 'the response',
        period: '2026-01',
        status: 'ok',
      }),
    )
    backdate(id, new Date('2026-01-15T00:00:00Z'))

    clearStaleRunData(db, tenantId, CUTOFF)

    const row = loadRun(db, tenantId, id)
    expect(row?.period).toBe('2026-01')
    expect(row?.status).toBe('ok')
    expect(row?.costMicroEur).toBeGreaterThan(0)
  })

  it('returns 0 and touches nothing when every run is already recent', () => {
    const id = recordRun(
      db,
      tenantId,
      run({ requestText: 'the request', responseText: 'the response' }),
    )
    backdate(id, new Date('2026-03-15T00:00:00Z'))

    expect(clearStaleRunData(db, tenantId, CUTOFF)).toBe(0)
  })

  it('does not cross tenants', () => {
    const otherTenantId = createSecondTenant(db)
    const id = recordRun(
      db,
      otherTenantId,
      run({ requestText: 'the request', responseText: 'the response' }),
    )
    backdate(id, new Date('2026-02-01T00:00:00Z'))

    expect(clearStaleRunData(db, tenantId, CUTOFF)).toBe(0)
    expect(loadRun(db, otherTenantId, id)?.requestText).toBe('the request')
  })

  it('returns 0 the second time, once there is nothing left to clear', () => {
    const id = recordRun(
      db,
      tenantId,
      run({ requestText: 'the request', responseText: 'the response' }),
    )
    backdate(id, new Date('2026-02-01T00:00:00Z'))

    expect(clearStaleRunData(db, tenantId, CUTOFF)).toBe(1)
    expect(clearStaleRunData(db, tenantId, CUTOFF)).toBe(0)
  })

  it('ignores a run older than `since`, the lower bound (#512)', () => {
    const id = recordRun(
      db,
      tenantId,
      run({ requestText: 'the request', responseText: 'the response' }),
    )
    backdate(id, new Date('2026-01-01T00:00:00Z'))

    expect(clearStaleRunData(db, tenantId, CUTOFF, new Date('2026-01-15T00:00:00Z'))).toBe(0)

    const row = loadRun(db, tenantId, id)
    expect(row?.requestText).toBe('the request')
  })

  it('clears a run inside the [since, olderThan) window', () => {
    const id = recordRun(
      db,
      tenantId,
      run({ requestText: 'the request', responseText: 'the response' }),
    )
    backdate(id, new Date('2026-01-20T00:00:00Z'))

    expect(clearStaleRunData(db, tenantId, CUTOFF, new Date('2026-01-15T00:00:00Z'))).toBe(1)

    const row = loadRun(db, tenantId, id)
    expect(row?.requestText).toBeNull()
  })

  it('matches nothing when `since` falls after `olderThan`, rather than skipping rows', () => {
    const id = recordRun(
      db,
      tenantId,
      run({ requestText: 'the request', responseText: 'the response' }),
    )
    backdate(id, new Date('2026-02-01T00:00:00Z'))

    // A `since` after `olderThan` — the shape a shortened retention window can
    // produce for one run — must not be treated as "clear everything below it".
    expect(clearStaleRunData(db, tenantId, CUTOFF, new Date('2026-02-15T00:00:00Z'))).toBe(0)

    const row = loadRun(db, tenantId, id)
    expect(row?.requestText).toBe('the request')
  })
})

describe('ai_spend_monthly', () => {
  it('is zeroes for a month with no runs, not a missing row', () => {
    expect(loadSpendMonth(db, tenantId, '2026-03')).toEqual({
      month: '2026-03',
      runCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      costMicroEur: 0,
    })
  })

  it('sums tokens and cost across the month', () => {
    runIn('2026-03')
    runIn('2026-03')

    const month = loadSpendMonth(db, tenantId, '2026-03')
    expect(month.runCount).toBe(2)
    expect(month.inputTokens).toBe(6_000)
    expect(month.outputTokens).toBe(1_000)
    expect(month.cacheWriteTokens).toBe(0)
    expect(month.costMicroEur).toBe(
      2 * costMicroEur(PROVIDER, MODEL, { inputTokens: 3_000, outputTokens: 500, cachedTokens: 0, cacheWriteTokens: 0 }),
    )
  })

  it('sums cache-write tokens separately from cache reads', () => {
    runIn('2026-03', {
      usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 30, cacheWriteTokens: 40 },
    })

    expect(loadSpendMonth(db, tenantId, '2026-03')).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 30,
      cacheWriteTokens: 40,
    })
  })

  it('counts a run whatever its status', () => {
    // An errored run still cost money; a capped one costs zero. Summing the
    // column is therefore right in both directions, with no status filter.
    runIn('2026-03', { status: 'error' })
    at(recordRun(db, tenantId, refused('capped')), '2026-03')

    const month = loadSpendMonth(db, tenantId, '2026-03')
    expect(month.runCount).toBe(2)
    expect(month.costMicroEur).toBe(
      costMicroEur(PROVIDER, MODEL, { inputTokens: 3_000, outputTokens: 500, cachedTokens: 0, cacheWriteTokens: 0 }),
    )
  })

  it('separates months', () => {
    runIn('2026-02')
    runIn('2026-03')
    runIn('2026-03')

    expect(loadSpendMonth(db, tenantId, '2026-02').runCount).toBe(1)
    expect(loadSpendMonth(db, tenantId, '2026-03').runCount).toBe(2)
  })

  it('groups by the UTC month, the same rule spendMonthOf uses', () => {
    // 2026-03-01 00:30 Brussels is still February in UTC. The boundary hour is
    // the documented cost of a view SQLite can actually compute.
    const id = recordRun(db, tenantId, run())
    backdate(id, new Date('2026-02-28T23:30:00Z'))

    expect(loadSpendMonth(db, tenantId, '2026-02').runCount).toBe(1)
    expect(loadSpendMonth(db, tenantId, '2026-03').runCount).toBe(0)
    expect(spendMonthOf(new Date('2026-02-28T23:30:00Z'))).toBe('2026-02')
  })

  it('lists history newest first', () => {
    runIn('2026-01')
    runIn('2026-02')
    runIn('2026-03')

    expect(loadSpendHistory(db, tenantId).map((month) => month.month)).toEqual([
      '2026-03',
      '2026-02',
      '2026-01',
    ])
  })

  it('limits history to the most recent months', () => {
    runIn('2026-01')
    runIn('2026-02')
    runIn('2026-03')

    expect(loadSpendHistory(db, tenantId, 2).map((month) => month.month)).toEqual([
      '2026-03',
      '2026-02',
    ])
  })

  it("excludes another tenant's runs from the same months (#411)", () => {
    const otherTenantId = createSecondTenant(db)
    runFor(tenantId, '2026-02', { costMicroEurOverride: eurToMicroEur(1) })
    runFor(tenantId, '2026-03', { costMicroEurOverride: eurToMicroEur(2) })
    runFor(otherTenantId, '2026-03', { costMicroEurOverride: eurToMicroEur(9) })

    expect(loadSpendHistory(db, tenantId)).toMatchObject([
      { month: '2026-03', runCount: 1, costMicroEur: eurToMicroEur(2) },
      { month: '2026-02', runCount: 1, costMicroEur: eurToMicroEur(1) },
    ])
    expect(loadSpendMonth(db, otherTenantId, '2026-03')).toMatchObject({
      runCount: 1,
      costMicroEur: eurToMicroEur(9),
    })
  })
})

describe('budgetState', () => {
  const now = new Date('2026-03-15T03:00:00Z')
  let tenantId: string
  beforeEach(() => {
    tenantId = getSoleTenantId(db)
  })

  it('reports an untouched month as fully available', () => {
    const state = budgetState(db, tenantId, now)
    expect(state.month).toBe('2026-03')
    expect(state.spentMicroEur).toBe(0)
    expect(state.budgetMicroEur).toBe(eurToMicroEur(config.GEMINI_MONTHLY_BUDGET_EUR))
    expect(state.remainingMicroEur).toBe(state.budgetMicroEur)
    expect(state.usedBp).toBe(0)
    expect(state.exceeded).toBe(false)
  })

  it('measures spend against the budget in basis points', () => {
    runIn('2026-03', { costMicroEurOverride: eurToMicroEur(3.75) })

    const state = budgetState(db, tenantId, now)
    expect(state.spentMicroEur).toBe(eurToMicroEur(3.75))
    // 3.75 of 15 euro.
    expect(state.usedBp).toBe(2_500)
    expect(state.remainingMicroEur).toBe(eurToMicroEur(11.25))
    expect(state.exceeded).toBe(false)
  })

  it('clamps an overspend rather than reporting a negative remainder', () => {
    runIn('2026-03', { costMicroEurOverride: eurToMicroEur(20) })

    const state = budgetState(db, tenantId, now)
    expect(state.remainingMicroEur).toBe(0)
    expect(state.usedBp).toBe(10_000)
    expect(state.exceeded).toBe(true)
  })

  it('is exceeded exactly at the budget, not one micro-euro past it', () => {
    runIn('2026-03', { costMicroEurOverride: eurToMicroEur(config.GEMINI_MONTHLY_BUDGET_EUR) })
    expect(budgetState(db, tenantId, now).exceeded).toBe(true)
  })

  it("ignores another month's spend", () => {
    runIn('2026-02', { costMicroEurOverride: eurToMicroEur(20) })
    expect(budgetState(db, tenantId, now).exceeded).toBe(false)
  })

  it('converts to euros for a banner', () => {
    runIn('2026-03', { costMicroEurOverride: eurToMicroEur(2.5) })
    expect(budgetEur(budgetState(db, tenantId, now))).toEqual({ spent: 2.5, budget: 15 })
  })

  it("does not let another tenant's exhausted budget block this tenant (#411)", () => {
    const otherTenantId = createSecondTenant(db)
    db.update(tenantIntegrations)
      .set({ aiMonthlyBudgetEurMicro: eurToMicroEur(1) })
      .where(eq(tenantIntegrations.tenantId, otherTenantId))
      .run()
    runFor(otherTenantId, '2026-03', { costMicroEurOverride: eurToMicroEur(1) })

    expect(budgetState(db, otherTenantId, now)).toMatchObject({
      budgetMicroEur: eurToMicroEur(1),
      remainingMicroEur: 0,
      exceeded: true,
    })
    expect(budgetState(db, tenantId, now)).toMatchObject({
      budgetMicroEur: eurToMicroEur(config.GEMINI_MONTHLY_BUDGET_EUR),
      spentMicroEur: 0,
      remainingMicroEur: eurToMicroEur(config.GEMINI_MONTHLY_BUDGET_EUR),
      exceeded: false,
    })
  })

  it("changes one tenant's allowance only when that tenant spends (#411)", () => {
    const otherTenantId = createSecondTenant(db)
    const before = budgetState(db, tenantId, now)

    runFor(otherTenantId, '2026-03', { costMicroEurOverride: eurToMicroEur(4) })
    expect(budgetState(db, tenantId, now)).toEqual(before)

    runFor(tenantId, '2026-03', { costMicroEurOverride: eurToMicroEur(3) })
    expect(budgetState(db, tenantId, now).remainingMicroEur).toBe(
      before.remainingMicroEur - eurToMicroEur(3),
    )
  })
})

describe('checkBudget', () => {
  const now = new Date('2026-03-15T03:00:00Z')
  let tenantId: string
  beforeEach(() => {
    tenantId = getSoleTenantId(db)
  })

  it('allows a call inside the budget', () => {
    const decision = checkBudget(db, tenantId, eurToMicroEur(0.02), now)
    expect(decision).toMatchObject({ allowed: true, reason: 'ok' })
  })

  it('refuses once the month is spent, with a code rather than a sentence', () => {
    runIn('2026-03', { costMicroEurOverride: eurToMicroEur(15) })

    const decision = checkBudget(db, tenantId, 0, now)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('month_budget_exceeded')
    // The state travels with the decision: the banner shows the figures.
    expect(decision.state.spentMicroEur).toBe(eurToMicroEur(15))
  })

  it('refuses an estimate larger than what is left, not just larger than the budget', () => {
    // A month at 95% must not be allowed to start a run costing half the budget.
    runIn('2026-03', { costMicroEurOverride: eurToMicroEur(14.5) })

    const decision = checkBudget(db, tenantId, eurToMicroEur(1), now)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('estimate_exceeds_remaining')
  })

  it('allows an estimate that exactly fits', () => {
    runIn('2026-03', { costMicroEurOverride: eurToMicroEur(14) })
    expect(checkBudget(db, tenantId, eurToMicroEur(1), now).allowed).toBe(true)
  })

  it('allows a call with no estimate given', () => {
    expect(checkBudget(db, tenantId, undefined, now).allowed).toBe(true)
  })
})

describe('a zero budget', () => {
  it('means no AI spend at all, from the first call', () => {
    // The honest reading of a tenant's budget set to 0. Treating it as unlimited
    // is the one interpretation that could produce a bill nobody asked for.
    const tenantId = getSoleTenantId(db)
    db.update(tenantIntegrations)
      .set({ aiMonthlyBudgetEurMicro: 0 })
      .where(eq(tenantIntegrations.tenantId, tenantId))
      .run()

    const state = budgetState(db, tenantId, new Date('2026-03-15T03:00:00Z'))
    expect(state.budgetMicroEur).toBe(0)
    expect(state.exceeded).toBe(true)
    // Not NaN, which is what a naive percentage of zero would give.
    expect(state.usedBp).toBe(10_000)
    expect(checkBudget(db, tenantId, 0, new Date('2026-03-15T03:00:00Z')).reason).toBe(
      'month_budget_exceeded',
    )
  })
})

describe('countRunsSince (#454)', () => {
  const NOW = new Date('2026-09-10T12:00:00.000Z')
  const since = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 60 * 60 * 1_000)

  /** One row of a kind and status, backdated by `hoursAgo`. */
  const recordAt = (
    forTenant: string,
    hoursAgo: number,
    overrides: Partial<RecordRun> = {},
  ): string => {
    const id = recordRun(db, forTenant, run({ kind: 'prompt_validation', ...overrides }))
    // `createdAt` has a default rather than a parameter, so the clock is moved afterwards —
    // which is also the only way to write a row older than this process.
    db.update(aiRuns).set({ createdAt: since(hoursAgo) }).where(eq(aiRuns.id, id)).run()
    return id
  }

  it('counts this tenant’s rows of the given kind inside the window', () => {
    recordAt(tenantId, 1)
    recordAt(tenantId, 5)
    recordAt(tenantId, 23)

    expect(countRunsSince(db, tenantId, 'prompt_validation', since(24))).toBe(3)
  })

  it('excludes a row older than the window', () => {
    recordAt(tenantId, 1)
    // 25 hours: the case the daily cap exists to let through, so today's allowance is
    // genuinely a rolling day and not a counter that never resets.
    recordAt(tenantId, 25)

    expect(countRunsSince(db, tenantId, 'prompt_validation', since(24))).toBe(1)
  })

  it('excludes another kind of run', () => {
    recordAt(tenantId, 1, { kind: 'narrative' })
    recordAt(tenantId, 1, { kind: 'prompt_validation' })

    expect(countRunsSince(db, tenantId, 'prompt_validation', since(24))).toBe(1)
  })

  it('excludes a second tenant’s matching row', () => {
    const other = createSecondTenant(db)
    recordAt(tenantId, 1)
    recordAt(other, 1)
    recordAt(other, 2)

    expect(countRunsSince(db, tenantId, 'prompt_validation', since(24))).toBe(1)
    expect(countRunsSince(db, other, 'prompt_validation', since(24))).toBe(2)
  })

  it('narrows to a status set, which is how refusals stay free', () => {
    // `ok` and `error` spent something; `blocked` and `capped` never reached a provider, so
    // counting them would charge a tenant an attempt for being refused one.
    recordAt(tenantId, 1, { status: 'ok' })
    recordAt(tenantId, 1, { status: 'error' })
    recordAt(tenantId, 1, { status: 'blocked' })
    recordAt(tenantId, 1, { status: 'capped' })

    expect(countRunsSince(db, tenantId, 'prompt_validation', since(24), ['ok', 'error'])).toBe(2)
    // Omitted, every status counts — a different question, and one this function can answer.
    expect(countRunsSince(db, tenantId, 'prompt_validation', since(24))).toBe(4)
  })

  it('is zero rather than null on an empty ledger', () => {
    expect(countRunsSince(db, tenantId, 'prompt_validation', since(24), ['ok'])).toBe(0)
  })
})
