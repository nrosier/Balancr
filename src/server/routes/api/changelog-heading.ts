/**
 * The exact format `changelog.ts`'s parser requires for CHANGELOG.md's version
 * headings — its own leaf module, with no other imports, so
 * `scripts/check-changelog.ts` can import it without pulling in `schemas.ts`'s
 * whole chain (and, through it, config validation that expects a running
 * server's `.env`).
 */
export const HEADING = /^## \[(\d+\.\d+\.\d+)\] — (\d{4}-\d{2}-\d{2})$/
