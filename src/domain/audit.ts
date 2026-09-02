/**
 * The record of every change a human approved.
 *
 * Two things write here: an answered clarification (the user's own words) and an
 * applied proposal (the model's words, confirmed). Both mutate `category_meta`,
 * which is the one table in the database whose contents cannot be regenerated
 * from Actual or Ghostfolio — so "who changed this, when, and what did it say
 * before" is not bookkeeping, it is the only way to undo a bad answer later.
 *
 * Three properties, each of which is a decision rather than a convention:
 *
 *  - **Append only.** Nothing in this module updates or deletes a row. The
 *    absence of an `updateAudit` is the guarantee.
 *  - **No foreign keys** (see `audit_log` in the schema). An entry survives the
 *    pruning of the run that suggested it and the deletion of the account that
 *    approved it, and a reader treats a dangling id as "no longer available".
 *  - **Field pairs, not sentences.** `before`/`after` hold the values, so a trail
 *    written during a Dutch session reads correctly in English. Rendering is the
 *    UI's job, exactly as it is for findings.
 */
import { and, desc, eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { auditLog } from '../db/schema.ts'

export type AuditRow = typeof auditLog.$inferSelect

/**
 * Anything that can insert: the database, or an open transaction.
 *
 * Both writers here change `category_meta` and record the entry in one
 * transaction — an applied change with no trail, or a trail for a change that
 * rolled back, are both worse than either failing outright.
 */
export type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0]
export type AuditWriter = Db | Transaction

/**
 * What may be recorded. A closed set for the same reason the finding codes are:
 * an action nothing renders is an action nobody reads, and the audit view groups
 * by this.
 */
export const AUDIT_ACTIONS = [
  'clarification.answer',
  'clarification.dismiss',
  'proposal.apply',
  'proposal.reject',
  /**
   * The settings screen's writes.
   *
   * They belong here for the same reason the other four do: `settings`,
   * `prompts` and `account_map` hold judgement rather than data, so none of it
   * can be regenerated from Actual or Ghostfolio. A threshold that quietly
   * changed three months ago is the kind of thing that makes a chart look like a
   * bug, and `before`/`after` is the only way to answer "was it always 3 000?".
   *
   * `prompt.create` is recorded even though `prompts` is itself versioned: the
   * row says what the text became, and the entry says who made it and when.
   */
  'settings.params',
  'settings.locale',
  'account.map',
  'prompt.create',
  'prompt.activate',
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export interface AuditEntry {
  action: AuditAction
  /** The table the change landed in, e.g. `category_meta`. */
  entity: string
  /** Which row — a category id, an account id. */
  entityRef: string
  /** Who approved it. Null for a change the system made unattended. */
  actorId?: string | null
  /** The AI run that suggested it, when one did. */
  runId?: string | null
  proposalId?: string | null
  /** Only the fields that changed, so the entry is readable at a glance. */
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  at?: Date
}

const json = (value: Record<string, unknown> | null | undefined): string | null =>
  value === undefined || value === null ? null : JSON.stringify(value)

/** Appends one entry and returns its id. */
export function recordAudit(writer: AuditWriter, entry: AuditEntry): string {
  const rows = (writer as Db)
    .insert(auditLog)
    .values({
      action: entry.action,
      entity: entry.entity,
      entityRef: entry.entityRef,
      actorId: entry.actorId ?? null,
      runId: entry.runId ?? null,
      proposalId: entry.proposalId ?? null,
      beforeJson: json(entry.before),
      afterJson: json(entry.after),
      ...(entry.at === undefined ? {} : { at: entry.at }),
    })
    .returning()
    .all()

  const row = rows[0]
  if (row === undefined) throw new Error(`failed to record audit entry ${entry.action}`)
  return row.id
}

export interface AuditQuery {
  entity?: string
  entityRef?: string
  action?: AuditAction
  limit?: number
}

/**
 * The trail, newest first.
 *
 * Newest first because the question this answers is almost always "what happened
 * to this category recently", and a caller wanting the original state reads the
 * `before` of the oldest entry rather than paging through the newest.
 */
export function loadAuditTrail(db: Db, query: AuditQuery = {}): AuditRow[] {
  const filters = [
    ...(query.entity === undefined ? [] : [eq(auditLog.entity, query.entity)]),
    ...(query.entityRef === undefined ? [] : [eq(auditLog.entityRef, query.entityRef)]),
    ...(query.action === undefined ? [] : [eq(auditLog.action, query.action)]),
  ]

  return db
    .select()
    .from(auditLog)
    .where(filters.length === 0 ? undefined : and(...filters))
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(query.limit ?? 200)
    .all()
}

/** The stored pair, parsed. Unreadable json reads as absent, never as a throw. */
export function auditValues(row: AuditRow): {
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
} {
  const parse = (raw: string | null): Record<string, unknown> | null => {
    if (raw === null) return null
    try {
      const value: unknown = JSON.parse(raw)
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }
  return { before: parse(row.beforeJson), after: parse(row.afterJson) }
}
