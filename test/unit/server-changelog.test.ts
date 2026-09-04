/**
 * The changelog the version dialog reads.
 *
 * `parseChangelog` is tested against a fixture rather than the real
 * `CHANGELOG.md`, because the parser's contract does not depend on today's
 * entries and a test tied to them would break on every release. The route test
 * covers the one thing a fixture cannot: that a session is required, same as
 * every other endpoint in this directory.
 */
import { describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { users } from '../../src/db/schema.ts'
import { buildApp } from '../../src/server/app.ts'
import { createSession } from '../../src/server/auth/sessions.ts'
import { SESSION_COOKIE } from '../../src/server/cookies.ts'
import { parseChangelog } from '../../src/server/routes/api/changelog.ts'
import type { Changelog } from '../../src/server/routes/api/schemas.ts'
import { apiFixture } from '../helpers/api-fixture.ts'

const FIXTURE = `# Changelog

All notable changes to Balancr.

## [0.2.0] — 2026-01-15

### Added

- **A thing happened** ([#12](https://github.com/nrosier/Balancr/issues/12)).
  More detail on the same bullet.
- Another bullet.

## [0.1.0] — 2026-01-01

### Fixed

- The first fix.
`

describe('parseChangelog', () => {
  it('splits the file into one entry per version heading', () => {
    const changelog = parseChangelog(FIXTURE)

    expect(changelog.available).toBe(true)
    expect(changelog.entries.map((entry) => entry.version)).toEqual(['0.2.0', '0.1.0'])
    expect(changelog.entries[0]?.date).toBe('2026-01-15')
  })

  it('drops the preamble above the first heading', () => {
    const changelog = parseChangelog(FIXTURE)
    expect(changelog.entries[0]?.html).not.toContain('Changelog')
    expect(changelog.entries[0]?.html).not.toContain('All notable changes')
  })

  it('renders each body through the same sanitiser as the AI narrative', () => {
    const changelog = parseChangelog(FIXTURE)
    const html = changelog.entries[0]?.html ?? ''

    expect(html).toContain('<h3>Added</h3>')
    expect(html).toContain('A thing happened')
    // The issue reference collapses to its label, same as everywhere else
    // `renderMarkdown` is used — the label text survives, the href does not.
    expect(html).toContain('#12')
    expect(html).not.toContain('href')
  })

  it('builds the release link from the version, not from the markdown', () => {
    const changelog = parseChangelog(FIXTURE)
    expect(changelog.entries[0]?.releaseUrl).toBe(
      'https://github.com/nrosier/Balancr/releases/tag/v0.2.0',
    )
  })

  it('degrades to an empty, unavailable changelog rather than throwing', () => {
    expect(parseChangelog(null)).toEqual({ available: false, entries: [] })
  })
})

describe('GET /api/changelog', () => {
  it('needs a session', async () => {
    const ctx = apiFixture()
    const app = await buildApp({ db: ctx.db, web: null })

    const res = await app.inject({ method: 'GET', url: '/api/changelog' })
    expect(res.statusCode).toBe(401)

    await app.close()
    ctx.sqlite.close()
  })

  it('answers with the shape the dialog expects, once signed in', async () => {
    const ctx = apiFixture()
    const app: FastifyInstance = await buildApp({ db: ctx.db, web: null })
    const row = ctx.db
      .insert(users)
      .values({
        oidcSub: `sub-${crypto.randomUUID()}`,
        email: 'nick@example.test',
        displayName: 'Nick',
        locale: 'en',
        role: 'owner',
      })
      .returning()
      .all()[0]
    if (row === undefined) throw new Error('inserting the user returned no row')
    const session = createSession(ctx.db, {
      userId: row.id,
      method: 'oidc',
      ip: undefined,
      userAgent: undefined,
    }).token

    const res = await app.inject({
      method: 'GET',
      url: '/api/changelog',
      cookies: { [SESSION_COOKIE]: session },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<Changelog>()
    expect(typeof body.available).toBe('boolean')
    expect(Array.isArray(body.entries)).toBe(true)

    await app.close()
    ctx.sqlite.close()
  })
})
