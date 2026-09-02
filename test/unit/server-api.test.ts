/**
 * The read-only API, through the real app.
 *
 * Four things are worth testing here, and only one of them is "the shape is
 * right":
 *
 *  - **Every endpoint needs a session.** None of the four says anything about
 *    `auth`, which is how the deny-by-default guard is supposed to work. A route
 *    that quietly became public would be a whole financial picture served to
 *    anyone who reached the container.
 *  - **No amount is ever a float.** The schemas assert it at the boundary; this
 *    walks the actual responses and checks every `*Cents`/`*Bp`/`*MicroEur` value
 *    in them, nested arrays included. One `/ 2` in a future aggregate turns
 *    `1234` into `1234.5`, which renders as `€ 12,345` — wrong by an order of
 *    magnitude, and invisible to a test of that aggregate.
 *  - **An empty deployment answers `null`, not `0`.** Zero net worth is a number
 *    someone would act on; "not computed yet" is the truth before the first sync.
 *  - **The directory never imports an adapter.** Asserted by scanning the source,
 *    because the rule is a property of the whole directory rather than of any one
 *    file, and the failure mode is a page that is slow and fragile for reasons
 *    nobody can see from the route.
 *
 * The database under all of it is built by `apiFixture`, which calls the same
 * persistence functions the jobs call — so these assertions are about the read
 * path rather than about rows a test invented.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { users } from '../../src/db/schema.ts'
import type { Db } from '../../src/db/index.ts'
import { buildApp } from '../../src/server/app.ts'
import { createSession } from '../../src/server/auth/sessions.ts'
import { SESSION_COOKIE } from '../../src/server/cookies.ts'
import { TREND_MONTHS } from '../../src/server/routes/api/budget.ts'
import { emergencyFundCentimonths } from '../../src/server/routes/api/overview.ts'
import { apiFixture, MONTH, PREVIOUS_MONTH, SNAPSHOT_DATE } from '../helpers/api-fixture.ts'

const ENDPOINTS = ['/api/overview', '/api/budget', '/api/portfolio', '/api/insights'] as const

let ctx: ReturnType<typeof apiFixture>
let app: FastifyInstance
let session: string

/** A signed-in owner, without walking the OIDC flow to get one. */
function signIn(db: Db, locale = 'en'): string {
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

/** A GET as the signed-in user. */
const get = (url: string, token = session) =>
  app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: token } })

async function open(options: Parameters<typeof apiFixture>[0] = {}): Promise<void> {
  ctx = apiFixture(options)
  app = await buildApp({ db: ctx.db, web: null })
  session = signIn(ctx.db)
}

beforeEach(async () => {
  await open()
})

afterEach(async () => {
  await app.close()
  ctx.sqlite.close()
})

describe('the guard', () => {
  it('refuses every endpoint without a session', async () => {
    for (const url of ENDPOINTS) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(401)
      expect(res.json<{ error: { code: string } }>().error.code, url).toBe('unauthenticated')
    }
  })

  it('serves every endpoint to a signed-in user', async () => {
    for (const url of ENDPOINTS) {
      const res = await get(url)
      expect(res.statusCode, url).toBe(200)
    }
  })

  it('counts every endpoint against the global rate limit', async () => {
    // Not a route-level bucket — the global one, which these inherit by not
    // opting out. The header is the observable proof they are inside it, and a
    // future `rateLimit: false` on one of them would show up here.
    for (const url of ENDPOINTS) {
      const res = await get(url)
      expect(res.headers['x-ratelimit-limit'], url).toBeDefined()
    }
  })
})

describe('GET /api/overview', () => {
  it('reports net worth, the month and the hygiene score', async () => {
    const body = (await get('/api/overview')).json()

    expect(body.netWorth).toEqual({
      date: SNAPSHOT_DATE,
      totalCents: 4_820_000,
      liquidCents: 1_240_000,
      investedCents: 3_700_000,
      debtCents: 120_000,
    })
    expect(body.month).toBe(MONTH)
    expect(body.totals.incomeCents).toBe(400_000)
    expect(body.totals.spentCents).toBe(352_000)
    expect(body.hygiene.scoreBp).toBe(9_150)
    expect(body.history).toEqual([{ date: SNAPSHOT_DATE, totalCents: 4_820_000 }])
  })

  it('states cover in hundredths of a month, over the mean of the window', async () => {
    const body = (await get('/api/overview')).json()
    // Mean of 310 000 and 352 000 is 331 000; 1 240 000 / 331 000 = 3.745…
    expect(body.emergencyFundCentimonths).toBe(375)
  })
})

