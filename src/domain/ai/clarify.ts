/**
 * The clarification queue: "what is this budget for?", asked once.
 *
 * `category_meta` is the one table whose contents cannot be regenerated from
 * Actual or Ghostfolio, and this is how it gets filled in. Which makes the whole
 * design a friction problem rather than a data problem: a tool that interrogates
 * you about a four-euro envelope is a tool that gets abandoned in week two, so
 * three rules do the work.
 *
 *  1. **Materiality.** A question is only worth asking about a category that
 *     carries a real share of the month *and* a real amount. Either test alone
 *     misfires: the relative one alone quizzes you about a small envelope in a
 *     quiet month, the absolute one alone quizzes you about every minor line in a
 *     large budget.
 *  2. **A guess, not a question.** The card carries the model's proposed answer
 *     and the user confirms or edits it. Where the answer is one of a fixed set
 *     (`fixed`/`variable`/...), the card is a choice; only "what is this for" is
 *     free text.
 *  3. **Asked once.** The queue keeps its answered and dismissed rows for ever,
 *     and that history - not the `category_meta` column - is what stops a repeat.
 *     A frequency of `monthly` is both the column default and a legitimate
 *     answer, so the column cannot tell the two apart and the queue can.
 *
 * Answering writes straight into `category_meta` with an audit entry, and needs no
 * second approval: the value is the user's own, typed or confirmed by them. That
 * is the line between this module and `proposals.ts`, where the value is the
 * *model's* and therefore does need one.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { CLARIFICATION_GUESS_VALUES } from '../../adapters/gemini/schemas.ts'
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import { categoryMeta, clarificationQueue } from '../../db/schema.ts'
import { t } from '../../i18n/index.ts'
import { logger } from '../../logger.ts'
import { recordAudit } from '../audit.ts'
import { loadCategoryMeta, loadFacts } from '../aggregate/facts.ts'
import { loadMonthTotals } from '../aggregate/month-store.ts'
import { CLARIFICATION_CODES, type ClarificationCode } from './codes.ts'

const log = logger.child({ module: 'ai.clarify' })

export type ClarificationRow = typeof clarificationQueue.$inferSelect
export type CategoryMetaRow = typeof categoryMeta.$inferSelect

/** The table a clarification answer lands in. Named once, for the audit entry. */
export const CLARIFY_ENTITY = 'category_meta'

export class ClarifyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClarifyError'
  }
}

export interface ClarifyPolicy {
  /** Share of the month's spend a category must carry, in basis points. */
  materialityFloorBp: number
  /** ...and the amount it must carry, so a quiet month is not an interrogation. */
  materialityFloorCents: number
  /** How many questions may be open at once, queue-wide. */
  maxOpen: number
}

/**
 * Two percent and fifty euro, five at a time.
 *
 * Five because a queue of five is a panel someone clears in a minute, and a queue
 * of thirty is one they never open. The rest are not lost: the next run proposes
 * them again, and by then the material ones have been answered.
 */
export const DEFAULT_CLARIFY_POLICY: ClarifyPolicy = {
  materialityFloorBp: 200,
  materialityFloorCents: 5_000,
  maxOpen: 5,
}

/** The user's answer for a code, as a `category_meta` column. */
const ANSWER_FIELD = {
  purpose_unknown: 'userDescription',
  nature_unknown: 'nature',
  frequency_unknown: 'expectedFrequency',
  custody_shared_unknown: 'custodyShared',
  sensitive_unknown: 'sensitive',
} as const satisfies Record<ClarificationCode, keyof CategoryMetaRow>

export type ClarificationField = (typeof ANSWER_FIELD)[ClarificationCode]

export const fieldFor = (code: ClarificationCode): ClarificationField => ANSWER_FIELD[code]

/**
 * Kept longer than the wire allows on purpose: `redact.ts` truncates a
 * description to `PURPOSE_MAX_CHARS` before it leaves the machine, so the store
 * can hold the whole of what someone typed while the model still gets the first
 * sentence of it.
 */
export const MAX_DESCRIPTION_CHARS = 500

/** What each answered question adds to `category_meta.confidence`. */
export const CONFIDENCE_PER_ANSWER = 20

/** Share of the month's spend, in basis points. Zero when nothing was spent. */
export function materialityBp(spentCents: number, monthSpentCents: number): number {
  if (monthSpentCents <= 0) return 0
  return Math.round((Math.abs(spentCents) / monthSpentCents) * 10_000)
}

// ---------------------------------------------------------------------------
//  Enqueue
// ---------------------------------------------------------------------------

/** A question the model proposed, before anything decided it was worth asking. */
export interface ClarifyCandidate {
  code: ClarificationCode
  categoryId: string
  /** The model's proposed answer. Empty when it had none. */
  guess: string
}

