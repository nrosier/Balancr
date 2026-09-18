#!/usr/bin/env tsx
/**
 * `npm run fake:seed` — maps the fake dataset's categories to COICOP divisions and flags
 * a couple as custody-shared, so Benchmark and Custody render real content under
 * `ACTUAL_FAKE_BACKEND=true` instead of their "nothing mapped yet" empty states (#391's
 * own follow-up).
 *
 * Both features read Balancr's own `category_meta`/`settings` tables
 * (`src/domain/benchmark/mapping.ts`, `src/domain/benchmark/household.ts`) — nothing
 * Actual itself exposes — so faking the Actual data alone was never going to be enough.
 *
 * `category_meta` rows only exist once the sync job has run at least once (it upserts one
 * row per category it finds; `saveCoicop`/`saveCustodyShared` refuse to conjure one). Run
 * the app with `ACTUAL_FAKE_BACKEND=true` and either let its startup jobs finish or call
 * `POST /api/refresh` before running this script.
 */
import { db } from '../../src/db/index.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { saveHousehold } from '../../src/domain/benchmark/household.ts'
import { MappingError, saveCoicop, saveCustodyShared, type CoicopChoice } from '../../src/domain/benchmark/mapping.ts'
import {
  CAT_DINING,
  CAT_GROCERIES,
  CAT_RENT,
  CAT_SHOPPING,
  CAT_SUBSCRIPTIONS,
  CAT_TRANSPORT,
  CAT_UTILITIES,
} from './actual-data.ts'

/** Divisions per `config/benchmark/be.yaml`'s own `groups[].coicop` lists. */
const COICOP: Readonly<Record<string, CoicopChoice>> = {
  [CAT_RENT]: '04',
  [CAT_UTILITIES]: '04',
  [CAT_GROCERIES]: '01',
  [CAT_TRANSPORT]: '07',
  [CAT_DINING]: '11',
  [CAT_SUBSCRIPTIONS]: '09',
  [CAT_SHOPPING]: '03',
}

/** Utilities and subscriptions both carry real monthly spend, which is what makes the
 *  custody split worth looking at rather than a single tiny line. */
const CUSTODY_SHARED = [CAT_UTILITIES, CAT_SUBSCRIPTIONS]

for (const [categoryId, code] of Object.entries(COICOP)) {
  try {
    saveCoicop(db, categoryId, code)
  } catch (error) {
    if (error instanceof MappingError) {
      throw new Error(
        `${categoryId} has no category_meta row yet. Run the sync job first — start the app ` +
          'with ACTUAL_FAKE_BACKEND=true and JOBS_ENABLED=true, or POST /api/refresh once it is up.',
      )
    }
    throw error
  }
}

for (const categoryId of CUSTODY_SHARED) {
  saveCustodyShared(db, categoryId, true)
}

// sharedCostBp overrides the roster-derived share (custody.ts), so no household member
// is needed to get a real split — the flagged categories alone would otherwise read
// `no_basis` instead of `no_shared`.
const tenantId = getSoleTenantId(db)
saveHousehold(db, tenantId, { sharedCostBp: 5000, sharedCostDirection: 'whole_invoice' })

console.log(
  `Mapped ${Object.keys(COICOP).length} categories to COICOP divisions, flagged ` +
    `${CUSTODY_SHARED.length} as custody-shared, and set a 50% household split.`,
)
