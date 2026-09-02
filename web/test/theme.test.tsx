/**
 * The theme: the module that stamps the document, and the three buttons that drive it.
 *
 * The property that matters is not "clicking dark makes it dark" — it is that
 * `system` **removes** the attribute instead of writing the resolved colour into it.
 * `tokens.css` carries the dark palette twice, once behind `prefers-color-scheme` and
 * once behind `[data-theme='dark']`, and that is what makes a dark-system visitor get
 * a dark page before any JavaScript runs. Stamping `data-theme="light"` on every load
 * would keep working — and would flash white on every navigation for everyone whose
 * machine is dark. So the removal is asserted directly.
 *
 * The rest is storage that must not be load-bearing (a private window throws rather
 * than returning null) and a system change that must only be followed while the mode
 * actually is `system`, since an explicit choice outranks the machine.
 */
import { act, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyMode,
  resolveTheme,
  storedMode,
  systemTheme,
  THEME_MODES,
} from '../src/theme/theme.ts'
import { ThemeToggle } from '../src/shell/ThemeToggle.tsx'
import { ThemeProvider, useTheme } from '../src/theme/ThemeContext.tsx'
import { clickLink, i18nReady, resetTheme, stubColorScheme } from './helpers.tsx'

const realMatchMedia = window.matchMedia

beforeAll(async () => {
  await i18nReady()
})

beforeEach(resetTheme)

afterEach(() => {
  window.matchMedia = realMatchMedia
  vi.restoreAllMocks()
})

describe('the mode the document is in', () => {
  it('hands control back to the media query for system, rather than pinning a colour', () => {
    applyMode('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    applyMode('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('remembers an explicit choice and forgets system', () => {
    applyMode('light')
    expect(storedMode()).toBe('light')

    applyMode('system')
    expect(storedMode()).toBe('system')
    expect(window.localStorage.getItem('balancr.theme')).toBeNull()
  })

  it('ignores a stored value that is not a mode', () => {
    // The key is readable and writable by anything else on the origin; a junk value
    // must not decide the palette.
    window.localStorage.setItem('balancr.theme', 'neon')
    expect(storedMode()).toBe('system')
  })

  it('still renders when storage throws, which it does in a private window', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('The operation is insecure.')
    })
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('The operation is insecure.')
    })

    expect(storedMode()).toBe('system')
    expect(() => applyMode('dark')).not.toThrow()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('resolves system to whatever the machine asks for', () => {
    stubColorScheme(true)
    expect(systemTheme()).toBe('dark')
    expect(resolveTheme('system')).toBe('dark')
    // An explicit choice does not consult the machine at all.
    expect(resolveTheme('light')).toBe('light')
  })
})

describe('ThemeToggle', () => {
  it('offers every mode, with exactly one pressed', async () => {
    await i18nReady()
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    )

    // Queried from inside the group, so "three buttons" cannot be satisfied by
    // three buttons scattered across the header.
    const group = screen.getByRole('group', { name: 'Colour theme' })
    const buttons = [...group.querySelectorAll('button')]
    expect(buttons).toHaveLength(THEME_MODES.length)
    expect(buttons.filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Follow system' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
  })

  it('names each option for a screen reader, since the buttons are icons', () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    )
    for (const name of ['Follow system', 'Light', 'Dark']) {
      const button = screen.getByRole('button', { name })
      // Both, because one is read out and the other is what a mouse user sees.
      expect(button.getAttribute('aria-label')).toBe(name)
      expect(button.getAttribute('title')).toBe(name)
    }
  })

  it('applies a choice to the document and moves the pressed state', () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    )

    clickLink(screen.getByRole('button', { name: 'Dark' }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(screen.getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Follow system' }).getAttribute('aria-pressed')).toBe(
      'false',
    )

    clickLink(screen.getByRole('button', { name: 'Follow system' }))
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })
})

describe('ThemeProvider', () => {
  /** Reports the resolved colour, which is what the charts read. */
  function Resolved(): ReactNode {
    const { resolved, mode } = useTheme()
    return <p data-testid="theme">{`${mode}:${resolved}`}</p>
  }

  it('reports the system colour while following the system', () => {
    stubColorScheme(true)
    render(
      <ThemeProvider>
        <Resolved />
      </ThemeProvider>,
    )
    expect(screen.getByTestId('theme').textContent).toBe('system:dark')
  })

  it('follows a system change while on system', () => {
    const media = stubColorScheme(false)
    render(
      <ThemeProvider>
        <Resolved />
      </ThemeProvider>,
    )
    expect(screen.getByTestId('theme').textContent).toBe('system:light')

    act(() => {
      media.change(true)
    })
    expect(screen.getByTestId('theme').textContent).toBe('system:dark')
  })

  it('does not let a system change overrule an explicit choice', () => {
    const media = stubColorScheme(false)
    render(
      <ThemeProvider>
        <ThemeToggle />
        <Resolved />
      </ThemeProvider>,
    )

    clickLink(screen.getByRole('button', { name: 'Light' }))
    expect(screen.getByTestId('theme').textContent).toBe('light:light')

    act(() => {
      media.change(true)
    })
    // Still light. Repainting here would silently undo what the user asked for.
    expect(screen.getByTestId('theme').textContent).toBe('light:light')
  })

  it('refuses to work outside the provider rather than defaulting to light', () => {
    expect(() => render(<Resolved />)).toThrow(/ThemeProvider/)
  })
})
