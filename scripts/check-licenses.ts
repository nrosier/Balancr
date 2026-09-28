/**
 * Fails the build when a dependency's license isn't one Balancr can safely
 * bundle into an MIT-licensed image it publishes publicly.
 *
 * "Ships" is not the same thing as npm's production/dev split. The Node server
 * only ever runs `--production` code, but the web frontend is a Vite bundle:
 * react, react-dom, and anything else Vite pulls into `dist/web`'s JS is
 * declared as a devDependency (the server doesn't need it) while its actual
 * *code* is what a browser downloads from the published image just as surely
 * as the server's own dependencies are (#721). So the scope checked here is
 * `--production` packages plus whatever a real Vite build actually bundles —
 * found by running one in memory (`write: false`, nothing touches `dist/`) and
 * reading the resulting chunks' `moduleIds`, the same "trust the real output,
 * not a hand-maintained guess about it" reasoning check-web-assets.mjs uses.
 * Everything else devDependencies-only (eslint, vitest, typescript, tsx, …)
 * never leaves this machine and is rightly out of scope.
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
import { fileURLToPath } from 'node:url'
import checker from 'license-checker'
import type { InitOpts, ModuleInfos } from 'license-checker'
import { build } from 'vite'

/** Every npm package name whose code a real production Vite build bundles. */
async function fetchViteBundledPackageNames(): Promise<Set<string>> {
  const result = await build({
    root: fileURLToPath(new URL('../web', import.meta.url)),
    configFile: fileURLToPath(new URL('../web/vite.config.ts', import.meta.url)),
    logLevel: 'silent',
    build: { write: false },
  })
  const results = Array.isArray(result) ? result : [result]
  // `build()`'s return type also covers `watch` mode, which this call never enables —
  // `write: false` alone always yields a `RolldownOutput`, so this filter only narrows
  // the type; nothing is ever actually dropped.
  const outputs = results.filter((r): r is Extract<typeof r, { output: unknown }> => 'output' in r)

  const names = new Set<string>()
  for (const output of outputs) {
    for (const chunk of output.output) {
      if (chunk.type !== 'chunk') continue
      for (const moduleId of chunk.moduleIds) {
        const afterNodeModules = moduleId.split('node_modules/').pop()
        if (afterNodeModules === undefined || afterNodeModules === moduleId) continue
        // A resolved module path, e.g. `react-dom/cjs/react-dom.production.js` or
        // `@scope/pkg/dist/index.js` — the package name is one segment, or two
        // for a scoped package.
        const segments = afterNodeModules.split('/')
        const name = segments[0]?.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
        if (name !== undefined) names.add(name)
      }
    }
  }
  return names
}

// Keyed by package name, not `name@version`: a Renovate lockfile-maintenance bump
// changes the version string on every routine update, and a license exception
// pinned to one exact version breaks CI on a dependency whose license hasn't
// actually changed (#724).
const EXCEPTIONS: Record<string, string> = {
  hyperformula:
    "GPL-3.0-only, pulled in transitively by @actual-app/core (Actual's own " +
    "formula engine) — not a dependency Balancr chose or can swap out. The GPL " +
    "component stays GPL; Balancr's own code stays MIT, and the source is " +
    'already public (npm + GitHub) either way. A visibility decision, not a ' +
    'compliance gap.',
}

// Anchored/exact where it matters: `UNLICENSED` (no license at all) is not the
// same thing as `Unlicense` (a public-domain dedication), and license-checker
// reports them as distinct strings. `UNKNOWN` is the third of that family —
// license-checker's own literal for a package that declares no license field
// at all, distinct from both and otherwise passing silently.
const DENY: RegExp[] = [/^\(?AGPL/i, /^\(?GPL/i, /SSPL/i, /^UNLICENSED$/, /^UNKNOWN$/]

function init(options: InitOpts): Promise<ModuleInfos> {
  return new Promise((resolve, reject) => {
    checker.init(options, (err, packages) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)))
      else resolve(packages)
    })
  })
}

const [production, everything, viteBundled] = await Promise.all([
  init({ start: process.cwd(), production: true }),
  init({ start: process.cwd() }),
  fetchViteBundledPackageNames(),
])

const inScope = new Set([
  ...Object.keys(production).map((key) => key.replace(/@[^@]+$/, '')),
  ...viteBundled,
])

const problems: string[] = []
const exceptions: string[] = []

for (const [key, info] of Object.entries(everything)) {
  if (key.startsWith('balancr@')) continue // this package's own UNLICENSED (private) entry
  const name = key.replace(/@[^@]+$/, '')
  if (!inScope.has(name)) continue // devDependency-only tooling — never ships, in the image or the browser

  const licenses = String(info.licenses ?? 'unknown')
  if (!DENY.some((pattern) => pattern.test(licenses))) continue

  const reason = EXCEPTIONS[name]
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
  `licenses ok — ${String(inScope.size)} package(s) checked (production + Vite-bundled), ` +
    `${String(exceptions.length)} allowed exception(s), 0 unreviewed`,
)
