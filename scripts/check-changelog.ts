/**
 * Fails the build when CHANGELOG.md's top heading doesn't match the exact
 * format `changelog.ts`'s `HEADING` regex requires.
 *
 * That parser needs an em dash (`—`) between the version and the date; a
 * manually-typed hyphen (`-`) instead compiles, runs, and simply never matches
 * — the newest entry silently disappears from the in-app changelog dialog
 * with no error anywhere. This imports the same regex the runtime parser
 * uses, so the two can never drift apart.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { HEADING } from '../src/server/routes/api/changelog-heading.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')

const top = changelog.split(/\r\n?|\n/).find((line) => line.startsWith('## '))

if (top === undefined) {
  console.error('changelog: CHANGELOG.md has no `## ` version heading at all')
  process.exit(1)
}

if (!HEADING.test(top)) {
  console.error(`changelog: top heading does not match the parser's required format`)
  console.error(`  found:    ${top}`)
  console.error(`  expected: ## [X.Y.Z] — YYYY-MM-DD (with an em dash, —, not a hyphen)`)
  process.exit(1)
}

console.log(`changelog ok — ${top}`)
