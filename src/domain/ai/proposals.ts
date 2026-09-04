/**
 * Propose-and-apply: nothing the model suggests takes effect until a person says so.
 *
 * The distinction this module rests on is whose words are being stored. A
 * clarification answer is the *user's* — typed or picked by them — so
 * `clarify.ts` writes it straight through. A proposal is the *model's*, inferred
 * from a name and a pattern of amounts, so it waits in `proposals` with status
 * `pending` until someone applies it. That is the whole reason the two live in
 * separate files with separate audit actions.
 *
 * Three properties are structural:
 *
 *  - **A closed handler map.** `PROPOSAL_HANDLERS` is the only thing that can
 *    change data, keyed by type. A row whose type has no handler is unappliable
 *    by construction. `category_meta.set` writes to Balancr's own table;
 *    `transaction_category.set` and `budget_amount.set` (#45) write to Actual
 *    instead, through a handler's optional `applyRemote` — see its doc comment
 *    for why that write runs outside the local transaction, and why it must be
 *    idempotent.
 *  - **The payload is validated twice**, once when the proposal is created and
 *    again when it is applied. The gap between the two is a version upgrade, a
 *    hand-edited database, or months of elapsed time — all of which can make a
 *    stored payload no longer mean what it did.
 *  - **The diff is recomputed at apply time.** The card shows what would change;
 *    the audit trail records what did. If something else touched the row in
 *    between, those are not the same, and the trail must be the true one.
 *
 * Like `ai_findings`, the stored diff holds values rather than sentences: field
 * names, before, after. A change approved in a Dutch session has to read
 * correctly in English later, so labels are translated at display time.
 */
import { and, asc, desc, eq, isNotNull, lte } from 'drizzle-orm'
import { z } from 'zod'
import {
  fetchTransaction,
  setCategoryBudgetAmount,
  updateTransactionCategory,
} from '../../adapters/actual/queries.ts'
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import { categoryMeta, monthlyCategoryFacts, proposals } from '../../db/schema.ts'
import { formatMoney } from '../../i18n/format.ts'
import { t } from '../../i18n/index.ts'
import { logger } from '../../logger.ts'
import { recordAudit, type AuditWriter } from '../audit.ts'
import { MAX_DESCRIPTION_CHARS, normaliseDescription } from './clarify.ts'

const log = logger.child({ module: 'ai.proposals' })

export type ProposalRow = typeof proposals.$inferSelect

export class ProposalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProposalError'
  }
}

/**
 * The types that exist.
 *
 * `category_meta.set` writes to Balancr's own `category_meta` table.
 * `transaction_category.set` and `budget_amount.set` (#45) are the first
 * writes back to Actual — both gated the same way as the first: a closed
 * handler map, applied only from an approved, audited proposal.
 */
export const PROPOSAL_TYPES = [
  'category_meta.set',
  'transaction_category.set',
  'budget_amount.set',
] as const
export type ProposalType = (typeof PROPOSAL_TYPES)[number]

/** How long a suggestion stays actionable. */
export const PROPOSAL_TTL_DAYS = 30

/** One field's before/after pair. Values, not sentences: see the file header. */
export interface DiffField {
  field: string
  before: string | boolean | null
  after: string | boolean
  /** Set when applying this field would reduce a protection the user has. */
  warn?: 'privacy'
}

export interface RenderedDiff {
  fields: DiffField[]
}

// ---------------------------------------------------------------------------
//  Handlers
// ---------------------------------------------------------------------------

/**
 * Mirrors the `category_meta` column enums. Declared here rather than imported
 * because the column's enum is a drizzle runtime detail; if the two ever diverge
 * the parse fails loudly at creation rather than writing an invalid value.
 */
const NATURES = ['fixed', 'variable', 'discretionary', 'income'] as const
const FREQUENCIES = ['monthly', 'quarterly', 'annual', 'irregular'] as const

/**
 * What a `category_meta.set` proposal may say.
 *
 * Every field optional, at least one present: a proposal that changes nothing is
 * a card the user has to dismiss for no reason. `strict()` because an unknown key
 * in a stored payload means the schema has moved on and the row should be
 * re-examined by a human, not silently half-applied.
 */