describe('GET /api/budget', () => {
  it('returns the latest computed month by default', async () => {
    const body = (await get('/api/budget')).json()

    expect(body.month).toBe(MONTH)
    // Descending, so a picker's first entry is the most recent.
    expect(body.months).toEqual([MONTH, PREVIOUS_MONTH])
    expect(body.totals.balanceCents).toBe(48_000)
    expect(body.uncategorised).toEqual({ txnCount: 3, amountCents: 4_250 })
  })

  it('flattens the baseline onto the category it belongs to', async () => {
    const body = (await get('/api/budget')).json()
    const groceries = body.categories.find(
      (row: { categoryId: string }) => row.categoryId === 'cat-groceries',
    )

    expect(groceries.spentCents).toBe(72_000)
    expect(groceries.baselineCents).toBe(61_000)
    expect(groceries.deltaBp).toBe(1_803)

    // Null rather than zero where there is not enough history to state a norm —
    // a norm of zero would read as "you always spend nothing on this".
    const energy = body.categories.find(
      (row: { categoryId: string }) => row.categoryId === 'cat-energy',
    )
    expect(energy.baselineCents).toBeNull()
    expect(energy.deltaBp).toBeNull()
  })

  it('returns findings as codes and integers, never as sentences', async () => {
    const body = (await get('/api/budget')).json()
    expect(body.signals).toHaveLength(2)
    expect(body.signals[0].code).toBe('above_baseline')
    expect(body.signals[0].severity).toBe('warn')
    expect(body.signals[0].metrics.deltaBp).toBe(1_803)
  })

  it('passes an alert through under the name the database stores it by', async () => {
    // `codes.ts`, `SEVERITY_RANK`, `capSeverity` and the `signals` column all say
    // `alert`; the response schema briefly said `critical`, and since nothing
    // translated between them every genuine alert came back as a 500 from here.
    const body = (await get('/api/budget')).json()
    const alert = body.signals.find(
      (row: { severity: string }) => row.severity === 'alert',
    )

    expect(alert.code).toBe('over_available')
    expect(alert.metrics.overspendCents).toBe(9_500)
  })

  it('carries a trend series per category, aligned to one shared window', async () => {
    const body = (await get('/api/budget')).json()

    // One window for the whole screen: twelve small charts are only comparable if
    // they share an x axis, and the client indexes into this list.
    expect(body.trendMonths).toHaveLength(TREND_MONTHS)
    expect(body.trendMonths.at(-1)).toBe(MONTH)
    expect(body.trendMonths.at(-2)).toBe(PREVIOUS_MONTH)

    for (const row of body.categories) {
      expect(row.trendCents, row.categoryId).toHaveLength(TREND_MONTHS)
    }

    const groceries = body.categories.find(
      (row: { categoryId: string }) => row.categoryId === 'cat-groceries',
    )
    // The two stored months at the end, zeroes before them: the fixture holds two
    // months of history, and a category spent nothing in a month it has no row for.
    expect(groceries.trendCents.slice(-2)).toEqual([60_000, 72_000])
    expect(groceries.trendCents.slice(0, -2).every((cents: number) => cents === 0)).toBe(true)
  })

  it('ends the trend window at the month asked for, not at today', async () => {
    // Pointing the picker at an older month should describe that month rather than
    // drawing a line that runs past it.
    const body = (await get(`/api/budget?month=${PREVIOUS_MONTH}`)).json()
    expect(body.trendMonths.at(-1)).toBe(PREVIOUS_MONTH)

    const groceries = body.categories.find(
      (row: { categoryId: string }) => row.categoryId === 'cat-groceries',
    )
    expect(groceries.trendCents.at(-1)).toBe(60_000)
  })

  it('honours ?month= for a month it has', async () => {
    const body = (await get(`/api/budget?month=${PREVIOUS_MONTH}`)).json()
    expect(body.month).toBe(PREVIOUS_MONTH)
    expect(body.totals.spentCents).toBe(310_000)
  })

  it('keeps offering every stored month, whichever one is being viewed', async () => {
    // The picker is how the reader got here, so looking at July must not take August
    // out of the list — a window ending at the month on screen would.
    const body = (await get(`/api/budget?month=${PREVIOUS_MONTH}`)).json()
    expect(body.months).toEqual([MONTH, PREVIOUS_MONTH])
  })

  it('answers a month it never computed with the empty state, not a 404', async () => {
    // A stale bookmark, which is not an error worth a red banner. The label is
    // the month that was asked for, so the client can say so.
    const res = await get('/api/budget?month=2019-03')
    expect(res.statusCode).toBe(200)
    expect(res.json().month).toBe('2019-03')
    expect(res.json().totals).toBeNull()
    expect(res.json().categories).toEqual([])
    // And still offers the months that do exist, or the reader is stranded there.
    expect(res.json().months).toEqual([MONTH, PREVIOUS_MONTH])
  })

  it('refuses a month that is not a month', async () => {
    // A silent fallback to the latest month would serve one month's numbers under
    // another month's label and hide the client's bug behind plausible data.
    for (const month of ['2026-13', 'august', '2026-8', '2026-08-01']) {
      const res = await get(`/api/budget?month=${month}`)
      expect(res.statusCode, month).toBe(400)
      expect(res.json<{ error: { code: string } }>().error.code, month).toBe('bad_request')
    }
  })
})

