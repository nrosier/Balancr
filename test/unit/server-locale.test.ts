/**
 * How the language is decided, and by whom.
 *
 * One resolution order, in one place: the signed-in account's own setting, then the
 * `balancr_locale` cookie, then a q-weighted `Accept-Language`, then `DEFAULT_LOCALE`.
 * The reason it is worth a suite of its own is that the answer is consumed twice — the
 * `<html lang>` attribute on the document the server sends, and the language the bundle
 * starts in via `/bootstrap` — and the failure mode when those two disagree is a page
 * announcing itself as English while every string on it is Dutch. A screen reader reads
 * that with the wrong voice and no test would notice, because nothing throws.
 *
 * The negotiation halves are tested as pure functions because the interesting cases are
 * in the header grammar rather than in the plumbing: `q=0` is a refusal and not a low
 * preference, `*` is not a language, and `nl-BE` has to select `nl` because that is what
 * the catalogues are keyed by. The four rungs are then tested through the real routes,
 * so what is asserted is the answer a browser would actually get.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { users } from '../../src/db/schema.ts'
import type { Db } from '../../src/db/index.ts'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { buildApp } from '../../src/server/app.ts'
import { createSession } from '../../src/server/auth/sessions.ts'
import { LOCALE_COOKIE, SESSION_COOKIE } from '../../src/server/cookies.ts'
import type { BootstrapResponse } from '../../src/server/contract.ts'
import { negotiateLocale, parseAcceptLanguage } from '../../src/server/locale.ts'

const SUPPORTED = ['en', 'nl'] as const

describe('parseAcceptLanguage', () => {
  it('returns nothing for a request that sent no header', () => {
    expect(parseAcceptLanguage(undefined)).toEqual([])
  })

  it('keeps header order when no weights are given', () => {
    expect(parseAcceptLanguage('nl-BE,nl,en')).toEqual(['nl-be', 'nl', 'en'])
  })

  it('orders by quality rather than by position', () => {
    expect(parseAcceptLanguage('en;q=0.5,nl;q=0.9')).toEqual(['nl', 'en'])
  })

  it('treats an unweighted tag as the strongest preference', () => {
    // `q` defaults to 1, so a tag with no weight outranks anything explicitly weighted.
    expect(parseAcceptLanguage('en;q=0.9,nl')).toEqual(['nl', 'en'])
  })

  it('drops q=0, which is a refusal and not a weak preference', () => {
    // The difference matters: sorted as a number, `nl;q=0` would come last and still
    // be chosen when it is the only supported language in the header.
    expect(parseAcceptLanguage('nl;q=0,en;q=0.5')).toEqual(['en'])
  })

  it('ignores a weight that is not a number rather than dropping the tag', () => {
    expect(parseAcceptLanguage('nl;q=high,en;q=0.2')).toEqual(['nl', 'en'])
  })

  it('lowercases, so a header written NL-be still matches a catalogue', () => {
    expect(parseAcceptLanguage('NL-be')).toEqual(['nl-be'])
  })
})

describe('negotiateLocale', () => {
  it('takes the first supported tag', () => {
    expect(negotiateLocale(['fr', 'nl', 'en'], SUPPORTED)).toBe('nl')
  })

  it('falls back from a region to its base language', () => {
    // The catalogues are `nl` and `en`; a browser asking for `nl-BE` wants Dutch.
    expect(negotiateLocale(['nl-be'], SUPPORTED)).toBe('nl')
  })

  it('prefers an exact match over an earlier base match', () => {
    expect(negotiateLocale(['en-GB', 'nl'], SUPPORTED)).toBe('en')
  })

  it('reads * as the default rather than as a language', () => {
    expect(negotiateLocale(['*'], SUPPORTED)).toBe('en')
  })

  it('answers null when nothing in the header is served', () => {
    // Null rather than the default, so the caller decides — the cookie rung above it
    // has already been tried and the default is the last word, not this function's.
    expect(negotiateLocale(['fr', 'de'], SUPPORTED)).toBeNull()
  })

  it('answers null for an empty header', () => {
    expect(negotiateLocale([], SUPPORTED)).toBeNull()
  })
})

const INDEX_HTML =
  '<!doctype html><html lang="en"><head></head><body><div id="root"></div></body></html>'

let bundle: string
let ctx: ReturnType<typeof createTestDb>
let app: FastifyInstance

/** A signed-in account whose stored language is `locale`, and its session token. */
function signIn(db: Db, locale: string): string {
  const row = db
    .insert(users)
    .values({
      oidcSub: `sub-${crypto.randomUUID()}`,
      email: 'nick@example.test',
      displayName: 'Nick',
      locale,
      role: 'owner',
    })
    .returning()
    .all()[0]
  if (row === undefined) throw new Error('inserting the user returned no row')
  return createSession(db, { userId: row.id, method: 'oidc', ip: undefined, userAgent: undefined })
    .token
}

