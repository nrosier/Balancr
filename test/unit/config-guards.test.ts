/**
 * What the configuration accepts, and what it refuses.
 *
 * Two kinds of case live here. The cross-field rules refuse a configuration that
 * would boot happily and then be quietly insecure, which is why they are errors
 * rather than warnings — and why they are tested: a guard that silently stops
 * firing is worse than no guard, because the message in `.env.example` still
 * promises it. The blank-value cases are the other direction: they assert that a
 * correct, deliberately incomplete configuration boots, because refusing one sends
 * people looking for a placeholder to type into a secret (#118).
 *
 * `config.ts` validates at import, so each case rebuilds the module graph with a
 * different environment. That is the same approach `gemini-client.test.ts` takes
 * for the provider switch.
 */
import { readFileSync } from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Config } from '../../src/config.ts'

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

/**
 * As `loadWith`, but for the accepted cases, where the question is what a variable
 * ended up holding rather than whether the load threw. `undefined` unsets a variable
 * that `test/setup.ts` filled in; the empty string is the case under test and is a
 * different thing entirely.
 */
async function configWith(
  overrides: Record<string, string | undefined>,
): Promise<Config> {
  vi.resetModules()
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value)
  return (await import('../../src/config.ts')).config
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

describe('a deployment with no Gemini credential (#165)', () => {
  /**
   * The whole point of the change: this used to be a refusal to boot.
   *
   * `vertex` is the default provider and needs `GOOGLE_CLOUD_PROJECT`, so a copied
   * `.env.example` with the AI block untouched could not start — and the half of
   * Balancr that can be trusted with a number is the half that never calls a model.
   * Someone who has not bought a key is entitled to the aggregation, the four
   * overspend signals, the burn rate and the net worth.
   */
  for (const provider of ['aistudio', 'vertex'] as const) {
    it(`boots on ${provider} with nothing configured for it`, async () => {
      expect(
        await loadWith({ GEMINI_PROVIDER: provider, GEMINI_API_KEY: '' }),
      ).toBeNull()
    })
  }

  it('reports itself as neither credentialed nor configured', async () => {
    const config = await configWith({ GEMINI_PROVIDER: 'aistudio', GEMINI_API_KEY: '' })

    expect(config.aiCredentialed).toBe(false)
    expect(config.aiConfigured).toBe(false)
  })

  it('reads a key on the switched-off deployment as credentialed but not configured', async () => {
    // The two flags exist separately for exactly this case. One flag would report
    // `switchedOff` for a missing key as well, sending its owner to flip a variable
    // that changes nothing.
    const config = await configWith({ AI_ENABLED: 'false' })

    expect(config.aiCredentialed).toBe(true)
    expect(config.aiConfigured).toBe(false)
  })

  it('is configured when the credential and the switch agree', async () => {
    const config = await configWith({ AI_ENABLED: 'true' })

    expect(config.aiConfigured).toBe(true)
  })

  /**
   * Missing is fine; contradictory is not.
   *
   * A key set for the other provider is not an instance that skipped the AI block —
   * it is one that filled it in and picked the wrong `GEMINI_PROVIDER`, and starting
   * quietly with the model off would hide a typo behind a supported configuration.
   */
  const contradictions = [
    {
      provider: 'vertex',
      env: { GEMINI_PROVIDER: 'vertex' },
      names: ['GOOGLE_CLOUD_PROJECT', 'GEMINI_API_KEY'],
    },
    {
      provider: 'aistudio',
      env: { GEMINI_PROVIDER: 'aistudio', GEMINI_API_KEY: '', GOOGLE_CLOUD_PROJECT: 'balancr' },
      names: ['GEMINI_API_KEY', 'GOOGLE_CLOUD_PROJECT'],
    },
  ] as const

  for (const { provider, env, names } of contradictions) {
    it(`refuses ${provider} configured with the other provider's credential`, async () => {
      const error = await loadWith(env)

      // Both names, because the fix is either one: set this, or switch to that.
      for (const name of names) expect(error?.message).toContain(name)
    })
  }
})

