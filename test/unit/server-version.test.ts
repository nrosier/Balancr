/**
 * Build identity, and the three files that have to agree about it.
 *
 * This exists because of a real afternoon: a container reported version `0.5.0`
 * while the image digest that had just been pulled was provably built from
 * `0.5.4`. Nothing was wrong with either — the image was pulled and the container
 * was never recreated — but there was no line in the logs that said so, and
 * establishing it took reading manifest digests out of workflow logs.
 *
 * `BALANCR_REVISION` is the fragile half. It is read from the environment by
 * `version.ts`, set by the Dockerfile, and passed by `release.yml`, and if any one
 * of those three renames it the revision becomes `null` in every log line forever.
 * Nothing fails, nothing warns, and the next person to ask which commit is running
 * gets a silent shrug. So the name is asserted in all three places: this is not
 * testing that the environment variable works, it is testing that the three halves
 * still spell it the same way.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ENV_VAR = 'BALANCR_REVISION'

function repoFile(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')
}

/** Re-imports the module with the environment as given, since it resolves at import. */
async function importWith(revision: string | undefined): Promise<{ APP_REVISION: string | null }> {
  vi.resetModules()
  if (revision === undefined) delete process.env[ENV_VAR]
  else process.env[ENV_VAR] = revision
  return (await import('../../src/server/version.ts')) as { APP_REVISION: string | null }
}

afterEach(() => {
  delete process.env[ENV_VAR]
  vi.resetModules()
})

describe('APP_VERSION', () => {
  it('is the version in package.json', async () => {
    vi.resetModules()
    const { APP_VERSION } = await import('../../src/server/version.ts')
    const declared = (JSON.parse(repoFile('package.json')) as { version: string }).version
    expect(APP_VERSION).toBe(declared)
  })
})

describe('APP_REVISION', () => {
  it('is the commit when the image stamped one', async () => {
    const { APP_REVISION } = await importWith('31deb4959a6e4c0f')
    expect(APP_REVISION).toBe('31deb4959a6e4c0f')
  })

  it('is null outside a built image, where the working tree is the answer', async () => {
    const { APP_REVISION } = await importWith(undefined)
    expect(APP_REVISION).toBeNull()
  })

  it('is null rather than blank when the build argument went unset', async () => {
    // `ENV BALANCR_REVISION=${BALANCR_REVISION}` with no `--build-arg` sets the
    // empty string, not nothing — so an unstamped image must not log `revision: ""`.
    expect((await importWith('')).APP_REVISION).toBeNull()
    expect((await importWith('   ')).APP_REVISION).toBeNull()
  })

  it('trims, so a stray newline in a build argument does not reach the logs', async () => {
    expect((await importWith('  abc123\n')).APP_REVISION).toBe('abc123')
  })
})

describe('the revision stamp', () => {
  it('is read under the name the Dockerfile declares', () => {
    const dockerfile = repoFile('Dockerfile')
    expect(dockerfile).toContain(`ARG ${ENV_VAR}=""`)
    expect(dockerfile).toContain(`ENV ${ENV_VAR}=\${${ENV_VAR}}`)
    expect(repoFile('src/server/version.ts')).toContain(`process.env.${ENV_VAR}`)
  })

  it('is passed by the workflow that builds the image', () => {
    // If this fails the image still builds, and every log line reads
    // `"revision":null` — which is exactly the blind spot this file is here for.
    expect(repoFile('.github/workflows/release.yml')).toMatch(
      new RegExp(`build-args:[\\s\\S]{0,200}${ENV_VAR}=\\$\\{\\{ github\\.sha \\}\\}`),
    )
  })
})

describe('the startup log', () => {
  it('names the version and the revision before anything that can fail', () => {
    const main = repoFile('src/main.ts')
    const banner = main.indexOf("'balancr starting'")
    expect(banner).toBeGreaterThan(-1)
    expect(main.slice(0, banner)).toContain('version: APP_VERSION')
    expect(main.slice(0, banner)).toContain('revision: APP_REVISION')
    // The point of the line is that it survives a crash in startup, so it has to
    // come before the first step that can throw.
    expect(banner).toBeLessThan(main.indexOf('applyMigrations(db as never)'))
  })
})
