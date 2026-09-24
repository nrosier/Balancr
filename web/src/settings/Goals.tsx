/**
 * A household-stated savings goal (#407): a target amount and, optionally, a target
 * date, measured against one of Balancr's own already-computed net-worth figures, or
 * (#407 extension) against one Actual Budget envelope's own rolling balance.
 *
 * The same shape as `Debts.tsx`: one row per stored goal with a server-assigned id,
 * so add/edit/remove are `POST`, `PATCH /:id` and `DELETE /:id` naming one row, and
 * removing a stored row is a request rather than a local edit. Simpler still than a
 * debt, because there is nothing to read back here: a goal has no `currentCents` of
 * its own (see `domain/goal/vocabulary.ts`) — its progress is computed fresh off net
 * worth (or a category's pooled balance), and that computation belongs to the
 * overview/budget cards, not this form.
 *
 * `status`/`doneAt` never travel through the same `POST`/`PATCH` as everything else —
 * they only ever change via the two dedicated, immediate routes below (`.../done`,
 * `.../reactivate`), the same reasoning `updateGoal`'s own doc comment gives for why
 * they are not folded into a whole-row replace.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { useT } from '../i18n.ts'
import {
  formatDate,
  formatMoney,
  goalKinds,
  goalPriorities,
  MAX_GOALS,
  parseMoneyToCents,
  type Goal,
  type GoalKind,
  type GoalPriority,
  type GoalSetting,
  type GoalStatus,
} from '../shared.ts'
import { Issue, Panel } from './Panel.tsx'
import type { SettingsPanelProps } from './state.ts'

/** One goal's row while it is being typed: every box is text until it parses. */
interface Draft {
  /** React's key and nothing else — stable across edits, including for an unsaved row. */
  key: string
  /** The server's id, or null for a row that has never been saved. */
  id: string | null
  kind: GoalKind
  /** Actual's own category id — set iff `kind === 'category'`. */
  categoryId: string | null
  priority: GoalPriority
  label: string
  targetCents: string
  /** Empty means "no target date" — a supported goal for a net-worth kind. */
  targetDate: string
  /** Read-only here — see the module doc comment for why. */
  status: GoalStatus
  doneAt: string | null
}

const draftOf = (goal: GoalSetting): Draft => ({
  key: goal.id,
  id: goal.id,
  kind: goal.kind,
  categoryId: goal.categoryId,
  priority: goal.priority,
  label: goal.label,
  targetCents: formatMoney(goal.targetCents),
  targetDate: goal.targetDate ?? '',
  status: goal.status,
  doneAt: goal.doneAt,
})

/**
 * The row as a `Goal`, minus `createdAt` — a draft never has one to state, and the
 * write path below (`bodyOf`) never sends it either — or null when something in it
 * isn't valid yet: not a number, or a category-kind goal missing the category or
 * target date it requires.
 *
 * `id` is the empty string for an unsaved draft — the request that creates the row
 * doesn't carry one.
 */
function parseRow(row: Draft): Omit<Goal, 'createdAt'> | null {
  const targetCents = parseMoneyToCents(row.targetCents)
  if (targetCents === null || targetCents <= 0) return null

  const targetDate = row.targetDate.trim() === '' ? null : row.targetDate.trim()
  if (row.kind === 'category' && (row.categoryId === null || targetDate === null)) return null

  return {
    id: row.id ?? '',
    kind: row.kind,
    categoryId: row.kind === 'category' ? row.categoryId : null,
    priority: row.priority,
    label: row.label.trim(),
    targetCents,
    targetDate,
    status: row.status,
    doneAt: row.doneAt,
  }
}

/**
 * The body both writes send: the whole goal, minus the id the URL already carries
 * and minus `status`/`doneAt` — `goalRequest` on the server deliberately has no
 * such fields, per the module doc comment.
 */
const bodyOf = (goal: Omit<Goal, 'createdAt'>): Omit<Goal, 'id' | 'status' | 'doneAt' | 'createdAt'> => ({
  kind: goal.kind,
  categoryId: goal.categoryId,
  priority: goal.priority,
  label: goal.label,
  targetCents: goal.targetCents,
  targetDate: goal.targetDate,
})

const sameDraft = (a: Draft, b: Draft): boolean =>
  JSON.stringify({ ...a, key: '' }) === JSON.stringify({ ...b, key: '' })

