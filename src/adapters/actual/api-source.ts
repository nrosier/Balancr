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
import * as fake from '../../../scripts/fake-backend/actual-fake-api.ts'

export const api: typeof real = process.env.ACTUAL_FAKE_BACKEND === 'true' ? (fake as unknown as typeof real) : real
