/**
 * The runtime prune, tested against a fixture `node_modules`.
 *
 * `scripts/prune-runtime-deps.mjs` deletes native binaries out of the image, which
 * gives it two ways to be wrong and only one of them is loud. Deleting too much means
 * the container cannot `require` its database driver and never starts. Deleting too
 * little is silent: up to #39 the script handled `prebuilds/<platform>-<arch>/`
 * directories and not flat `prebuilds/<platform>-<arch>.node` files, so every image
 * shipped all eight of better-sqlite3's platform binaries — 17 MB, seven of which no
 * Linux host can load — and nothing anywhere said so.
 *
 * A fixture tree rather than the real `node_modules`, because the test needs to assert
 * what was deleted, and it runs the script as a subprocess because the Dockerfile does.
 */
import { execFileSync } from 'node:child_process'
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../../scripts/prune-runtime-deps.mjs', import.meta.url))

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function write(path: string, body = 'x'): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

/**
 * A `node_modules` with both prebuild layouts in it, as the real one has:
 * `better-sqlite3` ships flat `.node` files, `argon2` ships directories.
 */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'balancr-prune-'))
  dirs.push(root)
  const modules = join(root, 'node_modules')

  const flat = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'linuxmusl-arm64',
    'linuxmusl-x64', 'win32-arm64', 'win32-x64']
  for (const tag of flat) write(join(modules, 'better-sqlite3/prebuilds', `${tag}.node`))
  write(join(modules, 'better-sqlite3/binding.gyp'))
  write(join(modules, 'better-sqlite3/deps/sqlite3/sqlite3.c'))
  write(join(modules, 'better-sqlite3/lib/index.js'))
  write(join(modules, 'better-sqlite3/src/better_sqlite3.cpp'))

  for (const tag of ['darwin-arm64', 'linux-arm64', 'linux-x64', 'win32-x64']) {
    write(join(modules, 'argon2/prebuilds', tag, 'argon2.node'))
  }
  write(join(modules, '@typescript/typescript-linux-x64/lib/tsgo'))
  write(join(modules, 'zod/index.js'))
  return modules
}

/**
 * `stdio` spelled out because `execFileSync` inherits stderr by default, and three of
 * these cases are supposed to fail — the run would print stack traces that are the test
 * passing. Piped stderr still reaches the thrown error's message, which is what the
 * failure cases assert on.
 */
const options: ExecFileSyncOptionsWithStringEncoding = {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}

function prune(modules: string, arch: string): string {
  return execFileSync('node', [script, modules, `--arch=${arch}`], options)
}

describe('foreign prebuilds', () => {
  it('keeps only the two Linux tags for the target arch, in flat layout', () => {
    const modules = fixture()
    prune(modules, 'amd64')
    expect(readdirSync(join(modules, 'better-sqlite3/prebuilds')).sort()).toEqual([
      'linux-x64.node',
      'linuxmusl-x64.node',
    ])
  })

  it('keeps the arm64 pair when that is the target, so the same script builds both', () => {
    const modules = fixture()
    prune(modules, 'arm64')
    expect(readdirSync(join(modules, 'better-sqlite3/prebuilds')).sort()).toEqual([
      'linux-arm64.node',
      'linuxmusl-arm64.node',
    ])
  })

  it('still prunes the directory layout, which is what argon2 ships', () => {
    const modules = fixture()
    prune(modules, 'amd64')
    // No `linuxmusl-x64` here: argon2 publishes no musl build and Alpine loads the
    // glibc one, which is the whole reason `linux-<arch>` is kept as well.
    expect(readdirSync(join(modules, 'argon2/prebuilds'))).toEqual(['linux-x64'])
  })

  it('reports the target arch and the bytes it removed', () => {
    const output = prune(fixture(), 'amd64')
    expect(output).toContain('for linux-x64')
    expect(output).toMatch(/pruned \d+ paths/)
  })
})

describe('what it must not touch', () => {
  it('leaves a package’s JavaScript alone', () => {
    const modules = fixture()
    prune(modules, 'amd64')
    expect(existsSync(join(modules, 'better-sqlite3/lib/index.js'))).toBe(true)
    expect(existsSync(join(modules, 'zod/index.js'))).toBe(true)
  })

  it('removes the vendored C sources only where there is a binding.gyp', () => {
    const modules = fixture()
    // A JavaScript package with a `deps/` directory of its own has no build to have
    // inputs for, so the rule must not reach it.
    write(join(modules, 'zod/deps/data.js'))
    prune(modules, 'amd64')
    expect(existsSync(join(modules, 'better-sqlite3/deps'))).toBe(false)
    expect(existsSync(join(modules, 'zod/deps/data.js'))).toBe(true)
  })

  it('takes the Go compiler with it, which --omit=dev does not', () => {
    const modules = fixture()
    prune(modules, 'amd64')
    expect(existsSync(join(modules, '@typescript/typescript-linux-x64'))).toBe(false)
  })
})

describe('refusing to leave a native package without a binary', () => {
  /**
   * The failure mode worth a hard error: an arch that matches nothing prunes every
   * binary, and the only symptom would be a container that exits on `require` long
   * after the build was declared green.
   */
  it('fails the build when nothing is left and nothing was compiled', () => {
    const modules = fixture()
    rmSync(join(modules, 'better-sqlite3/prebuilds/linux-x64.node'))
    rmSync(join(modules, 'better-sqlite3/prebuilds/linuxmusl-x64.node'))
    expect(() => prune(modules, 'amd64')).toThrow(/no binary left for linux-x64/)
  })

  it('accepts an empty prebuilds directory when the package was compiled from source', () => {
    const modules = fixture()
    rmSync(join(modules, 'better-sqlite3/prebuilds/linux-x64.node'))
    rmSync(join(modules, 'better-sqlite3/prebuilds/linuxmusl-x64.node'))
    write(join(modules, 'better-sqlite3/build/Release/better_sqlite3.node'))
    expect(() => prune(modules, 'amd64')).not.toThrow()
  })

  it('rejects an architecture it does not know rather than guessing', () => {
    expect(() => prune(fixture(), 'ppc64le')).toThrow(/unknown --arch/)
  })

  it('treats an unset build argument as "use this host"', () => {
    // `--arch=` is what `--arch=$TARGETARCH` expands to if the variable is missing.
    // Pruning everything would be the worst possible reading of it.
    const modules = fixture()
    const output = execFileSync('node', [script, modules, '--arch='], options)
    expect(output).toContain(`for linux-${process.arch}`)
  })
})
