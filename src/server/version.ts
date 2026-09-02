/**
 * The running version, read once.
 *
 * Not `process.env.npm_package_version`: npm sets that only when the process was
 * started through an npm script, and the image runs `node dist/main.js` — so the
 * health endpoint answered `"version": null` in the container while looking
 * correct in development. package.json is copied next to `dist`, so read it.
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
