/**
 * Balancr never writes to Ghostfolio, and this is what keeps that true.
 *
 * The promise is the same one `test/unit/actual-adapter.test.ts` makes about Actual, and
 * it needs the same two halves for the same reason. **The type guard protects the
 * adapter's own callers**: `request` accepts a `ReadOptions`, which cannot express a
 * method or a body, so `request('/api/v1/order', { method: 'POST', body })` does not
 * compile. **The source scan catches the file that goes around it** — a future module
 * that calls `fetch` itself, or a new helper here that takes a path and a method. A
 * type-only guard would leave that second hole open, which is why Actual has both.
 *
 * Ghostfolio deserves this more than the endpoint count suggests. `POST /api/v1/order`
 * and `POST /api/v1/import` are real, documented endpoints on the instance this adapter
 * authenticates against, holding somebody's actual accounts — and this is the file
 * anyone thinking "while I'm in here, let me just record that transaction" would open.
 *
 * The one exception is authentication, which exchanges the security token for a JWT and
 * changes nothing on the instance. It stays an exception rather than becoming a
 * parameter: `token()` takes no arguments and hardcodes both its method and its path,
 * so it is not the old permissive `request()` under a new name. The last test here is
 * what says so.
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchAccounts,
  fetchHealth,
  fetchPortfolioDetails,
  fetchPortfolioPerformance,
  resetGhostfolioToken,
} from '../../src/adapters/ghostfolio/client.ts'

const AUTH = '/api/v1/auth/anonymous'

/** Every file that may talk to Ghostfolio. A fourth one appearing is the risk. */
const SOURCES = [
  'src/adapters/ghostfolio/client.ts',
  'src/adapters/ghostfolio/probe.ts',
  'src/adapters/ghostfolio/types.ts',
] as const

/**
 * Source with comments removed.
 *
 * The guarantee is about code. These files legitimately *name* the write endpoints while
 * explaining why they are not called, and a scan that read the prose would fail on the
 * documentation of its own rule.
 */
const stripComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const sources = (): string =>
  SOURCES.map((file) => stripComments(readFileSync(file, 'utf8'))).join('\n')

const client = (): string => stripComments(readFileSync(SOURCES[0], 'utf8'))

interface Call {
  path: string
  /** Absent means `fetch`'s default, which is GET. That is the expected reading. */
  method: string | undefined
}

let calls: Call[]

/** Answers every read with a shape its schema accepts, and records the method. */
function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      calls.push({ path, method: init?.method })

      const body =
        path === AUTH
          ? { authToken: 'jwt' }
          : path === '/api/v1/health'
            ? {}
            : path === '/api/v1/account'
              ? { accounts: [] }
              : path.endsWith('/portfolio/performance')
                ? { chart: [], performance: {} }
                : { holdings: [], summary: {} }

      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }),
  )
}

beforeEach(() => {
  calls = []
  resetGhostfolioToken()
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetGhostfolioToken()
})

describe('what the adapter actually sends', () => {
  it('issues nothing but GET, apart from the one call that authenticates', async () => {
    // All four reads in one test on purpose: the assertion is about the set of requests
    // this adapter is capable of making, and a per-endpoint test would pass while a
    // fifth endpoint added tomorrow went unchecked.
    await fetchHealth()
    await fetchPortfolioDetails()
    await fetchPortfolioPerformance()
    await fetchAccounts()

    const writes = calls.filter(
      (call) => call.method !== undefined && call.method.toUpperCase() !== 'GET',
    )
    expect(writes).toEqual([{ path: AUTH, method: 'POST' }])
  })

  it('sends the token call once and then reads on the cached JWT', async () => {
    await fetchPortfolioDetails()
    await fetchAccounts()

    // Not a performance assertion. A token call per read would mean the POST is on the
    // ordinary request path rather than behind the cache, which is the shape this file
    // exists to prevent.
    expect(calls.filter((call) => call.path === AUTH)).toHaveLength(1)
  })

  it('asks for the liveness check without a token at all', async () => {
    await fetchHealth()
    // The one read that must work before authentication, and therefore the one read
    // whose `authenticated: false` is load-bearing rather than incidental.
    expect(calls).toEqual([{ path: '/api/v1/health', method: undefined }])
  })
})

describe('the read-only boundary', () => {
  it('names no Ghostfolio endpoint that changes anything', () => {
    // Ghostfolio's own documented write surface, plus the exports that would leak the
    // whole portfolio to disk. Paths rather than method names, because unlike Actual
    // there is no SDK here to name — the URL *is* the capability.
    const writePaths = [
      '/api/v1/order',
      '/api/v1/import',
      '/api/v1/export',
      '/api/v1/account/',
      '/api/v1/admin',
      '/api/v1/user',
      '/api/v1/subscription',
      '/api/v2/order',
      '/api/v2/import',
    ]

    const found = writePaths.filter((path) => sources().includes(path))
    expect(found).toEqual([])
  })

  it('names no HTTP method outside the token call', () => {
    const code = client()

    // Exactly one `method:` in the file, and it is the POST that authenticates.
    const methods = code.match(/method:\s*'[A-Z]+'/g) ?? []
    expect(methods).toEqual(["method: 'POST'"])

    // And it sits inside `token()` rather than in some newer helper that happens to
    // spell POST the same way. Bracketed by the function above it and the export below,
    // so the check survives the body being edited.
    const opens = code.indexOf('async function token(')
    const post = code.indexOf("method: 'POST'")
    const closes = code.indexOf('export function resetGhostfolioToken')
    expect(opens).toBeGreaterThan(-1)
    expect(post).toBeGreaterThan(opens)
    expect(post).toBeLessThan(closes)
  })

  it('gives the read path no way to carry a method or a body', () => {
    // `RequestInit` is the type that used to be accepted here, and accepting it again
    // is how the door reopens: it carries `method`, `body` and arbitrary headers, so a
    // caller holding one can place an order whatever the read functions above do. The
    // absence of the name is the assertion — `ReadOptions` offers `authenticated` and
    // nothing else.
    expect(client()).not.toContain('RequestInit')
    expect(client()).toContain('interface ReadOptions')
  })

  it('keeps the token call unparameterised, so it cannot become a general POST', () => {
    const code = client()
    // `token()` — no arguments. A `token(path: string)` would be the old permissive
    // `request()` wearing a different name, and every guarantee above would still pass.
    expect(code).toContain('async function token(): Promise<string>')
    expect(code).toContain("const path = '/api/v1/auth/anonymous'")
  })
})
