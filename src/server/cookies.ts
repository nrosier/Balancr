/**
 * Cookie names and attributes, decided once.
 *
 * The `__Host-` prefix is the load-bearing part. A browser accepts a cookie with
 * that prefix only when it is `Secure`, has `Path=/`, and carries no `Domain` —
 * which means it cannot be set by a sibling host. That is what makes two things
 * in this application sound rather than merely conventional:
 *
 *  - the session cookie cannot be planted by anything else under the parent
 *    domain, so an unrelated app on `*.example.com` cannot fix a session id; and
 *  - the CSRF cookie cannot be planted either, which is the one assumption that
 *    double-submit rests on. Without the prefix, double-submit degrades to
 *    "attacker sets both halves".
 *
 * The prefix requires HTTPS, and development runs on `http://localhost`, where a
 * browser rejects the cookie outright — so the name adapts to the deployment
 * rather than the code pretending the two cases are the same. `PUBLIC_BASE_URL`
 * decides, and `config` already refuses a non-HTTPS base URL in production, so
 * the unprefixed name cannot be what a real deployment uses.
 */
import { config } from '../config.ts'

/** True when the deployment is HTTPS, which is what `__Host-` and `Secure` need. */
export const secureCookies = config.PUBLIC_BASE_URL.startsWith('https://')

const named = (name: string): string => (secureCookies ? `__Host-${name}` : name)

/** Opaque session id. Read by the server only. */
export const SESSION_COOKIE = named('balancr_sid')

/**
 * The CSRF token. Deliberately readable by scripts — the SPA has to echo it in a
 * header, which is the whole mechanism. It is not a credential: on its own it
 * authenticates nothing.
 */
export const CSRF_COOKIE = named('balancr_csrf')

/**
 * The `state` of a login in progress, for the ten minutes one takes.
 *
 * Separate from the session cookie because it means something different: it binds
 * a callback to the browser that started the flow, so a callback URL on its own
 * cannot log anyone in. See `auth/login-flow.ts`.
 */
export const LOGIN_FLOW_COOKIE = named('balancr_login')

/**
 * The UI language, so the shell and the bundle start in the right one.
 *
 * Not a credential and not secret — the language is visible in the rendered page —
 * but `httpOnly` all the same, because the server is the only thing that should write
 * it. It caches the account's `locale` column, and a copy the page could set is a
 * copy that can disagree with what the nightly analysis will be written in. See
 * `locale.ts` for the resolution order it sits in.
 */
export const LOCALE_COOKIE = named('balancr_locale')

export interface CookieAttributes {
  path: string
  httpOnly: boolean
  secure: boolean
  sameSite: 'lax' | 'strict' | 'none'
  /** Seconds. Absent means a session cookie, which dies with the browser. */
  maxAge?: number
}

/**
 * `SameSite=Lax` rather than `Strict`: the OIDC provider redirects the browser
 * back to Balancr with a cross-site GET, and `Strict` would withhold the cookie
 * on exactly that navigation, so the callback would arrive with no state and the
 * login would fail on the last step. `Lax` still withholds it from cross-site
 * POSTs, which is the case that matters.
 */
export function cookieAttributes(httpOnly: boolean, maxAgeSeconds?: number): CookieAttributes {
  const base: CookieAttributes = { path: '/', httpOnly, secure: secureCookies, sameSite: 'lax' }
  // Built conditionally rather than with `maxAge: maxAgeSeconds`, because under
  // `exactOptionalPropertyTypes` an explicit `undefined` is not the same as an
  // absent key — and an absent key is what makes it a browser-session cookie.
  return maxAgeSeconds === undefined ? base : { ...base, maxAge: maxAgeSeconds }
}

/**
 * Attributes that delete a cookie.
 *
 * The attributes have to match the ones it was set with or the browser treats it
 * as a different cookie and leaves the original in place — which on a logout means
 * the session cookie is still there, pointing at a row that no longer exists. It
 * works out because the lookup fails, but "it works out" is not what a logout
 * should rest on.
 */
export function clearedCookie(httpOnly: boolean): CookieAttributes {
  return { ...cookieAttributes(httpOnly), maxAge: 0 }
}
