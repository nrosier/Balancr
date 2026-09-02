/**
 * The cross-field rules that only apply to a real deployment.
 *
 * Each of these refuses a configuration that would boot happily and then be
 * quietly insecure, which is why they are errors rather than warnings — and why
 * they are tested: a guard that silently stops firing is worse than no guard,
 * because the message in `.env.example` still promises it.
 *
 * `config.ts` validates at import, so each case rebuilds the module graph with a
 * different environment. That is the same approach `gemini-client.test.ts` takes
 * for the provider switch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

/** A deployment that should be accepted, so one field at a time can be broken. */
const productionEnv: Record<string, string> = {
  NODE_ENV: 'production',
  PUBLIC_BASE_URL: 'https://balancr.example.com',
  TRUSTED_PROXY_CIDRS: '172.16.0.0/12',
}

async function loadWith(overrides: Record<string, string>): Promise<Error | null> {
  vi.resetModules()
  for (const [key, value] of Object.entries({ ...productionEnv, ...overrides })) {
    vi.stubEnv(key, value)
  }
  try {
    await import('../../src/config.ts')
    return null
  } catch (error) {
    return error as Error
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('a production deployment', () => {
  it('is accepted when the public URL, the proxy range and the issuer are right', async () => {
    expect(
      await loadWith({
        AUTH_OIDC_ISSUER: 'https://authentik.example.com/application/o/balancr/',
        AUTH_OIDC_CLIENT_ID: 'balancr',
        AUTH_OIDC_CLIENT_SECRET: 'secret',
      }),
    ).toBeNull()
  })

  it('refuses a plain-http public URL, because the cookies are Secure', async () => {
    const error = await loadWith({ PUBLIC_BASE_URL: 'http://balancr.example.com' })
    expect(error?.message).toContain('PUBLIC_BASE_URL')
  })

  it('refuses a plain-http OIDC issuer', async () => {
    // The ID token's signature is not checked — OIDC Core 3.1.3.7 condition 6 lets
    // a client rely on TLS to the token endpoint instead, and `openid-client` does.
    // Over http:// on the container network, anything that can answer the token
    // request can name itself as any user.
    const error = await loadWith({
      AUTH_OIDC_ISSUER: 'http://authentik/application/o/balancr/',
      AUTH_OIDC_CLIENT_ID: 'balancr',
      AUTH_OIDC_CLIENT_SECRET: 'secret',
    })
    expect(error?.message).toContain('AUTH_OIDC_ISSUER')
    expect(error?.message).toContain('https://')
  })

  it('refuses a loopback-only trusted-proxy range', async () => {
    // Every request would read as coming from Traefik's own address, which breaks
    // rate limiting and the CIDR gate on local login at the same time.
    const error = await loadWith({ TRUSTED_PROXY_CIDRS: '127.0.0.1/32' })
    expect(error?.message).toContain('TRUSTED_PROXY_CIDRS')
  })

  it('refuses a deployment with no way to log in', async () => {
    const error = await loadWith({ AUTH_LOCAL_ENABLED: 'false' })
    expect(error?.message).toContain('No usable login method')
  })

  it('refuses OIDC settings that are only half filled in', async () => {
    // The failure this avoids is a deployment that boots, offers a login button and
    // fails on the redirect.
    const error = await loadWith({ AUTH_OIDC_ISSUER: 'https://authentik.example.com/o/balancr/' })
    expect(error?.message).toContain('partially configured')
  })
})

describe('a development deployment', () => {
  it('allows plain http, because localhost has no certificate', async () => {
    expect(
      await loadWith({
        NODE_ENV: 'development',
        PUBLIC_BASE_URL: 'http://localhost:3000',
        TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
        AUTH_OIDC_ISSUER: 'http://localhost:9000/application/o/balancr/',
        AUTH_OIDC_CLIENT_ID: 'balancr',
        AUTH_OIDC_CLIENT_SECRET: 'secret',
      }),
    ).toBeNull()
  })
})
