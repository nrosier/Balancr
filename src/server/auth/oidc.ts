/**
 * The OpenID Connect client, kept behind a small interface.
 *
 * Two decisions shape this file.
 *
 * **A real code flow, not forwarded headers.** Authentik can be asked to inject
 * `X-authentik-username` and be done with it, but then the application's idea of
 * who you are is a header, the proxy configuration is the security boundary, and
 * there is no server-side session to revoke. A code flow with PKCE gives real
 * sessions, group claims if they are ever needed, and survives the day the proxy
 * in front changes. See `net.ts` for the other half of that argument.
 *
 * **Discovery is lazy, and a failure is not permanent.** Authentik and Balancr
 * come up in the same compose stack, in no guaranteed order, and Authentik takes
 * the longer of the two. Discovering at boot would make the container crash-loop
 * behind its own dependency, so the metadata is fetched on the first login and
 * cached — and the cache is dropped when the fetch fails, so the next attempt
 * tries again rather than serving a rejected promise forever.
 *
 * The interface exists so routes depend on two methods rather than on
 * `openid-client`, which is what lets the route tests run a fake issuer through
 * the real library (see `test/helpers/oidc-issuer.ts`) and lets slice C add a
 * second login method without touching either.
 */
import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  customFetch,
  discovery,
  type Configuration,
  type CustomFetch,
} from 'openid-client'
import { config } from '../../config.ts'
import { logger } from '../../logger.ts'
import { HttpError } from '../errors.ts'

const log = logger.child({ module: 'server.auth.oidc' })

/**
 * `profile` and `email` on top of `openid`, because a display name and an address
 * are what the UI shows and the digest addresses. No `offline_access`: Balancr
 * never calls Authentik on the user's behalf, so a refresh token would be a
 * long-lived credential stored for no purpose.
 */
export const OIDC_SCOPE = 'openid profile email'

/** Where Authentik sends the browser back. Registered in the provider, so fixed. */
export const CALLBACK_PATH = '/auth/callback'

/** What a successful login establishes. Deliberately no tokens: see `exchange`. */
export interface OidcIdentity {
  /** The `sub` claim — stable per provider, and the only durable key here. */
  sub: string
  email: string | undefined
  name: string | undefined
}

/** The per-login secrets, generated and stored by `login-flow.ts`. */
export interface FlowSecrets {
  state: string
  nonce: string
  codeVerifier: string
}

export interface OidcClient {
  /** The URL to send the browser to. */
  authorizationUrl(secrets: FlowSecrets): Promise<URL>
  /** Validates the callback and exchanges the code. Throws on any mismatch. */
  exchange(input: { currentUrl: URL } & FlowSecrets): Promise<OidcIdentity>
}

export interface OidcSettings {
  issuer: string
  clientId: string
  clientSecret: string
  redirectUri: string
  /** Test seam: routes every request the library makes. Unset in production. */
  fetch?: CustomFetch
}

/**
 * The settings, or null when OIDC is not configured.
 *
 * Null rather than a throw because a deployment may legitimately run on local
 * login alone — `config.ts` already refuses the case where neither is available,
 * and refuses a half-filled OIDC block, so null here means "deliberately off".
 */
export function oidcSettings(): OidcSettings | null {
  const { AUTH_OIDC_ISSUER, AUTH_OIDC_CLIENT_ID, AUTH_OIDC_CLIENT_SECRET } = config
  if (
    AUTH_OIDC_ISSUER === undefined ||
    AUTH_OIDC_CLIENT_ID === undefined ||
    AUTH_OIDC_CLIENT_SECRET === undefined
  ) {
    return null
  }
  return {
    issuer: AUTH_OIDC_ISSUER,
    clientId: AUTH_OIDC_CLIENT_ID,
    clientSecret: AUTH_OIDC_CLIENT_SECRET,
    // Built from PUBLIC_BASE_URL rather than from the incoming request: the
    // redirect URI is compared byte for byte by the provider, and deriving it
    // from a `Host` header would let a request choose where the code is sent.
    redirectUri: new URL(CALLBACK_PATH, config.PUBLIC_BASE_URL).toString(),
  }
}

