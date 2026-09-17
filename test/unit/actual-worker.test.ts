/**
 * `worker.ts`'s `handleRequest` — the forked-process side of Actual, driven
 * in-process here rather than through a real fork (see the file's own header
 * comment for why it exports `handleRequest` separately from the
 * `process.on('message', ...)` loop).
 *
 * Three concerns share this file because they share one call:
 *  - opening: how Actual is asked to log (#123), and what Balancr says when
 *    the E2E password is the problem — worded for the settings form now,
 *    not for a `.env` variable, since this process is fed an already-resolved
 *    `ActualOpenConfig` rather than reading `.env` itself.
 *  - the `call`/`batch` dispatch, and `ALLOWED_METHODS` as the actual
 *    enforcement point for the read-only boundary once a bare method name
 *    crosses IPC (`test/unit/actual-adapter.test.ts`'s denylist test covers
 *    the same boundary from the source-scanning side).
 *  - `sync`/`shutdown`, and the unsolicited health push after a successful
 *    open.
 *
 * `@actual-app/api` is mocked here rather than in `actual-adapter.test.ts`,
 * which asserts the *real* package still exposes the methods this worker
 * calls — those two intentions cannot share a file, because `vi.mock`
 * applies to all of it. `aqlQuery` is deliberately left out of the mock even
 * though it is allowlisted, to exercise the "allowlisted but not a function
 * on this build of the package" branch.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActualOpenConfig, ActualResponse } from '../../src/adapters/actual/protocol.ts'

/** The `{id, ok, ...}` shape every request but `open`'s unsolicited push replies with. */
type Reply = Extract<ActualResponse, { id: number }>

const init = vi.fn<(config: Record<string, unknown>) => Promise<void>>()
const downloadBudget = vi.fn<(syncId: string, options?: { password?: string }) => Promise<void>>()
const sync = vi.fn<() => Promise<void>>()
const shutdown = vi.fn<() => Promise<void>>()
const getServerVersion = vi.fn<() => Promise<{ version: string } | { error: string }>>()
const getPreferences = vi.fn<() => Promise<{ budgetType: string; defaultCurrencyCode: string }>>()
const getAccountBalance = vi.fn<(id: string) => Promise<number>>()
const getSchedules = vi.fn<() => Promise<unknown[]>>()

vi.mock('@actual-app/api', () => ({
  init: (config: Record<string, unknown>) => init(config),
  downloadBudget: (syncId: string, options?: { password?: string }) =>
    downloadBudget(syncId, options),
  sync: () => sync(),
  shutdown: () => shutdown(),
  getServerVersion: () => getServerVersion(),
  getPreferences: () => getPreferences(),
  getAccountBalance: (id: string) => getAccountBalance(id),
  getSchedules: () => getSchedules(),
  // Present but `undefined`, not omitted — see the file header for why this
  // one method is deliberately not a function. Omitting the key outright
  // makes Vitest's mock proxy throw its own "no export defined" error on
  // access, which is a different failure than the one this file means to
  // exercise (`runCall`'s own `typeof fn !== 'function'` check).
  aqlQuery: undefined,
}))

/** An error shaped the way Actual's own errors are: a message plus a `code`. */
function actualError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

async function baseConfig(): Promise<ActualOpenConfig> {
  return {
    serverUrl: 'https://actual.example.com',
    password: 'server-password',
    dataDir: await mkdtemp(join(tmpdir(), 'balancr-worker-')),
    syncId: 'test-sync-id',
    e2ePassword: null,
    logLevel: 'info',
    baseCurrency: 'EUR',
  }
}

/**
 * A fresh `worker.ts` module instance, so `opened`/`health` never leak
 * between tests.
 */
async function freshWorker(): Promise<typeof import('../../src/adapters/actual/worker.ts')> {
  vi.resetModules()
  return await import('../../src/adapters/actual/worker.ts')
}

/** Opens a fresh worker and returns its reply plus whatever it pushed via `send`. */
async function open(
  config: ActualOpenConfig,
): Promise<{ response: Reply; sent: ActualResponse[] }> {
  const { handleRequest } = await freshWorker()
  const sent: ActualResponse[] = []
  // `open`'s own reply is always the `{id, ok, ...}` shape; the health push
  // goes through `send` instead, captured separately in `sent`.
  const response = (await handleRequest(
    { id: 1, kind: 'open', config },
    (message) => sent.push(message),
  )) as Reply
  return { response, sent }
}

