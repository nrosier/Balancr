/**
 * `GET /bootstrap` — the handful of facts the SPA needs before it can render.
 *
 * The alternative is a build-time constant, and it is wrong: the language list,
 * the formatting locale and the currency are the operator's `.env`, and an image
 * that baked them in would need rebuilding to change `SUPPORTED_LOCALES`. So the
 * browser asks, once, at startup.
 *
 * **Deliberately not under `/api/`.** That prefix is the read-only API, and
 * `test/unit/server-api.test.ts` asserts every route beneath it requires a session
 * — an absolute rule is worth more than a rule with one documented exception. This
 * is a sibling instead, public by necessity: it is what the sign-in screen needs in
 * order to be drawn in the right language.
 *
 * Nothing here is a secret. The version is already in `/healthz`, the CSRF cookie
 * is readable by script by design (that is the whole double-submit mechanism), and
 * the locale settings are visible in the rendered output anyway. What is *not* here
 * matters more: no upstream URLs, no issuer, no account names, and no hint about
 * whether local login is enabled — `/auth/session` answers that, per connection.
 */
import type { FastifyInstance } from 'fastify'
import { config } from '../../config.ts'
import type { BootstrapResponse } from '../contract.ts'
import { CSRF_COOKIE } from '../cookies.ts'
import { CSRF_HEADER } from '../csrf.ts'
import { APP_VERSION } from '../version.ts'

export function registerBootstrapRoute(app: FastifyInstance): void {
  app.get(
    '/bootstrap',
    // Public, and exempt from CSRF as every GET is. It stays inside the rate limit:
    // it is called once per page load, so the ordinary bucket is generous, and an
    // exemption would hand out a free unauthenticated endpoint.
    { config: { auth: false } },
    (): BootstrapResponse => ({
      version: APP_VERSION,
      locales: {
        supported: [...config.SUPPORTED_LOCALES],
        default: config.DEFAULT_LOCALE,
      },
      format: {
        locale: config.FORMAT_LOCALE,
        currency: config.BASE_CURRENCY,
        timeZone: config.TZ,
      },
      csrf: { cookie: CSRF_COOKIE, header: CSRF_HEADER },
    }),
  )
}
