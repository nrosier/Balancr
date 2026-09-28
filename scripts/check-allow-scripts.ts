/**
 * Fails the build when a dependency's install/preinstall/postinstall script
 * isn't covered by `allowScripts` in package.json.
 *
 * npm 12.1.0+ denies lifecycle scripts by default unless the exact
 * `name@version` is allowlisted there — which is exactly the safety property
 * we want, but it fails *open*: an allowlist gap silently skips the script
 * (no error, no missing native binary until something calls it at runtime)
 * instead of failing the build where the gap was introduced (#720).
 *
 * `package-lock.json` already carries the authoritative answer to "which
 * packages actually have a lifecycle script" — npm itself stamps
 * `hasInstallScript: true` on every tree entry that has one (including the
 * implicit `node-gyp rebuild` a `binding.gyp` triggers with no explicit
 * `install` script, e.g. fsevents). Reading that instead of re-deriving it
 * from `node_modules` means this check agrees with npm's own install
 * behaviour by construction, not by re-implementing it.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

interface LockPackage {
  version?: string
  hasInstallScript?: boolean
}

interface PackageLock {
  packages?: Record<string, LockPackage>
}

interface PackageJson {
  allowScripts?: Record<string, boolean>
}

// A lockfile path is one or more `node_modules/<name>` segments (`<name>` is
// two segments for a scoped package) — nesting is how npm resolves conflicting
// versions, but `allowScripts` keys by `name@version` regardless of where in
// the tree it sits, so only the last segment matters here.
function packageNameFromPath(path: string): string | undefined {
  return path.split('node_modules/').filter(Boolean).pop()
}

const lock: PackageLock = JSON.parse(readFileSync(`${root}/package-lock.json`, 'utf8'))
const pkg: PackageJson = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'))
const allowScripts = pkg.allowScripts ?? {}

const required = new Set<string>()
for (const [path, info] of Object.entries(lock.packages ?? {})) {
  if (!info.hasInstallScript || info.version === undefined) continue
  const name = packageNameFromPath(path)
  if (name === undefined) continue
  required.add(`${name}@${info.version}`)
}

const missing = [...required].filter((key) => !(key in allowScripts)).sort()

if (missing.length > 0) {
  console.error(
    `allow-scripts check failed — ${String(missing.length)} package(s) run a lifecycle ` +
      "script but aren't in package.json's allowScripts:\n",
  )
  for (const key of missing) console.error(`  ${key}`)
  console.error(
    '\nAdd each as `"<name>@<version>": true` under allowScripts once the script is ' +
      'reviewed, or the install will keep silently skipping it.',
  )
  process.exit(1)
}

console.log(
  `allow-scripts ok — ${String(required.size)} package(s) with a lifecycle script, ` +
    'all covered by allowScripts',
)