describe('a variable left blank in a copied .env.example (#118)', () => {
  // The six optional variables, and what each has to survive being blank. Table
  // rather than one test apiece because the interesting part is that the list is
  // complete: a seventh optional variable added with a bare `.min(1)` is exactly
  // the regression this guards, and adding its row here is the reminder.
  const optional = [
    'ACTUAL_E2E_PASSWORD',
    'GEMINI_API_KEY',
    'GOOGLE_CLOUD_PROJECT',
    'AUTH_OIDC_ISSUER',
    'AUTH_OIDC_CLIENT_ID',
    'AUTH_OIDC_CLIENT_SECRET',
  ] as const

  for (const key of optional) {
    it(`reads a blank ${key} as unset`, async () => {
      // `aistudio` needs GEMINI_API_KEY and `vertex` needs GOOGLE_CLOUD_PROJECT, so
      // blanking either one on its own trips the other provider's rule. Switching
      // provider per case keeps this about the blank value and not about Gemini.
      const provider = key === 'GEMINI_API_KEY' ? 'vertex' : 'aistudio'
      const config = await configWith({
        [key]: '',
        GEMINI_PROVIDER: provider,
        ...(provider === 'vertex' ? { GOOGLE_CLOUD_PROJECT: 'balancr' } : {}),
        ...(key === 'GOOGLE_CLOUD_PROJECT' ? { GEMINI_PROVIDER: 'aistudio' } : {}),
      })
      expect(config[key]).toBeUndefined()
    })
  }

  it('treats whitespace as blank, since a tab is not a client id', async () => {
    expect((await configWith({ AUTH_OIDC_CLIENT_ID: '  \t ' })).AUTH_OIDC_CLIENT_ID)
      .toBeUndefined()
  })

  it('leaves the spaces inside a value that has content', async () => {
    // Trimming would be a quiet edit to a secret. A password is entitled to end in
    // a space if whoever set it says so.
    const config = await configWith({ ACTUAL_E2E_PASSWORD: ' pass phrase ' })
    expect(config.ACTUAL_E2E_PASSWORD).toBe(' pass phrase ')
  })

  it('still refuses a blank required variable', async () => {
    // The distinction is optional versus required, not empty versus absent. A blank
    // ACTUAL_PASSWORD is a misconfiguration and not booting is the correct answer.
    const error = await loadWith({ ACTUAL_PASSWORD: '' })
    expect(error?.message).toContain('ACTUAL_PASSWORD')
  })

  it('reads an all-blank OIDC block as no OIDC at all, not as half-configured', async () => {
    const config = await configWith({
      AUTH_OIDC_ISSUER: '',
      AUTH_OIDC_CLIENT_ID: '',
      AUTH_OIDC_CLIENT_SECRET: '',
      AUTH_LOCAL_ENABLED: 'true',
    })
    expect(config.oidcEnabled).toBe(false)
  })

  it('still catches an OIDC block where one field is blank rather than absent', async () => {
    // Before #118 this case could not arise: the schema rejected the blank first, so
    // the cross-field rule never saw it. Now it does, and it has to say the same
    // thing it says for a missing line.
    const error = await loadWith({
      AUTH_OIDC_ISSUER: 'https://authentik.example.com/application/o/balancr/',
      AUTH_OIDC_CLIENT_ID: 'balancr',
      AUTH_OIDC_CLIENT_SECRET: '',
    })
    expect(error?.message).toContain('partially configured')
    expect(error?.message).toContain('AUTH_OIDC_CLIENT_SECRET')
  })

  it('rejects a filled-in AUTH_OIDC_ISSUER that is not a URL', async () => {
    // Blank means unset; wrong still means wrong.
    const error = await loadWith({
      AUTH_OIDC_ISSUER: 'authentik.example.com',
      AUTH_OIDC_CLIENT_ID: 'balancr',
      AUTH_OIDC_CLIENT_SECRET: 'secret',
    })
    expect(error?.message).toContain('AUTH_OIDC_ISSUER')
  })
})

describe('.env.example as shipped (#118)', () => {
  /**
   * `.env.example` exactly as a new deployment would inherit it — every line,
   * including the empty ones, because the empty ones are the case under test.
   *
   * Reading the real file rather than restating it is the point: a variable added
   * there with a `.min(1)` schema and no default breaks the copy-and-fill-in flow,
   * and this is what notices.
   */
  function shipped(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const line of readFileSync('.env.example', 'utf8').split('\n')) {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
      if (match?.[1] !== undefined) env[match[1]] = match[2] ?? ''
    }
    return env
  }

  /** The variables the file itself asks you to fill in. Nothing more. */
  const filledIn = {
    ACTUAL_PASSWORD: 'actual-password',
    ACTUAL_SYNC_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    GHOSTFOLIO_SECURITY_TOKEN: 'ghostfolio-token',
    SESSION_SECRET: 'x'.repeat(48),
    GOOGLE_CLOUD_PROJECT: 'balancr-prod',
    AUTH_OIDC_CLIENT_ID: 'balancr',
    AUTH_OIDC_CLIENT_SECRET: 'oidc-secret',
  }

  it('names every variable the schema knows about', () => {
    // A drifted example file is its own defect: someone following the README would
    // never learn the variable exists. Cheap to check while the file is already open.
    const declared = readFileSync('src/config.ts', 'utf8')
    for (const key of Object.keys(shipped())) {
      expect(declared, key).toContain(`  ${key}:`)
    }
  })

  it('boots once the variables it asks for are filled in', async () => {
    // The regression that matters, because this is the file the README tells you to
    // copy. Before #118 it failed on the optional variables it ships empty.
    expect(await loadWith({ ...shipped(), ...filledIn })).toBeNull()
  })

  it('boots with the whole Gemini block left as shipped (#165)', async () => {
    // `vertex` is the default provider and this file ships its credential empty, so
    // before #165 the copy-and-fill-in flow could not start without a Google Cloud
    // project — a paid dependency demanded of someone who wanted the budget figures.
    // Everything that computes a number is unaffected by not having it.
    const error = await loadWith({ ...shipped(), ...filledIn, GOOGLE_CLOUD_PROJECT: '' })

    expect(error).toBeNull()
  })

  it('boots with the OIDC block left empty and local login turned on', async () => {
    // The other honest starting point: no Authentik yet, break-glass login over LAN.
    // Three blank OIDC variables have to read as "no OIDC", not as "half-configured".
    const error = await loadWith({
      ...shipped(),
      ...filledIn,
      AUTH_OIDC_ISSUER: '',
      AUTH_OIDC_CLIENT_ID: '',
      AUTH_OIDC_CLIENT_SECRET: '',
      AUTH_LOCAL_ENABLED: 'true',
    })
    expect(error).toBeNull()
  })

  it('still refuses the file with nothing filled in at all', async () => {
    // Not booting is correct here — the required secrets really are missing — and it
    // has to complain about those, not about the optional variables left blank.
    const error = await loadWith(shipped())
    expect(error?.message).toContain('ACTUAL_PASSWORD')
    expect(error?.message).not.toContain('ACTUAL_E2E_PASSWORD')
  })
})
