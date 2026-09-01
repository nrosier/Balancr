/**
 * A one-at-a-time queue.
 *
 * Needed because Actual's API is a local sync engine over a SQLite cache with
 * no documented concurrency guarantees, and in a single-process app the cron
 * pipeline and an operator pressing "Sync now" will overlap eventually. Rather
 * than hope, every Actual operation is funnelled through one of these.
 */
export interface Serialiser {
  <T>(fn: () => Promise<T>): Promise<T>
}

export function createSerialiser(): Serialiser {
  let tail: Promise<unknown> = Promise.resolve()

  return <T>(fn: () => Promise<T>): Promise<T> => {
    // `then(fn, fn)` on both branches on purpose: one failed operation must not
    // poison the queue for every later one.
    const run = tail.then(fn, fn)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
