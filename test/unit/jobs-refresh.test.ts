/**
 * Starting a job because someone asked.
 *
 * Three claims, and none of them is "it runs the job" — the runner has its own suite
 * for that. What can only be tested here:
 *
 *  - **The expansion is complete and ordered.** A refresh of `portfolio` that forgot
 *    `networth` would leave a page whose halves disagree, and one that ran `signals`
 *    before `sync` would judge the facts that were about to be replaced. Both are
 *    silent: every job reports success and the numbers are wrong.
 *  - **The claim is the in-flight set, not the `jobs` table.** A row left saying
 *    `running` by a killed process must not refuse every refresh for the lifetime of
 *    the next one, and that is a property of which authority is consulted.
 *  - **The names match the registry.** `REFRESHABLE` is written out rather than
 *    derived, so the test that it has not drifted is the thing keeping it honest.
 *  - **The browser's copies match it too.** Two files under `web/` list job names, and
 *    they list them rather than importing them on purpose: importing this module would
 *    pull the runner, the schema, the configuration and the logger into a bundle that
 *    only needed seven strings. The cost of that choice is that a rename can land in one
 *    place, and the last two tests in this file are what makes it not silent.
 */
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { jobs as jobsTable } from '../../src/db/schema.ts'
import { registry } from '../../src/jobs/index.ts'
import { DATA_JOBS } from '../../src/server/routes/api/freshness.ts'
import { DEFAULT_REFRESH, expand, REFRESHABLE, startRefresh } from '../../src/jobs/refresh.ts'
import { jobsInFlight, loadJobRows, type Job } from '../../src/jobs/runner.ts'

let ctx: ReturnType<typeof createTestDb>

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
})

/**
 * A job that records that it ran, and optionally waits for permission to finish.
 *
 * The real registry's `sync` dials Actual and `portfolio` dials Ghostfolio, so every
 * test here uses fakes — which is the reason `startRefresh` takes the registry as an
 * argument instead of importing it.
 */
function fake(name: string, ran: string[], gate?: Promise<void>): Job {
  return {
    name,
    schedule: { kind: 'interval', minutes: 60 },
    run: async () => {
      ran.push(name)
      if (gate !== undefined) await gate
    },
  }
}

const fakes = (ran: string[], gate?: Promise<void>): Job[] =>
  REFRESHABLE.map((name) => fake(name, ran, gate))

