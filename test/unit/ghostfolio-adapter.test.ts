/**
 * The Ghostfolio adapter's failure behaviour.
 *
 * The happy path will be verified against the real server by `npm run probe`.
 * What cannot be verified there — and what actually matters — is what happens
 * when the server misbehaves: an expired token, an outage, or an upgrade that
 * changes a response. Those three must be told apart, because "retry later" and
 * "stop writing snapshots, the contract changed" are opposite reactions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GhostfolioError,
  fetchPortfolioDetails,
  resetGhostfolioToken,
} from '../../src/adapters/ghostfolio/client.ts'
import { probeGhostfolio } from '../../src/adapters/ghostfolio/probe.ts'

const AUTH = '/api/v1/auth/anonymous'

interface Route {
  status?: number
  body?: unknown
  /** Raw text, for the "answered with HTML" case. */
  text?: string
}

let routes: Record<string, Route | Route[]>
let calls: { path: string; authorization: string | null; body: string | null }[]

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Routes on pathname so query strings (`?range=max`) do not have to be spelled out. */
function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const headers = new Headers(init?.headers)
      calls.push({
        path: url.pathname,
        authorization: headers.get('authorization'),
        body: typeof init?.body === 'string' ? init.body : null,
      })

      const entry = routes[url.pathname]
      if (entry === undefined) return json({ message: 'not stubbed' }, 404)

      // An array lets one path answer differently on successive calls, which is
      // the only way to exercise the re-authentication retry.
      const route = Array.isArray(entry) ? (entry.shift() ?? { status: 500 }) : entry
      if (route.text !== undefined) {
        return new Response(route.text, { status: route.status ?? 200 })
      }
      return json(route.body ?? {}, route.status ?? 200)
    }),
  )
}

const HOLDING = {
  symbol: 'IWDA.AS',
  name: 'iShares Core MSCI World',
  currency: 'EUR',
  quantity: 12,
  marketPrice: 105.4,
  valueInBaseCurrency: 1264.8,
  isin: 'IE00B4L5Y983',
}

function healthyRoutes(): Record<string, Route | Route[]> {
  return {
    '/api/v1/health': { body: { status: 'OK' } },
    [AUTH]: { body: { authToken: 'jwt-1' } },
    '/api/v1/portfolio/details': {
      body: {
        holdings: { 'IWDA.AS': HOLDING },
        summary: { currentValueInBaseCurrency: 1264.8, totalInvestment: 1100 },
      },
    },
    '/api/v1/portfolio/performance': {
      body: {
        chart: [{ date: '2026-08-01', value: 1264.8 }],
        performance: { netPerformancePercentage: 0.15 },
      },
    },
    '/api/v1/account': {
      body: { accounts: [{ id: 'acc1', name: 'Bolero', currency: 'EUR', balance: 42.5 }] },
    },
  }
}

