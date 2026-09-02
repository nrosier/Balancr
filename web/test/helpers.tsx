/**
 * What every component test needs before it can render anything.
 *
 * Three pieces of setup, each of which the application does exactly once in
 * `main.tsx` and which a test therefore has to do too:
 *
 *  - **The catalogues.** Components call `t()`, and i18next is a singleton that has
 *    to be initialised before the first render or every string comes out as its own
 *    key. `catalogues()` reads the real files in `src/i18n/locales/`, so a test
 *    asserting on "Overview" is asserting on the shipped English, not on a fixture.
 *  - **The providers.** `RouterProvider` and `ThemeProvider` both throw when their
 *    hook is called outside them — deliberately, because a component rendered
 *    outside its provider is a wiring bug rather than a case to degrade into.
 *  - **A location.** `RouterProvider` reads `window.location.pathname` once at
 *    mount, so the path has to be pushed *before* rendering.
 *
 * `resetTheme` is here rather than in `setup.ts` because it is not "what jsdom is
 * missing" — it is state the application deliberately persists, and a test file that
 * checks a stored theme must not change what the next one sees.
 */
import { fireEvent, render, type RenderResult } from '@testing-library/react'
import type { ReactNode } from 'react'
import { initI18n } from '../src/i18n.ts'
import { RouterProvider } from '../src/router.tsx'
import { ThemeProvider } from '../src/theme/ThemeContext.tsx'

/** What a test deployment supports. Both catalogues exist on disk. */
export const SUPPORTED = ['en', 'nl'] as const

let started: Promise<unknown> | null = null

/**
 * Initialises i18next once per test file.
 *
 * Memoised because `initI18n` calls `i18next.init`, and a second call on the same
 * instance warns and re-enters — vitest gives each file its own module registry, so
 * one promise per file is exactly the right scope.
 */
export function i18nReady(language = 'en'): Promise<unknown> {
  started ??= initI18n({ supported: SUPPORTED, language })
  return started
}

/** Sets the address the next `RouterProvider` will read as its starting path. */
export function visit(path: string): void {
  window.history.pushState(null, '', path)
}

export interface RenderAppOptions {
  /** Pushed before mounting, because the router reads the path once. */
  path?: string
}

/** The same two providers `main.tsx` mounts the application in. */
function Providers({ children }: { children: ReactNode }): ReactNode {
  return (
    <ThemeProvider>
      <RouterProvider>{children}</RouterProvider>
    </ThemeProvider>
  )
}

/**
 * Renders inside those providers.
 *
 * Through Testing Library's `wrapper` rather than by wrapping `ui` here, because
 * `rerender` re-renders the root with what it is handed — a hand-wrapped tree would
 * lose both providers on the first update, and the component under test would throw
 * from a hook instead of showing whatever the update was meant to show.
 */
export function renderApp(ui: ReactNode, options: RenderAppOptions = {}): RenderResult {
  if (options.path !== undefined) visit(options.path)
  return render(ui, { wrapper: Providers })
}

/** Forgets a remembered theme and the attribute it stamps on `<html>`. */
export function resetTheme(): void {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
}

/**
 * Makes `matchMedia` answer for one query, which jsdom otherwise always answers
 * `false` to — the only way to test the dark-system path.
 */
export function stubColorScheme(dark: boolean): { change: (toDark: boolean) => void } {
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  let matches = dark

  window.matchMedia = ((query: string) =>
    ({
      media: query,
      get matches() {
        return query.includes('dark') ? matches : !matches
      },
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener)
      },
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener)
      },
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
      onchange: null,
    }) as unknown as MediaQueryList) as typeof window.matchMedia

  return {
    change: (toDark: boolean) => {
      matches = toDark
      for (const listener of listeners) {
        listener({ matches: toDark } as MediaQueryListEvent)
      }
    },
  }
}

/**
 * Clicks an anchor and reports whether the application claimed the click.
 *
 * Worth the ceremony for two reasons. jsdom follows a real `href` on an unprevented
 * click and logs "Not implemented: navigation" for every one, which would bury the
 * output of the tests that deliberately let a click through; and "did the router take
 * this click" is exactly `defaultPrevented` *after* React's handler and *before*
 * anything else, which a listener on `document` is the only place to read.
 */
export function clickLink(element: Element, init: MouseEventInit = {}): boolean {
  let claimed = false
  const spy = (event: Event): void => {
    claimed = event.defaultPrevented
    event.preventDefault()
  }
  document.addEventListener('click', spy)
  try {
    // Through `fireEvent` rather than `dispatchEvent`, so the state update the click
    // causes happens inside `act` and React does not warn about it.
    fireEvent(element, new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
  } finally {
    document.removeEventListener('click', spy)
  }
  return claimed
}
