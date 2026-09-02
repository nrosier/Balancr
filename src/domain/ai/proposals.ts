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
 *    by construction, which is what makes it safe to add
 *    Actual-mutating types later without auditing every call site: v1 registers
 *    exactly one handler, and it writes to Balancr's own table.
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
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import { categoryMeta, proposals } from '../../db/schema.ts'
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
 * One, in v1, and it writes to `category_meta`. The plan defers every handler
 * that would write back to Actual until the read path is proven against real
 * data, and a closed list is how that deferral is enforced rather than merely
 * intended.
 */
export const PROPOSAL_TYPES = ['category_meta.set'] as const
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
  /** What would change, against the row as it stands right now. */
  readonly diff: (writer: AuditWriter, targetRef: string, payload: unknown) => DiffField[]
  readonly apply: (writer: AuditWriter, targetRef: string, payload: unknown, now: Date) => void
  /** A human-readable name for the target, for the review card. */
  readonly targetName: (writer: AuditWriter, targetRef: string) => string | null
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

export const PROPOSAL_HANDLERS: Record<ProposalType, ProposalHandler> = {
  'category_meta.set': categoryMetaSetHandler,
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
export function createProposal(db: Db, options: CreateProposalOptions): ProposalRow {
  const handler = handlerFor(options.type)
  const now = options.now ?? new Date()
  const payload = handler.parse(options.payload)

  return db.transaction((tx) => {
    const fields = handler.diff(tx, options.targetRef, payload)
    if (fields.length === 0) {
      throw new ProposalError(
        `proposal ${options.type} for ${options.targetRef} would change nothing`,
      )
    }

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
  const name =
    (PROPOSAL_HANDLERS as Record<string, ProposalHandler | undefined>)[row.type]?.targetName(
      db,
      row.targetRef,
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
 * The payload is re-validated and the diff recomputed inside the transaction, so
 * what lands in the audit trail is what this write actually did rather than what
 * the card predicted weeks ago. A proposal whose fields have since been set to the
 * proposed values by hand applies as a no-op, and is still marked applied: the
 * user's decision was made, and re-presenting the card would be a bug.
 */
export function applyProposal(db: Db, options: DecideOptions): ApplyResult {
  const now = options.now ?? new Date()

  return db.transaction((tx) => {
    const row = tx.select().from(proposals).where(eq(proposals.id, options.id)).get()
    if (row === undefined) throw new ProposalError(`proposal ${options.id} does not exist`)
    if (row.status !== 'pending') {
      throw new ProposalError(`proposal ${options.id} is already ${row.status}`)
    }
    if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) {
      // Left pending rather than flipped to expired here: `expireProposals` owns
      // that transition, and doing it in the same breath as refusing the apply
      // would hide the refusal behind a state change.
      throw new ProposalError(`proposal ${options.id} expired on ${row.expiresAt.toISOString()}`)
    }

    const handler = handlerFor(row.type)
    let payload: unknown
    try {
      payload = handler.parse(JSON.parse(row.payloadJson))
    } catch (error) {
      throw new ProposalError(
        `proposal ${options.id} can no longer be applied: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const fields = handler.diff(tx, row.targetRef, payload)
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
