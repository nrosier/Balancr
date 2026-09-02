/**
 * The clarification queue.
 *
 * `category_meta` is the only table here whose contents cannot be rebuilt from
 * Actual or Ghostfolio, and this is how it gets filled in — so the tests that
 * matter are the ones about *not* asking:
 *
 *  - **Two floors, both required.** A relative floor alone interrogates you about
 *    a small envelope in a quiet month; an absolute one alone interrogates you
 *    about every minor line in a large budget.
 *  - **Asked once, including when the answer looks like the default.** Answering
 *    "every month" writes `monthly`, which is also the column default — so the
 *    column cannot be what stops the repeat, and the queue's own history has to be.
 *  - **One transaction.** An answer stored without closing its question gets
 *    asked again; a question closed without storing its answer never does.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { categoryMeta, clarificationQueue } from '../../src/db/schema.ts'
import { loadAuditTrail } from '../../src/domain/audit.ts'
import {
  answerClarification,
  choicesFor,
  ClarifyError,
  DEFAULT_CLARIFY_POLICY,
  dismissClarification,
  enqueueClarifications,
  materialityBp,
  MAX_DESCRIPTION_CHARS,
  normaliseDescription,
  openQuestionCount,
  openQuestions,
  parseAnswer,
  storedGuess,
  type ClarifyCandidate,
} from '../../src/domain/ai/clarify.ts'
import { initI18n } from '../../src/i18n/index.ts'
import { fact, seedMonth, totals } from '../fixtures/month.ts'
import { persistMonthTotals } from '../../src/domain/aggregate/month-store.ts'

const MONTH = '2026-03'

let ctx: ReturnType<typeof createTestDb>
let db: Db

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  db = ctx.db
})

/**
 * A month whose totals say EUR 3 100 was spent, with two categories at EUR 100
 * each: comfortably over both floors, so a test about anything else does not have
 * to think about materiality.
 */
function seedTypicalMonth(): void {
  seedMonth(db, MONTH, {
    facts: [
      fact(MONTH, 'food', { categoryName: 'Groceries' }),
      fact(MONTH, 'rent', { categoryName: 'Rent', spentCents: 90_000 }),
    ],
  })
}

const candidate = (overrides: Partial<ClarifyCandidate> = {}): ClarifyCandidate => ({
  code: 'nature_unknown',
  categoryId: 'food',
  guess: 'variable',
  ...overrides,
})

const openRow = (categoryId = 'food'): typeof clarificationQueue.$inferSelect => {
  const row = db
    .select()
    .from(clarificationQueue)
    .where(eq(clarificationQueue.categoryId, categoryId))
    .all()[0]
  if (row === undefined) throw new Error(`no queued question for ${categoryId}`)
  return row
}

const metaOf = (categoryId: string): typeof categoryMeta.$inferSelect => {
  const row = db.select().from(categoryMeta).where(eq(categoryMeta.categoryId, categoryId)).get()
  if (row === undefined) throw new Error(`no metadata for ${categoryId}`)
  return row
}

describe('materialityBp', () => {
  it('is the share of the month, in basis points', () => {
    expect(materialityBp(10_000, 100_000)).toBe(1_000)
  })

  it('is zero when the month spent nothing, rather than dividing by it', () => {
    expect(materialityBp(10_000, 0)).toBe(0)
  })

  it('reads a signed amount by its size', () => {
    expect(materialityBp(-10_000, 100_000)).toBe(1_000)
  })
})