export function GoalsPanel({ settings, state, owner }: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const { goals } = settings
  const locked = !owner || state.busy

  const [drafts, setDrafts] = useState<Draft[] | null>(null)
  // Memoized so an unrelated re-render (another panel's `state.busy` toggling) doesn't
  // regenerate the rows and remount every sub-form mid-edit.
  const stored = useMemo(() => goals.map(draftOf), [goals])
  const rows = drafts ?? stored
  const storedByKey = useMemo(() => new Map(stored.map((row) => [row.key, row])), [stored])

  const edit = (index: number, patch: Partial<Draft>): void => {
    setDrafts(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)))
  }

  /** Create or replace, depending on whether the server has ever seen this row. */
  const submit = (row: Draft): void => {
    const parsed = parseRow(row)
    if (parsed === null) return
    const [method, path] =
      row.id === null
        ? (['POST', '/api/settings/goals'] as const)
        : (['PATCH', `/api/settings/goals/${row.id}`] as const)
    state.save('goals', method, path, bodyOf(parsed), () => {
      // Back to the server's own list: the response carries the row it just wrote,
      // including the id a create assigned, so a local copy is only a second answer.
      setDrafts(null)
    })
  }

  const remove = (row: Draft): void => {
    if (row.id === null) {
      setDrafts(rows.filter((candidate) => candidate.key !== row.key))
      return
    }
    state.save('goals', 'DELETE', `/api/settings/goals/${row.id}`, undefined, () => {
      setDrafts(null)
    })
  }

  const add = (): void => {
    setDrafts([
      ...rows,
      {
        key: crypto.randomUUID(),
        id: null,
        kind: 'liquid',
        categoryId: null,
        priority: 'normal',
        label: '',
        targetCents: '',
        targetDate: '',
        status: 'active',
        doneAt: null,
      },
    ])
  }

  const markDone = (row: Draft): void => {
    if (row.id === null) return
    state.save('goals', 'POST', `/api/settings/goals/${row.id}/done`, undefined, () => {
      setDrafts(null)
    })
  }

  const reactivate = (row: Draft): void => {
    if (row.id === null) return
    state.save('goals', 'POST', `/api/settings/goals/${row.id}/reactivate`, undefined, () => {
      setDrafts(null)
    })
  }

  const active = rows.filter((row) => row.status === 'active')
  const archived = rows.filter((row) => row.status === 'done')
  const [showArchived, setShowArchived] = useState(false)

  // Excludes income envelopes — a goal has nothing to save toward there — but keeps
  // hidden ones: a hidden envelope is still a valid target, same as `categoryMeta`
  // already treats it everywhere else.
  const categoryOptions = useMemo(
    () => settings.categoryTranslations.filter((category) => !category.isIncome),
    [settings.categoryTranslations],
  )

  const renderFields = (row: Draft, index: number): ReactNode => (
    <div className="goal__fields">
      <div className="field">
        <label className="field__label" htmlFor={`goal-label-${row.key}`}>
          {t('settings:goals.label')}
        </label>
        <input
          id={`goal-label-${row.key}`}
          className="field__input"
          type="text"
          autoComplete="off"
          maxLength={80}
          placeholder={t('settings:goals.labelPlaceholder')}
          value={row.label}
          disabled={locked}
          onChange={(event) => edit(index, { label: event.target.value })}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`goal-kind-${row.key}`}>
          {t('settings:goals.kindLabel')}
        </label>
        <select
          id={`goal-kind-${row.key}`}
          className="field__input"
          value={row.kind}
          disabled={locked}
          onChange={(event) =>
            edit(index, {
              kind: event.target.value as GoalKind,
              // Switching away from `category` drops a categoryId that would
              // otherwise fail the symmetric refine (`categoryId` set for, and
              // only for, a category-kind goal).
              categoryId: event.target.value === 'category' ? row.categoryId : null,
            })
          }
        >
          {goalKinds.map((kind) => (
            <option key={kind} value={kind}>
              {t(`settings:goals.kind.${kind}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`goal-category-${row.key}`}>
          {t('settings:goals.categoryLabel')}
        </label>
        <select
          id={`goal-category-${row.key}`}
          className="field__input"
          value={row.categoryId ?? ''}
          disabled={locked || row.kind !== 'category'}
          onChange={(event) =>
            edit(index, { categoryId: event.target.value === '' ? null : event.target.value })
          }
        >
          <option value="">{t('settings:goals.categoryPlaceholder')}</option>
          {categoryOptions.map((category) => (
            <option key={category.categoryId} value={category.categoryId}>
              {category.categoryName}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`goal-priority-${row.key}`}>
          {t('settings:goals.priorityLabel')}
        </label>
        <select
          id={`goal-priority-${row.key}`}
          className="field__input"
          value={row.priority}
          disabled={locked}
          onChange={(event) => edit(index, { priority: event.target.value as GoalPriority })}
        >
          {goalPriorities.map((priority) => (
            <option key={priority} value={priority}>
              {t(`settings:goals.priority.${priority}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`goal-target-${row.key}`}>
          {t('settings:goals.target')}
        </label>
        <input
          id={`goal-target-${row.key}`}
          className="field__input num"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={row.targetCents}
          disabled={locked}
          onChange={(event) => edit(index, { targetCents: event.target.value })}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`goal-date-${row.key}`}>
          {t('settings:goals.targetDate')}
        </label>
        <input
          id={`goal-date-${row.key}`}
          className="field__input"
          type="date"
          value={row.targetDate}
          disabled={locked}
          onChange={(event) => edit(index, { targetDate: event.target.value })}
        />
        <p className="goal__reads muted">
          {row.kind === 'category'
            ? t('settings:goals.targetDateHintCategory')
            : t('settings:goals.targetDateHint')}
        </p>
      </div>
    </div>
  )

  return (
    <Panel
      title={t('settings:goals.title')}
      hint={t('settings:goals.hint')}
      notice={owner ? null : <p className="panel__meta muted">{t('settings:viewerOnly')}</p>}
    >
      <form
        className="goals-form"
        onSubmit={(event) => {
          // Nothing submits the form as a whole: each row is its own request, and the
          // buttons below say so. Prevented rather than left to reload the page.
          event.preventDefault()
        }}
      >
        {active.length === 0 ? (
          <p className="muted">{t('settings:goals.none')}</p>
        ) : (
          <ul className="goals">
            {active.map((row) => {
              const index = rows.indexOf(row)
              const parsed = parseRow(row)
              const before = storedByKey.get(row.key)
              const dirty = before === undefined || !sameDraft(before, row)

              return (
                <li className="goal" key={row.key}>
                  {renderFields(row, index)}

                  {parsed === null && (
                    <p className="goal__reads muted">{t('settings:goals.invalid')}</p>
                  )}

                  <div className="goals__actions">
                    <button
                      type="button"
                      className="button button--primary"
                      disabled={locked || parsed === null || !dirty}
                      onClick={() => submit(row)}
                    >
                      {row.id === null ? t('settings:goals.create') : t('settings:goals.save')}
                    </button>
                    {row.id !== null && (
                      <button
                        type="button"
                        className="button button--quiet"
                        disabled={locked}
                        onClick={() => markDone(row)}
                      >
                        {t('settings:goals.done')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="button button--quiet"
                      disabled={locked}
                      onClick={() => remove(row)}
                    >
                      {t('settings:goals.remove')}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        <Issue message={state.issue('targetCents')} />

        <div className="goals__actions">
          <button
            type="button"
            className="button button--quiet"
            disabled={locked || active.length >= MAX_GOALS}
            onClick={add}
          >
            {t('settings:goals.add')}
          </button>
        </div>
      </form>

      {archived.length > 0 && (
        <div className="goals-archive">
          <button
            type="button"
            className="status__disclosureButton"
            aria-expanded={showArchived}
            onClick={() => setShowArchived((current) => !current)}
          >
            {t('settings:goals.archive.toggle', { count: archived.length })}
          </button>
          {showArchived && (
            <ul className="goals">
              {archived.map((row) => (
                <li className="goal goal--archived" key={row.key}>
                  <p className="goal__reads">{row.label}</p>
                  <p className="goal__reads muted num">{row.targetCents}</p>
                  {row.doneAt !== null && (
                    <p className="goal__reads muted">
                      {t('settings:goals.archive.doneOn', { date: formatDate(row.doneAt) })}
                    </p>
                  )}
                  <div className="goals__actions">
                    <button
                      type="button"
                      className="button button--quiet"
                      disabled={locked}
                      onClick={() => reactivate(row)}
                    >
                      {t('settings:goals.reactivate')}
                    </button>
                    <button
                      type="button"
                      className="button button--quiet"
                      disabled={locked}
                      onClick={() => remove(row)}
                    >
                      {t('settings:goals.remove')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Panel>
  )
}
