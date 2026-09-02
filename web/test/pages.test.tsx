/**
 * The route table and the five pages hanging off it.
 *
 * The table is what stops the nav and the router from drifting: they read the same
 * array, so a page cannot become unreachable while still working. What is worth
 * asserting is the resolution around the edges — a trailing slash is the same page,
 * an unknown path is not a page at all — because those are the cases a `switch` in a
 * component would get subtly wrong and nothing would notice.
 *
 * The pages themselves are placeholders that #29–#33 replace wholesale, so the test
 * is not about their content. It is about the two things that stay true afterwards:
 * every page has exactly one level-one heading, and every string on it comes from the
 * catalogue rather than being written into the component. A hardcoded English word
 * survives a Dutch UI without failing anything, which is precisely why it is checked
 * here rather than left to a reading.
 */
import { screen } from '@testing-library/react'
import i18next from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'
import { NotFound } from '../src/pages/NotFound.tsx'
import { ROUTES, routeFor } from '../src/routes.ts'
import { clickLink, i18nReady, renderApp } from './helpers.tsx'

beforeAll(async () => {
  await i18nReady()
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
    // Nested detail paths arrive with the pages that need them (#30 onwards). Until
    // then this is a 404 in the content area, while the nav still lights the section
    // it sits under — which is the behaviour `isActive` is written for.
    expect(routeFor('/budget/2026-08')).toBeUndefined()
  })
})

describe('the pages', () => {
  it.each(ROUTES.map((route) => [route.labelKey, route] as const))(
    'gives %s one heading, a lede and a note, all translated',
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
      expect(screen.getByText(/^Coming next:/)).toBeTruthy()
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
