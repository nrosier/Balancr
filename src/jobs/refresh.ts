/**
 * Running a job because someone asked, rather than because a schedule came round.
 *
 * Every read endpoint serves Balancr's own SQLite and never calls an upstream, and
 * every response says how old the figures are. That is the right trade — a broken
 * Ghostfolio cannot become a broken page — but on its own it leaves the reader with
 * a page that says "two days old, `sync` failed" and nothing to do about it but wait
 * for tonight. This module is the other half: the loop that the freshness block
 * opens gets a way to close.
 *
 * Four rules, each with the failure it exists to prevent.
 *
 * **A refresh starts a job; it never waits for one.** The caller gets `202` and
 * watches the freshness block. Awaiting the run would tie a user-facing HTTP request
 * to `downloadBudget` against an Actual instance with no timeout guarantees, which
 * is precisely the coupling the read API was built to avoid — a refresh that hung
 * would take the request with it.
 *
 * **Dependents run automatically.** Refreshing `portfolio` alone would leave net
 * worth and the signals computed from the previous numbers: a page that is *partly*
 * fresh, which is worse to present than one that is uniformly old, because nothing
 * on it says which half is which. The dependents are the two jobs that call no
 * upstream at all — they recompute from stored facts — so running them costs CPU and
 * nothing else, and the alternative is asking whoever clicked to understand the
 * dependency graph.
 *
 * **One refresh at a time, and the refusal is honest about why.** Everything already
 * shares one queue because Actual's API is a local sync engine over a SQLite cache;
 * a second refresh could be queued safely, but a request that returns `202` and then
 * sits behind four jobs has told the caller something untrue. So a busy pipeline is
 * a `409`. What counts as busy is `jobsInFlight()` and not the `jobs` table — see
 * that function for why a `running` row is the wrong authority.
 *
 * **Nothing here can write to a source.** It runs jobs, and no job writes to Actual
 * or Ghostfolio; for Actual that is enforced by the denylist test over the adapter's
 * exports rather than by this comment.
 */
import type { Db } from '../db/index.ts'
import { logger } from '../logger.ts'
import { jobsInFlight, runJob, type Job } from './runner.ts'

const log = logger.child({ module: 'jobs.refresh' })

/**
 * What a refresh may name, **in the order the jobs must run**.
 *
 * The order is the registry's, and that is the point of writing it out: it is the
 * dependency order, and since the queue runs whatever it is handed in the order it is
 * handed it, `signals` before `sync` would judge the facts that were about to be
 * replaced. There is a test that these are the registry's names in the registry's
 * order, so a reordering there fails here rather than silently producing findings from
 * the previous pass.
 *
 * Kept as its own list rather than derived from `registry`, and this module imports
 * nothing from `index.ts` at all: the registry is handed to `startRefresh` the same
 * way it is handed to `createScheduler`. That keeps the barrel free to re-export this
 * module without a cycle, and it is what lets a test drive the routes with jobs that
 * do not dial Actual.
 *
 * Every job is nameable, `ai` included, and the fence around the one that spends money
 * is not this list — it is the door. `ai` is reachable only through
 * `POST /api/ai/refresh`, which is owner-only, sits in the strict AI rate-limit bucket
 * and is priced before it is pressed; `POST /api/refresh` refuses the name outright.
 * Naming it here anyway is what lets both doors share one implementation of "a job
 * someone started by hand" — the same claim, the same audit entry, the same `202` —
 * rather than the money one having a second copy that can drift from it.
 *
 * What keeps the ordinary button free is `DEFAULT_REFRESH`, below.
 */
export const REFRESHABLE = [
  'probe',
  'sync',
  'portfolio',
  'networth',
  'backfill',
  'signals',
  'ai',
] as const

export type Refreshable = (typeof REFRESHABLE)[number]

/**
 * What "refresh" with nothing named means: the four jobs the figures depend on.
 *
 * The same four as `DATA_JOBS` in the freshness block, and deliberately so — the
 * button exists to answer the sentence that block prints, so it should refresh
 * exactly what that block reports on.
 *
 * `backfill` is out because everything it writes is for a settled month in the past:
 * its output makes the charts longer, never more correct, and it is the one job that
 * makes a call per account per month, so putting it behind the obvious button would
 * turn a click into minutes of upstream traffic. `probe` is out because it writes no
 * fact any page reads. Both stay nameable, which is what the buttons on the status
 * panel use.
 */
export const DEFAULT_REFRESH = ['sync', 'portfolio', 'networth', 'signals'] as const

