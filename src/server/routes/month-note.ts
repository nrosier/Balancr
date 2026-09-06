/**
 * A month's own free-text note, read and written from the Budget page (#217, #270).
 *
 * Outside `routes/api/` for the same reason `proposals.ts` is: it writes — to the
 * `settings` row `month-note.ts` owns and to the audit log — so it can't be one of
 * that directory's read-only routes. Not folded into `settings.ts` either: this note
 * moved off the settings page entirely, and `settings.ts` owns one page's whole
 * payload, not an unrelated resource that happens to share a storage mechanism.
 *
 * Owner-only for the write, same as every other settings-shaped write: a viewer may
 * read a month's context, not add to it.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Db } from '../../db/index.ts'
import { recordAudit } from '../../domain/audit.ts'
import { loadMonthNote, saveMonthNote, MONTH_NOTE_KEY } from '../../domain/ai/month-note.ts'
import { requireOwner } from '../auth/guard.ts'
import { badRequest, invalidBody } from '../errors.ts'
import { monthKey } from './api/schemas.ts'
import { fieldIssues, parseBody } from '../validate.ts'

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

function resolveMonth(raw: unknown): string {
  if (typeof raw !== 'string' || !MONTH_PATTERN.test(raw)) {
    throw badRequest('month must be YYYY-MM.')
  }
  return raw
}

const monthNotePatchRequest = z.strictObject({ month: monthKey(), text: z.string() })

export function registerMonthNoteRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/budget/note', (request: FastifyRequest) => {
    const month = resolveMonth((request.query as { month?: unknown } | undefined)?.month)
    return { text: loadMonthNote(db, month) }
  })

  app.patch('/api/budget/note', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const { month, text } = parseBody(monthNotePatchRequest, request.body)

    const before = loadMonthNote(db, month)
    let after: string
    try {
      after = saveMonthNote(db, month, text)
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw invalidBody('The request body was not valid.', fieldIssues(error))
      }
      throw error
    }

    recordAudit(db, {
      action: 'budget.monthNote',
      entity: 'settings',
      entityRef: `${MONTH_NOTE_KEY}:${month}`,
      actorId: user.id,
      before: { text: before },
      after: { text: after },
    })

    return { text: after }
  })
}
