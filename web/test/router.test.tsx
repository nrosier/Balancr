/**
 * The hand-rolled router.
 *
 * Forty lines of code replacing a library, which is only a good trade if the two
 * things a library gets right for free are actually right here:
 *
 *  - **An anchor stays an anchor.** ⌘-click, ctrl-click, middle-click and shift-click
 *    all have to reach the browser, and a real `href` has to be present for
 *    "open in new tab" and for the status bar to show where a link goes. This is the
 *    bug a hand-rolled router ships with, and it is invisible to whoever wrote it.
 *  - **The back button works.** Nothing in the application calls `popstate`, so the
 *    only way this is covered is a test that fires one.
 *
 * `isActive` is tested against the prefix cases rather than the obvious ones, because
 * the interesting question is whether `/budget` lights up on `/budgeting` — it must
 * not — and whether it lights up on `/budget/2026-08`, which it must, since that is
 * how a detail route under a section will arrive.
 */
import { act, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { isActive, Link, RouterProvider, useRouter } from '../src/router.tsx'
import { clickLink, visit } from './helpers.tsx'

beforeEach(() => {
  visit('/')
})

/** Prints the current path, so a test can assert on what the router thinks it is. */
function Where(): ReactNode {
  const { path } = useRouter()
  return <p data-testid="path">{path}</p>
}

function Harness({ to = '/budget' }: { to?: string }): ReactNode {
  return (
    <RouterProvider>
      <Link to={to}>go</Link>
      <Where />
    </RouterProvider>
  )
}

const path = (): string => screen.getByTestId('path').textContent ?? ''

describe('isActive', () => {
  it('matches the root only exactly', () => {
    expect(isActive('/', '/')).toBe(true)
    expect(isActive('/budget', '/')).toBe(false)
  })

  it('matches a section and anything nested under it', () => {
    expect(isActive('/budget', '/budget')).toBe(true)
    expect(isActive('/budget/2026-08', '/budget')).toBe(true)
  })

  it('does not match a path that merely starts with the same letters', () => {
    expect(isActive('/budgeting', '/budget')).toBe(false)
    expect(isActive('/budget-2', '/budget')).toBe(false)
  })
})

describe('Link', () => {
  it('renders a real href, so the browser can open it in a new tab', () => {
    render(<Harness />)
    expect(screen.getByRole('link', { name: 'go' }).getAttribute('href')).toBe('/budget')
  })

  it('navigates in place on a plain left click', () => {
    render(<Harness />)
    expect(clickLink(screen.getByRole('link', { name: 'go' }))).toBe(true)
    expect(path()).toBe('/budget')
    expect(window.location.pathname).toBe('/budget')
  })

  it.each([
    ['⌘', { metaKey: true }],
    ['ctrl', { ctrlKey: true }],
    ['shift', { shiftKey: true }],
    ['alt', { altKey: true }],
    ['middle', { button: 1 }],
  ])('leaves a %s click to the browser', (_name, init) => {
    render(<Harness />)
    expect(clickLink(screen.getByRole('link', { name: 'go' }), init)).toBe(false)
    expect(path()).toBe('/')
  })

  it('marks itself as the current page, and only then', () => {
    render(<Harness />)
    const link = screen.getByRole('link', { name: 'go' })
    expect(link.getAttribute('aria-current')).toBeNull()

    clickLink(link)
    expect(screen.getByRole('link', { name: 'go' }).getAttribute('aria-current')).toBe('page')
  })

  it('calls onNavigate for an in-app click and not for a modified one', () => {
    let calls = 0
    render(
      <RouterProvider>
        <Link
          to="/settings"
          onNavigate={() => {
            calls += 1
          }}
        >
          go
        </Link>
      </RouterProvider>,
    )
    const link = screen.getByRole('link', { name: 'go' })
    clickLink(link, { metaKey: true })
    expect(calls).toBe(0)
    clickLink(link)
    expect(calls).toBe(1)
  })
})

describe('RouterProvider', () => {
  it('starts at the address the page was loaded with', () => {
    visit('/portfolio')
    render(<Harness />)
    expect(path()).toBe('/portfolio')
  })

  it('follows the back button', () => {
    render(<Harness />)
    clickLink(screen.getByRole('link', { name: 'go' }))
    expect(path()).toBe('/budget')

    act(() => {
      window.history.back()
      // jsdom applies the history change asynchronously and dispatches popstate
      // itself; firing it here is what a synchronous test can assert on.
      window.history.replaceState(null, '', '/')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(path()).toBe('/')
  })

  it('ignores a navigation to the page already showing', () => {
    render(<Harness to="/" />)
    const before = window.history.length
    clickLink(screen.getByRole('link', { name: 'go' }))
    expect(window.history.length).toBe(before)
  })
})

describe('useRouter', () => {
  it('refuses to work outside a provider rather than guessing a path', () => {
    // A component rendered outside the router is a wiring mistake; a default of `/`
    // would hide it behind a page that renders the wrong thing.
    expect(() => render(<Where />)).toThrow(/RouterProvider/)
  })
})
