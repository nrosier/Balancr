/**
 * Opening Actual: what Balancr asks for, and what it says when the answer is no.
 *
 * Two things are tested here because both belong to the same one-time `open()` call.
 * How Actual is asked to log (#123), and what Balancr says when
 * `ACTUAL_E2E_PASSWORD` is the problem — a different password from `ACTUAL_PASSWORD`,
 * read only when the budget is end-to-end encrypted, and the variable most likely to
 * be misunderstood, because Actual's own errors are written for someone standing in
 * front of Actual's UI and name neither the variable nor the file it lives in (#119).
 *
 * `@actual-app/api` is mocked here rather than in `actual-adapter.test.ts`, which
 * asserts the *real* package still exposes the methods the adapter calls. Those two
 * intentions cannot share a file, because `vi.mock` applies to all of it.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const downloadBudget = vi.fn<(syncId: string, options?: { password?: string }) => Promise<void>>()
const init = vi.fn<(config: Record<string, unknown>) => Promise<void>>()

vi.mock('@actual-app/api', () => ({
  init: (config: Record<string, unknown>) => init(config),
  downloadBudget: (syncId: string, options?: { password?: string }) =>
    downloadBudget(syncId, options),
  sync: vi.fn(async () => undefined),
  shutdown: vi.fn(async () => undefined),
  getServerVersion: vi.fn(async () => ({ version: '26.9.0' })),
  getPreferences: vi.fn(async () => ({
    budgetType: 'envelope',
    defaultCurrencyCode: 'EUR',
  })),
}))

/** An error shaped the way `withErrorCode` shapes one: a message plus a `code`. */
function actualError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * Opens Actual with a fresh module graph, and returns whatever came back out.
 *
 * The reset matters twice over: `client.ts` caches `opened`, so a second call in one
 * module instance would skip the download entirely, and `config.ts` validates at
 * import, so the temporary data directory has to be in place before either loads.
 */
async function open(): Promise<Error | null> {
  vi.resetModules()
  vi.stubEnv('ACTUAL_DATA_DIR', await mkdtemp(join(tmpdir(), 'balancr-e2e-')))
  const { withActual } = await import('../../src/adapters/actual/client.ts')
  try {
    await withActual(async () => undefined)
    return null
  } catch (error) {
    return error as Error
  }
}

