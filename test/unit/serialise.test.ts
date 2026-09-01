import { describe, expect, it } from 'vitest'
import { createSerialiser } from '../../src/util/serialise.ts'

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('createSerialiser', () => {
  it('runs operations one at a time, in submission order', async () => {
    const serialise = createSerialiser()
    const events: string[] = []

    const op = (name: string, delay: number) => async () => {
      events.push(`${name}:start`)
      await tick(delay)
      events.push(`${name}:end`)
      return name
    }

    // Deliberately slowest-first: without serialisation, `b` and `c` would
    // interleave with `a` and the ends would come back out of order.
    const results = await Promise.all([
      serialise(op('a', 30)),
      serialise(op('b', 1)),
      serialise(op('c', 1)),
    ])

    expect(results).toEqual(['a', 'b', 'c'])
    expect(events).toEqual([
      'a:start', 'a:end',
      'b:start', 'b:end',
      'c:start', 'c:end',
    ])
  })

  it('keeps draining after an operation rejects', async () => {
    const serialise = createSerialiser()
    const ran: string[] = []

    const failing = serialise(async () => {
      ran.push('failing')
      throw new Error('boom')
    })
    const after = serialise(async () => {
      ran.push('after')
      return 'ok'
    })

    await expect(failing).rejects.toThrow('boom')
    // A poisoned queue would leave this pending for ever — the failure mode
    // where sync silently stops working after one bad night.
    await expect(after).resolves.toBe('ok')
    expect(ran).toEqual(['failing', 'after'])
  })

  it('propagates each result to its own caller', async () => {
    const serialise = createSerialiser()
    const [one, two] = await Promise.all([
      serialise(async () => 1),
      serialise(async () => 2),
    ])
    expect([one, two]).toEqual([1, 2])
  })
})
