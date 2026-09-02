/**
 * Build identity: which version, and which commit, this process is.
 *
 * Both are here rather than in `config.ts` because neither is configuration. A
 * deployer sets `config`; these two are stamped by the build, and neither may
 * ever be able to fail startup — refusing to boot because a build label is
 * malformed would be worse than booting without one.
 *
 * Version is not `process.env.npm_package_version`: npm sets that only when the
 * process was started through an npm script, and the image runs `node
 * dist/main.js` — so the health endpoint answered `"version": null` in the
 * container while looking correct in development. package.json is copied next to
 * `dist`, so read it.
 */
import { readFileSync } from 'node:fs'
import { logger } from '../logger.ts'

const log = logger.child({ module: 'server.version' })

function read(): string | null {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    return (JSON.parse(raw) as { version?: string }).version ?? null
  } catch (error) {
    log.warn({ err: error }, 'could not read package.json for the version')
    return null
  }
}

/** Resolved at import: the file cannot change under a running process. */
export const APP_VERSION = read()

/**
 * The commit the image was built from, or null outside a built image.
 *
 * The version alone does not identify a build. Every push to main publishes
 * `edge` from the same package.json as the last tag, so `0.5.4` names two
 * different images — the released one and however many `edge` builds followed
 * it. When the question is "is the running container the code I just merged",
 * the version cannot answer and the commit can.
 *
 * Set by the Dockerfile from a build argument; absent in development, where the
 * working tree is the answer.
 */
export const APP_REVISION = process.env.BALANCR_REVISION?.trim() || null