beforeEach(() => {
  downloadBudget.mockReset()
  downloadBudget.mockResolvedValue(undefined)
  init.mockReset()
  init.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('an unencrypted budget with no ACTUAL_E2E_PASSWORD (#119)', () => {
  it('opens without complaint, because that is a complete configuration', async () => {
    vi.stubEnv('ACTUAL_E2E_PASSWORD', undefined)
    expect(await open()).toBeNull()
  })

  it('passes no password key at all, rather than one set to undefined', async () => {
    // Actual tests the property for truthiness inside `if (activeFile.encryptKeyId)`,
    // so `{ password: undefined }` would behave the same — but it states a password
    // was considered and rejected, which is not what happened.
    vi.stubEnv('ACTUAL_E2E_PASSWORD', undefined)
    await open()
    expect(downloadBudget).toHaveBeenCalledTimes(1)
    const options = downloadBudget.mock.calls[0]?.[1]
    expect(options).toEqual({})
    expect(options === undefined ? [] : Object.keys(options)).not.toContain('password')
  })

  it('reads a blank ACTUAL_E2E_PASSWORD as no password (#118)', async () => {
    // The two issues meet here: a blank value is what `.env.example` ships, and it
    // has to reach Actual as an absent password rather than as an empty one.
    vi.stubEnv('ACTUAL_E2E_PASSWORD', '')
    expect(await open()).toBeNull()
    expect(downloadBudget.mock.calls[0]?.[1]).toEqual({})
  })

  it('forwards a password that was actually set', async () => {
    vi.stubEnv('ACTUAL_E2E_PASSWORD', 'correct horse')
    expect(await open()).toBeNull()
    expect(downloadBudget.mock.calls[0]?.[1]).toEqual({ password: 'correct horse' })
  })
})

describe('an encryption failure', () => {
  // Every one of these is about the same variable, and Actual names it in none of
  // them. The message it does carry is kept, because it identifies which budget file
  // is encrypted — the one detail Balancr cannot supply.
  const cases = [
    {
      code: 'missing-key',
      actual: 'File Household is encrypted. Please provide a password.',
      says: 'set ACTUAL_E2E_PASSWORD',
    },
    {
      code: 'decrypt-failure',
      actual: 'Unable to decrypt file with this password. Please try again.',
      says: 'does not decrypt this budget',
    },
    {
      code: 'file-has-new-key',
      actual: 'Something went wrong trying to create a key, sorry!',
      says: 'has been changed in Actual',
    },
  ] as const

  for (const { code, actual, says } of cases) {
    it(`explains \`${code}\` in terms of ACTUAL_E2E_PASSWORD`, async () => {
      downloadBudget.mockRejectedValue(actualError(actual, code))
      const error = await open()
      expect(error?.message).toContain('ACTUAL_E2E_PASSWORD')
      expect(error?.message).toContain(says)
      // Actual's own words survive, so the budget file stays identifiable.
      expect(error?.message).toContain(actual)
      expect(error?.cause).toBeInstanceOf(Error)
    })
  }

  it('sends `old-key-style` to Actual rather than to .env', async () => {
    // The only one of the four that no configuration change can fix: the key itself
    // has to be recreated on a device that still has the file.
    downloadBudget.mockRejectedValue(
      actualError('This file is encrypted with an old unsupported key style.', 'old-key-style'),
    )
    const error = await open()
    expect(error?.message).toContain('recreate the key in Actual')
  })
})

describe('an error that is not about encryption', () => {
  it('leaves `budget-not-found` alone, so it still blames the sync id', async () => {
    // Rephrasing this one would send someone to the wrong line of `.env` entirely.
    const original = actualError(
      'Budget "test-sync-id" not found. Check the sync id of your budget.',
      'budget-not-found',
    )
    downloadBudget.mockRejectedValue(original)
    const error = await open()
    expect(error).toBe(original)
    expect(error?.message).not.toContain('ACTUAL_E2E_PASSWORD')
  })

  it('leaves an error with no code at all alone', async () => {
    const original = new Error('connect ECONNREFUSED 10.0.0.5:5006')
    downloadBudget.mockRejectedValue(original)
    expect(await open()).toBe(original)
  })

  it('rethrows a thrown non-Error unchanged', async () => {
    downloadBudget.mockRejectedValue('a string, because JavaScript')
    expect(await open()).toBe('a string, because JavaScript')
  })
})

describe("Actual's own logging (#123)", () => {
  // Actual's engine writes breadcrumbs and sync progress with `console.log`, and its
  // `verboseMode` starts out true — ten unparseable lines per sync in the middle of
  // pino's JSON. Asserted on the argument rather than on captured stdout: what
  // Balancr asks for is Balancr's business, and honouring it is Actual's.
  const verboseAt = async (level: string): Promise<unknown> => {
    vi.stubEnv('LOG_LEVEL', level)
    await open()
    return init.mock.calls[0]?.[0]?.['verbose']
  }

  it('is off at the levels a deployment actually runs at', async () => {
    expect(await verboseAt('info')).toBe(false)
  })

  it('is off at warn, where even less is wanted', async () => {
    expect(await verboseAt('warn')).toBe(false)
  })

  it('comes back at debug, because that is what asking for it looks like', async () => {
    // Not silenced, only quiet: when a budget will not load, that chatter is the
    // only view into why.
    expect(await verboseAt('debug')).toBe(true)
  })

  it('comes back at trace', async () => {
    expect(await verboseAt('trace')).toBe(true)
  })
})