beforeEach(() => {
  routes = healthyRoutes()
  calls = []
  resetGhostfolioToken()
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('authentication', () => {
  it('authenticates once and reuses the JWT', async () => {
    await fetchPortfolioDetails()
    await fetchPortfolioDetails()

    expect(calls.filter((c) => c.path === AUTH)).toHaveLength(1)
    const reads = calls.filter((c) => c.path === '/api/v1/portfolio/details')
    expect(reads).toHaveLength(2)
    expect(reads.every((c) => c.authorization === 'Bearer jwt-1')).toBe(true)
  })

  it('sends the security token only in the auth body, never onward', async () => {
    await fetchPortfolioDetails()

    const auth = calls.find((c) => c.path === AUTH)
    expect(auth?.body).toContain('test-token')
    // A token in a header or query string of a later call would end up in
    // Ghostfolio's access log.
    for (const call of calls.filter((c) => c.path !== AUTH)) {
      expect(call.body).toBeNull()
      expect(call.authorization).not.toContain('test-token')
    }
  })

  it('re-authenticates exactly once on a 401 and retries with the new token', async () => {
    routes[AUTH] = [{ body: { authToken: 'expired' } }, { body: { authToken: 'jwt-2' } }]
    routes['/api/v1/portfolio/details'] = [
      { status: 401, body: { message: 'Unauthorized' } },
      { body: { holdings: {} } },
    ]

    const details = await fetchPortfolioDetails()

    expect(details.holdings).toEqual({})
    expect(calls.filter((c) => c.path === AUTH)).toHaveLength(2)
    expect(
      calls.filter((c) => c.path === '/api/v1/portfolio/details').map((c) => c.authorization),
    ).toEqual(['Bearer expired', 'Bearer jwt-2'])
  })

  it('gives up after a second 401 instead of looping', async () => {
    routes['/api/v1/portfolio/details'] = { status: 401, body: { message: 'nope' } }

    await expect(fetchPortfolioDetails()).rejects.toThrow(GhostfolioError)
    expect(calls.filter((c) => c.path === '/api/v1/portfolio/details')).toHaveLength(2)
  })
})

describe('errors carry the offending path', () => {
  it('reports an HTTP failure with its status', async () => {
    routes['/api/v1/portfolio/details'] = { status: 502, body: {} }

    const error = await fetchPortfolioDetails().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GhostfolioError)
    expect((error as GhostfolioError).path).toBe('/api/v1/portfolio/details')
    expect((error as GhostfolioError).status).toBe(502)
  })

  it('reports a shape change without a status, which is how the probe tells them apart', async () => {
    // Ghostfolio 3.x style: holdings as an array instead of a symbol-keyed map.
    routes['/api/v1/portfolio/details'] = { body: { holdings: [HOLDING] } }

    const error = (await fetchPortfolioDetails().catch((e: unknown) => e)) as GhostfolioError
    expect(error.status).toBeUndefined()
    expect(error.message).toContain('/api/v1/portfolio/details')
    expect(error.message).toContain('unexpected shape')
  })

  it('treats a non-JSON body as a failure of that path', async () => {
    routes['/api/v1/portfolio/details'] = { text: '<html>login</html>' }

    await expect(fetchPortfolioDetails()).rejects.toThrow(/did not return JSON/)
  })
})

describe('probe', () => {
  it('passes against a healthy server and reports shapes, not amounts', async () => {
    const report = await probeGhostfolio()

    expect(report.status).toBe('ok')
    expect(report.warnings).toEqual([])
    expect(report.checks.map((c) => c.path)).toEqual([
      '/api/v1/health',
      '/api/v1/portfolio/details',
      '/api/v1/portfolio/performance',
      '/api/v1/account',
    ])
    // 1264.8 is the holding's value; a probe report must not carry it.
    const serialised = JSON.stringify(report)
    expect(serialised).not.toContain('1264')
    expect(serialised).toContain('1 holdings, 1 valued, 1 with ISIN')
  })

  it('classifies an outage as unreachable, so jobs retry', async () => {
    routes['/api/v1/health'] = { status: 503, body: {} }

    const report = await probeGhostfolio()

    expect(report.status).toBe('unreachable')
    // Nothing past health is probed: everything after it needs the JWT and would
    // fail identically.
    expect(report.checks).toHaveLength(1)
  })

  it('classifies a changed contract as shape-mismatch, so jobs stop writing', async () => {
    routes['/api/v1/account'] = { body: { accounts: [{ id: 'acc1', name: 'Bolero' }] } }

    const report = await probeGhostfolio()

    expect(report.status).toBe('shape-mismatch')
    const failing = report.checks.find((c) => c.status !== 'ok')
    expect(failing?.path).toBe('/api/v1/account')
    expect(failing?.error).toContain('currency')
  })

  it('a shape mismatch outranks an outage in the overall status', async () => {
    routes['/api/v1/portfolio/details'] = { body: { holdings: 'nonsense' } }
    routes['/api/v1/account'] = { status: 500, body: {} }

    // An outage clears itself; a changed contract needs a code change, so it is
    // the one that must be reported.
    expect((await probeGhostfolio()).status).toBe('shape-mismatch')
  })

  it('warns when holdings exist but none can be valued', async () => {
    const { valueInBaseCurrency: _dropped, ...unvalued } = HOLDING
    routes['/api/v1/portfolio/details'] = { body: { holdings: { 'IWDA.AS': unvalued } } }

    const report = await probeGhostfolio()

    // Parses fine, yet net worth would silently be missing the portfolio.
    expect(report.status).toBe('ok')
    expect(report.warnings.join('\n')).toContain('valueInBaseCurrency')
  })

  it('warns on an empty performance chart and empty account list', async () => {
    routes['/api/v1/portfolio/performance'] = { body: { chart: [] } }
    routes['/api/v1/account'] = { body: { accounts: [] } }

    const report = await probeGhostfolio()

    expect(report.status).toBe('ok')
    expect(report.warnings.some((w) => w.includes('empty chart'))).toBe(true)
    expect(report.warnings.some((w) => w.includes('no accounts'))).toBe(true)
  })

  it('starts from a fresh token so a stale JWT is diagnosed here', async () => {
    await fetchPortfolioDetails()
    calls = []

    await probeGhostfolio()

    expect(calls.filter((c) => c.path === AUTH)).toHaveLength(1)
  })
})

describe('every request is time-bounded', () => {
  it('passes an abort signal, so a hung upstream cannot hang the nightly job', async () => {
    await fetchPortfolioDetails()

    const mock = fetch as unknown as { mock: { calls: [string, RequestInit][] } }
    for (const [, init] of mock.mock.calls) {
      expect(init.signal).toBeInstanceOf(AbortSignal)
    }
  })
})
