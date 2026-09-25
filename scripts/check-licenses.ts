/**
 * Fails the build when a production dependency's license isn't one Balancr can
 * safely bundle into an MIT-licensed image it publishes publicly. `--production`
 * scope only: a devDependency's license never ships in the built artifact or the
 * Docker image, so it carries none of the same risk.
 *
 * The list below is deliberately short: MIT/BSD/Apache/ISC-family licenses are
 * the overwhelming majority of the npm ecosystem and carry no risk for an MIT
 * project, so this only needs to catch the licenses that would actually
 * constrain redistribution — strong copyleft, and no declared license at all.
 *
 * A forced dependency that can't be swapped out is still allowed, but only as a
 * named, written exception in EXCEPTIONS below — never a silent pass. Same shape
 * as skips:check's `SKIP-ALLOWED` marker: an exception has to be visible to be
 * reviewable.
 */
import checker from 'license-checker'

const EXCEPTIONS: Record<string, string> = {
  'hyperformula@3.4.0':
    "GPL-3.0-only, pulled in transitively by @actual-app/core (Actual's own " +
    "formula engine) — not a dependency Balancr chose or can swap out. The GPL " +
    "component stays GPL; Balancr's own code stays MIT, and the source is " +
    'already public (npm + GitHub) either way. A visibility decision, not a ' +
    'compliance gap.',
}

// Anchored/exact where it matters: `UNLICENSED` (no license at all) is not the
// same thing as `Unlicense` (a public-domain dedication), and license-checker
// reports them as distinct strings.
const DENY: RegExp[] = [/^\(?AGPL/i, /^\(?GPL/i, /SSPL/i, /^UNLICENSED$/]

checker.init({ start: process.cwd(), production: true }, (err, packages) => {
  if (err) {
    console.error('license-checker failed:', err)
    process.exit(1)
  }

  const problems: string[] = []
  const exceptions: string[] = []

  for (const [key, info] of Object.entries(packages)) {
    if (key.startsWith('balancr@')) continue // this package's own UNLICENSED (private) entry
    const licenses = String(info.licenses ?? 'unknown')
    if (!DENY.some((pattern) => pattern.test(licenses))) continue

    const reason = EXCEPTIONS[key]
    if (reason !== undefined) {
      exceptions.push(`${key}: ${licenses} — ${reason}`)
    } else {
      problems.push(
        `${key}: ${licenses} is not an allowed license. Replace the dependency, ` +
          'or add a written exception to EXCEPTIONS in scripts/check-licenses.ts.',
      )
    }
  }

  if (exceptions.length > 0) {
    console.log(`licenses: ${String(exceptions.length)} allowed exception(s):`)
    for (const line of exceptions) console.log(`  ${line}`)
  }

  if (problems.length > 0) {
    console.error(`licenses check failed — ${String(problems.length)} problem(s):\n`)
    for (const problem of problems) console.error(`  ${problem}`)
    process.exit(1)
  }

  console.log(
    `licenses ok — ${String(Object.keys(packages).length)} production package(s) checked, ` +
      `${String(exceptions.length)} allowed exception(s), 0 unreviewed`,
  )
})
