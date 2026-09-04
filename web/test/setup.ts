/**
 * What jsdom is missing that this application uses.
 *
 * Three browser APIs, absent from jsdom 30 rather than merely inert, and all three
 * reached by code that has nothing to do with the test that trips over them:
 *
 *  - **`ResizeObserver`.** `charts/Chart.tsx` observes its container so an ECharts
 *    instance resizes with the layout. Without a stub every test that renders a chart
 *    throws `ResizeObserver is not defined` — including tests that are not about
 *    charts, because a page component pulls one in. The stub deliberately never
 *    fires: jsdom reports every element as zero-sized, so a callback would only ever
 *    deliver `0 × 0`, and a chart resizing itself to nothing is a worse lie than a
 *    chart that never resizes. What the tests assert is that the component mounts,
 *    sets its options and disposes cleanly; measured geometry is a browser's job and
 *    belongs in the manual accessibility and responsive pass (#35).
 *  - **`localStorage`.** jsdom does provide `sessionStorage`, but `localStorage` on
 *    the global is Node's own experimental one, which is `undefined` unless the
 *    process was started with `--localstorage-file`. `theme/theme.ts` wraps every
 *    access in `try/catch` precisely because storage can be unavailable, so without
 *    this stub the suite would only ever exercise that catch and "the theme is
 *    remembered" would be untestable.
 *
 *  - **A 2D canvas context.** Even with the SVG renderer, zrender measures text
 *    through `canvas.getContext('2d').measureText` to lay out axis labels, and jsdom
 *    answers `getContext` with a "Not implemented" error unless the native `canvas`
 *    package is installed. The stub returns a width proportional to the string, which
 *    is not a real measurement and is not meant to be: nothing here asserts geometry,
 *    and installing a native canvas to render an SVG would be an odd trade.
 *
 * `window.scrollTo` is a third: jsdom defines it but answers every call with a
 * "Not implemented" error on its virtual console, and `shell/AppShell.tsx` scrolls to
 * the top on every navigation — so without a no-op every routing test would print an
 * error it is not about.
 *
 *  - **`<dialog>`'s modal methods.** jsdom 30 reflects the `open` attribute but does
 *    not implement `showModal`/`close` at all — not even as a "not implemented"
 *    stub — so `shell/ChangelogDialog.tsx`'s own `showModal()` call throws outright.
 *    The stub sets `open` and, the other direction, fires the same `close` event a
 *    real browser does — including on Escape, which real dialogs close on natively
 *    and jsdom does not — so a test can dispatch a `keydown` and assert on the
 *    component's `onClose`, exactly as it would against a browser.
 *
 * `matchMedia` is the last thing jsdom lacks and is deliberately *not* stubbed here.
 * `theme.ts` treats its absence as "the machine has no opinion", which resolves to
 * light — a real state worth being the default in tests. The tests that care about a
 * dark machine stub it themselves through `stubColorScheme` in `helpers.tsx`.
 */
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver = ResizeObserverStub

/** Enough of `Storage` for the one key this application keeps. */
class MemoryStorage {
  private readonly entries = new Map<string, string>()

  get length(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.entries.delete(key)
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, String(value))
  }
}

// Through `defineProperty` rather than assignment: the global `localStorage` Node
// installs is an accessor, and assigning to it does not necessarily stick.
Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorage(),
  writable: true,
  configurable: true,
})

// Roughly six pixels a character. zrender only asks for widths, so this is the whole
// surface it uses.
HTMLCanvasElement.prototype.getContext = ((): unknown => ({
  font: '',
  measureText: (text: string) => ({ width: text.length * 6 }),
})) as unknown as typeof HTMLCanvasElement.prototype.getContext

globalThis.scrollTo = () => {}

HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
  this.setAttribute('open', '')
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.close()
  }
  this.addEventListener('keydown', onKeydown)
  this.addEventListener('close', () => this.removeEventListener('keydown', onKeydown), {
    once: true,
  })
}

HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
  if (!this.open) return
  this.removeAttribute('open')
  this.dispatchEvent(new Event('close'))
}

// Testing Library's automatic cleanup only registers itself when the global test
// hooks are enabled, and they are not here — every test file imports its own.
afterEach(cleanup)
