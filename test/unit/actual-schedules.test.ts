/**
 * What comes back out of `fetchSchedules`, and — more importantly — what does not.
 *
 * Schedules are the first thing Balancr reads from Actual that carries a merchant's
 * name: "Netflix" is right there in the row, beside a payee id and an account id.
 * None of the three is a field this application has any use for, because the figure it
 * produces is a per-category total, and the way they are kept out is structural — the
 * Zod shape does not declare them, so the parse strips them and no type downstream can
 * hold one (#159). That is a property worth a test that fails loudly, because the
 * alternative way to find out is reading `ai_runs.payload_json` after the fact.
 *
 * `@actual-app/api` is mocked, like in `actual-open.test.ts` and for the same reason:
 * `actual-adapter.test.ts` asserts the *real* package still exposes `getSchedules` and
 * `getRules`, and those two intentions cannot share a file because `vi.mock` applies to
 * all of it. So one file says the methods exist and this one says what we do with them.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActualSchedule } from '../../src/adapters/actual/queries.ts'

const getSchedules = vi.fn<() => Promise<unknown[]>>()
const getRules = vi.fn<() => Promise<unknown[]>>()
const init = vi.fn<(config: Record<string, unknown>) => Promise<void>>()

vi.mock('@actual-app/api', () => ({
  init: (config: Record<string, unknown>) => init(config),
  downloadBudget: vi.fn(async () => undefined),
  sync: vi.fn(async () => undefined),
  shutdown: vi.fn(async () => undefined),
  getServerVersion: vi.fn(async () => ({ version: '26.9.0' })),
  getPreferences: vi.fn(async () => ({ budgetType: 'envelope', defaultCurrencyCode: 'EUR' })),
  getSchedules: () => getSchedules(),
  getRules: () => getRules(),
}))

/**
 * Everything a real row carries, including the three fields that must not survive.
 *
 * Written as Actual's `APIScheduleEntity` has it — `amount`, `amountOp` and `date`
 * without the leading underscores of the internal entity — plus `_conditions`, which
 * the shape does not declare at all and which is where the payee text lives.
 */
const NETFLIX = {
  id: 'sch-netflix',
  name: 'Netflix',
  payee: 'payee-9f21',
  account: 'account-3c07',
  amount: -1_399,
  amountOp: 'is',
  date: '2026-09-28',
  next_date: '2026-09-28',
  completed: false,
  posts_transaction: true,
  rule: 'rule-netflix',
  _conditions: [{ op: 'is', field: 'payee', value: 'NETFLIX INTERNATIONAL B.V.' }],
}

/** Strings that must not appear anywhere in the parsed result, at any depth. */
const NEVER_RETURNED = [
  'Netflix',
  'payee-9f21',
  'account-3c07',
  'NETFLIX INTERNATIONAL B.V.',
  'Immo Van Damme',
]

/**
 * Reads schedules with a fresh module graph.
 *
 * The reset matters twice over: `client.ts` caches `opened`, so a second call in one
 * module instance would skip the download, and `config.ts` validates at import, so the
 * temporary data directory has to be in place before either loads.
 */
async function load(schedules: unknown[], rules: unknown[] = []): Promise<ActualSchedule[]> {
  vi.resetModules()
  vi.stubEnv('ACTUAL_DATA_DIR', await mkdtemp(join(tmpdir(), 'balancr-schedules-')))
  getSchedules.mockResolvedValue(schedules)
  getRules.mockResolvedValue(rules)
  const { fetchSchedules } = await import('../../src/adapters/actual/queries.ts')
  return await fetchSchedules()
}

/** A rule that files a schedule under a category, as Actual stores the link. */
const categoryRule = (id: string, categoryId: string, extra: Record<string, unknown> = {}) => ({
  id,
  conditions: [{ op: 'is', field: 'payee', value: 'Immo Van Damme' }],
  actions: [{ op: 'set', field: 'category', value: categoryId }],
  ...extra,
})