/** The provider being unreachable is a 503, not a 500: it is someone else's outage. */
const unreachable = (): HttpError =>
  new HttpError(503, 'unavailable', 'The identity provider is not reachable right now.')

export function createOidcClient(settings: OidcSettings): OidcClient {
  let discovered: Promise<Configuration> | null = null

  function metadata(): Promise<Configuration> {
    if (discovered !== null) return discovered

    const options = settings.fetch === undefined ? undefined : { [customFetch]: settings.fetch }
    const pending = discovery(
      new URL(settings.issuer),
      settings.clientId,
      settings.clientSecret,
      undefined,
      options,
    ).then((configuration) => {
      // Also set on the instance: `discovery`'s options cover the discovery
      // request only, and the token request goes through the configuration.
      if (settings.fetch !== undefined) configuration[customFetch] = settings.fetch
      log.info({ issuer: settings.issuer }, 'OIDC issuer discovered')
      return configuration
    })

    pending.catch((error: unknown) => {
      // Dropped so the next login retries. Without this, one failed fetch during
      // startup would keep returning the same rejected promise until a restart.
      discovered = null
      log.error({ err: error, issuer: settings.issuer }, 'OIDC discovery failed')
    })

    discovered = pending
    return pending
  }

  return {
    async authorizationUrl(secrets: FlowSecrets): Promise<URL> {
      let configuration: Configuration
      try {
        configuration = await metadata()
      } catch {
        throw unreachable()
      }

      return buildAuthorizationUrl(configuration, {
        redirect_uri: settings.redirectUri,
        scope: OIDC_SCOPE,
        state: secrets.state,
        nonce: secrets.nonce,
        code_challenge: await calculatePKCECodeChallenge(secrets.codeVerifier),
        code_challenge_method: 'S256',
        // No `prompt` and no `max_age`. An existing Authentik session must not
        // produce a second password prompt — that is the point of putting SSO in
        // front of this — and asking for one anyway would also make the session
        // policy a decision taken here instead of in Authentik, where it is
        // configurable.
      })
    },

    async exchange({ currentUrl, state, nonce, codeVerifier }): Promise<OidcIdentity> {
      let configuration: Configuration
      try {
        configuration = await metadata()
      } catch {
        throw unreachable()
      }

      // Every check that matters is stated here rather than left to a default:
      // `expectedState` and `expectedNonce` are compared by the library against
      // the values this flow stored, `pkceCodeVerifier` proves the exchange comes
      // from whoever started the flow, and `idTokenExpected` refuses a response
      // with no ID token instead of treating an OAuth-only reply as a login.
      const tokens = await authorizationCodeGrant(configuration, currentUrl, {
        expectedState: state,
        expectedNonce: nonce,
        pkceCodeVerifier: codeVerifier,
        idTokenExpected: true,
      })

      const claims = tokens.claims()
      if (claims === undefined) {
        throw new HttpError(502, 'unavailable', 'The identity provider returned no ID token.')
      }

      // The tokens are read and dropped. Balancr has no reason to call Authentik
      // again on the user's behalf, so storing an access or refresh token would
      // be keeping a credential for a use that does not exist.
      return {
        sub: claims.sub,
        email: typeof claims.email === 'string' ? claims.email : undefined,
        name:
          typeof claims.name === 'string'
            ? claims.name
            : typeof claims.preferred_username === 'string'
              ? claims.preferred_username
              : undefined,
      }
    },
  }
}

/** The production client, or null when OIDC is off. Built once per process. */
export function oidcClientFromConfig(): OidcClient | null {
  const settings = oidcSettings()
  return settings === null ? null : createOidcClient(settings)
}
