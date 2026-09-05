/**
 * The route table and the five pages hanging off it.
 *
 * The table is what stops the nav and the router from drifting: they read the same
 * array, so a page cannot become unreachable while still working. What is worth
 * asserting is the resolution around the edges — a trailing slash is the same page,
 * an unknown path is not a page at all — because those are the cases a `switch` in a
 * component would get subtly wrong and nothing would notice.
 *
 * All five pages render their own content as of #32, so what is left to assert across
 * the table is what has to stay true of every one of them however its content changes:
 * exactly one level-one heading, and every string on it out of the catalogue rather
 * than written into the component. A hardcoded English word survives a Dutch UI without
 * failing anything, which is precisely why it is checked here rather than left to a
 * reading. What each page then does with its payload is its own file's subject —
 * `overview`, `budget`, `portfolio`, `insights` and `settings` each have one.
 *
 * Every page reads its own endpoint on mount, so `fetch` is stubbed for the whole file.
 * Not because this test is about the payload, but because a page component left to
 * reach the network in jsdom fails on the machine with no server and passes on the
 * machine with one.
 */
import { screen } from '@testing-library/react'
import i18next from 'i18next'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotFound } from '../src/pages/NotFound.tsx'
import { ROUTES, routeFor } from '../src/routes.ts'
import { apiStub, clickLink, i18nReady, renderApp } from './helpers.tsx'

beforeAll(async () => {
  await i18nReady()
})

beforeEach(() => {
  // Each real page renders its empty state, which is all this file needs from them.
  vi.stubGlobal('fetch', (path: string) => {
    const stub = apiStub(path)
    if (stub === null) throw new Error(`unstubbed request: ${path}`)
    return Promise.resolve(stub)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('routeFor', () => {
  it('resolves every path in the table', () => {
    for (const route of ROUTES) {
      expect(routeFor(route.path)).toBe(route)
    }
  })

  it('treats a trailing slash as the same page', () => {
    expect(routeFor('/budget/')).toBe(routeFor('/budget'))
    expect(routeFor('/')).toBe(ROUTES[0])
  })

  it('resolves nothing for a path no page owns', () => {
    expect(routeFor('/nope')).toBeUndefined()
    // A shared prefix is not the same as being nested under it — `nested`
    // requires the `/` boundary, so a sibling path spelled as an extension
    // of another route's own path must not resolve to that route.
    expect(routeFor('/budgetary')).toBeUndefined()
  })
})

describe('the pages', () => {
  it.each(ROUTES.map((route) => [route.labelKey, route] as const))(
    'gives %s one heading and a lede, both translated',
    (_key, route) => {
      renderApp(<route.Page />, { path: route.path })

      const headings = screen.getAllByRole('heading', { level: 1 })
      expect(headings).toHaveLength(1)
      expect(headings[0]?.textContent).toBeTruthy()

      // Every visible string resolved: i18next returns the key itself when a
      // catalogue entry is missing, so a stray `page.budget.lede` on screen is how
      // that failure looks.
      expect(document.body.textContent ?? '').not.toMatch(/\bpage\.[a-z]+\.[a-z]+\b/)
      expect(document.body.textContent ?? '').not.toMatch(/\bnav\.[a-z]+\b/)
    },
  )

  it('heads each page with the same words as its nav link', () => {
    // One catalogue key for both, so the sidebar and the heading cannot end up
    // calling the same page two different things.
    for (const route of ROUTES) {
      const { unmount } = renderApp(<route.Page />, { path: route.path })
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
        i18next.t(route.labelKey),
      )
      unmount()
    }
  })
})

describe('NotFound', () => {
  it('says what happened and offers a way out', () => {
    renderApp(<NotFound />, { path: '/typo' })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Page not found')
    expect(screen.getByText('There is nothing at that address.')).toBeTruthy()
  })

  it('offers a real link rather than history.back(), which has nowhere to go', () => {
    // Someone who typed the address, or followed a stale bookmark, has no history
    // entry behind them.
    renderApp(<NotFound />, { path: '/typo' })
    const back = screen.getByRole('link', { name: 'Back to overview' })
    expect(back.getAttribute('href')).toBe('/')

    clickLink(back)
    expect(window.location.pathname).toBe('/')
  })
})