/** Waits for the queue to drain. The in-flight set is what a refresh claims. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 200 && jobsInFlight().length > 0; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  if (jobsInFlight().length > 0) throw new Error(`still running: ${jobsInFlight().join(', ')}`)
}

describe('REFRESHABLE', () => {
  it('is the registry, in the registry order', () => {
    // Both directions on purpose. A job added to the registry and not here would be
    // unreachable by hand with nothing saying so; a name left here after a job was
    // removed would answer 202 and run nothing. The order is the dependency order.
    expect([...REFRESHABLE]).toEqual(registry.map((job) => job.name))
  })

  it('leaves the job that costs money out of the default', () => {
    // The fence around `ai` is the endpoint, not the list — but the ordinary button
    // sends `DEFAULT_REFRESH`, so this is what keeps that button free.
    expect(DEFAULT_REFRESH).not.toContain('ai')
    expect([...DEFAULT_REFRESH]).toEqual(['sync', 'portfolio', 'networth', 'signals'])
  })
})

describe('expand', () => {
  it('adds what reads the output of the job that was asked for', () => {
    expect(expand(['portfolio'])).toEqual(['portfolio', 'networth', 'signals'])
    expect(expand(['sync'])).toEqual(['sync', 'networth', 'signals'])
  })

  it('is transitive', () => {
    // `sync` pulls in `networth`, which pulls in `signals`. Named one hop at a time
    // this would stop after two, and the insights page would show findings computed
    // from the previous net worth.
    expect(expand(['sync'])).toContain('signals')
  })

  it('returns the registry order rather than the caller order', () => {
    expect(expand(['signals', 'sync'])).toEqual(['sync', 'networth', 'signals'])
  })

  it('does not repeat a job two callers both depend on', () => {
    expect(expand(['sync', 'portfolio'])).toEqual(['sync', 'portfolio', 'networth', 'signals'])
  })

  it('leaves a job with no dependents alone', () => {
    expect(expand(['probe'])).toEqual(['probe'])
    expect(expand(['backfill'])).toEqual(['backfill'])
  })

  it('never pulls in the job that spends money', () => {
    // The one edge deliberately missing from the map: `ai` does read what `signals`
    // writes, and adding that edge would put a Gemini call behind the free button.
    for (const name of REFRESHABLE) {
      if (name === 'ai') continue
      expect(expand([name])).not.toContain('ai')
    }
  })
})

describe('startRefresh', () => {
  it('runs the expanded set, in order, and says which was asked for', async () => {
    const ran: string[] = []
    const outcome = startRefresh(ctx.db, fakes(ran), ['portfolio'])

    expect(outcome).toMatchObject({
      accepted: ['portfolio', 'networth', 'signals'],
      requested: ['portfolio'],
    })
    await settle()
    expect(ran).toEqual(['portfolio', 'networth', 'signals'])
  })

  it('returns before the jobs have run', () => {
    // The whole point of the 202: awaiting `downloadBudget` against an Actual with no
    // timeout guarantee would tie a user-facing request to it.
    const ran: string[] = []
    startRefresh(ctx.db, fakes(ran), ['sync'])
    expect(ran).toEqual([])
  })

  it('refuses while the pipeline is busy, naming what is running', async () => {
    let open = (): void => {}
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const ran: string[] = []
    startRefresh(ctx.db, fakes(ran, gate), ['sync'])

    const second = startRefresh(ctx.db, fakes(ran), ['portfolio'])
    expect(second).toEqual({ busy: ['sync', 'networth', 'signals'] })

    open()
    await settle()
  })

  it('refuses two refreshes arriving in the same tick', () => {
    // Nothing is awaited between these two calls, which is the case a check against
    // the database could not refuse: neither request has written a row yet.
    const ran: string[] = []
    const first = startRefresh(ctx.db, fakes(ran), ['probe'])
    const second = startRefresh(ctx.db, fakes(ran), ['probe'])
    expect(first).not.toHaveProperty('busy')
    expect(second).toHaveProperty('busy')
  })

  it('is not blocked by a row a killed process left saying running', async () => {
    // The failure this prevents: a container killed mid-sync leaves `status: running`
    // in a table nothing will ever correct, and a refresh gated on that row is
    // refused for ever — on exactly the instance whose figures are now stalest.
    ctx.db
      .insert(jobsTable)
      .values({ name: 'sync', status: 'running', lastRunAt: new Date() })
      .run()

    const ran: string[] = []
    const outcome = startRefresh(ctx.db, fakes(ran), ['sync'])
    expect(outcome).not.toHaveProperty('busy')
    await settle()
    expect(ran).toContain('sync')
  })

  it('releases the claim after a job fails', async () => {
    // A claim released only on the success path would refuse every later refresh from
    // the moment Ghostfolio first timed out.
    const failing: Job[] = [
      {
        name: 'sync',
        schedule: { kind: 'interval', minutes: 60 },
        run: async () => {
          throw new Error('ECONNREFUSED actual:5006')
        },
      },
    ]
    startRefresh(ctx.db, failing, ['sync'])
    await settle()

    expect(jobsInFlight()).toEqual([])
    expect(startRefresh(ctx.db, failing, ['sync'])).not.toHaveProperty('busy')
    await settle()
  })

  it('drops a name the registry has not got rather than stopping the chain', async () => {
    // A rename that lands in one place and not the other should cost one job, not the
    // three after it.
    const ran: string[] = []
    const partial = [fake('networth', ran), fake('signals', ran)]
    const outcome = startRefresh(ctx.db, partial, ['sync'])

    expect(outcome).toMatchObject({ accepted: ['sync', 'networth', 'signals'] })
    await settle()
    expect(ran).toEqual(['networth', 'signals'])
  })

  it('records the attempt in the jobs table, so the freshness block moves', async () => {
    const ran: string[] = []
    startRefresh(ctx.db, fakes(ran), ['probe'])
    await settle()

    const row = loadJobRows(ctx.db).find((candidate) => candidate.name === 'probe')
    expect(row).toMatchObject({ status: 'ok' })
    expect(row?.lastSuccessAt).not.toBeNull()
  })

  it('reports the instant the caller can compare a job row against', async () => {
    const ran: string[] = []
    const outcome = startRefresh(ctx.db, fakes(ran), ['probe'])
    if ('busy' in outcome) throw new Error('the refresh was refused')
    await settle()

    const row = loadJobRows(ctx.db).find((candidate) => candidate.name === 'probe')
    // The client stops polling when `lastRunAt >= startedAt`. Millisecond precision on
    // both sides is what makes that comparison mean "my refresh", not "some refresh".
    expect(row?.lastRunAt?.getTime()).toBeGreaterThanOrEqual(outcome.startedAt.getTime())
  })
})

/**
 * A string-array constant, read out of a source file rather than imported.
 *
 * Deliberately crude: it matches the literal, not the module's meaning. That is the
 * point — a copy that has been turned into something cleverer than a list of quoted
 * names is no longer the copy this test was written to check, so failing to parse it is
 * the correct outcome and the message says which file to look at.
 */
function mirrored(file: string, name: string): string[] {
  const match = new RegExp(`const ${name}[^=]*= \\[([^\\]]*)\\]`).exec(readFileSync(file, 'utf8'))
  const body = match?.[1]
  if (body === undefined) throw new Error(`${name} is no longer an array literal in ${file}`)
  return [...body.matchAll(/'([^']+)'/g)].flatMap((quoted) => quoted[1] ?? [])
}

describe('the copies of these names in the browser bundle', () => {
  it('offers every job the endpoint accepts, and not the one it refuses', () => {
    // The settings panel puts a "Run now" beside a job only if this build believes
    // `POST /api/refresh` will take it. A name missing here is a job nobody can start by
    // hand; a name too many is a button that answers 400. `ai` has its own control, on
    // the panel that shows what a run costs.
    expect(mirrored('web/src/settings/Status.tsx', 'REFRESHABLE')).toEqual(
      REFRESHABLE.filter((name) => name !== 'ai'),
    )
  })

  it('warns about the same jobs the freshness block is computed from', () => {
    // `Freshness.tsx` decides whether to say "a job is failing" from this list. Drifted,
    // it would go quiet about exactly the job whose failure made the figures wrong.
    expect(mirrored('web/src/ui/Freshness.tsx', 'DATA_JOBS')).toEqual([...DATA_JOBS])
  })
})

/** Typing the fixture, so an unused import cannot make the file look tested. */
const _typecheck: (db: Db) => void = () => {}
void _typecheck
