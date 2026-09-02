/**
 * A fake Authentik, complete enough that `openid-client` cannot tell.
 *
 * Mocking `openid-client` instead would leave the interesting part untested.
 * Whether the PKCE verifier this application stored actually reaches the token
 * endpoint, whether the `state` and `nonce` compared are really the ones from the
 * flow row, and whether an ID token signed by an unknown key is refused, are all
 * questions about the wiring between Balancr and the library. A stub answers them
 * by construction, which is to say it does not answer them.
 *
 * So this is a provider: a discovery document, a JWKS, a token endpoint that
 * checks the client secret and re-derives the code challenge, and RS256-signed ID
 * tokens. It is reached through `openid-client`'s `customFetch` seam, so no port
 * is opened and no packet leaves the process.
 */
import { createHash } from 'node:crypto'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import type { CryptoKey, JWK } from 'jose'
import type { CustomFetch } from 'openid-client'
import type { OidcSettings } from '../../src/server/auth/oidc.ts'

export const ISSUER = 'https://authentik.test/application/o/balancr/'
export const CLIENT_ID = 'balancr-test-client'
export const CLIENT_SECRET = 'balancr-test-secret'
const KEY_ID = 'test-key-1'

const challengeFor = (verifier: string): string =>
  createHash('sha256').update(verifier, 'ascii').digest('base64url')

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** One authorization request the provider has issued a code for. */
interface PendingCode {
  codeChallenge: string
  nonce: string | undefined
  redirectUri: string
  audience: string
}

export interface AuthorizeOptions {
  /** Hand back a different `state` than the one asked for. */
  state?: string
  /** Put a different `nonce` in the ID token than the one requested. */
  nonce?: string
  /** Mint the ID token for another client of the same provider. */
  audience?: string
}

export interface FakeIssuer {
  /** Ready to pass to `createOidcClient`; the `fetch` seam is already set. */
  settings: OidcSettings
  /** The identity the next login establishes. Mutable, so a test can change it. */
  identity: { sub: string; email: string | undefined; name: string | undefined }
  /** How often metadata has been fetched — the discovery cache is asserted on. */
  discoveryCount: number
  /** Make discovery fail, for "a failed discovery is retried, not remembered". */
  discoveryFails: boolean
  /** Sign the next ID token with a key that is not in the JWKS. */
  signWithUnknownKey: boolean
  /**
   * What the provider would redirect the browser back with.
   *
   * The challenge and nonce are read out of the real authorization URL, so a
   * verifier that never arrives, or arrives wrong, fails at the token endpoint
   * rather than being waved through by the double.
   */
  authorize(url: URL, options?: AuthorizeOptions): { code: string; state: string }
  /** The same thing as a callback path and query, ready for `app.inject`. */
  callbackUrl(url: URL, options?: AuthorizeOptions): string
}

export async function createFakeIssuer(redirectUri: string): Promise<FakeIssuer> {
  const good = await generateKeyPair('RS256', { extractable: true })
  const unknown = await generateKeyPair('RS256', { extractable: true })
  const jwk: JWK = { ...(await exportJWK(good.publicKey)), kid: KEY_ID, alg: 'RS256', use: 'sig' }

  const codes = new Map<string, PendingCode>()
  let counter = 0

  const tokenEndpoint = new URL('token/', ISSUER).toString()
  const jwksUri = new URL('jwks/', ISSUER).toString()

  const fake: FakeIssuer = {
    settings: { issuer: ISSUER, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri },
    identity: { sub: 'ak-subject-1', email: 'nick@example.test', name: 'Nick' },
    discoveryCount: 0,
    discoveryFails: false,
    signWithUnknownKey: false,

    authorize(url, options) {
      const requested = url.searchParams.get('state')
      if (requested === null) throw new Error('authorization URL carried no state')
      const codeChallenge = url.searchParams.get('code_challenge')
      if (codeChallenge === null) throw new Error('authorization URL carried no code_challenge')

      counter += 1
      const code = `code-${String(counter)}`
      codes.set(code, {
        codeChallenge,
        nonce: options?.nonce ?? url.searchParams.get('nonce') ?? undefined,
        redirectUri: url.searchParams.get('redirect_uri') ?? '',
        audience: options?.audience ?? CLIENT_ID,
      })
      return { code, state: options?.state ?? requested }
    },

    callbackUrl(url, options) {
      const { code, state } = fake.authorize(url, options)
      return `/auth/callback?${new URLSearchParams({ code, state, iss: ISSUER }).toString()}`
    },
  }

  const idToken = async (pending: PendingCode): Promise<string> => {
    const now = Math.floor(Date.now() / 1000)
    const claims: Record<string, string> = {}
    if (pending.nonce !== undefined) claims.nonce = pending.nonce
    if (fake.identity.email !== undefined) claims.email = fake.identity.email
    if (fake.identity.name !== undefined) claims.name = fake.identity.name

    const key: CryptoKey = fake.signWithUnknownKey ? unknown.privateKey : good.privateKey
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
      .setIssuer(ISSUER)
      .setSubject(fake.identity.sub)
      .setAudience(pending.audience)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(key)
  }

  const token = async (body: string): Promise<Response> => {
    const params = new URLSearchParams(body)

    if (params.get('client_id') !== CLIENT_ID || params.get('client_secret') !== CLIENT_SECRET) {
      return json({ error: 'invalid_client' }, 401)
    }
    if (params.get('grant_type') !== 'authorization_code') {
      return json({ error: 'unsupported_grant_type' }, 400)
    }

    const code = params.get('code') ?? ''
    const pending = codes.get(code)
    // Single use here too, so a replayed code is refused by the provider as well
    // as by the flow table — the two defences are tested separately.
    codes.delete(code)
    if (pending === undefined) return json({ error: 'invalid_grant' }, 400)

    const verifier = params.get('code_verifier')
    if (verifier === null || challengeFor(verifier) !== pending.codeChallenge) {
      return json({ error: 'invalid_grant', error_description: 'PKCE mismatch' }, 400)
    }
    if (params.get('redirect_uri') !== pending.redirectUri) {
      return json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400)
    }

    return json({
      access_token: 'access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'openid profile email',
      id_token: await idToken(pending),
    })
  }

  const fetchImpl: CustomFetch = async (url, options) => {
    if (url.includes('.well-known/openid-configuration')) {
      fake.discoveryCount += 1
      if (fake.discoveryFails) return json({ error: 'server_error' }, 500)
      return json({
        issuer: ISSUER,
        authorization_endpoint: new URL('authorize/', ISSUER).toString(),
        token_endpoint: tokenEndpoint,
        jwks_uri: jwksUri,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        scopes_supported: ['openid', 'profile', 'email'],
      })
    }
    if (url === jwksUri) return json({ keys: [jwk] })
    if (url === tokenEndpoint) {
      const body = options.body
      return token(typeof body === 'string' ? body : String(body))
    }
    return json({ error: 'not_found', url }, 404)
  }

  fake.settings.fetch = fetchImpl
  return fake
}