const categoryMetaSetSchema = z
  .object({
    userDescription: z.string().min(1).max(MAX_DESCRIPTION_CHARS).optional(),
    /** COICOP class, e.g. `01.1.1`. Format only; the mapping table is deferred. */
    coicopCode: z
      .string()
      .regex(/^\d{2}(\.\d{1,2}){0,3}$/, 'not a COICOP code')
      .optional(),
    nature: z.enum(NATURES).optional(),
    expectedFrequency: z.enum(FREQUENCIES).optional(),
    custodyShared: z.boolean().optional(),
    sensitive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'a proposal must change at least one field',
  })

export type CategoryMetaSet = z.infer<typeof categoryMetaSetSchema>

/** The order fields are reviewed in. Stable, so a card does not reshuffle. */
const CATEGORY_META_FIELDS = [
  'userDescription',
  'coicopCode',
  'nature',
  'expectedFrequency',
  'custodyShared',
  'sensitive',
] as const satisfies readonly (keyof CategoryMetaSet)[]

interface ProposalHandler {
  readonly type: ProposalType
  /** The table the change lands in, for the audit entry. */
  readonly entity: string
  /** Throws unless the payload is valid for this type. Returns the clean form. */
  readonly parse: (payload: unknown) => unknown
  /**
   * What would change, against the row as it stands right now.
   *
   * Async because the two Actual-writing handlers need a value Actual holds
   * (a transaction's current category) that no local table mirrors —
   * `category_meta.set`'s implementation just wraps its synchronous body in
   * an immediately-resolved value. Both `createProposal` and `applyProposal`
   * `await` this *before* opening their local `db.transaction`, since
   * better-sqlite3's transaction callback runs synchronously.
   */
  readonly diff: (
    writer: AuditWriter,
    targetRef: string,
    payload: unknown,
  ) => DiffField[] | Promise<DiffField[]>
  /** Local bookkeeping only, inside the transaction. No-op for a handler with no local mirror to update. */
  readonly apply: (writer: AuditWriter, targetRef: string, payload: unknown, now: Date) => void
  /**
   * A human-readable name for the target, for the review card. `payload` is
   * passed for handlers (`transaction_category.set`) that snapshot a display
   * name at generation time rather than have this call Actual.
   */
  readonly targetName: (writer: AuditWriter, targetRef: string, payload?: unknown) => string | null
  /**
   * The write to Actual, if this type makes one. Runs *outside and before*
   * any local `db.transaction` — see `applyProposal`. Must be idempotent:
   * setting a category or a budget amount to a specific value ends at the
   * same state no matter how many times it runs, which is what makes it safe
   * to re-apply by hand after a crash between this call succeeding and the
   * local commit that follows it.
   */
  readonly applyRemote?: (targetRef: string, payload: unknown) => Promise<void>
}

const loadMeta = (
  writer: AuditWriter,
  categoryId: string,
): typeof categoryMeta.$inferSelect | undefined =>
  (writer as Db).select().from(categoryMeta).where(eq(categoryMeta.categoryId, categoryId)).get()

const categoryMetaSetHandler: ProposalHandler = {
  type: 'category_meta.set',
  entity: 'category_meta',

  parse: (payload) => {
    const result = categoryMetaSetSchema.safeParse(payload)
    if (!result.success) {
      throw new ProposalError(
        `invalid category_meta.set payload:\n${z.prettifyError(result.error)}`,
      )
    }
    // The description goes through the same normalisation as a typed answer: the
    // model's guess is untrusted text from the same wire as everything else.
    const clean = { ...result.data }
    if (clean.userDescription !== undefined) {
      clean.userDescription = normaliseDescription(clean.userDescription)
      if (clean.userDescription === '') {
        throw new ProposalError('invalid category_meta.set payload: description is empty')
      }
    }
    return clean
  },

  diff: (writer, targetRef, payload) => {
    const clean = categoryMetaSetHandler.parse(payload) as CategoryMetaSet
    const meta = loadMeta(writer, targetRef)
    if (meta === undefined) throw new ProposalError(`category ${targetRef} has no metadata row`)

    const fields: DiffField[] = []
    for (const field of CATEGORY_META_FIELDS) {
      const after = clean[field]
      if (after === undefined) continue
      const before = meta[field] ?? null
      if (before === after) continue
      fields.push({
        field,
        before,
        after,
        // The one change here that takes protection away rather than adding
        // knowledge: a category that stops being sensitive starts sending its
        // name to Google. Worth a warning next to the checkbox, not a refusal —
        // the user is allowed to decide their therapy budget is just "Health".
        ...(field === 'sensitive' && after === false ? { warn: 'privacy' as const } : {}),
      })
    }
    return fields
  },

  apply: (writer, targetRef, payload, now) => {
    const clean = categoryMetaSetHandler.parse(payload) as CategoryMetaSet
    const meta = loadMeta(writer, targetRef)
    if (meta === undefined) throw new ProposalError(`category ${targetRef} has no metadata row`)

    // Only the fields the payload names, so applying a description proposal does
    // not reset a nature the user set by hand last week.
    //
    // `confidence` is deliberately untouched. It measures how much of this row the
    // user stated themselves, and an approved proposal is them finding the model's
    // guess plausible — the approval is recorded in the audit trail, which is
    // where it belongs.
    ;(writer as Db)
      .update(categoryMeta)
      .set({ ...clean, updatedAt: now })
      .where(eq(categoryMeta.categoryId, targetRef))
      .run()
  },

  targetName: (writer, targetRef) => loadMeta(writer, targetRef)?.nameSnapshot ?? null,
}