describe('enqueueClarifications', () => {
  it('queues a material question with the guess and the run that made it', () => {
    seedTypicalMonth()

    const result = enqueueClarifications(db, {
      month: MONTH,
      candidates: [candidate()],
      runId: 'run-1',
    })

    expect(result.enqueued).toHaveLength(1)
    const row = openRow()
    expect(row.questionCode).toBe('nature_unknown')
    expect(row.status).toBe('open')
    expect(row.runId).toBe('run-1')
    expect(row.materialityBp).toBe(materialityBp(10_000, totals(MONTH).spentCents))
    expect(storedGuess(row)).toBe('variable')
  })

  it('does nothing at all when the model asked nothing', () => {
    seedTypicalMonth()
    expect(enqueueClarifications(db, { month: MONTH, candidates: [] })).toEqual({
      enqueued: [],
      skipped: [],
    })
  })

  it('skips a category too small to be worth a question', () => {
    seedMonth(db, MONTH, {
      facts: [
        fact(MONTH, 'food'),
        fact(MONTH, 'stamps', { spentCents: 400 }),
      ],
    })

    const result = enqueueClarifications(db, {
      month: MONTH,
      candidates: [candidate({ categoryId: 'stamps' })],
    })

    expect(result.enqueued).toEqual([])
    expect(result.skipped[0]?.reason).toBe('immaterial')
  })

  it('skips a large share of a quiet month, because the amount is still small', () => {
    // The case a relative floor alone gets wrong: EUR 40 is 8% of a EUR 500
    // month, and still not worth a question.
    seedMonth(db, MONTH, { facts: [fact(MONTH, 'coffee', { spentCents: 4_000 })] })
    // Overwrites the fixture's total: seedMonth writes an ordinary month, and this
    // test needs a quiet one.
    persistMonthTotals(db, [totals(MONTH, { spentCents: 50_000 })], [])

    const result = enqueueClarifications(db, {
      month: MONTH,
      candidates: [candidate({ categoryId: 'coffee' })],
    })

    expect(result.skipped[0]?.materialityBp).toBeGreaterThan(
      DEFAULT_CLARIFY_POLICY.materialityFloorBp,
    )
    expect(result.skipped[0]?.reason).toBe('immaterial')
  })

  it('skips a category it has no metadata for', () => {
    seedTypicalMonth()
    const result = enqueueClarifications(db, {
      month: MONTH,
      candidates: [candidate({ categoryId: 'ghost' })],
    })
    expect(result.skipped[0]?.reason).toBe('unknown_category')
  })

  it('does not ask a question that is already open', () => {
    seedTypicalMonth()
    enqueueClarifications(db, { month: MONTH, candidates: [candidate()] })

    const again = enqueueClarifications(db, { month: MONTH, candidates: [candidate()] })

    expect(again.skipped[0]?.reason).toBe('already_open')
    expect(openQuestionCount(db)).toBe(1)
  })

  it('does not re-ask a question whose answer happens to equal the column default', () => {
    // The load-bearing one. `monthly` is both a legitimate answer and the default,
    // so only the queue's own history can tell that this was asked and answered.
    seedTypicalMonth()
    enqueueClarifications(db, {
      month: MONTH,
      candidates: [candidate({ code: 'frequency_unknown', guess: 'monthly' })],
    })
    answerClarification(db, { id: openRow().id, value: 'monthly' })

    const again = enqueueClarifications(db, {
      month: MONTH,
      candidates: [candidate({ code: 'frequency_unknown', guess: 'monthly' })],
    })

    expect(again.skipped[0]?.reason).toBe('already_answered')
    expect(openQuestionCount(db)).toBe(0)
  })

  it('does not ask what the user has already told it by hand', () => {
    seedTypicalMonth()
    db.update(categoryMeta)
      .set({ userDescription: 'Weekly supermarket run' })
      .where(eq(categoryMeta.categoryId, 'food'))
      .run()

    const result = enqueueClarifications(db, {
      month: MONTH,
      candidates: [candidate({ code: 'purpose_unknown', guess: 'Groceries' })],
    })

    expect(result.skipped[0]?.reason).toBe('already_known')
  })

  it('caps the queue, keeping the questions about the biggest categories', () => {
    seedMonth(db, MONTH, {
      facts: [
        fact(MONTH, 'small', { spentCents: 12_000 }),
        fact(MONTH, 'medium', { spentCents: 40_000 }),
        fact(MONTH, 'large', { spentCents: 120_000 }),
      ],
    })

    const result = enqueueClarifications(db, {
      month: MONTH,
      candidates: [
        candidate({ categoryId: 'small' }),
        candidate({ categoryId: 'medium' }),
        candidate({ categoryId: 'large' }),
      ],
      policy: { ...DEFAULT_CLARIFY_POLICY, maxOpen: 2 },
    })

    expect(result.enqueued.map((row) => row.categoryId)).toEqual(['large', 'medium'])
    expect(result.skipped).toEqual([
      expect.objectContaining({ categoryId: 'small', reason: 'queue_full' }),
    ])
  })

  it('counts the questions already open against the cap', () => {
    seedTypicalMonth()
    enqueueClarifications(db, {
      month: MONTH,
      candidates: [candidate()],
      policy: { ...DEFAULT_CLARIFY_POLICY, maxOpen: 1 },
    })

    const result = enqueueClarifications(db, {
      month: MONTH,
      candidates: [candidate({ categoryId: 'rent' })],
      policy: { ...DEFAULT_CLARIFY_POLICY, maxOpen: 1 },
    })

    expect(result.skipped[0]?.reason).toBe('queue_full')
  })
})