export type SkipReason =
  | 'immaterial'
  | 'unknown_category'
  | 'already_known'
  | 'already_open'
  | 'already_answered'
  | 'queue_full'

export interface SkippedCandidate {
  code: ClarificationCode
  categoryId: string
  reason: SkipReason
  materialityBp: number
}

export interface EnqueueResult {
  enqueued: ClarificationRow[]
  /** Why each rejected candidate was rejected. Logged, so silence is explicable. */
  skipped: SkippedCandidate[]
}

export interface EnqueueOptions {
  month: string
  candidates: readonly ClarifyCandidate[]
  /** The run that proposed them, for the audit trail. */
  runId?: string | null
  policy?: ClarifyPolicy
  now?: Date
}

/**
 * Is the answer already on record?
 *
 * Two of these read a nullable column, and three read a value only a human could
 * have set: `expected_frequency` defaults to `monthly` and the two flags default
 * to false, so a *non-default* value is proof of an answer while the default
 * proves nothing. That is exactly why the queue keeps its answered rows - this
 * test is a shortcut, not the guarantee.
 */
function alreadyKnown(code: ClarificationCode, meta: CategoryMetaRow): boolean {
  switch (code) {
    case 'purpose_unknown':
      return meta.userDescription !== null && meta.userDescription.trim() !== ''
    case 'nature_unknown':
      return meta.nature !== null
    case 'frequency_unknown':
      return meta.expectedFrequency !== 'monthly'
    case 'custody_shared_unknown':
      return meta.custodyShared
    case 'sensitive_unknown':
      return meta.sensitive
  }
}

/**
 * The model's proposals, reduced to the questions worth putting on screen.
 *
 * Ordered by materiality before the cap is applied, so when the queue only has
 * room for two, the two are the ones about the largest categories rather than the
 * two the model happened to mention first.
 */
export function enqueueClarifications(db: Db, options: EnqueueOptions): EnqueueResult {
  const policy = options.policy ?? DEFAULT_CLARIFY_POLICY
  const now = options.now ?? new Date()
  const result: EnqueueResult = { enqueued: [], skipped: [] }
  if (options.candidates.length === 0) return result

  const monthSpentCents = loadMonthTotals(db, [options.month])[0]?.spentCents ?? 0
  const spentFor = new Map(
    loadFacts(db, options.month).map((fact) => [fact.categoryId, fact.spentCents]),
  )
  const meta = loadCategoryMeta(db)

  const categoryIds = [...new Set(options.candidates.map((one) => one.categoryId))]
  const history = db
    .select({
      categoryId: clarificationQueue.categoryId,
      questionCode: clarificationQueue.questionCode,
      status: clarificationQueue.status,
    })
    .from(clarificationQueue)
    .where(inArray(clarificationQueue.categoryId, categoryIds))
    .all()
  const asked = new Map(history.map((row) => [`${row.categoryId} ${row.questionCode}`, row.status]))

  // Queue-wide, not per category: the cap exists to bound what a person is asked
  // in total, and five questions about one envelope is worse than five about five.
  const openNow = openQuestionCount(db)

  const scored = options.candidates
    .map((candidate) => ({
      candidate,
      share: materialityBp(spentFor.get(candidate.categoryId) ?? 0, monthSpentCents),
      spentCents: Math.abs(spentFor.get(candidate.categoryId) ?? 0),
    }))
    // By share, then by id and code so a tie resolves the same way twice.
    .sort(
      (a, b) =>
        b.share - a.share ||
        a.candidate.categoryId.localeCompare(b.candidate.categoryId) ||
        a.candidate.code.localeCompare(b.candidate.code),
    )

  let room = Math.max(0, policy.maxOpen - openNow)
  const rows: (typeof clarificationQueue.$inferInsert)[] = []

  for (const { candidate, share, spentCents } of scored) {
    const skip = (reason: SkipReason): void => {
      result.skipped.push({
        code: candidate.code,
        categoryId: candidate.categoryId,
        reason,
        materialityBp: share,
      })
    }

    const row = meta.get(candidate.categoryId)
    if (row === undefined) {
      skip('unknown_category')
      continue
    }
    const status = asked.get(`${candidate.categoryId} ${candidate.code}`)
    if (status === 'open') {
      skip('already_open')
      continue
    }
    if (status !== undefined) {
      skip('already_answered')
      continue
    }
    if (alreadyKnown(candidate.code, row)) {
      skip('already_known')
      continue
    }
    if (share < policy.materialityFloorBp || spentCents < policy.materialityFloorCents) {
      skip('immaterial')
      continue
    }
    if (room === 0) {
      skip('queue_full')
      continue
    }

    room -= 1
    rows.push({
      categoryId: candidate.categoryId,
      questionCode: candidate.code,
      runId: options.runId ?? null,
      materialityBp: share,
      suggestionJson: JSON.stringify({ guess: candidate.guess }),
      status: 'open',
      createdAt: now,
    })
  }

  if (rows.length > 0) {
    result.enqueued = db.insert(clarificationQueue).values(rows).returning().all()
  }
  if (result.skipped.length > 0) {
    log.debug({ month: options.month, skipped: result.skipped }, 'clarifications not enqueued')
  }
  return result
}

