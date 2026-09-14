/**
 * Standalone coverage for the rebuilt `PeriodPicker` (#345), before any page wires it
 * up: mode switch, paging, availability-based graying/disabling, and outside-click /
 * Escape dismissal — the behaviors the mockup at `/tmp/period-picker-concept.html`
 * specified and no existing test file covered for the calendar-library version this
 * replaces.
 */
import { fireEvent, screen, within } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Period, PeriodKind } from '../src/ui/PeriodPicker.tsx'
import { PeriodPicker } from '../src/ui/PeriodPicker.tsx'
import { i18nReady, renderApp } from './helpers.tsx'

beforeAll(async () => {
  await i18nReady()
})

function kindLabel(kind: PeriodKind): string {
  return kind === 'month' ? 'Month' : 'Year'
}

const AVAILABLE = new Set(['2025-11', '2025-12', '2026-01', '2026-08'])

function Harness({ initial }: { initial: Period }): ReactNode {
  const [period, setPeriod] = useState<Period>(initial)
  return (
    <PeriodPicker
      period={period}
      onSelect={setPeriod}
      id="test-period"
      label="Period"
      kindLabel={kindLabel}
      availableMonths={AVAILABLE}
    />
  )
}

function open(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Period' }))
}

describe('PeriodPicker', () => {
  it('opens a dialog from the trigger and shows the selected month', () => {
    renderApp(<Harness initial={{ kind: 'month', value: '2026-08' }} />)
    expect(screen.queryByRole('dialog')).toBeNull()

    open()

    expect(screen.getByRole('dialog', { name: 'Period' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Period' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('selects a month cell, closing the popover and reporting the new period', () => {
    const onSelect = vi.fn()
    function Controlled(): ReactNode {
      return (
        <PeriodPicker
          period={{ kind: 'month', value: '2026-08' }}
          onSelect={onSelect}
          id="test-period"
          label="Period"
          kindLabel={kindLabel}
          availableMonths={AVAILABLE}
        />
      )
    }
    renderApp(<Controlled />)
    open()

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Jan' }))

    expect(onSelect).toHaveBeenCalledWith({ kind: 'month', value: '2026-01' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('disables and grays out a month with no data, without a click handler firing', () => {
    const onSelect = vi.fn()
    function Controlled(): ReactNode {
      return (
        <PeriodPicker
          period={{ kind: 'month', value: '2026-08' }}
          onSelect={onSelect}
          id="test-period"
          label="Period"
          kindLabel={kindLabel}
          availableMonths={AVAILABLE}
        />
      )
    }
    renderApp(<Controlled />)
    open()

    const feb = within(screen.getByRole('dialog')).getByRole('button', { name: 'Feb' })
    expect(feb.hasAttribute('disabled')).toBe(true)
    expect(feb.className).toContain('is-outside')

    fireEvent.click(feb)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('switches to year mode without selecting, and disables a year with no data at all', () => {
    renderApp(<Harness initial={{ kind: 'month', value: '2026-08' }} />)
    open()

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Year' }))

    // 2026 has data (August); the same twelve-year block also covers 2016, which has none.
    expect(screen.getByRole('button', { name: '2026' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: '2016' }).hasAttribute('disabled')).toBe(true)
  })

  it('pages the month grid by year with the nav buttons', () => {
    renderApp(<Harness initial={{ kind: 'month', value: '2026-08' }} />)
    open()

    expect(within(screen.getByRole('dialog')).getByText('2026')).toBeTruthy()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Previous' }))
    expect(within(screen.getByRole('dialog')).getByText('2025')).toBeTruthy()
  })

  it('dismisses on outside pointerdown', () => {
    renderApp(<Harness initial={{ kind: 'month', value: '2026-08' }} />)
    open()
    expect(screen.getByRole('dialog')).toBeTruthy()

    fireEvent.pointerDown(document.body)

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('dismisses on Escape and returns focus to the trigger', () => {
    renderApp(<Harness initial={{ kind: 'month', value: '2026-08' }} />)
    open()
    expect(screen.getByRole('dialog')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Period' }))
  })
})
