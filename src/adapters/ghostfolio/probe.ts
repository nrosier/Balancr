/**
 * Startup capability check for Ghostfolio.
 *
 * Three of the four endpoints Balancr reads are Ghostfolio's own frontend API:
 * unversioned, and free to change on any upgrade. The probe is what keeps that
 * from becoming a silently wrong chart — it calls each path once, validates the
 * response, and reports which one broke.
 *
 * The two failure modes are deliberately kept apart, because the right reaction
 * differs:
 *
 *  - `unreachable` — Ghostfolio is down, restarting, or the token is wrong.
 *    Transient. Balancr still boots and still serves budget data; the portfolio
 *    views show a stale-data notice and the next job retries.
 *  - `shape-mismatch` — Ghostfolio answered, but not with what we parse. The
 *    numbers we would derive are unknown, so portfolio jobs must refuse to
 *    write snapshots rather than persist a plausible-looking wrong value.
 *
 * Nothing here logs an amount. A probe report is a shape report.
 */
import { logger } from '../../logger.ts'
import {
  GhostfolioError,
  fetchAccounts,
  fetchHealth,
  fetchPortfolioDetails,
  fetchPortfolioPerformance,
  resetGhostfolioToken,
} from './client.ts'

const log = logger.child({ module: 'ghostfolio:probe' })

export type ProbeStatus = 'ok' | 'unreachable' | 'shape-mismatch'

export interface ProbeCheck {
  readonly path: string
  readonly status: ProbeStatus
  /** Shape-level facts only — counts and field presence, never values. */
  readonly detail: string
  readonly error?: string
}

export interface ProbeReport {
  readonly status: ProbeStatus
  readonly checks: readonly ProbeCheck[]
  /** Fields we depend on that were absent or empty. Not fatal, but wrong-ish. */
  readonly warnings: readonly string[]
  readonly at: Date
}

/**
 * An HTTP error means "not reachable in a usable state"; a Zod failure means
 * "reachable, but we cannot trust what it said". `GhostfolioError.status` is the
 * discriminator: `parse()` throws without one, `request()` throws with one.
 */
function classify(error: unknown): { status: ProbeStatus; message: string } {
  if (error instanceof GhostfolioError) {
    return {
      status: error.status === undefined ? 'shape-mismatch' : 'unreachable',
      message: error.message,
    }
  }
  return {
    status: 'unreachable',
    message: error instanceof Error ? error.message : String(error),
  }
}

async function check(
  path: string,
  run: () => Promise<string>,
): Promise<ProbeCheck> {
  try {
    return { path, status: 'ok', detail: await run() }
  } catch (error) {
    const { status, message } = classify(error)
    return { path, status, detail: 'failed', error: message }
  }
}

/**
 * Runs every read Balancr depends on, once.
 *
 * Never throws: the caller decides what a failure means. `assertUsable` is the
 * throwing wrapper for contexts that need one.
 */
export async function probeGhostfolio(): Promise<ProbeReport> {
  // Start from a clean token so an expired cached JWT is diagnosed as an auth
  // problem now rather than surfacing during the first real job.
  resetGhostfolioToken()

  const warnings: string[] = []

  const checks: ProbeCheck[] = []

  checks.push(await check('/api/v1/health', async () => {
    await fetchHealth()
    return 'reachable'
  }))

  // Everything below needs the JWT, and all of it fails the same way if auth
  // fails, so there is no value in probing further once health is unreachable.
  if (checks[0]?.status === 'ok') {
    checks.push(await check('/api/v1/portfolio/details', async () => {
      const details = await fetchPortfolioDetails()
      const holdings = details.holdings

      if (holdings.length === 0) {
        warnings.push('portfolio/details returned no holdings')
      }
      // Without valueInBaseCurrency there is nothing to put in net worth, and
      // recomputing it from quantity × price would silently ignore FX.
      const valued = holdings.filter((h) => h.valueInBaseCurrency != null).length
      if (holdings.length > 0 && valued === 0) {
        warnings.push(
          'no holding carries valueInBaseCurrency — portfolio value cannot be computed',
        )
      }
      if (details.summary === undefined) {
        warnings.push('portfolio/details has no summary block')
      }
      const withIsin = holdings.filter((h) => h.isin).length
      return `${holdings.length} holdings, ${valued} valued, ${withIsin} with ISIN`
    }))

    // Not `/api/v1/…`: the client tries v2 first and falls back, so naming one
    // version here would report a path that may not be the one that answered.
    checks.push(await check('portfolio/performance', async () => {
      const performance = await fetchPortfolioPerformance()
      if (performance.chart.length === 0) {
        warnings.push('portfolio/performance returned an empty chart')
      }
      const dated = performance.chart.filter((p) => /^\d{4}-\d{2}-\d{2}/.test(p.date))
      if (performance.chart.length > 0 && dated.length !== performance.chart.length) {
        warnings.push('portfolio/performance chart has non-ISO dates')
      }
      return `${performance.chart.length} chart points`
    }))

    checks.push(await check('/api/v1/account', async () => {
      const { accounts } = await fetchAccounts()
      if (accounts.length === 0) {
        warnings.push('account returned no accounts — net-worth mapping has nothing to map')
      }
      const currencies = new Set(accounts.map((a) => a.currency))
      return `${accounts.length} accounts, ${currencies.size} currencies`
    }))
  }

  // Worst status wins, and a shape mismatch is worse than being unreachable:
  // an outage resolves itself, a changed contract needs a code change.
  const status: ProbeStatus = checks.some((c) => c.status === 'shape-mismatch')
    ? 'shape-mismatch'
    : checks.some((c) => c.status === 'unreachable')
      ? 'unreachable'
      : 'ok'

  const report: ProbeReport = { status, checks, warnings, at: new Date() }
  logProbe(report)
  return report
}

function logProbe(report: ProbeReport): void {
  for (const c of report.checks) {
    if (c.status === 'ok') log.debug({ path: c.path, detail: c.detail }, 'probe ok')
    else log.error({ path: c.path, status: c.status, err: c.error }, 'probe failed')
  }
  for (const warning of report.warnings) log.warn({ warning }, 'probe warning')

  if (report.status === 'shape-mismatch') {
    log.error(
      'Ghostfolio responded with an unexpected shape. Portfolio data is disabled ' +
        'until src/adapters/ghostfolio/types.ts matches this Ghostfolio version.',
    )
  } else if (report.status === 'unreachable') {
    log.warn('Ghostfolio is unreachable; portfolio data will be stale until it returns.')
  }
}

/**
 * Throws unless every probed endpoint parsed.
 *
 * For jobs that are about to persist portfolio figures — the point of the whole
 * exercise is that we would rather have no snapshot than a wrong one.
 */
export async function assertGhostfolioUsable(): Promise<ProbeReport> {
  const report = await probeGhostfolio()
  if (report.status === 'ok') return report

  const failed = report.checks
    .filter((c) => c.status !== 'ok')
    .map((c) => `  ${c.path} [${c.status}]: ${c.error ?? 'unknown'}`)
    .join('\n')
  throw new Error(`Ghostfolio probe failed (${report.status}):\n${failed}`)
}
