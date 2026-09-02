/**
 * CSRF, by double submit.
 *
 * The threat is narrow and worth stating exactly, because it decides the design:
 * the session cookie is sent on a cross-site form POST, so any page on the
 * internet can make an authenticated request to Balancr as long as it does not
 * need to *read* the response. `SameSite=Lax` already blocks the cross-site POST
 * case in current browsers; this is the second lock, for the cases Lax does not
 * cover (a same-site subdomain, a browser that treats an unknown method
 * generously) and for the day a future route needs `SameSite=None`.
 *
 * Double submit works here — rather than being the weak choice it is on many
 * sites — because of the `__Host-` cookie prefix: a token that no sibling host
 * can set is a token an attacker cannot know. See `cookies.ts`.
 *
 * Two deliberate properties:
 *
 *  - **The token is per browser, not per form.** A fresh token for every render
 *    breaks the back button, breaks two tabs, and buys nothing here: the secret
 *    is unreadable cross-origin either way.
 *  - **Only unsafe methods are checked.** A GET that changes state would be a
 *    bug this file cannot fix, so it does not pretend to.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
// Type-only, for the `request.cookies` / `reply.setCookie` augmentation the
// plugin declares. The plugin itself is registered in `app.ts`.
import type {} from '@fastify/cookie'
import { cookieAttributes, CSRF_COOKIE } from './cookies.ts'
import { forbidden } from './errors.ts'

/** The header the SPA echoes the cookie in. */
export const CSRF_HEADER = 'x-csrf-token'

/** 32 bytes: the same order as a session id, and far beyond guessing. */
export const CSRF_TOKEN_BYTES = 32

/** Methods that cannot change state, so cannot be the vehicle for this attack. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export const newCsrfToken = (): string => randomBytes(CSRF_TOKEN_BYTES).toString('base64url')

/**
 * Constant-time comparison.
 *
 * `timingSafeEqual` throws when the lengths differ, so the length is checked
 * first — and it is safe to check it early, because our own tokens are all the
 * same length, so a mismatch there tells an attacker only that they did not send
 * a token of ours. What must not leak is *how much* of a correct-length token was
 * right, and that is what the constant-time compare protects.
 */
function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

const headerValue = (request: FastifyRequest): string | null => {
  const raw = request.headers[CSRF_HEADER]
  if (typeof raw === 'string') return raw
  // A repeated header arrives as an array. Two different tokens is not something
  // a correct client does, so it is refused rather than resolved.
  if (Array.isArray(raw) && raw.length === 1) return raw[0] ?? null
  return null
}

/**
 * Ensures the browser has a token, and returns it.
 *
 * Called on safe requests, so the SPA's first page load leaves with a usable
 * token and its first mutation does not have to be preceded by a bootstrap
 * request.
 */
export function ensureCsrfToken(request: FastifyRequest, reply: FastifyReply): string {
  const existing = request.cookies[CSRF_COOKIE]
  if (typeof existing === 'string' && existing.length > 0) return existing

  const token = newCsrfToken()
  // Not httpOnly: the SPA must read it to echo it. That is the mechanism, not an
  // oversight — the token is not a credential on its own.
  void reply.setCookie(CSRF_COOKIE, token, cookieAttributes(false))
  return token
}

/**
 * The guard.
 *
 * Registered as a hook rather than per route so that a route added later is
 * covered by default. A route that must opt out says so explicitly with
 * `config.csrf === false`, which is greppable — unlike a route that was simply
 * never added to a list.
 */
export function csrfHook(request: FastifyRequest, reply: FastifyReply): void {
  // Checked before anything else, so an exempt route neither validates a token nor
  // gets handed one — `/healthz` should not answer a container health check with a
  // Set-Cookie every thirty seconds.
  const routeConfig = request.routeOptions.config as { csrf?: boolean } | undefined
  if (routeConfig?.csrf === false) return

  if (SAFE_METHODS.has(request.method)) {
    ensureCsrfToken(request, reply)
    return
  }

  const cookie = request.cookies[CSRF_COOKIE]
  const header = headerValue(request)

  if (typeof cookie !== 'string' || cookie.length === 0 || header === null) {
    throw forbidden('Missing CSRF token.')
  }
  if (!sameToken(cookie, header)) {
    throw forbidden('CSRF token mismatch.')
  }
}

export function registerCsrf(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    csrfHook(request, reply)
  })
}