/**
 * What a `transaction_category.set` proposal may say. `targetRef` is the
 * Actual transaction id.
 *
 * `payeeName` is snapshotted at generation time rather than looked up from
 * `targetName`, so the review card never needs an Actual call just to render
 * — the payload already carries everything the card shows besides the diff
 * itself.
 */
const transactionCategorySetSchema = z
  .object({
    categoryId: z.string().min(1),
    payeeName: z.string().nullable(),
  })
  .strict()

export type TransactionCategorySet = z.infer<typeof transactionCategorySetSchema>

/**
 * What a `budget_amount.set` proposal may say. `targetRef` is a composite
 * `categoryId:month` — see `encodeBudgetTarget`/`decodeBudgetTarget` below.
 */
const budgetAmountSetSchema = z
  .object({
    amountCents: z.number().int(),
  })
  .strict()

export type BudgetAmountSet = z.infer<typeof budgetAmountSetSchema>

/**
 * `proposals.targetRef` and `auditLog.entityRef` are single text columns
 * (`schema.ts`), so a budget-amount proposal's category and month live in one
 * string rather than a new column. `lastIndexOf` rather than `split` because
 * a category id could in principle contain a colon; a month (`YYYY-MM`) never
 * does, so splitting from the right is unambiguous.
 */
export function encodeBudgetTarget(categoryId: string, month: string): string {
  return `${categoryId}:${month}`
}

export function decodeBudgetTarget(targetRef: string): { categoryId: string; month: string } {
  const at = targetRef.lastIndexOf(':')
  if (at < 0) throw new ProposalError(`malformed budget target ref: ${targetRef}`)
  return { categoryId: targetRef.slice(0, at), month: targetRef.slice(at + 1) }
}

const transactionCategorySetHandler: ProposalHandler = {
  type: 'transaction_category.set',
  entity: 'actual_transaction',

  parse: (payload) => {
    const result = transactionCategorySetSchema.safeParse(payload)
    if (!result.success) {
      throw new ProposalError(
        `invalid transaction_category.set payload:\n${z.prettifyError(result.error)}`,
      )
    }
    return result.data
  },

  diff: async (writer, targetRef, payload) => {
    const clean = transactionCategorySetHandler.parse(payload) as TransactionCategorySet
    const current = await fetchTransaction(targetRef)
    if (current === null) throw new ProposalError(`transaction ${targetRef} no longer exists`)
    if (current.categoryId === clean.categoryId) return []

    // Names, not raw Actual ids — resolved locally against `category_meta`
    // (kept in step by every sync), so the review card reads like the rest
    // of the app rather than showing a category id.
    const before =
      current.categoryId === null
        ? null
        : loadMeta(writer, current.categoryId)?.nameSnapshot ?? current.categoryId
    const after = loadMeta(writer, clean.categoryId)?.nameSnapshot ?? clean.categoryId

    return [{ field: 'category', before, after }]
  },

  // No local mirror of a transaction's category exists — `applyRemote` is the
  // whole of the write, and the audit row `applyProposal` records is what
  // makes this durable.
  apply: () => {},

  targetName: (_writer, _targetRef, payload) => {
    const clean = transactionCategorySetSchema.safeParse(payload)
    return clean.success ? clean.data.payeeName : null
  },

  applyRemote: async (targetRef, payload) => {
    const clean = transactionCategorySetHandler.parse(payload) as TransactionCategorySet
    await updateTransactionCategory(targetRef, clean.categoryId)
  },
}