// ---------------------------------------------------------------------------
//  Read
// ---------------------------------------------------------------------------

/** The model's stored guess. Unreadable json reads as no guess. */
export function storedGuess(row: ClarificationRow): string {
  if (row.suggestionJson === null) return ''
  try {
    const parsed: unknown = JSON.parse(row.suggestionJson)
    if (typeof parsed === 'object' && parsed !== null && 'guess' in parsed) {
      const guess = (parsed as { guess: unknown }).guess
      return typeof guess === 'string' ? guess : ''
    }
  } catch {
    return ''
  }
  return ''
}

export interface AnswerChoice {
  value: string
  /** The value as the user reads it, in their language. */
  label: string
}

export interface ClarificationCard {
  id: string
  categoryId: string
  /** The real name, resolved locally - a sensitive category never sent one. */
  categoryName: string
  code: ClarificationCode
  /** The question, already in `locale`. */
  question: string
  /** The model's proposed answer, verbatim. */
  guess: string
  /** The guess as a translated label, when the answer is one of a fixed set. */
  guessLabel: string | null
  /** Non-null when the card is a choice rather than a text field. */
  choices: AnswerChoice[] | null
  materialityBp: number
  createdAt: Date
}

const isCode = (value: string): value is ClarificationCode =>
  (CLARIFICATION_CODES as readonly string[]).includes(value)

/** The translated label for one enumerated answer: `variable`, `annual`, `yes`. */
export const answerLabel = (value: string, locale: string): string => t(locale, `ai:answer.${value}`)

/** The choices for a code, or null when its answer is free text. */
export function choicesFor(code: ClarificationCode, locale: string): AnswerChoice[] | null {
  const values = CLARIFICATION_GUESS_VALUES[code]
  if (values === undefined) return null
  return values.map((value) => ({ value, label: answerLabel(value, locale) }))
}

/**
 * The open cards, most material first.
 *
 * A row whose `question_code` is not in the vocabulary is dropped rather than
 * rendered: it can only come from a downgrade that removed a code, and a card
 * reading `frequency_unknown` is worse than one card fewer.
 */
export function openQuestions(
  db: Db,
  locale: string = config.DEFAULT_LOCALE,
  limit = 20,
): ClarificationCard[] {
  const rows = db
    .select({ queue: clarificationQueue, name: categoryMeta.nameSnapshot })
    .from(clarificationQueue)
    .leftJoin(categoryMeta, eq(categoryMeta.categoryId, clarificationQueue.categoryId))
    .where(eq(clarificationQueue.status, 'open'))
    .all()

  return rows
    .filter((row) => isCode(row.queue.questionCode))
    .sort(
      (a, b) =>
        b.queue.materialityBp - a.queue.materialityBp ||
        a.queue.createdAt.getTime() - b.queue.createdAt.getTime(),
    )
    .slice(0, limit)
    .map(({ queue, name }) => {
      const code = queue.questionCode as ClarificationCode
      const categoryName = name ?? queue.categoryId
      const guess = storedGuess(queue)
      const choices = choicesFor(code, locale)
      return {
        id: queue.id,
        categoryId: queue.categoryId,
        categoryName,
        code,
        question: t(locale, `ai:clarify.${code}`, { category: categoryName }),
        guess,
        guessLabel:
          choices !== null && choices.some((choice) => choice.value === guess)
            ? answerLabel(guess, locale)
            : null,
        choices,
        materialityBp: queue.materialityBp,
        createdAt: queue.createdAt,
      }
    })
}

/** How many questions are waiting. For a badge, without loading the cards. */
export function openQuestionCount(db: Db): number {
  return db
    .select({ id: clarificationQueue.id })
    .from(clarificationQueue)
    .where(eq(clarificationQueue.status, 'open'))
    .all().length
}

// ---------------------------------------------------------------------------
//  Answer
// ---------------------------------------------------------------------------

/**
 * A control character, which is invisible both in a payload and in an audit
 * trail. Tested by code point rather than by a regex containing the characters
 * themselves, which no reviewer could read.
 */
function isControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return code < 0x20 || code === 0x7f
}

