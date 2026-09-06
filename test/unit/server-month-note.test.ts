/**
 * `GET`/`PATCH /api/budget/note` (#217, redesigned per-month by #270).
 *
 * One thing is load-bearing here beyond the ordinary owner/viewer split: a note
 * is keyed by month, so writing one must never touch another's.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../../src/db/index.ts'
import { auditLog, users } from '../../src/db/schema.ts'
import { loadMonthNote, MONTH_NOTE_MAX_CHARS } from '../../src/domain/ai/month-note.ts'
import { initI18n } from '../../src/i18n/index.ts'
import { buildApp } from '../../src/server/app.ts'
import { createSession } from '../../src/server/auth/sessions.ts'
import { CSRF_COOKIE, SESSION_COOKIE } from '../../src/server/cookies.ts'
import { CSRF_HEADER, newCsrfToken } from '../../src/server/csrf.ts'
import { apiFixture, MONTH, PREVIOUS_MONTH } from '../helpers/api-fixture.ts'

let ctx: ReturnType<typeof apiFixture>
let app: FastifyInstance
let owner: string
let viewer: string

function signIn(db: Db, role: 'owner' | 'viewer'): string {
  const row = db
    .insert(users)
    .values({
      oidcSub: `sub-${crypto.randomUUID()}`,
      email: `${role}@example.test`,
      displayName: role,
      locale: 'en',
      role,
    })
    .returning()
    .all()[0]
  if (row === undefined) throw new Error('inserting the user returned no row')
  return createSession(db, { userId: row.id, method: 'oidc', ip: undefined, userAgent: undefined })
    .token
}

const get = (url: string, token = owner) =>
  app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: token } })

function patch(url: string, body: object, options: { token?: string; csrf?: boolean } = {}) {
  const csrf = newCsrfToken()
  return app.inject({
    method: 'PATCH',
    url,
    payload: body,
    cookies: {
      [SESSION_COOKIE]: options.token ?? owner,
      ...(options.csrf === false ? {} : { [CSRF_COOKIE]: csrf }),
    },
    headers: options.csrf === false ? {} : { [CSRF_HEADER]: csrf },
  })
}

/** The audit actions written, most recent first. */
const auditActions = (db: Db): string[] =>
  db
    .select({ action: auditLog.action })
    .from(auditLog)
    .all()
    .map((row) => row.action)

beforeAll(async () => {
  await initI18n()
})

beforeEach(async () => {
  ctx = apiFixture()
  app = await buildApp({ db: ctx.db, web: null })
  owner = signIn(ctx.db, 'owner')
  viewer = signIn(ctx.db, 'viewer')
})

afterEach(async () => {
  await app.close()
  ctx.sqlite.close()
})

describe('GET /api/budget/note', () => {
  it('answers with an empty note for a month with none', async () => {
    const res = await get(`/api/budget/note?month=${MONTH}`)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ text: string }>().text).toBe('')
  })

  it('answers with a stored note for that month', async () => {
    await patch('/api/budget/note', { month: MONTH, text: 'Replaced the dishwasher this month.' })
    const res = await get(`/api/budget/note?month=${MONTH}`)
    expect(res.json<{ text: string }>().text).toBe('Replaced the dishwasher this month.')
  })

  it('refuses a malformed month', async () => {
    const res = await get('/api/budget/note?month=2026-13')
    expect(res.statusCode).toBe(400)
  })

  it('refuses a missing month', async () => {
    const res = await get('/api/budget/note')
    expect(res.statusCode).toBe(400)
  })

  it('is readable by a viewer', async () => {
    const res = await get(`/api/budget/note?month=${MONTH}`, viewer)
    expect(res.statusCode).toBe(200)
  })
})

describe('PATCH /api/budget/note', () => {
  it('stores the note and answers with it', async () => {
    const res = await patch('/api/budget/note', { month: MONTH, text: 'Dentist bill, about 150 euros.' })

    expect(res.statusCode).toBe(200)
    expect(res.json<{ text: string }>().text).toBe('Dentist bill, about 150 euros.')
    expect(loadMonthNote(ctx.db, MONTH)).toBe('Dentist bill, about 150 euros.')
  })

  it('keeps each month independent', async () => {
    await patch('/api/budget/note', { month: MONTH, text: 'This month is high because of the dishwasher.' })
    await patch('/api/budget/note', { month: PREVIOUS_MONTH, text: 'Nothing unusual.' })

    expect(loadMonthNote(ctx.db, MONTH)).toBe('This month is high because of the dishwasher.')
    expect(loadMonthNote(ctx.db, PREVIOUS_MONTH)).toBe('Nothing unusual.')
  })

  it('deletes the key entirely when cleared, so an empty text clears it', async () => {
    await patch('/api/budget/note', { month: MONTH, text: 'Dentist bill in March.' })
    const res = await patch('/api/budget/note', { month: MONTH, text: '' })

    expect(res.json<{ text: string }>().text).toBe('')
    expect(loadMonthNote(ctx.db, MONTH)).toBe('')
  })

  it('trims the stored text', async () => {
    const res = await patch('/api/budget/note', { month: MONTH, text: '  padded  ' })
    expect(res.json<{ text: string }>().text).toBe('padded')
  })

  it('refuses text over the length bound', async () => {
    const res = await patch('/api/budget/note', { month: MONTH, text: 'x'.repeat(MONTH_NOTE_MAX_CHARS + 1) })
    expect(res.statusCode).toBe(400)
    expect(loadMonthNote(ctx.db, MONTH)).toBe('')
  })

  it('refuses a malformed month', async () => {
    const res = await patch('/api/budget/note', { month: '2026-13', text: 'fine' })
    expect(res.statusCode).toBe(400)
  })

  it('refuses an unknown field', async () => {
    const res = await patch('/api/budget/note', { month: MONTH, text: 'fine', extra: true })
    expect(res.statusCode).toBe(400)
  })

  it('is refused for a viewer', async () => {
    const res = await patch('/api/budget/note', { month: MONTH, text: 'Dentist bill in March.' }, { token: viewer })
    expect(res.statusCode).toBe(403)
    expect(loadMonthNote(ctx.db, MONTH)).toBe('')
  })

  it('records the write in the audit log', async () => {
    await patch('/api/budget/note', { month: MONTH, text: 'Dentist bill in March.' })
    expect(auditActions(ctx.db)).toContain('budget.monthNote')
  })

  it('refuses a write with no CSRF token', async () => {
    const res = await patch('/api/budget/note', { month: MONTH, text: 'fine' }, { csrf: false })
    expect(res.statusCode).toBe(403)
  })
})
