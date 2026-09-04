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
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { categoryMeta, clarificationQueue, proposals, users } from '../../src/db/schema.ts'
import type { Db } from '../../src/db/index.ts'
import { buildApp } from '../../src/server/app.ts'
import { createSession } from '../../src/server/auth/sessions.ts'
import { SESSION_COOKIE } from '../../src/server/cookies.ts'
import { TREND_MONTHS } from '../../src/server/routes/api/budget.ts'
import { emergencyFundCentimonths } from '../../src/server/routes/api/overview.ts'
import { initI18n } from '../../src/i18n/index.ts'
import { storeNarrative } from '../../src/domain/ai/narrative.ts'
import { recordRun } from '../../src/domain/ai/runs.ts'
import { saveHousehold } from '../../src/domain/benchmark/household.ts'
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

beforeAll(async () => {
  // The insights route renders three things from the catalogue — the narrative's
  // "unnamed category", the clarification questions and the proposal diffs — so it
  // needs the same i18n singleton `main.ts` starts before it listens. Everything
  // else here is codes and integers and would pass without it.
  await initI18n()
})

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

  it('splits the shared categories, and leaves what was paid alone (#44)', async () => {
    // Flagged and split in one gesture on the settings screen, so the card appears on
    // the next reload: the split is recomputed per request rather than stored, and this
    // is the assertion that proves it — nothing here re-runs the nightly pass.
    ctx.db
      .update(categoryMeta)
      .set({ custodyShared: true })
      .where(sql`category_id = 'cat-groceries'`)
      .run()
    saveHousehold(ctx.db, { members: [{ birthYear: 2013, custodyBp: 5_000 }] })

    const body = (await get('/api/budget')).json()
    expect(body.custody.kind).toBe('ok')
    expect(body.custody.basis).toBe('roster')
    expect(body.custody.shareBp).toBe(5_000)
    // Actual's own figure, unchanged, and the borne figure beside it.
    expect(body.custody.paidCents).toBe(72_000)
    expect(body.custody.borneCents).toBe(36_000)
    expect(body.custody.offsetCents).toBe(36_000)
    expect(body.custody.lines).toEqual([
      {
        categoryId: 'cat-groceries',
        categoryName: 'Groceries',
        paidCents: 72_000,
        borneCents: 36_000,
      },
    ])
    // And the category itself still reports what left the account, or the two halves of
    // the page would disagree about the same envelope.
    const groceries = body.categories.find(
      (row: { categoryId: string }) => row.categoryId === 'cat-groceries',
    )
    expect(groceries.spentCents).toBe(72_000)
  })

  it('reports no split when nothing is flagged as shared', async () => {
    const body = (await get('/api/budget')).json()
    expect(body.custody).toEqual({ kind: 'unavailable', reason: 'no_shared', paidCents: null })
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

  it('labels each price with its own currency, not with the value currency', async () => {
    // Two amounts in two currencies on one row: the value is converted for us, the
    // quote is not. A client cannot recover the quote currency from anything else in
    // the payload, so it travels with the price.
    const body = (await get('/api/portfolio')).json()
    for (const holding of body.holdings) {
      expect(typeof holding.priceCurrency).toBe('string')
      expect(holding.priceCurrency).toMatch(/^[A-Z]{3}$/)
    }
  })

  it('falls back to the value currency for a row stored before the column existed', async () => {
    // The migration backfills, so a null should not survive — this covers the row
    // that reaches the reader anyway. Answering null would make the client choose
    // between crashing on `Intl` and inventing a currency; the value currency is what
    // those rows were rendered with all along.
    ctx.db.run(sql`UPDATE portfolio_snapshots SET price_currency = NULL`)
    const body = (await get('/api/portfolio')).json()
    expect(body.holdings.length).toBeGreaterThan(0)
    for (const holding of body.holdings) {
      expect(holding.priceCurrency).toBe(holding.currency)
    }
  })

  it('omits money-weighted return rather than reporting it as zero', async () => {
    const body = (await get('/api/portfolio')).json()
    expect(body.mwrBp).toBeUndefined()
  })

  it('publishes the invested and cash halves of the total', async () => {
    const body = (await get('/api/portfolio')).json()

    expect(body.investedValueCents).toBe(382_143)
    // Nothing idle at the broker in this fixture, and zero is the answer — the
    // client draws it, because "no cash sitting there" is worth knowing.
    expect(body.cashValueCents).toBe(0)
  })

  it('answers null for both halves when they do not add up to the total', async () => {
    // A row written before the split existed reads as two zeroes against a real
    // total, and publishing that would tell the reader every euro is invested. The
    // API would rather say it does not know: the total is still trustworthy, and the
    // page has a state for a missing split.
    ctx.db.run(sql`UPDATE portfolio_metrics SET invested_value_cents = NULL, cash_value_cents = NULL`)
    const body = (await get('/api/portfolio')).json()

    expect(body.totalValueCents).toBe(382_143)
    expect(body.investedValueCents).toBeNull()
    expect(body.cashValueCents).toBeNull()
  })
})

