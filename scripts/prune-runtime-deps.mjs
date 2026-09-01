/**
 * Removes bytes from a production `node_modules` that can never be executed.
 *
 * Run in the Dockerfile's `deps` stage, after `npm ci --omit=dev`. Two things
 * `--omit=dev` leaves behind:
 *
 *  - **`@typescript/typescript-*`.** TypeScript 7 is a Go binary delivered via
 *    optional per-platform packages. npm does not mark an *optional* dependency
 *    of a *dev* dependency as dev, so 27 MB of compiler follows the runtime
 *    image around. Nothing in `dist/` can call it.
 *  - **Foreign prebuilds.** Native modules pack a binary per platform;
 *    this image is amd64 Alpine and will only ever load one of them.
 *
 * Deliberately conservative: it deletes only whole platform directories whose
 * name is not one this image can use, and never touches a package's JavaScript.
 * If it were to delete the wrong binary the container would fail to start —
 * which is why the build smoke-tests `/healthz`, the path that opens SQLite.
 */
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Platform tags this image can actually execute. Alpine is musl. */
const KEEP = new Set(['linux-x64', 'linuxmusl-x64'])

const root = process.argv[2] ?? 'node_modules'
let removedBytes = 0
const removed = []

function sizeOf(path) {
  let total = 0
  const stack = [path]
  while (stack.length > 0) {
    const current = stack.pop()
    const stats = statSync(current, { throwIfNoEntry: false })
    if (!stats) continue
    if (stats.isDirectory()) {
      for (const entry of readdirSync(current)) stack.push(join(current, entry))
    } else {
      total += stats.size
    }
  }
  return total
}

function drop(path) {
  removedBytes += sizeOf(path)
  removed.push(path)
  rmSync(path, { recursive: true, force: true })
}

/** Prunes one `prebuilds/` directory down to the platforms this image runs. */
function prunePrebuilds(prebuilds) {
  for (const entry of readdirSync(prebuilds, { withFileTypes: true })) {
    if (entry.isDirectory() && !KEEP.has(entry.name)) drop(join(prebuilds, entry.name))
  }
}

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const path = join(dir, entry.name)

    if (entry.name === 'prebuilds') {
      prunePrebuilds(path)
      continue
    }
    // The Go compiler packages: @typescript/typescript-linux-x64 and friends.
    if (dir.endsWith('@typescript')) {
      drop(path)
      continue
    }
    if (entry.name === '.bin') continue
    walk(path)
  }
}

walk(root)

process.stdout.write(
  `pruned ${removed.length} directories, ${(removedBytes / 1e6).toFixed(1)} MB\n` +
    removed.map((path) => `  - ${path}\n`).join(''),
)