/**
 * What else has to run for the answer to be consistent.
 *
 * Keyed by the job asked for, listing what reads its output. `signals` reads the
 * facts `sync` writes and the snapshot `networth` writes; `networth` reads the
 * account values that both `sync` and `portfolio` produce. Neither calls an upstream,
 * which is what makes running them unconditionally cheap enough to be the default.
 *
 * `backfill` has no dependents: every row it writes is for a month-end in the past,
 * and no job reads those — the charts do, directly. `probe` has none either; it is a
 * diagnosis, not an input.
 *
 * **`ai` is nobody's dependent, and that edge is missing on purpose.** It genuinely
 * does read what `signals` writes, so by the logic of this map it belongs under it —
 * and putting it there would make every refresh of the budget page place a Gemini call
 * that nobody asked for and nothing priced. The findings the insights page shows are
 * the deterministic ones either way; the model's reading of them is a night old and
 * says so.
 */
const DEPENDENTS: Readonly<Record<Refreshable, readonly Refreshable[]>> = {
  probe: [],
  sync: ['networth', 'signals'],
  portfolio: ['networth', 'signals'],
  networth: ['signals'],
  backfill: [],
  signals: [],
  ai: [],
}

/**
 * The jobs that will actually run: what was asked for, plus what reads its output,
 * in dependency order rather than the caller's. See `REFRESHABLE`.
 */
export function expand(asked: readonly Refreshable[]): Refreshable[] {
  const wanted = new Set<Refreshable>()

  // Transitively rather than one hop: an edge added to the map later must not leave a
  // job out because its dependent's dependent happened not to be named. The set is
  // also the cycle guard, so a graph that gains one loops nowhere.
  const add = (name: Refreshable): void => {
    if (wanted.has(name)) return
    wanted.add(name)
    for (const dependent of DEPENDENTS[name]) add(dependent)
  }
  for (const name of asked) add(name)

  return REFRESHABLE.filter((name) => wanted.has(name))
}

export interface RefreshStarted {
  /** The expanded set, in the order it will run. */
  accepted: Refreshable[]
  /** What the caller named, before dependents were added. */
  requested: Refreshable[]
  startedAt: Date
}

/** Why a refresh was refused. Only ever a busy pipeline; an unknown name is a 400. */
export interface RefreshBusy {
  busy: readonly string[]
}

/**
 * Claims the pipeline and starts the jobs, or reports what is already running.
 *
 * Synchronous up to and including the claim, and that is load-bearing: `runJob` adds
 * to the in-flight set before it touches the queue, so two requests in the same tick
 * cannot both pass the check. Everything after the claim is deliberately not awaited
 * — see the header.
 *
 * Every job is handed over in that same tick, rather than the next being started when
 * the previous one resolves. Both orders run identically — `runJob` funnels through one
 * serial queue — but only this one claims the whole chain at once. Awaiting between two
 * jobs would leave the in-flight set momentarily empty, and a second refresh arriving in
 * that window is accepted and interleaved with the first: `signals` then judges facts
 * `sync` is halfway through replacing, both jobs report success, and the findings are
 * wrong with nothing on the page saying so.
 *
 * All of them are stamped with one instant, which is the same convention the nightly
 * pass follows — `runDueJobs` gives every job the tick's `now`. The row itself is not
 * written until the job reaches the front of the queue, so a client polling the
 * freshness block still sees a queued job carrying its previous `lastRunAt`.
 *
 * A job never rejects (the runner catches and records), so this needs no `catch` — but
 * it gets one anyway, because a bug in the runner itself must not become an unhandled
 * rejection that takes the process down and leaves the whole dashboard stale.
 */
export function startRefresh(
  db: Db,
  registry: readonly Job[],
  asked: readonly Refreshable[],
  now = new Date(),
): RefreshStarted | RefreshBusy {
  const busy = jobsInFlight()
  if (busy.length > 0) return { busy }

  const accepted = expand(asked)
  const running = accepted.flatMap((name) => {
    const job = registry.find((candidate) => candidate.name === name)
    // Cannot happen against the real registry — `REFRESHABLE` matches it, and there is
    // a test that says so — but it can against the fakes a test builds. Dropping rather
    // than throwing keeps a name that has gone from stopping the jobs after it.
    if (job === undefined) log.warn({ job: name }, 'refresh named a job the registry has not got')
    return job === undefined ? [] : [job]
  })

  void Promise.all(running.map((job) => runJob(db, job, now))).catch((error: unknown) => {
    log.error({ err: error }, 'the refresh chain failed outside a job')
  })

  log.info({ accepted, requested: [...asked] }, 'refresh started')
  return { accepted, requested: [...asked], startedAt: now }
}
