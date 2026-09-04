/**
 * The entry point, and the one place with a deliberate top-level `await`.
 *
 * Three things must be true before the first render, and none of them can be
 * decided at build time:
 *
 *  1. **Formatting.** `configureFormatting` has to run before any component calls
 *     `formatMoney`, or the first paint uses the built-in defaults. They happen to
 *     be the Belgian ones, which is why this is worth being explicit about — the
 *     wrong values would look right on this deployment and wrong on someone else's.
 *  2. **Catalogues and the chosen language**, so nothing renders an English string
 *     for a frame in a Dutch UI.
 *  3. **`<html lang>`**, which the server already set on the document it sent. The
 *     bundle re-asserts it through `initI18n` so a later switch keeps it true, but the
 *     value both agree on is the server's: `bootstrap.locales.active`.
 *
 * All three come from `/bootstrap`, which is `SUPPORTED_LOCALES`, `FORMAT_LOCALE`
 * and friends — the operator's `.env`, not the image. Baking them in would mean
 * rebuilding to add a language.
 *
 * The stylesheet order at the top is load-bearing: fonts declare the family, tokens
 * define the variables, base uses them, and `components.css` builds the shared
 * primitives on top. `signin.css` is imported here as well as by the screen that owns
 * it, because `renderUnreachable` below uses its layout at a point where no component
 * has rendered.
 */
// Stylesheets first, and in this order. Vite emits CSS in the order the module
// graph reaches it, so importing a component before the tokens would put component
// rules ahead of the variables and the reset they build on.
import './theme/fonts.css'
import './theme/tokens.css'
import './theme/base.css'
import './theme/components.css'
import './auth/signin.css'
import './privacy/privacy.css'

import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { initI18n } from './i18n.ts'
import { PrivacyProvider } from './privacy/PrivacyContext.tsx'
import { RouterProvider } from './router.tsx'
import { configureFormatting, type BootstrapResponse } from './shared.ts'
import { ThemeProvider } from './theme/ThemeContext.tsx'

/**
 * Shown when `/bootstrap` cannot be reached — the container is starting, or a proxy
 * is in front of nothing. Both sentences are hardcoded, in both languages, because
 * the catalogues are exactly what failed to be configured. Same reasoning as the
 * `<noscript>` block in `index.html`.
 */
function renderUnreachable(root: HTMLElement): void {
  const wrap = document.createElement('div')
  wrap.className = 'signin'
  const card = document.createElement('div')
  card.className = 'signin__card'
  for (const line of [
    'Balancr could not start: the server did not answer.',
    'Balancr kon niet starten: de server antwoordde niet.',
  ]) {
    const p = document.createElement('p')
    p.textContent = line
    card.append(p)
  }
  wrap.append(card)
  root.replaceChildren(wrap)
}

const container = document.getElementById('root')
if (container === null) throw new Error('#root is missing from index.html')

let bootstrap: BootstrapResponse
try {
  const response = await fetch('/bootstrap', {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`/bootstrap answered ${String(response.status)}`)
  bootstrap = (await response.json()) as BootstrapResponse
} catch (cause) {
  // Logged as well as rendered: the console is where the operator will look, and the
  // status code is the part the screen deliberately does not show.
  console.error('bootstrap failed', cause)
  renderUnreachable(container)
  throw cause
}

configureFormatting({
  formatLocale: bootstrap.format.locale,
  currency: bootstrap.format.currency,
  timeZone: bootstrap.format.timeZone,
})

// The server resolved this: the signed-in account's own setting, then the locale
// cookie, then `Accept-Language`, then `DEFAULT_LOCALE`. Deciding it again here — off
// `navigator.languages`, say — would be a second implementation of the same order, and
// the way `<html lang>` ends up disagreeing with the strings underneath it.
await initI18n({
  supported: bootstrap.locales.supported,
  language: bootstrap.locales.active,
})

createRoot(container).render(
  <ThemeProvider>
    <PrivacyProvider>
      <RouterProvider>
        <App bootstrap={bootstrap} />
      </RouterProvider>
    </PrivacyProvider>
  </ThemeProvider>,
)
