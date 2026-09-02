/**
 * Light, dark, or whatever the system says.
 *
 * The tricky part is not the switch, it is the first paint. `tokens.css` carries the
 * dark values twice — once behind `prefers-color-scheme` and once behind
 * `[data-theme='dark']` — so a dark-system visitor gets a dark page before any
 * JavaScript runs. This module therefore sets `data-theme` **only** for an explicit
 * choice and removes the attribute for `system`; the alternative, stamping the
 * resolved theme on every load, would mean the correct theme arrives one script late
 * and the page flashes white on the way.
 *
 * Doing it without JavaScript is also what keeps the Content-Security-Policy free of
 * `'unsafe-inline'` — the usual fix for the flash is an inline bootstrap script,
 * which that policy refuses.
 */
import type { ResolvedTheme } from './tokens.ts'

export type ThemeMode = 'system' | 'light' | 'dark'

// One definition, in the module that owns the palettes.
export type { ResolvedTheme }

export const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark']

const STORAGE_KEY = 'balancr.theme'

const isMode = (value: unknown): value is ThemeMode =>
  value === 'system' || value === 'light' || value === 'dark'

/**
 * Storage access is wrapped because it throws rather than returning null in a
 * private window and wherever site data is blocked. A remembered theme is a
 * convenience; losing it must not stop the application from rendering.
 */
export function storedMode(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return isMode(raw) ? raw : 'system'
  } catch {
    return 'system'
  }
}

function remember(mode: ThemeMode): void {
  try {
    if (mode === 'system') window.localStorage.removeItem(STORAGE_KEY)
    else window.localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    // Ignored on purpose — see above.
  }
}

const darkQuery = (): MediaQueryList | null =>
  typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null

/** What the system currently asks for. Light when it has no opinion. */
export function systemTheme(): ResolvedTheme {
  return darkQuery()?.matches === true ? 'dark' : 'light'
}

/** The theme actually in effect for a mode. */
export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  return mode === 'system' ? systemTheme() : mode
}

/**
 * Applies a mode to the document and remembers it.
 *
 * Removing the attribute for `system` hands control back to the media query in
 * `tokens.css`, which is both less code and the only version that survives the
 * system theme changing while the tab is open.
 */
export function applyMode(mode: ThemeMode): ResolvedTheme {
  const root = document.documentElement
  if (mode === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', mode)
  remember(mode)
  return resolveTheme(mode)
}

/**
 * Calls back when the *system* theme changes, which only matters while the mode is
 * `system`. Returns the unsubscribe.
 */
export function onSystemThemeChange(listener: (theme: ResolvedTheme) => void): () => void {
  const query = darkQuery()
  if (query === null) return () => undefined
  const handler = (event: MediaQueryListEvent): void => {
    listener(event.matches ? 'dark' : 'light')
  }
  query.addEventListener('change', handler)
  return () => {
    query.removeEventListener('change', handler)
  }
}
