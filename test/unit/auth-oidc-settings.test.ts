/**
 * The one value in the OIDC flow that is derived rather than configured.
 *
 * A provider compares `redirect_uri` byte for byte and refuses the authorization
 * request when it differs by a character. That refusal happens *at the provider*,
 * before the browser returns, so Balancr never sees the failed login and cannot
 * improve the message the operator reads. Which makes the derivation itself the
 * thing to pin: it is not observable from either side once it is wrong (#110).
 *
 * `config.ts` validates at import, so each case rebuilds the module graph with a
 * different environment, the same way `config-guards.test.ts` does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OidcSettings } from '../../src/server/auth/oidc.ts'

/** Enough of a real deployment for the cross-field guards to accept it. */
const deployment: Record<string, string> = {
  NODE_ENV: 'production',
  PUBLIC_BASE_URL: 'https://balancr.example.com',
  TRUSTED_PROXY_CIDRS: '172.16.0.0/12',
  AUTH_OIDC_ISSUER: 'https://authentik.example.com/application/o/balancr/',
  AUTH_OIDC_CLIENT_ID: 'balancr',
  AUTH_OIDC_CLIENT_SECRET: 'a-client-secret',
}

async function settingsWith(overrides: Record<string, string>): Promise<OidcSettings | null> {
  vi.resetModules()
  for (const [key, value] of Object.entries({ ...deployment, ...overrides })) {
    vi.stubEnv(key, value)
  }
  const { oidcSettings } = await import('../../src/server/auth/oidc.ts')
  return oidcSettings()
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('the derived redirect URI (#110)', () => {
  it('is the public base URL plus /auth/callback', async () => {
    const settings = await settingsWith({})
    expect(settings?.redirectUri).toBe('https://balancr.example.com/auth/callback')
  })

  it('does not double the slash when the base URL ends in one', async () => {
    // The likeliest way to end up with a value that differs from the registered
    // one by a single character, and the operator would be looking at two strings
    // that read identically in a browser's address bar.
    const settings = await settingsWith({ PUBLIC_BASE_URL: 'https://balancr.example.com/' })
    expect(settings?.redirectUri).toBe('https://balancr.example.com/auth/callback')
  })

  it('keeps a non-default port, which the provider also compares', async () => {
    const settings = await settingsWith({
      NODE_ENV: 'development',
      PUBLIC_BASE_URL: 'http://localhost:3000',
    })
    expect(settings?.redirectUri).toBe('http://localhost:3000/auth/callback')
  })

  it('discards a sub-path in the base URL, because Balancr is served at the root', async () => {
    // Pinned rather than fixed: the SPA and every route are rooted, so a sub-path
    // deployment does not work regardless of what this returns. Pinning it makes
    // the symptom legible — someone hosting under a prefix gets a redirect URI
    // without the prefix, and this test is where that is written down.
    const settings = await settingsWith({ PUBLIC_BASE_URL: 'https://example.com/balancr/' })
    expect(settings?.redirectUri).toBe('https://example.com/auth/callback')
  })

  it('is null when OIDC is off, rather than a URI for a provider that is not there', async () => {
    vi.resetModules()
    for (const [key, value] of Object.entries(deployment)) vi.stubEnv(key, value)
    // Undefined, not empty: `config.ts` treats an empty string as a filled-in
    // value and rejects it, which is the right call — a blank client id is a
    // misconfiguration, not a decision to run without OIDC.
    for (const key of ['AUTH_OIDC_ISSUER', 'AUTH_OIDC_CLIENT_ID', 'AUTH_OIDC_CLIENT_SECRET']) {
      vi.stubEnv(key, undefined)
    }
    vi.stubEnv('AUTH_LOCAL_ENABLED', 'true')
    const { oidcSettings } = await import('../../src/server/auth/oidc.ts')
    expect(oidcSettings()).toBeNull()
  })
})