beforeEach(() => {
  init.mockReset()
  init.mockResolvedValue(undefined)
  downloadBudget.mockReset()
  downloadBudget.mockResolvedValue(undefined)
  sync.mockReset()
  sync.mockResolvedValue(undefined)
  shutdown.mockReset()
  shutdown.mockResolvedValue(undefined)
  getServerVersion.mockReset()
  getServerVersion.mockResolvedValue({ version: '26.9.0' })
  getPreferences.mockReset()
  getPreferences.mockResolvedValue({ budgetType: 'envelope', defaultCurrencyCode: 'EUR' })
  getAccountBalance.mockReset()
  getAccountBalance.mockResolvedValue(4_200)
  getSchedules.mockReset()
  getSchedules.mockResolvedValue([])
})

afterEach(() => {
  vi.resetModules()
})

describe("opening: an unencrypted budget with no E2E password (#119)", () => {
  it('opens without complaint, because that is a complete configuration', async () => {
    const { response } = await open(await baseConfig())
    expect(response).toEqual({ id: 1, ok: true, result: null })
  })

  it('passes no password key at all, rather than one set to undefined', async () => {
    // Actual tests the property for truthiness inside `if (activeFile.encryptKeyId)`,
    // so `{ password: undefined }` would behave the same — but it states a password
    // was considered and rejected, which is not what happened.
    await open(await baseConfig())
    expect(downloadBudget).toHaveBeenCalledTimes(1)
    const options = downloadBudget.mock.calls[0]?.[1]
    expect(options).toEqual({})
    expect(options === undefined ? [] : Object.keys(options)).not.toContain('password')
  })

  it('forwards an E2E password that was actually set', async () => {
    const config = await baseConfig()
    config.e2ePassword = 'correct horse'
    await open(config)
    expect(downloadBudget.mock.calls[0]?.[1]).toEqual({ password: 'correct horse' })
  })

  it('pushes an unsolicited health message once opened', async () => {
    const { sent } = await open(await baseConfig())
    expect(sent).toEqual([
      {
        type: 'health',
        health: expect.objectContaining({
          opened: true,
          serverVersion: '26.9.0',
          budgetType: 'envelope',
          currencyCode: 'EUR',
        }),
      },
    ])
  })
})

describe('opening: an encryption failure, worded for the settings form', () => {
  const cases = [
    {
      code: 'missing-key',
      actual: 'File Household is encrypted. Please provide a password.',
      says: 'the E2E password must be its encryption password',
    },
    {
      code: 'decrypt-failure',
      actual: 'Unable to decrypt file with this password. Please try again.',
      says: 'does not decrypt this budget',
    },
    {
      code: 'file-has-new-key',
      actual: 'Something went wrong trying to create a key, sorry!',
      says: 'has changed in Actual since',
    },
  ] as const

  for (const { code, actual, says } of cases) {
    it(`explains \`${code}\` in terms of the settings form's E2E password`, async () => {
      downloadBudget.mockRejectedValue(actualError(actual, code))
      const { response } = await open(await baseConfig())
      expect(response.ok).toBe(false)
      const message = !response.ok ? response.error.message : ''
      expect(message).toContain(says)
      // Actual's own words survive, so the budget file stays identifiable.
      expect(message).toContain(actual)
      expect(message).not.toContain('ACTUAL_E2E_PASSWORD')
    })
  }

  it('sends `old-key-style` to Actual rather than to any field', async () => {
    // The only one of the four that no configuration change can fix: the key itself
    // has to be recreated on a device that still has the file.
    downloadBudget.mockRejectedValue(
      actualError('This file is encrypted with an old unsupported key style.', 'old-key-style'),
    )
    const { response } = await open(await baseConfig())
    const message = !response.ok ? response.error.message : ''
    expect(message).toContain('recreate the key in Actual')
  })
})

describe('opening: an error that is not about encryption', () => {
  it('leaves `budget-not-found` alone, so it still blames the sync id', async () => {
    downloadBudget.mockRejectedValue(
      actualError('Budget "test-sync-id" not found. Check the sync id of your budget.', 'budget-not-found'),
    )
    const { response } = await open(await baseConfig())
    expect(response.ok).toBe(false)
    const message = !response.ok ? response.error.message : ''
    expect(message).toContain('not found')
    expect(message).not.toContain('E2E password')
  })

  it('leaves an error with no code at all alone', async () => {
    downloadBudget.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5006'))
    const { response } = await open(await baseConfig())
    expect(response).toEqual({ id: 1, ok: false, error: { message: 'connect ECONNREFUSED 10.0.0.5:5006' } })
  })

  it('reports a thrown non-Error as its stringified form', async () => {
    downloadBudget.mockRejectedValue('a string, because JavaScript')
    const { response } = await open(await baseConfig())
    expect(response).toEqual({
      id: 1,
      ok: false,
      error: { message: 'a string, because JavaScript' },
    })
  })
})

