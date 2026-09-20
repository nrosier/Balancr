/**
 * The settings connection-test worker runs in a separate process, so the main
 * process's patched global fetch cannot protect it. These tests drive the exact
 * exported entry point used by the worker's IPC listener and make its mocked Actual
 * client perform a request, proving the child installs and uses its own guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const init = vi.fn<(config: Record<string, unknown>) => Promise<void>>()
const downloadBudget = vi.fn<() => Promise<void>>()
const shutdown = vi.fn<() => Promise<void>>()

vi.mock('@actual-app/api', () => ({
  init: (config: Record<string, unknown>) => init(config),
  downloadBudget: () => downloadBudget(),
  shutdown: () => shutdown(),
}))

const realFetch = globalThis.fetch

const candidate = {
  serverUrl: 'https://candidate.example',
  syncId: 'sync-id',
  password: 'server-password',
}

const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

async function freshWorker(): Promise<typeof import('../../src/adapters/actual/test-worker.ts')> {
  vi.resetModules()
  return await import('../../src/adapters/actual/test-worker.ts')
}

beforeEach(() => {
  init.mockReset()
  init.mockImplementation(async (config) => {
    await fetch(new URL('/probe', String(config['serverURL'])))
  })
  downloadBudget.mockReset()
  downloadBudget.mockResolvedValue(undefined)
  shutdown.mockReset()
  shutdown.mockResolvedValue(undefined)
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.resetModules()
})

describe('the Actual connection-test worker egress guard (#412)', () => {
  it('allows the submitted candidate host and same-host redirects', async () => {
    const inner = vi.fn(async (input: Parameters<typeof fetch>[0]) =>
      urlOf(input).endsWith('/probe')
        ? new Response(null, { status: 302, headers: { location: '/ready' } })
        : new Response('ok'),
    )
    globalThis.fetch = inner as unknown as typeof fetch
    const { testCandidate } = await freshWorker()

    await expect(testCandidate(candidate)).resolves.toEqual({ ok: true, message: null })
    expect(inner.mock.calls.map(([input]) => urlOf(input))).toEqual([
      'https://candidate.example/probe',
      'https://candidate.example/ready',
    ])
    expect(downloadBudget).toHaveBeenCalledOnce()
  })

  it('cannot follow the candidate host to a destination the main guard rejects', async () => {
    const inner = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://collector.evil.example/report' },
      }),
    )
    globalThis.fetch = inner as unknown as typeof fetch
    const { testCandidate } = await freshWorker()

    const result = await testCandidate(candidate)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('collector.evil.example')
    expect(inner).toHaveBeenCalledOnce()
    expect(downloadBudget).not.toHaveBeenCalled()
  })
})
