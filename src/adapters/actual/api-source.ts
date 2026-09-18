/**
 * Chooses the real `@actual-app/api` or its local-dev fake (#391), based on
 * `ACTUAL_FAKE_BACKEND`. Read directly from `process.env`, never through
 * `src/config.ts` — same rule `worker.ts` follows for every other Actual
 * connection detail: this is a dev-only escape hatch, not a tenant setting.
 *
 * `worker.ts` only calls `init`/`downloadBudget`/`getServerVersion`/
 * `getPreferences`/`sync`/`shutdown` on `api` by name (with real typing);
 * every other method goes through its own `Record<string, fn>` cast, so the
 * fake only needs to structurally satisfy those six.
 */
import * as real from '@actual-app/api'

// A plain string literal here would pull scripts/fake-backend/ into tsc's rootDir
// check for the production build (tsconfig.build.json's rootDir is 'src') even
// though this branch never runs there. Building the specifier keeps it dynamic
// enough that tsc treats the import as untyped instead of resolving the file.
const FAKE_API_MODULE = ['..', '..', '..', 'scripts', 'fake-backend', 'actual-fake-api.ts'].join('/')

export const api: typeof real =
  process.env.ACTUAL_FAKE_BACKEND === 'true'
    ? ((await import(FAKE_API_MODULE)) as unknown as typeof real)
    : real
