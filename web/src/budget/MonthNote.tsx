/**
 * A month's own note, its own tab on the Budget page (#217, redesigned per-month by
 * #270, moved off the shared toolbar into its own section per follow-up feedback).
 *
 * Not a warning about the future — context for a specific month, most often the
 * current one: "the dishwasher broke, that's why household appliances is high this
 * month." `budget-nudge.ts` (Insights page) reads whichever month it is nudging.
 *
 * Self-contained, on `BudgetNudge.tsx`'s pattern rather than `useSettingsState`'s:
 * this card has its own resource (one note, keyed by the month currently shown) and
 * its own save, and neither reaches the page's main `/api/budget` payload.
 *
 * **The stepper is disabled while a draft is unsaved.** Direct lesson from #268: an
 * unsaved edit in one Benchmark tab was silently discarded by switching to another.
 * Stepping a month here swaps which note is being edited exactly the same way a tab
 * switch swapped which household draft was live, so the same guard applies.
 */
import { useState, type ReactNode } from 'react'
import { ApiError, apiSend } from '../api/client.ts'
import { useCsrf } from '../api/csrf.tsx'
import { useResource, useSessionExpiry } from '../api/resource.tsx'
import { useT } from '../i18n.ts'
import { formatMonth } from '../shared.ts'
import { Issue, Panel } from '../settings/Panel.tsx'

const MONTH_NOTE_MAX_CHARS = 1000

export interface MonthNotePanelProps {
  /** `data.month` from the main `/api/budget` payload — the month on screen when this mounts. */
  initialMonth: string
  owner: boolean
}

/** Plain `YYYY-MM` arithmetic, local to this file rather than pulling the server's
 * `util/month.ts` into the client bundle for one `+1`/`-1` step. */
function shiftMonth(month: string, delta: number): string {
  const year = Number(month.slice(0, 4))
  const index = Number(month.slice(5, 7)) - 1 + delta
  const shifted = new Date(Date.UTC(year, index, 1))
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`
}

export function MonthNotePanel({ initialMonth, owner }: MonthNotePanelProps): ReactNode {
  const { t, language } = useT()
  const csrf = useCsrf()
  const expired = useSessionExpiry()
  const [month, setMonth] = useState(initialMonth)
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<ApiError | null>(null)

  const resource = useResource<{ text: string }>(`/api/budget/note?month=${month}`)
  const text = draft ?? resource.data?.text ?? ''
  const tooLong = text.length > MONTH_NOTE_MAX_CHARS
  const locked = !owner || busy

  const step = (delta: number): void => {
    if (draft !== null) return
    setFailure(null)
    setMonth(shiftMonth(month, delta))
  }

  const submit = (): void => {
    setBusy(true)
    setFailure(null)
    void apiSend<{ text: string }>('PATCH', '/api/budget/note', { month, text: text.trim() }, csrf)
      .then(() => {
        setBusy(false)
        setDraft(null)
        resource.reload()
      })
      .catch((cause: unknown) => {
        setBusy(false)
        const error =
          cause instanceof ApiError
            ? cause
            : new ApiError('network_error', 'Balancr could not be reached.', 0, null)
        if (error.code === 'unauthenticated') expired()
        else setFailure(error)
      })
  }

  return (
    <Panel
      title={t('budget:monthNote.title')}
      hint={t('budget:monthNote.hint')}
      notice={owner ? null : <p className="panel__meta muted">{t('settings:viewerOnly')}</p>}
    >
      <form className="stack" onSubmit={(event) => { event.preventDefault(); submit() }}>
        <div className="toolbar">
          <button
            type="button"
            className="button button--quiet"
            aria-label={t('budget:monthNote.stepper.previous')}
            disabled={draft !== null}
            onClick={() => step(-1)}
          >
            ‹
          </button>
          <span className="muted">{formatMonth(month, language)}</span>
          <button
            type="button"
            className="button button--quiet"
            aria-label={t('budget:monthNote.stepper.next')}
            disabled={draft !== null}
            onClick={() => step(1)}
          >
            ›
          </button>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="month-note">
            {t('budget:monthNote.label', { month: formatMonth(month, language) })}
          </label>
          <textarea
            id="month-note"
            className="field__input"
            rows={4}
            maxLength={MONTH_NOTE_MAX_CHARS + 200}
            placeholder={t('budget:monthNote.placeholder')}
            value={text}
            disabled={locked}
            onChange={(event) => setDraft(event.target.value)}
          />
          <p className="panel__meta muted">
            {t('budget:monthNote.count', { count: text.length, max: MONTH_NOTE_MAX_CHARS })}
          </p>
        </div>

        {failure === null ? null : (
          <p className="notice notice--warn" role="status">
            {failure.message}
          </p>
        )}
        <Issue message={failure?.issues.find((candidate) => candidate.path === 'text')?.message} />

        <button type="submit" className="button button--primary" disabled={locked || draft === null || tooLong}>
          {busy ? t('shell.loading') : t('action.save')}
        </button>
      </form>
    </Panel>
  )
}