describe('openQuestions', () => {
  beforeEach(() => {
    seedTypicalMonth()
    enqueueClarifications(db, {
      month: MONTH,
      candidates: [
        candidate({ categoryId: 'rent', code: 'purpose_unknown', guess: 'The flat' }),
        candidate({ categoryId: 'food' }),
      ],
    })
  })

  it('asks about the real category name, in the reader language', () => {
    const cards = openQuestions(db, 'nl')
    const food = cards.find((card) => card.categoryId === 'food')

    expect(food?.categoryName).toBe('Groceries')
    expect(food?.question).toContain('Groceries')
    expect(food?.question).toMatch(/vaste kost/i)
  })

  it('offers the choices for an enumerated answer, and the guess as a label', () => {
    const food = openQuestions(db, 'en').find((card) => card.categoryId === 'food')

    expect(food?.choices?.map((choice) => choice.value)).toEqual([
      'fixed',
      'variable',
      'discretionary',
      'income',
    ])
    expect(food?.guess).toBe('variable')
    expect(food?.guessLabel).toBe('Variable cost')
  })

  it('leaves a free-text question without choices or a label', () => {
    const rent = openQuestions(db, 'en').find((card) => card.categoryId === 'rent')

    expect(rent?.choices).toBeNull()
    expect(rent?.guess).toBe('The flat')
    expect(rent?.guessLabel).toBeNull()
  })

  it('puts the biggest category first', () => {
    expect(openQuestions(db, 'en').map((card) => card.categoryId)).toEqual(['rent', 'food'])
  })

  it('drops a row whose question code no longer exists', () => {
    // Only reachable by downgrading past a removed code. One card fewer beats a
    // card reading `frequency_unknown`.
    ctx.sqlite
      .prepare('update clarification_queue set question_code = ? where category_id = ?')
      .run('gone_unknown', 'food')

    expect(openQuestions(db, 'en').map((card) => card.categoryId)).toEqual(['rent'])
  })

  it('counts what is waiting without rendering it', () => {
    expect(openQuestionCount(db)).toBe(2)
  })
})

describe('choicesFor', () => {
  it('translates yes and no like any other answer', () => {
    expect(choicesFor('custody_shared_unknown', 'nl')?.map((choice) => choice.label)).toEqual([
      'Ja',
      'Nee',
    ])
  })

  it('has no choices for a question answered in prose', () => {
    expect(choicesFor('purpose_unknown', 'en')).toBeNull()
  })
})

describe('normaliseDescription', () => {
  it('collapses whitespace', () => {
    expect(normaliseDescription('  Weekly   supermarket\n run  ')).toBe('Weekly supermarket run')
  })

  it('strips control characters, which are invisible in an audit trail', () => {
    const smuggled = `Groceries${String.fromCharCode(0)}${String.fromCharCode(27)}[31m`
    expect(normaliseDescription(smuggled)).toBe('Groceries [31m')
  })

  it('caps the length', () => {
    expect(normaliseDescription('x'.repeat(MAX_DESCRIPTION_CHARS + 50))).toHaveLength(
      MAX_DESCRIPTION_CHARS,
    )
  })
})

describe('parseAnswer', () => {
  it('keeps an enumerated answer as the column value', () => {
    expect(parseAnswer('nature_unknown', 'variable')).toBe('variable')
  })

  it('turns yes and no into the boolean the column holds', () => {
    expect(parseAnswer('custody_shared_unknown', 'yes')).toBe(true)
    expect(parseAnswer('sensitive_unknown', 'no')).toBe(false)
  })

  it('refuses an answer outside the vocabulary', () => {
    expect(() => parseAnswer('nature_unknown', 'sort of fixed')).toThrow(ClarifyError)
  })

  it('refuses an empty description', () => {
    expect(() => parseAnswer('purpose_unknown', '   ')).toThrow(/cannot be empty/)
  })
})

