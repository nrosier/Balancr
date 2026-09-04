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
 *
 * `apiStub` is here for the same reason `renderApp` is: from #29 onwards a page fetches
 * its own endpoint as soon as it mounts, so a test about routing, the session or the
 * shell has to answer for a page it is not testing. Left to reach the network, those
 * tests would fail on a machine with no server and pass on one with a server running.
 */
import { fireEvent, render, type RenderResult } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { CsrfConfig } from '../src/api/client.ts'
import { CsrfProvider } from '../src/api/csrf.tsx'
import { initI18n, setLanguage } from '../src/i18n.ts'
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

/**
 * The names `/bootstrap` gives the double-submit pair.
 *
 * Deliberately not the conventional ones: `useCsrf` throws rather than guessing, and a
 * test that passed with a guessed name would hide the day a provider goes missing.
 */
export const CSRF: CsrfConfig = { cookie: 'balancr_csrf', header: 'x-csrf-token' }

/** Sets the address the next `RouterProvider` will read as its starting path. */
export function visit(path: string): void {
  window.history.pushState(null, '', path)
}

export interface RenderAppOptions {
  /** Pushed before mounting, because the router reads the path once. */
  path?: string
}

/**
 * The same providers `main.tsx` and `App.tsx` mount the application in.
 *
 * `CsrfProvider` joins them from #33: a page that writes reads the token config from
 * context, because pages are rendered by the route table as `<route.Page />` and take
 * no props. Every test rendering the settings page — including `pages.test.tsx`, which
 * renders all five to count their headings — needs it, and `useCsrf` throws without it.
 */
function Providers({ children }: { children: ReactNode }): ReactNode {
  return (
    <ThemeProvider>
      <CsrfProvider csrf={CSRF}>
        <RouterProvider>{children}</RouterProvider>
      </CsrfProvider>
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

/**
 * What each read endpoint answers on a deployment whose jobs have never run: every
 * field null, every list empty, so the page renders its "no data yet" state.
 *
 * Keyed by path rather than answering everything, so a test's own queue still gets the
 * `/auth/*` calls it was written for. One row per page, all five as of #32.
 */
const EMPTY_READS: Record<string, unknown> = {
  '/api/overview': {
    freshness: { stale: false, asOf: null, jobsEnabled: true, jobs: [] },
    netWorth: null,
    history: [],
    month: null,
    totals: null,
    emergencyFundCentimonths: null,
    hygiene: null,
  },
  '/api/settings': {
    build: { version: null, revision: null },
    profile: { email: null, displayName: null, locale: 'en', role: 'owner' },
    locales: { supported: ['en', 'nl'], default: 'en' },
    // Deliberately empty rather than the real default grid: these are not job output,
    // and half of `DEFAULT_PARAMS` copied here would be a second definition of it that
    // drifts. The thresholds panel renders the fields the payload names, so an empty
    // object renders an empty form, which is all a routing test needs. Fidelity to the
    // real payload is `settings.test.tsx`'s job.
    params: {},
    paramDefaults: {},
    prompts: [],
    accounts: [],
    dedupe: [],
    ai: {
      models: { fast: 'gemini-3.7-flash', deep: 'gemini-3.1-pro-preview' },
      month: '2026-09',
      spentMicroEur: 0,
      budgetMicroEur: 15_000_000,
      remainingMicroEur: 15_000_000,
      usedBp: 0,
      exceeded: false,
      history: [],
    },
  },
  // Readiness on a deployment where nothing has run: ready, because the database is
  // readable, and every upstream `unknown` rather than `ok` — which is the answer the
  // status panel exists to give and the one a routing test must not depend on.
  '/api/status': {
    ready: true,
    degraded: true,
    at: '2026-09-03T02:00:00.000Z',
    version: null,
    revision: null,
    jobsEnabled: true,
    checks: [
      { name: 'database', status: 'ok', reason: null },
      { name: 'actual', status: 'unknown', reason: 'neverRun' },
      { name: 'ghostfolio', status: 'unknown', reason: 'neverRun' },
      { name: 'jobs', status: 'unknown', reason: 'neverRun' },
    ],
    jobs: [],
    probes: [],
  },
  '/api/budget': {
    freshness: { stale: false, asOf: null, jobsEnabled: true, jobs: [] },
    // A month label the server invents when nothing has been computed, so the page
    // has something to head its empty state with. `months` being empty is what tells
    // the page apart from a month that simply was not aggregated.
    month: '2026-09',
    months: [],
    totals: null,
    history: [],
    trendMonths: [],
    categories: [],
    signals: [],
    uncategorised: null,
  },
  '/api/portfolio': {
    freshness: { stale: false, asOf: null, jobsEnabled: true, jobs: [] },
    date: null,
    totalValueCents: null,
    twrBp: null,
    allocation: [],
    holdings: [],
    history: [],
  },
  '/api/insights': {
    freshness: { stale: false, asOf: null, jobsEnabled: true, jobs: [] },
    ai: { enabled: true, reason: null },
    owner: true,
    month: null,
    months: [],
    signals: [],
    narrative: null,
    questions: [],
    proposals: [],
    // The one object on this payload that is never null: the cap comes from the
    // environment, so a deployment that has spent nothing still has a budget. The page
    // knows that and leaves it out of its own empty test — see `isEmpty` in
    // `pages/Insights.tsx`.
    spend: {
      month: '2026-09',
      spentMicroEur: 0,
      budgetMicroEur: 15_000_000,
      usedBp: 0,
      exceeded: false,
    },
    runs: [],
  },
}

/** That answer as a `Response`, or null for a path no page reads. */
export function apiStub(path: string): Response | null {
  const body = EMPTY_READS[path]
  if (body === undefined) return null
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Puts i18next back into English.
 *
 * The counterpart to `resetTheme`, and needed for the same reason: i18next is a
 * singleton per test file, so a test that proves the language control works leaves
 * every test after it reading Dutch — and failing on a heading that is on screen.
 */
export async function resetLanguage(): Promise<void> {
  await setLanguage('en')
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