beforeEach(() => {
  init.mockReset()
  init.mockResolvedValue(undefined)
  getSchedules.mockReset()
  getRules.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('the parse is the privacy boundary (#159)', () => {
  it('returns the eight fields it declares and nothing else', async () => {
    const schedule = (await load([NETFLIX]))[0]!
    expect(Object.keys(schedule).sort()).toEqual([
      'amountCents',
      'approximate',
      'categoryId',
      'completed',
      'date',
      'id',
      'nextDate',
      'postsTransaction',
    ])
  })

  it('leaves the name, the payee and the account behind in Actual', async () => {
    // Serialised whole rather than checked field by field: the claim is about the
    // object, and a future field carrying a merchant's name would have to defeat this
    // deliberately rather than by being forgotten.
    const parsed = await load([NETFLIX], [categoryRule('rule-netflix', 'cat-subs')])
    const serialised = JSON.stringify(parsed)
    for (const secret of NEVER_RETURNED) expect(serialised).not.toContain(secret)
    // And it did read the row: the amount and the category came through.
    expect(parsed[0]!.amountCents).toBe(-1_399)
    expect(parsed[0]!.categoryId).toBe('cat-subs')
  })
})

describe('the amount', () => {
  const withAmount = (amount: unknown, amountOp: string) => [
    { ...NETFLIX, amount, amountOp },
  ]

  it('is exact when the schedule states one', async () => {
    const schedule = (await load(withAmount(-1_399, 'is')))[0]!
    expect(schedule.amountCents).toBe(-1_399)
    expect(schedule.approximate).toBe(false)
  })

  it('is the upper bound of a range, not its middle', async () => {
    // Actual's own `getScheduledAmount` averages the two, which is right for its "next
    // up" sidebar and wrong for "can this envelope still take what is coming": an
    // average understates the cost half the time, and that is the half worth warning
    // about. `Math.min` in Actual's negative-is-out convention is the larger cost.
    const schedule = (await load(withAmount({ num1: -8_000, num2: -12_000 }, 'isbetween')))[0]!
    expect(schedule.amountCents).toBe(-12_000)
    expect(schedule.approximate).toBe(true)
  })

  it('reads a range stated the other way round the same way', async () => {
    const schedule = (await load(withAmount({ num1: -12_000, num2: -8_000 }, 'isbetween')))[0]!
    expect(schedule.amountCents).toBe(-12_000)
  })

  it('is approximate when the schedule says "about"', async () => {
    const schedule = (await load(withAmount(-5_000, 'isapprox')))[0]!
    expect(schedule.amountCents).toBe(-5_000)
    expect(schedule.approximate).toBe(true)
  })

  it('is zero when the schedule states none, rather than a parse failure', async () => {
    // `amount` is optional in Actual's own entity. Nothing is committed by a schedule
    // with no amount, and `committedForMonth` skips it — which is a better answer than
    // refusing to read the whole list.
    const { amount: _amount, ...noAmount } = NETFLIX
    const schedule = (await load([noAmount]))[0]!
    expect(schedule.amountCents).toBe(0)
  })
})

describe('the category', () => {
  it('comes from the rule the schedule owns', async () => {
    const parsed = await load([NETFLIX], [categoryRule('rule-netflix', 'cat-subs')])
    expect(parsed[0]!.categoryId).toBe('cat-subs')
  })

  it('is null when the schedule owns no rule', async () => {
    const { rule: _rule, ...noRule } = NETFLIX
    const parsed = await load([noRule], [categoryRule('rule-other', 'cat-subs')])
    expect(parsed[0]!.categoryId).toBeNull()
  })

  it('is null when the rule sets no category', async () => {
    // Never inferred from a rule that merely matches a payee: that would attribute
    // money to an envelope by guesswork, which #159 rules out. The schedule lands in
    // the unallocated line instead.
    const parsed = await load([NETFLIX], [
      { id: 'rule-netflix', conditions: [], actions: [{ op: 'set', field: 'notes', value: 'x' }] },
    ])
    expect(parsed[0]!.categoryId).toBeNull()
  })

  it('is null when the rule has been deleted out from under it', async () => {
    const parsed = await load([NETFLIX], [
      categoryRule('rule-netflix', 'cat-subs', { tombstone: true }),
    ])
    expect(parsed[0]!.categoryId).toBeNull()
  })
})

describe('the dates', () => {
  it('reads a one-off as the date it is', async () => {
    const parsed = await load([NETFLIX])
    expect(parsed[0]!.date).toEqual({ kind: 'once', date: '2026-09-28' })
  })

  it('applies every default a recurrence leaves out', async () => {
    // Normalised at the boundary, where Actual's shape is still in view, so the pure
    // expander downstream has no optionality left to guess about.
    const parsed = await load([
      { ...NETFLIX, date: { frequency: 'monthly', start: '2026-01-28' } },
    ])
    expect(parsed[0]!.date).toEqual({
      kind: 'recurring',
      recurrence: {
        frequency: 'monthly',
        interval: 1,
        patterns: [],
        skipWeekend: false,
        weekendSolveMode: 'after',
        start: '2026-01-28',
        endMode: 'never',
        endOccurrences: null,
        endDate: null,
      },
    })
  })

  it('keeps everything a recurrence does state', async () => {
    const parsed = await load([
      {
        ...NETFLIX,
        date: {
          frequency: 'monthly',
          interval: 3,
          patterns: [{ value: -1, type: 'FR' }],
          skipWeekend: true,
          weekendSolveMode: 'before',
          start: '2026-01-30',
          endMode: 'after_n_occurrences',
          endOccurrences: 8,
        },
      },
    ])
    expect(parsed[0]!.date).toEqual({
      kind: 'recurring',
      recurrence: {
        frequency: 'monthly',
        interval: 3,
        patterns: [{ value: -1, type: 'FR' }],
        skipWeekend: true,
        weekendSolveMode: 'before',
        start: '2026-01-30',
        endMode: 'after_n_occurrences',
        endOccurrences: 8,
        endDate: null,
      },
    })
  })

  it('carries Actual own next date through, or null when it has none', async () => {
    expect((await load([NETFLIX]))[0]!.nextDate).toBe('2026-09-28')
    const { next_date: _next, ...noNext } = NETFLIX
    expect((await load([noNext]))[0]!.nextDate).toBeNull()
  })
})

describe('which schedules come back at all', () => {
  it('drops a tombstoned one', async () => {
    // Actual soft-deletes, so a deleted schedule can still be in the list it hands
    // over — and a deleted direct debit is not a commitment.
    const parsed = await load([
      { ...NETFLIX, tombstone: true },
      { ...NETFLIX, id: 'sch-rent', tombstone: false },
    ])
    expect(parsed.map((schedule) => schedule.id)).toEqual(['sch-rent'])
  })

  it('keeps a completed one, and says so', async () => {
    // Filtered later, in `committedForMonth`, rather than here: the adapter reports
    // what Actual holds and the domain decides what it means.
    const parsed = await load([{ ...NETFLIX, completed: true }])
    expect(parsed[0]!.completed).toBe(true)
  })

  it('keeps one Actual does not post itself', async () => {
    // Deliberately not a filter: a schedule somebody pays by hand is still an expected
    // cost and still counts.
    const parsed = await load([{ ...NETFLIX, posts_transaction: false }])
    expect(parsed[0]!.postsTransaction).toBe(false)
  })

  it('treats both flags as false when the row omits them', async () => {
    const { completed: _c, posts_transaction: _p, ...bare } = NETFLIX
    const schedule = (await load([bare]))[0]!
    expect(schedule.completed).toBe(false)
    expect(schedule.postsTransaction).toBe(false)
  })

  it('reads both lists inside one open, so the two agree', async () => {
    // A rule list fetched after a sync that changed a schedule's category would
    // attribute this month's bill to last month's envelope.
    await load([NETFLIX], [categoryRule('rule-netflix', 'cat-subs')])
    expect(init).toHaveBeenCalledTimes(1)
    expect(getSchedules).toHaveBeenCalledTimes(1)
    expect(getRules).toHaveBeenCalledTimes(1)
  })
})

describe('when Actual returns something else entirely', () => {
  it('names getSchedules and the offending field', async () => {
    // Loud rather than silent: a shape change that halved every committed figure would
    // otherwise look like a quiet month.
    await expect(load([{ ...NETFLIX, amountOp: 'is-ish' }])).rejects.toThrow(/getSchedules/)
    await expect(load([{ ...NETFLIX, amountOp: 'is-ish' }])).rejects.toThrow(/amountOp/)
  })

  it('names getRules when the rules are the problem', async () => {
    await expect(load([NETFLIX], [{ id: 'rule-netflix' }])).rejects.toThrow(/getRules/)
  })

  it('refuses a recurrence with no start date', async () => {
    await expect(load([{ ...NETFLIX, date: { frequency: 'monthly' } }])).rejects.toThrow(
      /getSchedules/,
    )
  })
})