const loadBudgetedCents = (writer: AuditWriter, categoryId: string, month: string): number | null => {
  const row = (writer as Db)
    .select({ budgetedCents: monthlyCategoryFacts.budgetedCents })
    .from(monthlyCategoryFacts)
    .where(and(eq(monthlyCategoryFacts.categoryId, categoryId), eq(monthlyCategoryFacts.month, month)))
    .get()
  return row?.budgetedCents ?? null
}

const budgetAmountSetHandler: ProposalHandler = {
  type: 'budget_amount.set',
  entity: 'actual_budget',

  parse: (payload) => {
    const result = budgetAmountSetSchema.safeParse(payload)
    if (!result.success) {
      throw new ProposalError(`invalid budget_amount.set payload:\n${z.prettifyError(result.error)}`)
    }
    return result.data
  },

  // Synchronous, unlike the handler above: the current amount is Actual's own
  // figure for this month, already mirrored locally by the sync job
  // (`monthlyCategoryFacts.budgetedCents`), so no Actual call is needed here.
  // Pre-formatted into Belgian numerals at diff time — a fixed rendering
  // locale, not a UI-language translation, so this does not create the
  // English/Dutch consistency problem the file header describes for values
  // that are shown as words.
  diff: (writer, targetRef, payload) => {
    const clean = budgetAmountSetHandler.parse(payload) as BudgetAmountSet
    const { categoryId, month } = decodeBudgetTarget(targetRef)
    const currentCents = loadBudgetedCents(writer, categoryId, month)
    if (currentCents === null) {
      throw new ProposalError(`no budget facts for category ${categoryId} in ${month}`)
    }
    if (currentCents === clean.amountCents) return []

    return [
      {
        field: 'amount',
        before: formatMoney(currentCents),
        after: formatMoney(clean.amountCents),
      },
    ]
  },

  // Same reasoning as the handler above: nothing local to update, the audit
  // row is the record. Deliberately not patching `monthlyCategoryFacts`
  // eagerly — that would be a second source of truth for a number the next
  // sync already refreshes correctly, an accepted, temporary staleness window
  // rather than something to engineer around.
  apply: () => {},

  targetName: (writer, targetRef) => {
    const { categoryId, month } = decodeBudgetTarget(targetRef)
    const name = loadMeta(writer, categoryId)?.nameSnapshot ?? categoryId
    return `${name} (${month})`
  },

  applyRemote: async (targetRef, payload) => {
    const clean = budgetAmountSetHandler.parse(payload) as BudgetAmountSet
    const { categoryId, month } = decodeBudgetTarget(targetRef)
    await setCategoryBudgetAmount(month, categoryId, clean.amountCents)
  },
}

export const PROPOSAL_HANDLERS: Record<ProposalType, ProposalHandler> = {
  'category_meta.set': categoryMetaSetHandler,
  'transaction_category.set': transactionCategorySetHandler,
  'budget_amount.set': budgetAmountSetHandler,
}

const handlerFor = (type: string): ProposalHandler => {
  const handler = (PROPOSAL_HANDLERS as Record<string, ProposalHandler | undefined>)[type]
  if (handler === undefined) throw new ProposalError(`no handler for proposal type ${type}`)
  return handler
}

// ---------------------------------------------------------------------------
//  Create
// ---------------------------------------------------------------------------

export interface CreateProposalOptions {
  type: ProposalType
  /** A category id, for the one type that exists. */
  targetRef: string
  payload: unknown
  runId?: string | null
  /** Defaults to `PROPOSAL_TTL_DAYS` after `now`. */
  expiresAt?: Date
  now?: Date
}

/**
 * Stores a pending proposal, or refuses.
 *
 * Refuses a no-op: if the diff against the current row is empty there is nothing
 * to approve, and a card saying "change nothing to nothing" trains people to
 * click through cards without reading them.
 *
 * A pending proposal for the same target is superseded rather than duplicated —
 * `proposals_pending_uq` would reject the insert anyway, and the newer suggestion
 * is computed from newer data. Superseding is not an audit event: nothing the
 * user approved changed.
 */
