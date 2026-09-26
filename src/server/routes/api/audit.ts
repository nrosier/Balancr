/**
 * `GET /api/audit` — the trail of every change a human approved (#592).
 *
 * Owner-only, unlike the rest of this directory: `before`/`after` can carry a
 * co-parent's name or a euro figure a viewer should not see, the same reasoning
 * `settings.ts` already applies to writing these rows in the first place. This
 * route only reads what `src/domain/audit.ts` already recorded.
 */
import type { Db } from '../../../db/index.ts'
import { AUDIT_ACTIONS, auditValues, loadAuditTrail, type AuditAction } from '../../../domain/audit.ts'
import { badRequest } from '../../errors.ts'
import { auditTrailSchema, type AuditTrail } from './schemas.ts'

/** Past this, the query param is refused rather than silently clamped. */
export const MAX_AUDIT_LIMIT = 200
const DEFAULT_AUDIT_LIMIT = 50

const ACTION_SET = new Set<string>(AUDIT_ACTIONS)

function resolveAction(raw: unknown): AuditAction | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw !== 'string' || !ACTION_SET.has(raw)) {
    throw badRequest('action must be one of the recognised audit actions.')
  }
  return raw as AuditAction
}

function resolveString(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw !== 'string') throw badRequest(`${field} must be a string.`)
  return raw
}

function resolveLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_AUDIT_LIMIT
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_AUDIT_LIMIT) {
    throw badRequest(`limit must be an integer between 1 and ${MAX_AUDIT_LIMIT}.`)
  }
  return value
}

export interface AuditQueryParams {
  entity?: unknown
  entityRef?: unknown
  action?: unknown
  limit?: unknown
}

export function buildAuditTrail(db: Db, tenantId: string, query: AuditQueryParams | undefined): AuditTrail {
  const entity = resolveString(query?.entity, 'entity')
  const entityRef = resolveString(query?.entityRef, 'entityRef')
  const action = resolveAction(query?.action)
  const limit = resolveLimit(query?.limit)

  const rows = loadAuditTrail(db, tenantId, {
    ...(entity === undefined ? {} : { entity }),
    ...(entityRef === undefined ? {} : { entityRef }),
    ...(action === undefined ? {} : { action }),
    limit,
  })

  return auditTrailSchema.parse({
    entries: rows.map((row) => ({
      id: row.id,
      action: row.action,
      entity: row.entity,
      entityRef: row.entityRef,
      actorId: row.actorId,
      runId: row.runId,
      proposalId: row.proposalId,
      ...auditValues(row),
      at: row.at.toISOString(),
    })),
  })
}
