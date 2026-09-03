/**
 * Removes bytes from a production `node_modules` that can never be executed.
 *
 * Run in the Dockerfile's `deps` stage, after `npm ci --omit=dev`. Three things
 * `--omit=dev` leaves behind:
 *
 *  - **`@typescript/typescript-*`.** TypeScript 7 is a Go binary delivered via
 *    optional per-platform packages. npm does not mark an *optional* dependency
 *    of a *dev* dependency as dev, so 27 MB of compiler follows the runtime
 *    image around. Nothing in `dist/` can call it.
 *  - **Foreign prebuilds.** Native modules pack a binary per platform; this image
 *    loads exactly one of them. There are two layouts in the wild and both are
 *    handled: `prebuilds/<platform>-<arch>/` directories, which is what `argon2`
 *    ships, and flat `prebuilds/<platform>-<arch>.node` files, which is what
 *    `better-sqlite3` 13 ships. Handling only the first left eight platform
 *    binaries — 17 MB, seven of them unloadable — in every image up to #39.
 *  - **Vendored C sources.** A package with a `binding.gyp` compiles from
 *    `deps/`; `better-sqlite3` vendors the whole SQLite amalgamation there, 10 MB
 *    that only `node-gyp` ever reads and only at install time. By the time this
 *    script runs, the install has either used a prebuild or already compiled.
 *
 * Deliberately conservative: it deletes platform binaries this image cannot load
 * and build inputs of native packages, and never touches a package's JavaScript.
 * If it were to delete the wrong binary the container would fail to start — which
 * is why `image.yml` runs the built image and waits for `/healthz`, the path that
 * opens SQLite, and why the check below refuses to leave a native package with no
 * binary at all rather than letting that surface as a crash loop.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * Docker's spelling of an architecture and Node's are different, and this script
 * is handed whichever the caller has: `TARGETARCH` in the Dockerfile, `process.arch`
 * when someone runs it by hand.
 */
const ARCHS = { amd64: 'x64', x64: 'x64', arm64: 'arm64', aarch64: 'arm64' }

function parse(argv) {
  let root = 'node_modules'
  let requested = process.arch
  for (const arg of argv) {
    const flag = /^--arch=(.*)$/.exec(arg)
    // An empty `--arch=` is what an unset build argument expands to; it means
    // "you decide", not "prune everything".
    if (flag) {
      if (flag[1] !== '') requested = flag[1]
      continue
    }
    root = arg
  }
  const arch = ARCHS[requested]
  if (arch === undefined) {
    throw new Error(`unknown --arch=${requested}; expected one of ${Object.keys(ARCHS).join(', ')}`)
  }
  return { root, arch }
}

const { root, arch } = parse(process.argv.slice(2))

/**
 * Platform tags this image can execute. Alpine is musl, and `linux-<arch>` stays
 * because `argon2` publishes no musl build and is loaded through the glibc one.
 */
const KEEP = new Set([`linux-${arch}`, `linuxmusl-${arch}`])

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

/**
 * Prunes one `prebuilds/` down to the platforms this image runs, in either layout.
 *
 * `pkg` is the package directory, needed only for the check afterwards: a prebuilds
 * directory left with nothing in it and no compiled fallback beside it means the
 * platform tag this script was given does not match the image, and saying so here
 * beats a container that exits on `require`.
 */
function prunePrebuilds(pkg, prebuilds) {
  for (const entry of readdirSync(prebuilds, { withFileTypes: true })) {
    const name = entry.isDirectory() ? entry.name : basename(entry.name, '.node')
    if (!entry.isDirectory() && !entry.name.endsWith('.node')) continue
    if (!KEEP.has(name)) drop(join(prebuilds, entry.name))
  }
  const left = readdirSync(prebuilds)
  const compiled = ['Release', 'Debug'].some((dir) => existsSync(join(pkg, 'build', dir)))
  if (left.length === 0 && !compiled) {
    throw new Error(
      `${prebuilds} has no binary left for linux-${arch} and ${pkg} has no compiled ` +
        `build/ either — the wrong --arch would make this container fail to start`,
    )
  }
}

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const path = join(dir, entry.name)

    if (entry.name === 'prebuilds') {
      prunePrebuilds(dir, path)
      continue
    }
    // Vendored C sources, kept only for a source build that has already happened
    // or was never needed. Gated on `binding.gyp` so this can only ever match a
    // native package — a JavaScript package has no build to have inputs for.
    if (entry.name === 'deps' && existsSync(join(dir, 'binding.gyp'))) {
      drop(path)
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
  `pruned ${removed.length} paths for linux-${arch}, ${(removedBytes / 1e6).toFixed(1)} MB\n` +
    removed.map((path) => `  - ${path}\n`).join(''),
)
