/**
 * What the repository is allowed to contain.
 *
 * `52e4e5e` — the v0.5.18 release commit, and so the v0.5.18 tag and the published
 * release with it — tracked `node_modules` as a symlink pointing at one machine's
 * absolute home-directory path. Any checkout of it replaces a real `node_modules`
 * with a self-referential link, after which every binary resolved through it fails
 * with `ELOOP`: `npm run` cannot spawn a script, `tsc` cannot be read, and the gate
 * stops running while reporting only an exit code. Nothing in the gate could see it,
 * because the gate itself was what broke.
 *
 * A tracked symlink is worth refusing as a class rather than by name. It is a path
 * whose meaning depends on the machine that resolves it, which is the opposite of
 * what a checkout is for, and this repository has no legitimate use for one — a
 * future exception should be argued for here rather than committed quietly.
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

/** `[mode, path]` for every file in the commit, recursing into trees. */
const trackedEntries = (): { mode: string; path: string }[] =>
  execFileSync('git', ['ls-tree', '-r', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [meta = '', path = ''] = line.split('\t')
      return { mode: meta.split(' ')[0] ?? '', path }
    })

describe('the tracked tree', () => {
  it('has files in it, so an empty answer cannot pass the checks below', () => {
    // `git ls-tree` on a shallow or absent checkout would otherwise make this file a
    // guard that reports success without looking at anything.
    expect(trackedEntries().length).toBeGreaterThan(100)
  })

  it('tracks no symlink', () => {
    const links = trackedEntries().filter((entry) => entry.mode === '120000')
    expect(links.map((entry) => entry.path)).toEqual([])
  })

  it('tracks nothing under node_modules, whatever its shape', () => {
    // The symlink is one way to commit it; `git add -A` over an unignored real
    // directory is another, and it would be just as wrong for a different reason.
    const vendored = trackedEntries()
      .map((entry) => entry.path)
      .filter((path) => path === 'node_modules' || path.split('/').includes('node_modules'))
    expect(vendored).toEqual([])
  })
})