export async function createProposal(db: Db, options: CreateProposalOptions): Promise<ProposalRow> {
  const handler = handlerFor(options.type)
  const now = options.now ?? new Date()
  const payload = handler.parse(options.payload)

  // Computed before the transaction opens: better-sqlite3's `db.transaction`
  // callback runs synchronously, and a couple of handlers need an `await` to
  // reach a value (a transaction's current category) that no local table
  // mirrors.
  const fields = await handler.diff(db, options.targetRef, payload)
  if (fields.length === 0) {
    throw new ProposalError(`proposal ${options.type} for ${options.targetRef} would change nothing`)
  }

  return db.transaction((tx) => {
    const superseded = tx
      .update(proposals)
      .set({ status: 'expired' })
      .where(
        and(
          eq(proposals.type, options.type),
          eq(proposals.targetRef, options.targetRef),
          eq(proposals.status, 'pending'),
        ),
      )
      .returning({ id: proposals.id })
      .all()
    if (superseded.length > 0) {
      log.debug(
        { type: options.type, targetRef: options.targetRef, superseded: superseded.length },
        'superseded a pending proposal with a newer one',
      )
    }

    const diff: RenderedDiff = { fields }
    const expiresAt =
      options.expiresAt ?? new Date(now.getTime() + PROPOSAL_TTL_DAYS * 24 * 60 * 60 * 1_000)
    const rows = tx
      .insert(proposals)
      .values({
        type: options.type,
        targetRef: options.targetRef,
        payloadJson: JSON.stringify(payload),
        renderedDiffJson: JSON.stringify(diff),
        runId: options.runId ?? null,
        status: 'pending',
        createdAt: now,
        expiresAt,
      })
      .returning()
      .all()
    const row = rows[0]
    if (row === undefined) throw new ProposalError('failed to store the proposal')
    return row
  })
}

// ---------------------------------------------------------------------------
//  Read
// ---------------------------------------------------------------------------

export function loadProposal(db: Db, id: string): ProposalRow | null {
  return db.select().from(proposals).where(eq(proposals.id, id)).get() ?? null
}

/** The cards awaiting a decision, oldest first: the queue is worked, not browsed. */
export function pendingProposals(db: Db, limit = 50): ProposalRow[] {
  return db
    .select()
    .from(proposals)
    .where(eq(proposals.status, 'pending'))
    .orderBy(asc(proposals.createdAt), asc(proposals.id))
    .limit(limit)
    .all()
}

/**
 * Every pending `budget_amount.set` proposal for one month — the candidate set #45's
 * nightly pass already computed and the AI nudge (#217) may adjust.
 *
 * `createProposal`'s supersede-on-same-target behaviour is what lets the nudge reuse
 * this set directly: adjusting one just means creating a new proposal for the same
 * `(type, targetRef)`, which cleanly expires the row this reads.
 */
export function pendingBudgetProposals(db: Db, month: string): ProposalRow[] {
  return db
    .select()
    .from(proposals)
    .where(and(eq(proposals.status, 'pending'), eq(proposals.type, 'budget_amount.set')))
    .orderBy(asc(proposals.createdAt), asc(proposals.id))
    .all()
    .filter((row) => decodeBudgetTarget(row.targetRef).month === month)
}

/** Everything that happened to one target, newest first. */
export function proposalHistory(db: Db, targetRef: string, limit = 50): ProposalRow[] {
  return db
    .select()
    .from(proposals)
    .where(eq(proposals.targetRef, targetRef))
    .orderBy(desc(proposals.createdAt), desc(proposals.id))
    .limit(limit)
    .all()
}

/** The stored diff, or null when the row has none or it is unreadable. */
export function storedDiff(row: ProposalRow): RenderedDiff | null {
  if (row.renderedDiffJson === null) return null
  try {
    const parsed: unknown = JSON.parse(row.renderedDiffJson)
    if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as RenderedDiff).fields)) {
      return parsed as RenderedDiff
    }
  } catch {
    return null
  }
  return null
}

export interface RenderedField {
  field: string
  /** The field name as the user reads it. */
  label: string
  before: string
  after: string
  /** A translated warning, or null. */
  warn: string | null
}