/** Collapses whitespace, drops control characters, caps the length. */
export function normaliseDescription(value: string): string {
  const clean = [...value]
    .map((char) => (isControl(char) ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length <= MAX_DESCRIPTION_CHARS
    ? clean
    : clean.slice(0, MAX_DESCRIPTION_CHARS).trimEnd()
}

/** The value to store for one answer, validated against what the code allows. */
export function parseAnswer(code: ClarificationCode, value: string): string | boolean {
  const allowed = CLARIFICATION_GUESS_VALUES[code]
  if (allowed === undefined) {
    const clean = normaliseDescription(value)
    if (clean === '') throw new ClarifyError(`an answer to ${code} cannot be empty`)
    return clean
  }
  const trimmed = value.trim()
  if (!allowed.includes(trimmed)) {
    throw new ClarifyError(
      `"${trimmed}" is not a valid answer to ${code} (expected ${allowed.join(', ')})`,
    )
  }
  // `yes`/`no` are the wire form of a boolean column; everything else is an enum
  // whose values are the column's own.
  if (trimmed === 'yes' || trimmed === 'no') return trimmed === 'yes'
  return trimmed
}

export interface AnswerOptions {
  id: string
  /** What the user confirmed or typed. Validated, never trusted. */
  value: string
  /** Who answered. */
  userId?: string | null
  now?: Date
}

export interface AnswerResult {
  categoryId: string
  code: ClarificationCode
  field: ClarificationField
  before: string | boolean | null
  after: string | boolean
  /** `category_meta.confidence` after the bump. */
  confidence: number
  auditId: string
}

/**
 * Stores one answer, marks the question answered, records the change.
 *
 * All three in one transaction: an answer that landed in `category_meta` while its
 * question stayed open would be asked again, and a question marked answered whose
 * value was rolled back would never be asked again.
 */
export function answerClarification(db: Db, options: AnswerOptions): AnswerResult {
  const now = options.now ?? new Date()

  return db.transaction((tx) => {
    const row = tx
      .select()
      .from(clarificationQueue)
      .where(eq(clarificationQueue.id, options.id))
      .get()
    if (row === undefined) throw new ClarifyError(`clarification ${options.id} does not exist`)
    if (row.status !== 'open') {
      throw new ClarifyError(`clarification ${options.id} is already ${row.status}`)
    }
    if (!isCode(row.questionCode)) {
      throw new ClarifyError(`clarification ${options.id} asks an unknown question`)
    }
    const code: ClarificationCode = row.questionCode
    const field = ANSWER_FIELD[code]
    const after = parseAnswer(code, options.value)

    const meta = tx
      .select()
      .from(categoryMeta)
      .where(eq(categoryMeta.categoryId, row.categoryId))
      .get()
    if (meta === undefined) {
      throw new ClarifyError(`category ${row.categoryId} has no metadata row`)
    }
    const before = (meta[field] ?? null) as string | boolean | null

    const confidence = Math.min(100, meta.confidence + CONFIDENCE_PER_ANSWER)
    tx.update(categoryMeta)
      .set({ [field]: after, confidence, updatedAt: now })
      .where(eq(categoryMeta.categoryId, row.categoryId))
      .run()

    tx.update(clarificationQueue)
      .set({ status: 'answered', answeredAt: now })
      .where(eq(clarificationQueue.id, row.id))
      .run()

    const auditId = recordAudit(tx, {
      action: 'clarification.answer',
      entity: CLARIFY_ENTITY,
      entityRef: row.categoryId,
      actorId: options.userId ?? null,
      runId: row.runId,
      before: { [field]: before },
      after: { [field]: after },
      at: now,
    })

    return { categoryId: row.categoryId, code, field, before, after, confidence, auditId }
  })
}

export interface DismissOptions {
  id: string
  userId?: string | null
  now?: Date
}

/**
 * Closes a question without answering it - and therefore for good.
 *
 * Recorded even though nothing changed: "do not ask me this" is a decision, and
 * the row that stops the question being re-asked should be traceable to whoever
 * made it.
 */
export function dismissClarification(db: Db, options: DismissOptions): void {
  const now = options.now ?? new Date()

  db.transaction((tx) => {
    const row = tx
      .select()
      .from(clarificationQueue)
      .where(and(eq(clarificationQueue.id, options.id), eq(clarificationQueue.status, 'open')))
      .get()
    if (row === undefined) {
      throw new ClarifyError(`clarification ${options.id} is not open`)
    }

    tx.update(clarificationQueue)
      .set({ status: 'dismissed', answeredAt: now })
      .where(eq(clarificationQueue.id, row.id))
      .run()

    recordAudit(tx, {
      action: 'clarification.dismiss',
      entity: CLARIFY_ENTITY,
      entityRef: row.categoryId,
      actorId: options.userId ?? null,
      runId: row.runId,
      at: now,
    })
  })
}