describe('the advice on GET /api/portfolio', () => {
  /**
   * The one place in the read API that computes rather than reads, so it gets tested
   * through the route rather than only at `buildAdvice` — the interesting failures are
   * about what the route feeds it, not about the arithmetic (`advice-suggest.test.ts`
   * covers that). The fixture is 100% equities against the `balanced` bands, which is
   * exactly the shape that should produce one sale and one purchase.
   */
  it('measures the stored allocation against the default profile', async () => {
    const body = (await get('/api/portfolio')).json()

    expect(body.advice.profile).toBe('balanced')
    expect(body.advice.isPreset).toBe(true)
    expect(body.advice.drift.investedValueCents).toBe(382_143)
    expect(
      body.advice.drift.lines.map((line: { assetClass: string; state: string }) => [
        line.assetClass,
        line.state,
      ]),
    ).toEqual([
      ['EQUITY', 'above'],
      ['FIXED_INCOME', 'below'],
      ['REAL_ESTATE', 'inside'],
      ['COMMODITY', 'inside'],
    ])
    // Worst first, and the figure the page leads with.
    expect(body.advice.drift.worstOutsideBp).toBe(2_500)
  })

  it('carries the band on every line, so the client needs no second copy of the profile', async () => {
    const body = (await get('/api/portfolio')).json()
    const equity = body.advice.drift.lines[0]

    expect(equity).toMatchObject({ minBp: 5_500, targetBp: 6_500, maxBp: 7_500 })
    expect(equity.shareBp).toBe(10_000)
    expect(equity.outsideBp).toBe(2_500)
  })

  it('attaches the drift line that motivates each suggestion', async () => {
    // The rule #41 exists for: no suggestion without the figure behind it. Asserted as
    // the whole line rather than as "reason is truthy", because a summary of the drift
    // would satisfy the latter while leaving the page unable to show the band.
    const body = (await get('/api/portfolio')).json()

    expect(body.advice.suggestions.length).toBeGreaterThan(0)
    for (const suggestion of body.advice.suggestions) {
      const line = body.advice.drift.lines.find(
        (candidate: { assetClass: string }) => candidate.assetClass === suggestion.assetClass,
      )
      expect(suggestion.reason).toEqual(line)
      expect(suggestion.reason.state).not.toBe('inside')
      expect(suggestion.amountCents).toBeGreaterThan(0)
    }
  })

  it('names the position a sale would come out of, and prices its beurstaks', async () => {
    const body = (await get('/api/portfolio')).json()
    const sell = body.advice.suggestions.find((row: { action: string }) => row.action === 'sell')

    expect(sell.assetClass).toBe('EQUITY')
    // Paired with the purchase on the other side, so the gap is the size of the trade.
    expect(sell.funding).toBe('paired')
    expect(sell.amountCents).toBe(133_750)
    // The largest equity position in the snapshot, by name — a sale of "something" is
    // not something anybody can act on.
    expect(sell.position).toMatchObject({ isin: 'IE00B4L5Y983', name: 'iShares Core MSCI World' })
    expect(sell.unavailable).toBeUndefined()

    // A range rather than a figure, and that is the correct answer here: the beurstaks
    // rate on a fund is 0,12% or 1,32% depending on whether it accumulates and is
    // FSMA-registered, and a snapshot row for a fund nobody put in the universe says
    // neither. So the line names what it does not know and brackets the cost.
    expect(sell.tax.lines[0]).toMatchObject({ rule: 'tob', amount_cents: null })
    expect(sell.tax.complete).toBe(false)
    expect(sell.tax.total_min_cents).toBeGreaterThan(0)
    expect(sell.tax.total_max_cents).toBeGreaterThan(sell.tax.total_min_cents)
    // Said out loud rather than silently left out: the cost base never reaches Balancr.
    expect(sell.taxOmits).toEqual(['capital_gains'])
  })

  it('says why a purchase names no fund instead of inventing one', async () => {
    // No `config/fund-universe.yaml` in a test run, which is the same state as a fresh
    // install. The suggestion still travels — the drift is real — but it carries the
    // reason it cannot name an instrument, and no tax figure for a trade it cannot price.
    const body = (await get('/api/portfolio')).json()
    const buy = body.advice.suggestions.find((row: { action: string }) => row.action === 'buy')

    expect(buy.assetClass).toBe('FIXED_INCOME')
    expect(buy.fund).toBeNull()
    expect(buy.unavailable).toBe('no_fund_in_universe')
    expect(buy.tax).toBeNull()
  })

  it('answers null when there is no invested value to measure against', async () => {
    // Bands are shares of the invested value. Measuring them against the total would put
    // every class below its floor on an instance whose Ghostfolio holds a bank balance,
    // and then confidently suggest four purchases.
    ctx.db.run(sql`UPDATE portfolio_metrics SET invested_value_cents = NULL, cash_value_cents = NULL`)
    const body = (await get('/api/portfolio')).json()

    expect(body.allocation.length).toBeGreaterThan(0)
    expect(body.advice).toBeNull()
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

  it('says whether a model is available, so an empty section can be explained (#165)', async () => {
    // Three of the five sections need a model, and an empty array from a deployment
    // without a key is indistinguishable from "nothing to report". The flag is what
    // lets the page print the difference. The test environment has a key, so `enabled`
    // is the interesting assertion here; the three off codes are covered as a unit.
    const body = (await get('/api/insights')).json()

    expect(body.ai).toEqual({ enabled: true, reason: null })
    // The deterministic half is unaffected by the flag either way.
    expect(body.signals).not.toEqual([])
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

  it('reports every month there is data for, and who is asking', async () => {
    const body = (await get('/api/insights')).json()

    expect(body.months).toEqual([MONTH, PREVIOUS_MONTH])
    expect(body.owner).toBe(true)
  })

  it('says no when the viewer is not the owner', async () => {
    const viewer = ctx.db
      .insert(users)
      .values({ oidcSub: `sub-${crypto.randomUUID()}`, locale: 'en', role: 'viewer' })
      .returning()
      .all()[0]
    if (viewer === undefined) throw new Error('inserting the viewer returned no row')
    const token = createSession(ctx.db, {
      userId: viewer.id,
      method: 'oidc',
      ip: undefined,
      userAgent: undefined,
    }).token

    const body = (await get('/api/insights', token)).json()
    expect(body.owner).toBe(false)
  })

  it('filters signals and the narrative to the month asked for (#158)', async () => {
    // The fixture's signals belong to `MONTH` alone — July has none stored — so
    // asking for July is the one request that proves the filter runs at all.
    const july = (await get(`/api/insights?month=${PREVIOUS_MONTH}`)).json()
    expect(july.month).toBe(PREVIOUS_MONTH)
    expect(july.signals).toEqual([])
    expect(july.narrative).toBeNull()

    const august = (await get(`/api/insights?month=${MONTH}`)).json()
    expect(august.signals[0].code).toBe('above_baseline')
  })

  it('filters the ledger to the month, plus the calls about no month at all (#158)', async () => {
    const augustRun = recordRun(ctx.db, {
      kind: 'findings',
      model: 'gemini-3.7-flash',
      locale: 'en',
      payload: { categories: [] },
      status: 'ok',
      period: MONTH,
    })
    const julyRun = recordRun(ctx.db, {
      kind: 'findings',
      model: 'gemini-3.7-flash',
      locale: 'en',
      payload: { categories: [] },
      status: 'ok',
      period: PREVIOUS_MONTH,
    })
    const chatRun = recordRun(ctx.db, {
      kind: 'clarify',
      model: 'gemini-3.7-flash',
      locale: 'en',
      payload: { categories: [] },
      status: 'ok',
    })

    const august = (await get(`/api/insights?month=${MONTH}`)).json()
    expect(august.runs.map((run: { id: string }) => run.id).sort()).toEqual(
      [augustRun, chatRun].sort(),
    )

    const july = (await get(`/api/insights?month=${PREVIOUS_MONTH}`)).json()
    expect(july.runs.map((run: { id: string }) => run.id).sort()).toEqual(
      [julyRun, chatRun].sort(),
    )
  })

  it('never filters the clarification or proposal queues by month, since neither is about one (#158)', async () => {
    // Both are standing work: a question or a proposed change carries a category,
    // not a month, so switching the month picker must not make either vanish.
    ctx.db
      .insert(clarificationQueue)
      .values({ categoryId: 'cat-groceries', questionCode: 'purpose_unknown', status: 'open' })
      .run()
    ctx.db
      .insert(proposals)
      .values({ type: 'category_meta.set', targetRef: 'cat-groceries', payloadJson: '{}' })
      .run()

    const august = (await get(`/api/insights?month=${MONTH}`)).json()
    const july = (await get(`/api/insights?month=${PREVIOUS_MONTH}`)).json()

    expect(august.questions).toHaveLength(1)
    expect(august.proposals).toHaveLength(1)
    expect(july.questions).toEqual(august.questions)
    expect(july.proposals).toEqual(august.proposals)
  })

  it('renders the narrative, rather than shipping the labels the model wrote', async () => {
    // The bug this pins: `bodyMd` addresses the month as `c1`, `c2`, because that is
    // what the model was given, and only the server can resolve those. Sending it raw
    // produced a paragraph no client could render into anything readable.
    storeNarrative(ctx.db, {
      runId: recordRun(ctx.db, {
        kind: 'narrative',
        model: 'gemini-3.1-pro-preview',
        locale: 'en',
        payload: { categories: [] },
        status: 'ok',
      }),
      period: MONTH,
      locale: 'en',
      bodyMd: '## The month\n\nSpending in c1 rose, and c999 is gone.',
    })

    const body = (await get('/api/insights')).json()

    expect(body.narrative.period).toBe(MONTH)
    // Markdown, through the server's own sanitiser. Every heading level renders as
    // `<h3>`, because the narrative sits under the page's own `<h1>`.
    expect(body.narrative.html).toContain('<h3>The month</h3>')
    // `c1` is one of the fixture's categories — which one depends on how the bundle
    // happened to order them, and that is not what this asserts.
    const names = ['Groceries', 'Energy', 'Salary']
    expect(names.some((name) => (body.narrative.html as string).includes(name))).toBe(true)
    expect(body.narrative.html).not.toMatch(/\bc1\b/)
    // A label with no name left: a category that has since disappeared from the
    // month's facts reads as a phrase, never as an identifier.
    expect(body.narrative.html).toContain('an unnamed category')
    expect(body.narrative.html).not.toMatch(/\bc999\b/)
  })
})

describe('the AI ledger', () => {
  /** One run of each shape worth showing: a call that worked, and one refused. */
  function ledger(): { ok: string; capped: string } {
    const ok = recordRun(ctx.db, {
      kind: 'findings',
      model: 'gemini-3.7-flash',
      locale: 'en',
      payload: { month: MONTH, categories: [{ label: 'c1', spentCents: 72_000 }] },
      status: 'ok',
      usage: { inputTokens: 2_800, outputTokens: 320, cachedTokens: 0 },
      durationMs: 1_400,
    })
    const capped = recordRun(ctx.db, {
      kind: 'narrative',
      model: 'gemini-3.1-pro-preview',
      locale: 'nl',
      payload: { month: MONTH, categories: [] },
      status: 'capped',
      error: 'the month budget is exhausted',
    })
    return { ok, capped }
  }

  it('rides on the insights payload, newest first', async () => {
    const { ok, capped } = ledger()

    const body = (await get('/api/insights')).json()

    expect(body.runs.map((run: { id: string }) => run.id)).toEqual([capped, ok])
    const [refused, succeeded] = body.runs
    expect(succeeded.kind).toBe('findings')
    expect(succeeded.inputTokens).toBe(2_800)
    expect(succeeded.costMicroEur).toBeGreaterThan(0)
    expect(succeeded.durationMs).toBe(1_400)
    // The refusal is the row worth reading: it explains an answer the page does not
    // have, and it cost nothing.
    expect(refused.status).toBe('capped')
    expect(refused.costMicroEur).toBe(0)
    expect(refused.error).toBe('the month budget is exhausted')
  })

  it('never carries a payload inline, whatever the ledger holds', async () => {
    ledger()
    const res = await get('/api/insights')

    for (const run of res.json().runs) {
      expect(run.payload).toBeUndefined()
      expect(run.payloadJson).toBeUndefined()
    }
    // And the bundle's own shape is absent from the whole response, not just from
    // the rows: twenty of these would be most of it, fetched to render a list of
    // dates. `label` is the redacted bundle's word for a category — the signals
    // above carry `categoryId` and a real name, so it appears nowhere else.
    expect(res.body).not.toContain('"label"')
  })

  it('serves one payload verbatim, with the run it belongs to', async () => {
    const { ok } = ledger()

    const res = await get(`/api/insights/runs/${ok}/payload`)

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.payload).toEqual({
      month: MONTH,
      categories: [{ label: 'c1', spentCents: 72_000 }],
    })
    // Alongside the payload rather than left to the client to stitch on: the same
    // bundle sent to Flash and to Pro is two different facts.
    expect(body.id).toBe(ok)
    expect(body.model).toBe('gemini-3.7-flash')
    expect(body.locale).toBe('en')
  })

  it('serves the payload of a call that never went out', async () => {
    // The point of storing one for a refused run: the page can show what it would
    // have sent, so a capped month is inspectable rather than merely empty.
    const { capped } = ledger()

    const body = (await get(`/api/insights/runs/${capped}/payload`)).json()
    expect(body.status).toBe('capped')
    expect(body.payload).toEqual({ month: MONTH, categories: [] })
  })

  it('answers null for a payload that will not parse, rather than failing', async () => {
    // A row whose JSON is broken is itself the finding, and the rest of the row is
    // still readable — so the audit view gets to say so.
    const { ok } = ledger()
    ctx.db.$client.prepare('update ai_runs set payload_json = ? where id = ?').run('{ not json', ok)

    const res = await get(`/api/insights/runs/${ok}/payload`)
    expect(res.statusCode).toBe(200)
    expect(res.json().payload).toBeNull()
  })

  it('404s on a run that is not in the ledger', async () => {
    // Which is what a page holding a list from before a prune will ask for.
    const res = await get('/api/insights/runs/00000000-0000-0000-0000-000000000000/payload')
    expect(res.statusCode).toBe(404)
  })

  it('needs a session, like every other read here', async () => {
    const { ok } = ledger()
    const res = await app.inject({ method: 'GET', url: `/api/insights/runs/${ok}/payload` })
    expect(res.statusCode).toBe(401)
  })

  it('is readable by a viewer, who can already see what it explains', async () => {
    // Gating the audit view harder than the conclusions would mean the person who can
    // read the findings cannot check them. Spending is the owner's alone.
    const { ok } = ledger()
    const viewer = ctx.db
      .insert(users)
      .values({ oidcSub: `sub-${crypto.randomUUID()}`, locale: 'en', role: 'viewer' })
      .returning()
      .all()[0]
    if (viewer === undefined) throw new Error('inserting the viewer returned no row')
    const token = createSession(ctx.db, {
      userId: viewer.id,
      method: 'oidc',
      ip: undefined,
      userAgent: undefined,
    }).token

    const res = await get(`/api/insights/runs/${ok}/payload`, token)
    expect(res.statusCode).toBe(200)
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
    // No allocation is not a portfolio at every floor: it is a portfolio nobody has
    // synced yet, and four suggestions to buy would be the app's first act.
    expect(portfolio.advice).toBeNull()
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
