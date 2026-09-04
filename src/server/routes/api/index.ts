/**
 * The read-only API the views read from.
 *
 * One rule holds this directory together: **a request never calls an upstream.**
 * Everything served here comes out of Balancr's own SQLite, written by a job on a
 * schedule. Three consequences, all of them the point:
 *
 *  - A page load cannot be slow because Ghostfolio's price provider is slow, and
 *    cannot fail because Actual is mid-restart.
 *  - Opening the insights page cannot spend money. The AI budget is a limit rather
 *    than a hope precisely because reads are free.
 *  - What is served can be out of date, so every response carries `freshness`.
 *    That is a field, not a banner the client may forget to draw.
 *
 * The rule is enforced by a test that scans this directory for adapter imports,
 * rather than by everyone remembering it.
 *
 * Every route is a GET and every route needs a session — they say nothing about
 * `auth`, which is how the guard's deny-by-default works. The mutations live
 * elsewhere on purpose: the settings writes in `../settings.ts`, the one call that
 * can spend money in `../ai.ts`. Both still answer on `/api/…` URLs; it is the
 * directory that is read-only, so the scanning test above has something to scan.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { config } from '../../../config.ts'
import type { Db } from '../../../db/index.ts'
import { notFound } from '../../errors.ts'
import { buildBudget } from './budget.ts'
import { buildChangelog } from './changelog.ts'
import { buildInsights, buildRunPayload } from './insights.ts'
import { buildOverview } from './overview.ts'
import { buildPortfolio } from './portfolio.ts'
import { buildStatus } from './status.ts'

/**
 * Which language the rendered-text exceptions come back in.
 *
 * The signed-in user's own setting wins, because it is the one they chose in
 * Balancr. `?locale=` is honoured after that for a client that wants to preview the
 * other language without changing the setting — the monthly narrative is cached per
 * locale, so a preview shows a cached translation or nothing rather than triggering
 * a model call. An unsupported value falls through to the default instead of 400ing:
 * the worst case is reading the dashboard in English.
 *
 * `Accept-Language` is deliberately not consulted here. It belongs with the screens
 * in `0.6.0`, where there is a cookie to remember the answer in — negotiating it per
 * API call would mean two tabs could disagree about the language of the same page.
 */
export function resolveLocale(request: FastifyRequest): string {
  const supported = new Set(config.SUPPORTED_LOCALES)

  const chosen = request.user?.locale
  if (chosen !== undefined && supported.has(chosen)) return chosen

  const asked = (request.query as { locale?: unknown } | undefined)?.locale
  if (typeof asked === 'string' && supported.has(asked)) return asked

  return config.DEFAULT_LOCALE
}

export function registerApiRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/overview', () => buildOverview(db))

  app.get('/api/budget', (request: FastifyRequest) =>
    buildBudget(db, (request.query as { month?: unknown } | undefined)?.month),
  )

  app.get('/api/portfolio', () => buildPortfolio(db))

  app.get('/api/insights', (request: FastifyRequest) =>
    buildInsights(db, {
      month: (request.query as { month?: unknown } | undefined)?.month,
      locale: resolveLocale(request),
      // Only so the page knows whether to draw the button that spends money.
      // `POST /api/ai/narrative` gates itself; this is presentation (#158).
      owner: request.user?.role === 'owner',
    }),
  )

  /**
   * One AI run's payload — what was prepared for that call, verbatim.
   *
   * A session, not `requireOwner`. The payload is the redacted bundle and nothing
   * else: aggregates, category names, and an opaque label where a sensitive category
   * would be. `/api/insights` already hands the same signals and the same month's
   * spend to any session, so gating the audit view harder than the numbers it
   * explains would only mean the person who can read the conclusions cannot check
   * them. What the owner alone may do is *spend* — that is `../ai.ts`.
   */
  app.get('/api/insights/runs/:id/payload', (request: FastifyRequest) => {
    const { id } = request.params as { id: string }
    const payload = buildRunPayload(db, id)
    // The ledger is pruned, and a run that has aged out is exactly the case a page
    // holding a stale list will ask for.
    if (payload === null) throw notFound('No such AI run.')
    return payload
  })

  // The detailed half of readiness. `/readyz` serves the same computation stripped of
  // every message, because it answers without a session; this one is behind the guard
  // and may quote what an upstream said. See `status.ts`.
  app.get('/api/status', () => buildStatus(db))

  // The version number in the header opens a dialog on this. See `changelog.ts` for
  // why the file is read from next to `dist/` rather than copied into it.
  app.get('/api/changelog', () => buildChangelog())
}
