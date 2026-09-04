/**
 * Blurring money on screen, the same mechanism as `theme/theme.ts`.
 *
 * A `data-privacy="on"` attribute on `<html>`, read by one CSS rule
 * (`privacy.css`) that blurs every element carrying `data-private` —
 * `ui/Money.tsx`'s wrapper, and a chart's own tooltip/container markup.
 * `<html>` rather than a class on the shell, because ECharts tooltips are
 * floating divs appended to `document.body`, outside the shell entirely; an
 * attribute on a shell wrapper would never reach them.
 *
 * This is a visual filter, not a data boundary: the formatted text is
 * unchanged underneath it, still selectable and still what a screen reader
 * announces. It defends against a shoulder glance, not against anyone with
 * DevTools or the page's own JSON responses — see the toggle's tooltip and
 * the README for the exact wording.
 */

export const STORAGE_KEY = 'balancr.privacy'

/**
 * Storage access is wrapped for the same reason `theme.ts` wraps it: it
 * throws rather than returning null in a private window and wherever site
 * data is blocked, and losing a remembered preference must not stop the
 * page from rendering.
 */
export function storedEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'on'
  } catch {
    return false
  }
}

function remember(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(STORAGE_KEY, 'on')
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignored on purpose — see above.
  }
}

/** Applies the setting to the document and remembers it. */
export function applyPrivacy(enabled: boolean): void {
  const root = document.documentElement
  if (enabled) root.setAttribute('data-privacy', 'on')
  else root.removeAttribute('data-privacy')
  remember(enabled)
}
