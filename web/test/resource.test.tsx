/**
 * The endpoint hook and the state wrapper, tested apart from any page.
 *
 * `overview.test.tsx` covers the four states through a real screen, which is the right
 * place for "does the page say the right thing". What it cannot reach is the behaviour
 * that only shows up between two requests, and that every page from #30 onwards
 * inherits without writing a line of it:
 *
 *  - **A reload does not blank the screen.** The figures stay, marked busy, until the
 *    new ones arrive. A dashboard that empties itself on refresh reads as data loss.
 *  - **A refresh that fails keeps what it had.** The last good figures with a note
 *    above them beat an error page that throws away information already on screen.
 *  - **A late answer never wins.** Two requests in flight can land out of order, and
 *    the older one arriving second must not overwrite the newer.
 *
 * The probe component is deliberately trivial — anything more would be testing itself.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useResource } from '../src/api/resource.tsx'
import { DataState } from '../src/ui/DataState.tsx'
import { i18nReady } from './helpers.tsx'

interface Counted {
  label: string
}

function Probe({ path = '/api/counted' }: { path?: string }): ReactNode {
  const resource = useResource<Counted>(path)
  return (
    <>
      <button type="button" onClick={resource.reload}>
        reload
      </button>
      <DataState resource={resource}>{(data) => <p>{data.label}</p>}</DataState>
    </>
  )
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Hands out one reply per call, held open until the test releases it. */
function deferred(): {
  fetchMock: ReturnType<typeof vi.fn>
  settle: (index: number, reply: Response | Error) => void
} {
  const resolvers: ((reply: Response | Error) => void)[] = []
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((resolve, reject) => {
        resolvers.push((reply) => {
          if (reply instanceof Error) reject(reply)
          else resolve(reply)
        })
      }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return {
    fetchMock,
    settle: (index, reply) => {
      resolvers[index]?.(reply)
    },
  }
}

beforeAll(async () => {
  await i18nReady()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a reload with figures already on screen', () => {
  it('keeps them, marked busy, until the new ones arrive', async () => {
    const { settle } = deferred()
    render(<Probe />)
    settle(0, json({ label: 'first' }))
    await screen.findByText('first')

    fireEvent.click(screen.getByRole('button', { name: 'reload' }))
    await waitFor(() => {
      expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
    })
    // Still the old figure, not a loading screen.
    expect(screen.getByText('first')).toBeTruthy()

    settle(1, json({ label: 'second' }))
    await screen.findByText('second')
    expect(document.querySelector('[aria-busy="true"]')).toBeNull()
  })

  it('keeps them when the reload fails, and notes the failure above them', async () => {
    const { settle } = deferred()
    render(<Probe />)
    settle(0, json({ label: 'first' }))
    await screen.findByText('first')

    fireEvent.click(screen.getByRole('button', { name: 'reload' }))
    settle(1, new TypeError('fetch failed'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Balancr could not be reached.')
    expect(screen.getByText('first')).toBeTruthy()
  })
})

describe('two requests in flight', () => {
  it('ignores the older one when it lands second', async () => {
    const { settle } = deferred()
    const { rerender } = render(<Probe path="/api/counted?page=1" />)

    // The path changes before the first answer arrives — a filter changed, a month
    // stepped. The first request is now for a screen nobody is looking at.
    rerender(<Probe path="/api/counted?page=2" />)
    settle(1, json({ label: 'page two' }))
    await screen.findByText('page two')

    settle(0, json({ label: 'page one' }))
    await waitFor(() => {
      expect(screen.getByText('page two')).toBeTruthy()
    })
    expect(screen.queryByText('page one')).toBeNull()
  })
})