/** What a browser sends when a person is navigating to a URL. */
const NAVIGATION = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }

const langOf = (html: string): string | null =>
  /<html\b[^>]*\blang="([^"]*)"/.exec(html)?.[1] ?? null

beforeAll(() => {
  bundle = mkdtempSync(join(tmpdir(), 'balancr-locale-'))
  writeFileSync(join(bundle, 'index.html'), INDEX_HTML)
  mkdirSync(join(bundle, 'assets'))
})

afterAll(() => {
  rmSync(bundle, { recursive: true, force: true })
})

beforeEach(async () => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  app = await buildApp({ db: ctx.db, oidc: null, web: bundle })
})

afterEach(async () => {
  await app.close()
  ctx.sqlite.close()
})

/** Both places the resolved language surfaces, for the same request. */
async function resolved(headers: Record<string, string>, cookies: Record<string, string> = {}) {
  const shell = await app.inject({
    method: 'GET',
    url: '/',
    headers: { ...NAVIGATION, ...headers },
    cookies,
  })
  const boot = await app.inject({ method: 'GET', url: '/bootstrap', headers, cookies })
  return {
    lang: langOf(shell.body),
    active: boot.json<BootstrapResponse>().locales.active,
  }
}

describe('the resolution order', () => {
  it('starts from DEFAULT_LOCALE when the request says nothing', async () => {
    expect(await resolved({})).toEqual({ lang: 'en', active: 'en' })
  })

  it('honours Accept-Language', async () => {
    expect(await resolved({ 'accept-language': 'nl-BE,nl;q=0.9' })).toEqual({
      lang: 'nl',
      active: 'nl',
    })
  })

  it('falls back to the default when the header asks for nothing served', async () => {
    expect(await resolved({ 'accept-language': 'fr-BE,fr;q=0.9' })).toEqual({
      lang: 'en',
      active: 'en',
    })
  })

  it('lets the cookie outrank the header', async () => {
    // The cookie is a decision; the header is a browser default. Someone who switched
    // the language on a borrowed laptop should not be switched back on the next load.
    const answer = await resolved({ 'accept-language': 'en' }, { [LOCALE_COOKIE]: 'nl' })
    expect(answer).toEqual({ lang: 'nl', active: 'nl' })
  })

  it('ignores a cookie naming a language the deployment does not serve', async () => {
    // Cookies are visitor-supplied. An unserved value has to fall through to the next
    // rung rather than reach `<html lang>`, or a hand-set cookie decides the attribute.
    const answer = await resolved({ 'accept-language': 'nl' }, { [LOCALE_COOKIE]: 'fr' })
    expect(answer).toEqual({ lang: 'nl', active: 'nl' })
  })

  it('lets the account setting outrank both', async () => {
    const token = signIn(ctx.db, 'nl')
    const answer = await resolved(
      { 'accept-language': 'en' },
      { [SESSION_COOKIE]: token, [LOCALE_COOKIE]: 'en' },
    )
    expect(answer).toEqual({ lang: 'nl', active: 'nl' })
  })

  it('honours the account setting on the shell, which requires no session of its own', async () => {
    // The shell is a public route. It gets `request.user` anyway — the auth preHandler
    // loads the session for every request that carries one — and that is the whole
    // reason the first paint can be in the account's language rather than the browser's.
    const token = signIn(ctx.db, 'nl')
    const res = await app.inject({
      method: 'GET',
      url: '/budget',
      headers: NAVIGATION,
      cookies: { [SESSION_COOKIE]: token },
    })
    expect(res.statusCode).toBe(200)
    expect(langOf(res.body)).toBe('nl')
  })
})

describe('the shell response', () => {
  it('varies on what it resolved from, so one visitor is not cached for the next', async () => {
    const res = await app.inject({ method: 'GET', url: '/', headers: NAVIGATION })
    expect(res.headers['vary']).toBe('accept-language, cookie')
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('changes nothing but the attribute', async () => {
    const dutch = await app.inject({
      method: 'GET',
      url: '/',
      headers: { ...NAVIGATION, 'accept-language': 'nl' },
    })
    expect(dutch.body).toBe(INDEX_HTML.replace('lang="en"', 'lang="nl"'))
  })
})