export interface ProposalCard {
  id: string
  type: string
  targetRef: string
  /** The category's name, or the raw id when the row is gone. */
  targetName: string
  fields: RenderedField[]
  createdAt: Date
  /** Unformatted: the view owns Belgian date formatting, not the domain. */
  expiresAt: Date | null
  status: ProposalRow['status']
}

/**
 * One stored value as text.
 *
 * Booleans and enum values are translated through `ai:answer.*`, the same keys the
 * clarification cards use — the answer to "is this shared?" should read the same
 * whether the user typed it or approved it. Free text is shown verbatim.
 */
function renderValue(value: string | boolean | null, locale: string): string {
  if (value === null) return t(locale, 'ai:proposal.value.unset')
  if (typeof value === 'boolean') return t(locale, value ? 'ai:answer.yes' : 'ai:answer.no')
  const enumerated: readonly string[] = [...NATURES, ...FREQUENCIES]
  return enumerated.includes(value) ? t(locale, `ai:answer.${value}`) : value
}

/**
 * A row plus its diff, translated for review.
 *
 * Reads the *stored* diff rather than recomputing: the card should show what was
 * proposed. `applyProposal` recomputes against the live row, which is where a
 * stale diff is caught.
 */
export function renderProposal(
  db: Db,
  row: ProposalRow,
  locale: string = config.DEFAULT_LOCALE,
): ProposalCard {
  const diff = storedDiff(row)
  let payload: unknown
  try {
    payload = JSON.parse(row.payloadJson)
  } catch {
    payload = undefined
  }
  const name =
    (PROPOSAL_HANDLERS as Record<string, ProposalHandler | undefined>)[row.type]?.targetName(
      db,
      row.targetRef,
      payload,
    ) ?? null

  return {
    id: row.id,
    type: row.type,
    targetRef: row.targetRef,
    targetName: name ?? row.targetRef,
    fields: (diff?.fields ?? []).map((field) => ({
      field: field.field,
      label: t(locale, `ai:proposal.field.${field.field}`),
      before: renderValue(field.before, locale),
      after: renderValue(field.after, locale),
      warn: field.warn === undefined ? null : t(locale, `ai:proposal.warn.${field.warn}`),
    })),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    status: row.status,
  }
}

// ---------------------------------------------------------------------------
//  Decide
// ---------------------------------------------------------------------------

export interface DecideOptions {
  id: string
  /** Who decided. Null only for a decision the system made on its own. */
  userId?: string | null
  now?: Date
}

export interface ApplyResult {
  id: string
  type: string
  targetRef: string
  /** What actually changed, computed against the row as it was. */
  fields: DiffField[]
  auditId: string
}

const before = (fields: readonly DiffField[]): Record<string, unknown> =>
  Object.fromEntries(fields.map((field) => [field.field, field.before]))

const after = (fields: readonly DiffField[]): Record<string, unknown> =>
  Object.fromEntries(fields.map((field) => [field.field, field.after]))

/**
 * Applies one proposal, and records what it changed.
 *
 * The payload is re-validated and the diff recomputed against the live row, so
 * what lands in the audit trail is what this write actually did rather than what
 * the card predicted weeks ago. A proposal whose fields have since been set to the
 * proposed values by hand applies as a no-op, and is still marked applied: the
 * user's decision was made, and re-presenting the card would be a bug.
 *
 * Two phases, not one, because a handler's Actual write (`applyRemote`) is
 * async and better-sqlite3's `db.transaction` callback cannot be:
 *
 *  1. Check the row is `pending` and unexpired, recompute the diff, and — for
 *     the two handlers that have one — `await handler.applyRemote`, all
 *     outside any local transaction.
 *  2. Only once that succeeds, open `db.transaction` and re-check the row's
 *     status from inside it before doing the (synchronous) local bookkeeping
 *     and recording the audit row.
 *
 * Step 2's re-check guards the one window step 1 opens: the row could have
 * been applied or rejected by someone else while `applyRemote` was in
 * flight. If `applyRemote` throws, this function throws before either phase
 * touches local state — the proposal stays `pending`, nothing is recorded,
 * and the actual write did not happen. A crash *after* `applyRemote`
 * succeeds but before step 2 commits is not guarded against and is not
 * meant to be: both remote writes are idempotent (see `ProposalHandler.applyRemote`),
 * so recovering from it is a manual re-apply, not a double-apply.
 */
