/**
 * `CHANGELOG.md`, parsed into the entries the version dialog in the header shows.
 *
 * The file lives at the repo root, a sibling of `src/` rather than something
 * nested under it, so it cannot use the `new URL('./relative', import.meta.url)`
 * idiom `apply-migrations.ts`/`i18n/index.ts` use for their own asset — that trick
 * only works because those two source directories already live *under* `src/`, at
 * the same depth `dist/` mirrors. `version.ts` has the actual precedent for a
 * repo-root file: the Dockerfile copies `CHANGELOG.md` next to `dist/` (alongside
 * `package.json`), so it is read the same way, resolved once at import — the file
 * cannot change under a running process.
 *
 * Parsing is split from reading (`parseChangelog` takes the raw text, or null) so
 * a test can exercise the parser against a fixture without touching the real
 * file, and the missing-file degrade path, without mocking the filesystem.
 */
import { readFileSync } from 'node:fs'
import { renderMarkdown } from '../../../util/markdown.ts'
import { changelogSchema, type Changelog } from './schemas.ts'

const HEADING = /^## \[(\d+\.\d+\.\d+)\] — (\d{4}-\d{2}-\d{2})$/

interface ParsedEntry {
  version: string
  date: string
  body: string
}

/**
 * Splits the file on its version headings. The intro paragraph above the first
 * one — the "Keep a Changelog" preamble — belongs to nobody's entry and is
 * dropped.
 */
function parseEntries(source: string): ParsedEntry[] {
  const lines = source.split(/\r\n?|\n/)
  const entries: ParsedEntry[] = []

  for (const line of lines) {
    const heading = HEADING.exec(line)
    if (heading !== null) {
      entries.push({ version: heading[1] as string, date: heading[2] as string, body: '' })
      continue
    }
    const current = entries[entries.length - 1]
    if (current !== undefined) current.body += `${line}\n`
  }

  return entries
}

/**
 * `raw` is null when the file could not be read — an image built before this
 * shipped, or a dev checkout with a stale `dist/`. The dialog reads `available:
 * false` as "no changelog with this build," not as a repository with no history.
 */
export function parseChangelog(raw: string | null): Changelog {
  if (raw === null) return changelogSchema.parse({ available: false, entries: [] })

  return changelogSchema.parse({
    available: true,
    entries: parseEntries(raw).map((entry) => ({
      version: entry.version,
      date: entry.date,
      html: renderMarkdown(entry.body),
      // Built from the version, not parsed out of the markdown — the tag
      // convention (`git tag` shows `v0.9.0`, `v0.10.0`, …) is stable even
      // where the body text itself changes.
      releaseUrl: `https://github.com/nrosier/Balancr/releases/tag/v${entry.version}`,
    })),
  })
}

function read(): string | null {
  try {
    return readFileSync(new URL('../../../../CHANGELOG.md', import.meta.url), 'utf8')
  } catch {
    return null
  }
}

/** Resolved at import: the file cannot change under a running process. */
const RAW = read()

export function buildChangelog(): Changelog {
  return parseChangelog(RAW)
}
