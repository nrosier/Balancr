/**
 * Fails the build when a test is skipped, disabled, or `.only`-focused.
 *
 * A `.skip` or `.only` compiles clean and the suite still passes green — that is
 * exactly why it survives review. #429 shipped with a single `it.skip` that sat
 * unnoticed in the suite for weeks; nothing but a human re-reading every test file
 * would have caught it before then. This walks every test file vitest.config.ts
 * points at and turns the same mistake into a build failure the moment it happens,
 * rather than the moment somebody happens to skim past it.
 *
 * A deliberate, time-bound exception is still possible without editing this
 * script: put `SKIP-ALLOWED: <reason>, see #<issue>` as a comment on the same
 * line as the `.skip`/`.only`/`xit`/`xdescribe` call. This check still prints
 * that line on every run, so an exception is never silent — only permitted, and
 * traceable to the issue that tracks removing it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// The directories vitest.config.ts's two projects point `include` at. Walked
// directly rather than importing the config, so this check has no dependency on
// vitest resolving anything.
const TEST_DIRS = ['test', 'src', join('web', 'test'), join('web', 'src')]
const TEST_FILE = /\.test\.tsx?$/

function walk(dir: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return // TEST_DIRS is speculative — not every one of these exists today.
  }
  for (const entry of entries) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full, out)
    } else if (TEST_FILE.test(entry)) {
      out.push(full)
    }
  }
}

const files: string[] = []
for (const dir of TEST_DIRS) walk(join(root, dir), files)

// One entry per marker vitest treats as "don't run this the normal way". Named
// individually rather than one generic `\.skip\(`/`\.only\(` pattern, so a
// failure names the exact call instead of just the line.
const MARKERS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'it.skip', pattern: /\bit\.skip\(/ },
  { name: 'test.skip', pattern: /\btest\.skip\(/ },
  { name: 'describe.skip', pattern: /\bdescribe\.skip\(/ },
  { name: 'it.only', pattern: /\bit\.only\(/ },
  { name: 'test.only', pattern: /\btest\.only\(/ },
  { name: 'describe.only', pattern: /\bdescribe\.only\(/ },
  { name: 'xit', pattern: /\bxit\(/ },
  { name: 'xtest', pattern: /\bxtest\(/ },
  { name: 'xdescribe', pattern: /\bxdescribe\(/ },
]

// The escape hatch: a same-line marker naming a reason and the issue that tracks
// removing it. The issue reference is mandatory — an exception nobody can look
// up again is indistinguishable from one nobody remembers granting.
const ALLOWED = /SKIP-ALLOWED:.*#\d+/

const problems: string[] = []
const allowed: string[] = []

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const relPath = relative(root, file)
  lines.forEach((line, i) => {
    const hit = MARKERS.find(({ pattern }) => pattern.test(line))
    if (!hit) return
    const where = `${relPath}:${String(i + 1)}`
    if (ALLOWED.test(line)) {
      allowed.push(`${where}: ${hit.name} — ${line.trim()}`)
    } else {
      problems.push(
        `${where}: ${hit.name} with no exception marker — remove it, or mark it ` +
          '`// SKIP-ALLOWED: <reason>, see #<issue>` if it is genuinely temporary',
      )
    }
  })
}

if (allowed.length > 0) {
  console.log(`test-skips: ${String(allowed.length)} allowed exception(s):`)
  for (const line of allowed) console.log(`  ${line}`)
}

if (problems.length > 0) {
  console.error(`test-skips check failed — ${String(problems.length)} problem(s):\n`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

console.log(
  `test-skips ok — ${String(files.length)} test file(s) scanned, ` +
    `${String(allowed.length)} allowed exception(s), 0 unmarked skips/onlys`,
)
