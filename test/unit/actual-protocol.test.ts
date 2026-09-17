/**
 * Whether a `Date` argument survives a real `fork()` round trip — the one
 * assumption `client.ts`'s whole proxy design leans on (`fetchAccountBalances`'s
 * `asOf` argument is a `Date`), stated in its header comment as the reason it
 * forks with `serialization: 'advanced'` rather than Node's default JSON mode.
 *
 * A real fork, not a mock: this is a guarantee about `node:child_process`
 * itself, not about any of Balancr's own code, and documentation is not
 * proof. A small, dependency-free fixture script
 * (`fixtures/date-echo-worker.mjs`) is forked twice — once with
 * `serialization: 'advanced'` and once with Node's default — so the negative
 * case is a control proving *why* the option matters, not just that the
 * positive case happens to pass.
 */
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/date-echo-worker.mjs', import.meta.url))

interface EchoReply {
  isDate: boolean
  iso: string | null
}

function echoDate(serialization: 'json' | 'advanced' | undefined): Promise<EchoReply> {
  return new Promise((resolve, reject) => {
    const child = fork(FIXTURE_PATH, [], {
      stdio: 'pipe',
      ...(serialization === undefined ? {} : { serialization }),
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('fixture worker did not reply within 5s'))
    }, 5_000)
    child.once('message', (message: EchoReply) => {
      clearTimeout(timer)
      child.kill()
      resolve(message)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    const sent = new Date('2026-09-28T00:00:00.000Z')
    child.send({ date: sent })
  })
}

describe('fork serialization and Date fidelity', () => {
  it('advanced mode round-trips a Date as a real Date', async () => {
    const reply = await echoDate('advanced')
    expect(reply.isDate).toBe(true)
    expect(reply.iso).toBe('2026-09-28T00:00:00.000Z')
  })

  it("default (json) mode does not — proving why advanced mode is necessary", async () => {
    const reply = await echoDate(undefined)
    expect(reply.isDate).toBe(false)
  })
})