describe("opening: Actual's own logging (#123)", () => {
  // Actual's engine writes breadcrumbs and sync progress with `console.log`, and its
  // `verboseMode` starts out true — ten unparseable lines per sync in the middle of
  // pino's JSON. Asserted on the argument rather than on captured stdout: what
  // Balancr asks for is Balancr's business, and honouring it is Actual's.
  const verboseAt = async (logLevel: string): Promise<unknown> => {
    const config = await baseConfig()
    config.logLevel = logLevel
    await open(config)
    return init.mock.calls[0]?.[0]?.['verbose']
  }

  it('is off at the levels a deployment actually runs at', async () => {
    expect(await verboseAt('info')).toBe(false)
  })

  it('is off at warn, where even less is wanted', async () => {
    expect(await verboseAt('warn')).toBe(false)
  })

  it('comes back at debug, because that is what asking for it looks like', async () => {
    expect(await verboseAt('debug')).toBe(true)
  })

  it('comes back at trace', async () => {
    expect(await verboseAt('trace')).toBe(true)
  })
})

describe("'call': dispatching one method", () => {
  it('runs an allowed method and returns its result', async () => {
    const { handleRequest } = await freshWorker()
    const response = await handleRequest(
      { id: 7, kind: 'call', method: 'getAccountBalance', args: ['acct-1'] },
      () => undefined,
    )
    expect(response).toEqual({ id: 7, ok: true, result: 4_200 })
    expect(getAccountBalance).toHaveBeenCalledWith('acct-1')
  })

  it('refuses a method that is not on the allowlist', async () => {
    const { handleRequest } = await freshWorker()
    const response = await handleRequest(
      { id: 7, kind: 'call', method: 'deleteAccount', args: ['acct-1'] },
      () => undefined,
    )
    expect(response).toEqual({
      id: 7,
      ok: false,
      error: { message: 'method not allowed: deleteAccount' },
    })
  })

  it('reports an allowlisted method the package does not actually expose', async () => {
    // `aqlQuery` is allowlisted but deliberately not part of the mock above.
    const { handleRequest } = await freshWorker()
    const response = await handleRequest(
      { id: 7, kind: 'call', method: 'aqlQuery', args: [] },
      () => undefined,
    )
    expect(response).toEqual({
      id: 7,
      ok: false,
      error: { message: '@actual-app/api has no method aqlQuery' },
    })
  })
})

describe("'batch': running several ops as one reply", () => {
  it('runs every op in order and returns their results in that order', async () => {
    const { handleRequest } = await freshWorker()
    const response = await handleRequest(
      {
        id: 9,
        kind: 'batch',
        ops: [
          { method: 'getSchedules', args: [] },
          { method: 'getAccountBalance', args: ['acct-1'] },
        ],
      },
      () => undefined,
    )
    expect(response).toEqual({ id: 9, ok: true, result: [[], 4_200] })
    expect(getSchedules.mock.invocationCallOrder[0]).toBeLessThan(
      getAccountBalance.mock.invocationCallOrder[0]!,
    )
  })

  it('aborts the whole batch at the first disallowed op, running nothing after it', async () => {
    const { handleRequest } = await freshWorker()
    const response = await handleRequest(
      {
        id: 9,
        kind: 'batch',
        ops: [
          { method: 'getSchedules', args: [] },
          { method: 'deleteAccount', args: ['acct-1'] },
          { method: 'getAccountBalance', args: ['acct-1'] },
        ],
      },
      () => undefined,
    )
    expect(response).toEqual({
      id: 9,
      ok: false,
      error: { message: 'method not allowed: deleteAccount' },
    })
    expect(getSchedules).toHaveBeenCalledTimes(1)
    expect(getAccountBalance).not.toHaveBeenCalled()
  })
})

describe("'sync'", () => {
  it('calls through to Actual and replies ok', async () => {
    const { handleRequest } = await freshWorker()
    const response = await handleRequest({ id: 3, kind: 'sync' }, () => undefined)
    expect(response).toEqual({ id: 3, ok: true, result: null })
    expect(sync).toHaveBeenCalledTimes(1)
  })
})

describe("'shutdown'", () => {
  it('shuts Actual down when a budget is open', async () => {
    const { handleRequest } = await freshWorker()
    await handleRequest({ id: 1, kind: 'open', config: await baseConfig() }, () => undefined)
    const response = await handleRequest({ id: 2, kind: 'shutdown' }, () => undefined)
    expect(response).toEqual({ id: 2, ok: true, result: null })
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('is a no-op against Actual when nothing was ever opened', async () => {
    const { handleRequest } = await freshWorker()
    const response = await handleRequest({ id: 2, kind: 'shutdown' }, () => undefined)
    expect(response).toEqual({ id: 2, ok: true, result: null })
    expect(shutdown).not.toHaveBeenCalled()
  })
})
