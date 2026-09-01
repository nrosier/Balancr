/**
 * Keeps the README's static badges honest.
 *
 * The release and licence badges are static rather than shields.io's `github/…`
 * endpoints, because this repository is private: shields fetches over the public
 * API, gets a 404, and renders "repo not found" — which is worse than no badge,
 * since it looks like the project is broken rather than simply not public. The CI
 * badge is GitHub's own `badge.svg`, which a signed-in viewer with access can
 * read, so that one stays dynamic.
 *
 * The cost of static is drift: the version bump that closes a milestone touches
 * `package.json` and would leave the badge quoting the previous release. This
 * check is what makes that a build failure instead of a wrong number sitting at
 * the top of the page for a month.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const readme = readFileSync(join(root, 'README.md'), 'utf8')

/** shields.io percent-encodes `-` as `--` inside a badge segment. */
const escape = (text) => text.replace(/-/g, '--').replace(/_/g, '__').replace(/ /g, '_')

const expected = [
  {
    what: 'release',
    // `v` prefixed, matching the git tag that publishes it.
    url: `https://img.shields.io/badge/release-v${escape(pkg.version)}-blue`,
    fix: 'bump the badge with package.json — the two are the same release',
  },
  {
    what: 'license',
    url: `https://img.shields.io/badge/license-${escape(pkg.license)}-blue`,
    fix: 'match the SPDX id in package.json and the text in LICENSE',
  },
]

const problems = []
for (const badge of expected) {
  if (!readme.includes(badge.url)) {
    problems.push(`README is missing the ${badge.what} badge \`${badge.url}\` — ${badge.fix}`)
  }
}

// A dynamic shields badge pointed at this repository renders "repo not found" for
// everyone, so catch one being reintroduced rather than waiting for a screenshot.
const dynamic = readme.match(/img\.shields\.io\/github\/[^\s")]+/g)
if (dynamic !== null) {
  problems.push(
    `README uses shields.io GitHub endpoints, which cannot read a private repo ` +
      `and render "repo not found": ${dynamic.join(', ')}`,
  )
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`badges: ${problem}`)
  process.exit(1)
}

console.log(`badges ok — release v${pkg.version}, licence ${pkg.license}`)