describe('GET /api/portfolio', () => {
  it('returns the latest snapshot, largest holding first', async () => {
    const body = (await get('/api/portfolio')).json()

    expect(body.date).toBe(SNAPSHOT_DATE)
    expect(body.totalValueCents).toBe(382_143)
    expect(body.twrBp).toBe(742)
    expect(body.holdings.map((row: { symbol: string }) => row.symbol)).toEqual([
      'IWDA.AS',
      'WSML.AS',
    ])
    expect(body.allocation).toEqual([
      { assetClass: 'EQUITY', valueCents: 382_143, shareBp: 10_000 },
    ])
  })

  it('carries quantity as the exact decimal string the provider gave', async () => {
    // Fractional shares are real and a quantity is not money, so neither an
    // integer nor a float is right. The text neither rounds nor invents precision.
    const body = (await get('/api/portfolio')).json()
    expect(body.holdings[0].quantity).toBe('31.5')
    expect(typeof body.holdings[0].quantity).toBe('string')
  })

  it('omits money-weighted return rather than reporting it as zero', async () => {
    const body = (await get('/api/portfolio')).json()
    expect(body.mwrBp).toBeUndefined()
  })
})

describe('GET /api/insights', () => {
  it('reports the month, its findings and the AI spend', async () => {
    const body = (await get('/api/insights')).json()

    expect(body.month).toBe(MONTH)
    expect(body.signals[0].code).toBe('above_baseline')
    // Nothing has been spent, and the figure is reported before it is a problem.
    expect(body.spend.spentMicroEur).toBe(0)
    expect(body.spend.exceeded).toBe(false)
    expect(body.narrative).toBeNull()
    expect(body.questions).toEqual([])
    expect(body.proposals).toEqual([])
  })

  it('never calls the model to answer a read', async () => {
    // Asserted by the absence of an `ai_runs` row: a request that reached Gemini
    // would have written one, and the whole cost guard depends on it not happening.
    const before = ctx.db.$client.prepare('select count(*) as n from ai_runs').get() as {
      n: number
    }
    await get('/api/insights')
    const after = ctx.db.$client.prepare('select count(*) as n from ai_runs').get() as { n: number }
    expect(after.n).toBe(before.n)
  })
})

describe('freshness', () => {
  it('rides on every response', async () => {
    for (const url of ENDPOINTS) {
      const body = (await get(url)).json()
      expect(body.freshness, url).toBeDefined()
      expect(body.freshness.stale, url).toBe(false)
      expect(body.freshness.asOf, url).not.toBeNull()
      expect(body.freshness.jobsEnabled, url).toBe(true)
    }
  })

  it('names the jobs and reports no error while they are fine', async () => {
    const body = (await get('/api/overview')).json()
    const names = body.freshness.jobs.map((job: { name: string }) => job.name)
    expect(names).toEqual(expect.arrayContaining(['sync', 'portfolio', 'networth', 'signals']))
    for (const job of body.freshness.jobs) expect(job.error).toBeNull()
  })

  it('turns stale, on every endpoint, when a data job last failed', async () => {
    await app.close()
    ctx.sqlite.close()
    await open({ jobsFailed: true })

    for (const url of ENDPOINTS) {
      const body = (await get(url)).json()
      expect(body.freshness.stale, url).toBe(true)
      const sync = body.freshness.jobs.find((job: { name: string }) => job.name === 'sync')
      expect(sync.error, url).toContain('ECONNREFUSED')
    }
  })
})

describe('a deployment that has never run a job', () => {
  beforeEach(async () => {
    await app.close()
    ctx.sqlite.close()
    await open({ empty: true })
  })

  it('answers null rather than zero', async () => {
    const overview = (await get('/api/overview')).json()
    expect(overview.netWorth).toBeNull()
    expect(overview.month).toBeNull()
    expect(overview.totals).toBeNull()
    expect(overview.emergencyFundCentimonths).toBeNull()
    expect(overview.hygiene).toBeNull()

    const portfolio = (await get('/api/portfolio')).json()
    expect(portfolio.date).toBeNull()
    expect(portfolio.totalValueCents).toBeNull()
    expect(portfolio.twrBp).toBeNull()
  })

  it('does not describe an empty deployment as stale', async () => {
    // The first thing a new user sees should not be a warning about nothing.
    const body = (await get('/api/overview')).json()
    expect(body.freshness.stale).toBe(false)
    expect(body.freshness.asOf).toBeNull()
    expect(body.freshness.jobs).toEqual([])
  })

  it('still serves the budget, labelled with the current month', async () => {
    const body = (await get('/api/budget')).json()
    expect(body.month).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/)
    expect(body.months).toEqual([])
    expect(body.totals).toBeNull()
    expect(body.uncategorised).toBeNull()
  })
})

