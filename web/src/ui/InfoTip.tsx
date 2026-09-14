/**
 * A small "i" trigger next to a label that reveals a short explanation on hover,
 * focus or click (#346) — the app's first reusable info/tooltip primitive. Neither
 * `Panel`'s `hint` prop nor the `aria-describedby` pattern in `settings/Benchmark.tsx`
 * fits here: both are permanent prose under a field, not something a reader can
 * reveal and dismiss on demand next to a specific value.
 *
 * Dismissal on outside click/Escape mirrors `PeriodPicker.tsx`'s own handling —
 * the one existing precedent in this codebase for "opens on interaction, closes on
 * Escape or outside click" — as a safety net for the cases hover-leave/blur miss
 * (e.g. focus staying put after a click elsewhere already blurred nothing, or a
 * screen reader user pressing Escape rather than hunting for the trigger again).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useT } from '../i18n.ts'
import './info-tip.css'

export interface InfoTipProps {
  /** id given to the popover text node; referenced by aria-describedby while open. */
  id: string
  text: string
}

export function InfoTip({ id, text }: InfoTipProps): ReactNode {
  const { t } = useT()
  const rootRef = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent): void {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <span className="info-tip" ref={rootRef}>
      <button
        type="button"
        className="info-tip__trigger"
        aria-label={t('action.moreInfo')}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((was) => !was)}
      >
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <circle cx="10" cy="10" r="7.5" />
          <path d="M10 9v4.2" />
          <circle cx="10" cy="6.4" r="0.6" fill="currentColor" stroke="none" />
        </svg>
      </button>
      {open ? (
        <span id={id} role="tooltip" className="info-tip__bubble">
          {text}
        </span>
      ) : null}
    </span>
  )
}
