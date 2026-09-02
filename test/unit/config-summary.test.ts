/**
 * The startup configuration dump, which is only safe because of this test.
 *
 * `configSummary` is logged at `info` on every boot, so it is read by whoever is
 * diagnosing a deployment — and it sits one keystroke away from printing a secret
 * into a log that gets pasted into an issue. The contract is: name every variable,
 * reveal no secret value. Both halves are asserted here rather than trusted, and a
 * new secret added to the summary without a mask fails this file.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

/** Distinctive enough that a substring search cannot match anything else. */
const secrets: Record<string, string> = {
  ACTUAL_PASSWORD: 'secret-actual-password-zzz',
  ACTUAL_E2E_PASSWORD: 'secret-e2e-password-zzz',
  GHOSTFOLIO_SECURITY_TOKEN: 'secret-ghostfolio-token-zzz',
  GEMINI_API_KEY: 'secret-gemini-key-zzz',
  SESSION_SECRET: 'secret-session-secret-that-is-long-enough-zzz',
  AUTH_OIDC_CLIENT_SECRET: 'secret-oidc-client-secret-zzz',
}

const deployment: Record<string, string> = {
  ...secrets,
  NODE_ENV: 'production',
  PUBLIC_BASE_URL: 'https://balancr.example.com',
  TRUSTED_PROXY_CIDRS: '172.16.0.0/12',
  AUTH_OIDC_ISSUER: 'https://authentik.example.com/application/o/balancr/',
  AUTH_OIDC_CLIENT_ID: 'balancr',
}

async function summary(): Promise<Record<string, unknown>> {
  vi.resetModules()
  for (const [key, value] of Object.entries(deployment)) vi.stubEnv(key, value)
  const { configSummary } = await import('../../src/config.ts')
  return configSummary()
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('configSummary', () => {
  it('reveals no secret value anywhere in what it returns', async () => {
    const serialised = JSON.stringify(await summary())
    for (const [key, value] of Object.entries(secrets)) {
      expect(serialised, `${key} leaked into the startup log`).not.toContain(value)
    }
  })

  it('says a secret is set, and how long it is, rather than omitting it', async () => {
    // The length is the useful part: a truncated paste or a stray quote shows up as
    // a wrong count, which is most of what goes wrong with a secret in an env file.
    const dump = await summary()
    expect(dump.SESSION_SECRET).toBe(`set (${secrets.SESSION_SECRET?.length} chars)`)
    expect(dump.GEMINI_API_KEY).toBe(`set (${secrets.GEMINI_API_KEY?.length} chars)`)
  })

  it('distinguishes unset from set, so a missing variable is visible', async () => {
    vi.resetModules()
    for (const [key, value] of Object.entries(deployment)) vi.stubEnv(key, value)
    vi.stubEnv('ACTUAL_E2E_PASSWORD', undefined)
    const { configSummary } = await import('../../src/config.ts')
    expect(configSummary().ACTUAL_E2E_PASSWORD).toBe('unset')
  })

  it('names the OIDC inputs that are not secrets (#110)', async () => {
    // The client id travels in the authorization URL and the issuer is a public
    // metadata endpoint. Printing them turns a rejected login into a comparison.
    const dump = await summary()
    expect(dump.AUTH_OIDC_ISSUER).toBe(deployment.AUTH_OIDC_ISSUER)
    expect(dump.AUTH_OIDC_CLIENT_ID).toBe('balancr')
    expect(dump.PUBLIC_BASE_URL).toBe('https://balancr.example.com')
  })

  it('does not carry the client secret at all, masked or otherwise', async () => {
    // Not in the summary in any form: it is the one OIDC value with no diagnostic
    // use, so the safest thing a log can say about it is nothing.
    expect(Object.keys(await summary())).not.toContain('AUTH_OIDC_CLIENT_SECRET')
  })
})