describe('money', () => {
  /** Every `*Cents`, `*Bp`, `*MicroEur` or `*Centimonths` value anywhere in a payload. */
  function amounts(value: unknown, path = '$'): { path: string; value: unknown }[] {
    if (Array.isArray(value)) return value.flatMap((item, i) => amounts(item, `${path}[${i}]`))
    if (value === null || typeof value !== 'object') return []
    return Object.entries(value).flatMap(([key, child]) => {
      const here = `${path}.${key}`
      const named = /(Cents|Bp|MicroEur|Centimonths)$/.test(key)
      // `metrics` is a free-form map whose keys carry the unit, so its values are
      // amounts whatever they are called.
      const inMetrics = /\.metrics$/.test(path)
      if (!named && !inMetrics) return amounts(child, here)
      // A series under an amount-named key — `trendCents` is one spend figure per
      // month — is checked element by element. The array is not the number; its
      // entries are, and asserting on the array would only prove it is an array.
      if (Array.isArray(child)) {
        return child.flatMap((item, i) =>
          item !== null && typeof item === 'object'
            ? amounts(item, `${here}[${i}]`)
            : [{ path: `${here}[${i}]`, value: item }],
        )
      }
      return [{ path: here, value: child }, ...amounts(child, here)]
    })
  }

  it('is integer cents and integer basis points, everywhere, on every endpoint', async () => {
    for (const url of ENDPOINTS) {
      const found = amounts((await get(url)).json())
      // A guard against the walk itself silently matching nothing.
      expect(found.length, url).toBeGreaterThan(5)
      for (const { path, value } of found) {
        if (value === null) continue
        expect(typeof value, `${url} ${path}`).toBe('number')
        expect(Number.isInteger(value), `${url} ${path} = ${String(value)}`).toBe(true)
      }
    }
  })
})

describe('the locale of the rendered-text exceptions', () => {
  it('follows the signed-in user’s own setting', async () => {
    const nl = signIn(ctx.db, 'nl')
    const res = await get('/api/insights', nl)
    expect(res.statusCode).toBe(200)
  })

  it('accepts ?locale= for a preview, and ignores one it does not support', async () => {
    for (const locale of ['nl', 'en', 'klingon']) {
      const res = await get(`/api/insights?locale=${locale}`)
      // An unsupported value falls through to the default rather than 400ing: the
      // worst case is reading the dashboard in English.
      expect(res.statusCode, locale).toBe(200)
    }
  })
})

describe('the no-upstream rule', () => {
  it('holds for every file in the directory, not just the ones anyone remembers', () => {
    // The same technique as the Actual read-only denylist test: the rule is a
    // property of the directory, so it is checked against the directory.
    const dir = 'src/server/routes/api'
    const offenders = readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => /from '[^']*adapters\//.test(readFileSync(`${dir}/${name}`, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('has no route opting out of the guard or the rate limit', () => {
    const dir = 'src/server/routes/api'
    const offenders = readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => /(auth|csrf|rateLimit):\s*false/.test(readFileSync(`${dir}/${name}`, 'utf8')))
    expect(offenders).toEqual([])
  })
})

describe('months of cover', () => {
  // The two cases a fixture cannot produce, tested directly. Both answer null,
  // and both would otherwise be a number on the dashboard: `Infinity` renders as
  // nonsense, and a division by an average of zero is not a figure about money.
  it('is unknown rather than infinite when there is no spend to divide by', () => {
    expect(emergencyFundCentimonths(1_240_000, [])).toBeNull()
    expect(emergencyFundCentimonths(1_240_000, [{ spentCents: 0 }, { spentCents: 0 }])).toBeNull()
  })

  it('averages the window rather than reading the latest month', () => {
    // A holiday or an annual premium in one month would otherwise halve the
    // figure and read as an emergency.
    const spiky = [{ spentCents: 100_000 }, { spentCents: 100_000 }, { spentCents: 400_000 }]
    expect(emergencyFundCentimonths(600_000, spiky)).toBe(300)
    expect(emergencyFundCentimonths(600_000, [{ spentCents: 400_000 }])).toBe(150)
  })

  it('is hundredths of a month, so a fraction never becomes a float', () => {
    expect(emergencyFundCentimonths(333_333, [{ spentCents: 100_000 }])).toBe(333)
  })
})
