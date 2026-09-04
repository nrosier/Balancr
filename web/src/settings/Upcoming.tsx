/**
 * The one place to say what's coming up (#217).
 *
 * A single running free-text note, not a list of dated line items: the owner already
 * knows a dentist bill or an annual renewal is coming, and a form asking for a category
 * and an amount and a date is a form that has to be kept accurate as plans shift. Plain
 * text is always accurate, because there is nothing in it to go stale except the words
 * themselves. `BudgetNudge` (on the Insights page) is the only reader — this panel only
 * writes.
 *
 * Same draft-state shape as `HouseholdPanel`'s `selfLabel` field: `useState<string | null>`
 * for "untouched" versus "whatever is stored", reset to `null` once the save the draft
 * describes has actually happened.
 */
import { useState, type ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { Issue, Panel } from './Panel.tsx'
import type { SettingsPanelProps } from './state.ts'

const UPCOMING_NOTE_MAX_CHARS = 1000

export function UpcomingPanel({ settings, state, owner }: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const locked = !owner || state.busy

  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? settings.ai.upcomingNote
  const tooLong = text.length > UPCOMING_NOTE_MAX_CHARS

  const submit = (): void => {
    state.save('upcoming-note', 'PATCH', '/api/settings/upcoming-note', { text: text.trim() }, () => {
      setDraft(null)
    })
  }

  return (
    <Panel
      title={t('settings:ai.upcomingNote.title')}
      hint={t('settings:ai.upcomingNote.hint')}
      notice={owner ? null : <p className="panel__meta muted">{t('settings:viewerOnly')}</p>}
    >
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="field">
          <label className="field__label" htmlFor="upcoming-note">
            {t('settings:ai.upcomingNote.label')}
          </label>
          <textarea
            id="upcoming-note"
            className="field__input"
            rows={4}
            maxLength={UPCOMING_NOTE_MAX_CHARS + 200}
            placeholder={t('settings:ai.upcomingNote.placeholder')}
            value={text}
            disabled={locked}
            onChange={(event) => setDraft(event.target.value)}
          />
          <p className="panel__meta muted">
            {t('settings:ai.upcomingNote.count', { count: text.length, max: UPCOMING_NOTE_MAX_CHARS })}
          </p>
        </div>

        <Issue message={state.issue('text')} />

        <button
          type="submit"
          className="button button--primary"
          disabled={locked || draft === null || tooLong}
        >
          {state.pending === 'upcoming-note' ? t('shell.loading') : t('action.save')}
        </button>
      </form>
    </Panel>
  )
}
