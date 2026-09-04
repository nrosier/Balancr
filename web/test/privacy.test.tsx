/**
 * Privacy mode: the module that stamps the document, the provider that drives it, and
 * the button in the header.
 *
 * The property that matters is the same shape as `theme.test.tsx`'s: storage must not
 * be load-bearing (a private window throws rather than returning null), the attribute
 * on `<html>` is what `privacy.css` actually reads, and the keyboard shortcut must
 * never swallow a keystroke someone is typing into a field.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PrivacyToggle } from '../src/shell/PrivacyToggle.tsx'
import { applyPrivacy, storedEnabled } from '../src/privacy/privacy.ts'
import { PrivacyProvider, usePrivacy } from '../src/privacy/PrivacyContext.tsx'
import { clickLink, i18nReady, resetPrivacy } from './helpers.tsx'

beforeAll(async () => {
  await i18nReady()
})

beforeEach(resetPrivacy)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the state the document is in', () => {
  it('stamps data-privacy on <html> when on, and removes it when off', () => {
    applyPrivacy(true)
    expect(document.documentElement.getAttribute('data-privacy')).toBe('on')

    applyPrivacy(false)
    expect(document.documentElement.hasAttribute('data-privacy')).toBe(false)
  })

  it('remembers an explicit choice in both directions', () => {
    applyPrivacy(true)
    expect(storedEnabled()).toBe(true)

    applyPrivacy(false)
    expect(storedEnabled()).toBe(false)
  })

  it('defaults to off with nothing stored', () => {
    expect(storedEnabled()).toBe(false)
  })

  it('still renders when storage throws, which it does in a private window', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('The operation is insecure.')
    })
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('The operation is insecure.')
    })

    expect(storedEnabled()).toBe(false)
    expect(() => applyPrivacy(true)).not.toThrow()
    expect(document.documentElement.getAttribute('data-privacy')).toBe('on')
  })
})

describe('PrivacyToggle', () => {
  it('starts off, and switches the document and its own pressed state on click', () => {
    render(
      <PrivacyProvider>
        <PrivacyToggle />
      </PrivacyProvider>,
    )

    const button = screen.getByRole('button', { name: 'Privacy mode' })
    expect(button.getAttribute('aria-pressed')).toBe('false')

    clickLink(button)
    expect(document.documentElement.getAttribute('data-privacy')).toBe('on')
    expect(button.getAttribute('aria-pressed')).toBe('true')

    clickLink(button)
    expect(document.documentElement.hasAttribute('data-privacy')).toBe(false)
    expect(button.getAttribute('aria-pressed')).toBe('false')
  })

  it('carries the caveat in its title, not just a label', () => {
    render(
      <PrivacyProvider>
        <PrivacyToggle />
      </PrivacyProvider>,
    )
    const title = screen.getByRole('button', { name: 'Privacy mode' }).getAttribute('title')
    expect(title).toMatch(/not a security control/)
  })
})

describe('PrivacyProvider', () => {
  function Probe(): ReactNode {
    const { enabled } = usePrivacy()
    return <p data-testid="privacy">{String(enabled)}</p>
  }

  it('starts from whatever was stored', () => {
    applyPrivacy(true)
    render(
      <PrivacyProvider>
        <Probe />
      </PrivacyProvider>,
    )
    expect(screen.getByTestId('privacy').textContent).toBe('true')
  })

  it('toggles on Shift+Ctrl+E from the page body', () => {
    render(
      <PrivacyProvider>
        <Probe />
      </PrivacyProvider>,
    )
    expect(screen.getByTestId('privacy').textContent).toBe('false')

    fireEvent.keyDown(window, { key: 'e', ctrlKey: true, shiftKey: true })
    expect(screen.getByTestId('privacy').textContent).toBe('true')

    fireEvent.keyDown(window, { key: 'E', metaKey: true, shiftKey: true })
    expect(screen.getByTestId('privacy').textContent).toBe('false')
  })

  it('does not toggle while a text field has focus, so it cannot swallow a keystroke', () => {
    render(
      <PrivacyProvider>
        <Probe />
        <input aria-label="note" />
      </PrivacyProvider>,
    )

    const input = screen.getByRole('textbox', { name: 'note' })
    input.focus()
    // Fired on the field itself, not on window, so `event.target` is the field —
    // the same as a real keystroke, which bubbles from wherever focus actually is.
    fireEvent.keyDown(input, { key: 'e', ctrlKey: true, shiftKey: true })
    expect(screen.getByTestId('privacy').textContent).toBe('false')
  })

  it('refuses to work outside the provider rather than defaulting to off', () => {
    expect(() => render(<Probe />)).toThrow(/PrivacyProvider/)
  })
})