export async function applyProposal(db: Db, options: DecideOptions): Promise<ApplyResult> {
  const now = options.now ?? new Date()

  const initial = db.select().from(proposals).where(eq(proposals.id, options.id)).get()
  if (initial === undefined) throw new ProposalError(`proposal ${options.id} does not exist`)
  if (initial.status !== 'pending') {
    throw new ProposalError(`proposal ${options.id} is already ${initial.status}`)
  }
  if (initial.expiresAt !== null && initial.expiresAt.getTime() <= now.getTime()) {
    // Left pending rather than flipped to expired here: `expireProposals` owns
    // that transition, and doing it in the same breath as refusing the apply
    // would hide the refusal behind a state change.
    throw new ProposalError(`proposal ${options.id} expired on ${initial.expiresAt.toISOString()}`)
  }

  const handler = handlerFor(initial.type)
  let payload: unknown
  try {
    payload = handler.parse(JSON.parse(initial.payloadJson))
  } catch (error) {
    throw new ProposalError(
      `proposal ${options.id} can no longer be applied: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const fields = await handler.diff(db, initial.targetRef, payload)

  if (handler.applyRemote !== undefined) {
    await handler.applyRemote(initial.targetRef, payload)
  }

  return db.transaction((tx) => {
    const row = tx.select().from(proposals).where(eq(proposals.id, options.id)).get()
    if (row === undefined) throw new ProposalError(`proposal ${options.id} does not exist`)
    if (row.status !== 'pending') {
      throw new ProposalError(`proposal ${options.id} is already ${row.status}`)
    }

    handler.apply(tx, row.targetRef, payload, now)

    tx.update(proposals)
      .set({ status: 'applied', appliedAt: now, appliedBy: options.userId ?? null })
      .where(eq(proposals.id, row.id))
      .run()

    const auditId = recordAudit(tx, {
      action: 'proposal.apply',
      entity: handler.entity,
      entityRef: row.targetRef,
      actorId: options.userId ?? null,
      runId: row.runId,
      proposalId: row.id,
      before: before(fields),
      after: after(fields),
      at: now,
    })

    return { id: row.id, type: row.type, targetRef: row.targetRef, fields, auditId }
  })
}

/**
 * Declines one proposal.
 *
 * Audited with no before/after, for the same reason a dismissed clarification is:
 * "no" is a decision, and a rejected suggestion that reappears next month should
 * be traceable to the run that re-proposed it rather than look like a first ask.
 */
export function rejectProposal(db: Db, options: DecideOptions): ProposalRow {
  const now = options.now ?? new Date()

  return db.transaction((tx) => {
    const row = tx.select().from(proposals).where(eq(proposals.id, options.id)).get()
    if (row === undefined) throw new ProposalError(`proposal ${options.id} does not exist`)
    if (row.status !== 'pending') {
      throw new ProposalError(`proposal ${options.id} is already ${row.status}`)
    }

    const handler = handlerFor(row.type)
    tx.update(proposals)
      .set({ status: 'rejected', appliedAt: now, appliedBy: options.userId ?? null })
      .where(eq(proposals.id, row.id))
      .run()

    recordAudit(tx, {
      action: 'proposal.reject',
      entity: handler.entity,
      entityRef: row.targetRef,
      actorId: options.userId ?? null,
      runId: row.runId,
      proposalId: row.id,
      at: now,
    })

    return { ...row, status: 'rejected', appliedAt: now, appliedBy: options.userId ?? null }
  })
}

/**
 * Retires the proposals nobody decided on.
 *
 * A suggestion computed from a month that is now four months old is not a
 * suggestion any more, and expiring it is not the same as rejecting it: no audit
 * row, because nobody decided anything. Idempotent, so the nightly job can call
 * it unconditionally.
 */
export function expireProposals(db: Db, now: Date = new Date()): number {
  return db
    .update(proposals)
    .set({ status: 'expired' })
    .where(
      and(
        eq(proposals.status, 'pending'),
        isNotNull(proposals.expiresAt),
        lte(proposals.expiresAt, now),
      ),
    )
    .returning({ id: proposals.id })
    .all().length
}