describe('answerClarification', () => {
  beforeEach(() => {
    seedTypicalMonth()
    enqueueClarifications(db, { month: MONTH, candidates: [candidate()], runId: 'run-1' })
  })

  it('stores the answer, closes the question and raises the confidence', () => {
    const result = answerClarification(db, { id: openRow().id, value: 'fixed', userId: 'u1' })

    expect(result).toMatchObject({
      categoryId: 'food',
      field: 'nature',
      before: null,
      after: 'fixed',
      confidence: 20,
    })
    expect(metaOf('food').nature).toBe('fixed')
    expect(openRow().status).toBe('answered')
    expect(openRow().answeredAt).toBeInstanceOf(Date)
  })

  it('records who changed what, and which run suggested it', () => {
    const { auditId } = answerClarification(db, {
      id: openRow().id,
      value: 'variable',
      userId: 'u1',
    })

    const row = loadAuditTrail(db, { entityRef: 'food' })[0]
    expect(row?.id).toBe(auditId)
    expect(row?.action).toBe('clarification.answer')
    expect(row?.actorId).toBe('u1')
    expect(row?.runId).toBe('run-1')
    expect(JSON.parse(row?.afterJson ?? '{}')).toEqual({ nature: 'variable' })
  })

  it('stores a description the way it will be read back', () => {
    enqueueClarifications(db, {
      month: MONTH,
      candidates: [candidate({ categoryId: 'rent', code: 'purpose_unknown' })],
    })
    answerClarification(db, {
      id: openRow('rent').id,
      value: '  The   flat in Ghent  ',
    })

    expect(metaOf('rent').userDescription).toBe('The flat in Ghent')
  })

  it('never pushes confidence past full', () => {
    db.update(categoryMeta)
      .set({ confidence: 95 })
      .where(eq(categoryMeta.categoryId, 'food'))
      .run()

    expect(answerClarification(db, { id: openRow().id, value: 'fixed' }).confidence).toBe(100)
  })

  it('refuses to answer the same question twice', () => {
    const id = openRow().id
    answerClarification(db, { id, value: 'fixed' })

    expect(() => answerClarification(db, { id, value: 'variable' })).toThrow(/already answered/)
  })

  it('refuses a question that does not exist', () => {
    expect(() => answerClarification(db, { id: 'nope', value: 'fixed' })).toThrow(/does not exist/)
  })

  it('leaves the question open when the answer is rejected', () => {
    // The transaction property: a closed question with no stored answer would
    // never be asked again.
    expect(() => answerClarification(db, { id: openRow().id, value: 'maybe' })).toThrow(
      ClarifyError,
    )
    expect(openRow().status).toBe('open')
    expect(metaOf('food').nature).toBeNull()
    expect(loadAuditTrail(db)).toHaveLength(0)
  })
})

describe('dismissClarification', () => {
  beforeEach(() => {
    seedTypicalMonth()
    enqueueClarifications(db, { month: MONTH, candidates: [candidate()], runId: 'run-1' })
  })

  it('closes the question for good, and records the decision', () => {
    dismissClarification(db, { id: openRow().id, userId: 'u1' })

    expect(openRow().status).toBe('dismissed')
    expect(openQuestionCount(db)).toBe(0)
    const row = loadAuditTrail(db)[0]
    expect(row?.action).toBe('clarification.dismiss')
    expect(row?.beforeJson).toBeNull()
    expect(row?.afterJson).toBeNull()
  })

  it('is not asked again on the next run', () => {
    dismissClarification(db, { id: openRow().id })

    const result = enqueueClarifications(db, { month: MONTH, candidates: [candidate()] })
    expect(result.skipped[0]?.reason).toBe('already_answered')
  })

  it('refuses a question that is not open', () => {
    dismissClarification(db, { id: openRow().id })
    expect(() => dismissClarification(db, { id: openRow().id })).toThrow(/is not open/)
  })
})
