/**
 * Response headers.
 *
 * The content-security policy is written to permit no external origin at all —
 * not "no untrusted CDN", none. That is the same decision as bundling every asset
 * locally rather than loading a chart library from a CDN: a financial dashboard
 * that fetches a script from someone else's domain gives that domain the ability
 * to read the page. `'self'` everywhere means a compromised dependency can still
 * do damage inside the page, but cannot phone the numbers home.
 *
 * `'unsafe-inline'` appears nowhere, which is a constraint on the frontend rather
 * than on this file: styles and scripts come from files, and the SPA is built
 * accordingly.
 *
 * HSTS is conditional on the deployment actually being HTTPS. Sent from
 * `http://localhost` it would pin the browser to HTTPS for *every* application on
 * localhost, which is the kind of thing that costs a developer an afternoon and a
 * cleared HSTS cache.
 */
import helmet from '@fastify/helmet'
import type { FastifyInstance } from 'fastify'
import { secureCookies } from './cookies.ts'

/** One year, and subdomains included. Only sent when the deployment is HTTPS. */
export const HSTS_MAX_AGE_SECONDS = 31_536_000

/**
 * The policy, as data so a test can assert on it.
 *
 * `frame-ancestors 'none'` rather than X-Frame-Options: the latter is superseded
 * and cannot express "nobody at all" as reliably. `base-uri 'none'` stops an
 * injected `<base>` from redirecting every relative URL on the page — a cheap
 * defence against an injection that gets that far.
 */
export const contentSecurityPolicy = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  // `data:` for inline SVG and chart export; no remote image host.
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'"],
  // The SPA talks to this origin only. No analytics, no error reporter.
  'connect-src': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'none'"],
  'object-src': ["'none'"],
  // Nothing here needs to be a frame or a worker from elsewhere.
  'frame-src': ["'none'"],
  'worker-src': ["'self'"],
  'manifest-src': ["'self'"],
} as const

export async function registerSecurityHeaders(app: FastifyInstance): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: contentSecurityPolicy as unknown as Record<string, string[]>,
    },
    // Sent only where it means something; see the file header.
    hsts: secureCookies
      ? { maxAge: HSTS_MAX_AGE_SECONDS, includeSubDomains: true, preload: false }
      : false,
    // A referrer to an external site would leak the path of the page being read,
    // and every path here is a statement about someone's money.
    referrerPolicy: { policy: 'no-referrer' },
    // Isolates the browsing context: a window this page opens cannot reach back
    // into it, and vice versa.
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    // Off: it forces every subresource to opt in with CORP headers, which breaks
    // nothing today but would break the first embedded PDF or font from `/static`
    // in a way that is hard to diagnose. Nothing here needs cross-origin
    // isolation (no SharedArrayBuffer, no precise timers).
    crossOriginEmbedderPolicy: false,
  })
}
