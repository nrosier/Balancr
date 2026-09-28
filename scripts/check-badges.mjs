/**
 * Keeps the README's badges pointed at this repository.
 *
 * This repository has been public since 2026-09-05, so the release and licence
 * badges read live from shields.io's `github/…` endpoints against the public
 * API — the same reason the CI badge, GitHub's own `badge.svg`, already worked.
 * Before that, those two were static text matched against `package.json`; the
 * risk this check now guards against is a badge pointed at the wrong repo (a
 * fork, a rename) rather than drift, since a dynamic badge cannot go stale.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const readme = readFileSync(join(root, 'README.md'), 'utf8')

const repo = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^https:\/\/github\.com\//, '')

const expected = [
  {
    what: 'release',
    url: `https://img.shields.io/github/v/release/${repo}?label=release`,
    fix: `point the release badge at img.shields.io/github/v/release/${repo}`,
  },
  {
    what: 'license',
    url: `https://img.shields.io/github/license/${repo}`,
    fix: `point the license badge at img.shields.io/github/license/${repo}`,
  },
]

const problems = []
for (const badge of expected) {
  if (!readme.includes(badge.url)) {
    problems.push(`README is missing the ${badge.what} badge \`${badge.url}\` — ${badge.fix}`)
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`badges: ${problem}`)
  process.exit(1)
}

console.log(`badges ok — ${repo}`)
