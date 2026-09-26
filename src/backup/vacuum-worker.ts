/**
 * `VACUUM INTO`, run as a forked child process so it cannot stall the server (#608).
 *
 * better-sqlite3 has no async variant of a statement — every call, `VACUUM INTO`
 * included, runs synchronously on whichever thread issues it. Run on the main
 * database connection, a multi-hundred-megabyte vacuum holds Node's single event
 * loop for as long as it takes to copy the file, stalling every in-flight HTTP
 * request for the duration — the same failure `crypto.ts`'s `deriveKey` avoids by
 * wrapping `scrypt` instead of calling `scryptSync`. There is no such wrapper for
 * `VACUUM INTO`, so the call itself has to move, not just await around it.
 *
 * A forked process rather than a worker thread, to match `adapters/actual/worker.ts`
 * — the one existing precedent in this codebase for isolating a blocking call — and
 * because the source connection this opens is a second, independent one to the same
 * file. WAL mode is what makes that safe: `snapshot.ts`'s header already establishes
 * that a read transaction against the live database blocks nothing, and a fresh
 * connection from another process is exactly what WAL mode exists to allow.
 *
 * Invoked with the source path and destination path as argv rather than over IPC:
 * this does one thing and exits, so there is nothing a persistent message channel
 * would buy over `fork`'s own exit code.
 */
import Database from 'better-sqlite3'

const [dbPath, plainPath] = process.argv.slice(2)

if (dbPath === undefined || plainPath === undefined) {
  console.error('vacuum-worker: expected <dbPath> <plainPath>')
  process.exit(1)
}

try {
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    sqlite.prepare('VACUUM INTO ?').run(plainPath)
  } finally {
    sqlite.close()
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
