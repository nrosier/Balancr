/**
 * Standalone coverage for `InfoTip` (#346): the popover is absent by default, opens
 * on hover and on focus, closes on mouseleave/blur, and — mirroring
 * `period-picker.test.tsx`'s coverage of the same dismissal pattern — closes on an
 * outside pointerdown or on Escape while open.
 */
import { fireEvent, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import { InfoTip } from '../src/ui/InfoTip.tsx'
import { i18nReady, renderApp } from './helpers.tsx'

beforeAll(async () => {
  await i18nReady()
})

const TEXT = 'A short explanation of this field.'

function trigger(): HTMLElement {
  return screen.getByRole('button', { name: 'More info' })
}

describe('InfoTip', () => {
  it('keeps the explanation hidden until opened', () => {
    renderApp(<InfoTip id="tip" text={TEXT} />)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('opens on hover and closes on mouseleave', () => {
    renderApp(<InfoTip id="tip" text={TEXT} />)

    fireEvent.mouseEnter(trigger())
    expect(screen.getByRole('tooltip').textContent).toBe(TEXT)

    fireEvent.mouseLeave(trigger())
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('opens on focus and closes on blur', () => {
    renderApp(<InfoTip id="tip" text={TEXT} />)

    fireEvent.focus(trigger())
    expect(screen.getByRole('tooltip').textContent).toBe(TEXT)

    fireEvent.blur(trigger())
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('toggles open and closed on click', () => {
    renderApp(<InfoTip id="tip" text={TEXT} />)

    fireEvent.click(trigger())
    expect(screen.getByRole('tooltip')).toBeTruthy()

    fireEvent.click(trigger())
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('dismisses on outside pointerdown', () => {
    renderApp(<InfoTip id="tip" text={TEXT} />)
    fireEvent.click(trigger())
    expect(screen.getByRole('tooltip')).toBeTruthy()

    fireEvent.pointerDown(document.body)

    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('dismisses on Escape', () => {
    renderApp(<InfoTip id="tip" text={TEXT} />)
    fireEvent.click(trigger())
    expect(screen.getByRole('tooltip')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
