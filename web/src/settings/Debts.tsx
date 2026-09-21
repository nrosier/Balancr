/**
 * Revolving debt — a credit card, a store card (#442). Split from #441 rather than
 * folded into it, because the two are not the same shape of fact:
 *
 *  - **A loan has a schedule; a revolving balance does not.** `Loans.tsx` re-anchors a
 *    principal, a rate and a term and reads back an amortized balance and a payoff date.
 *    There is no equivalent schedule here — a card balance goes up and down with
 *    spending and payments between statements, and the owner's own confirmed figure is
 *    the only honest answer. Nothing here amortizes and nothing projects a payoff.
 *  - **The APR is optional and only ever estimates one month forward.** `estimatedMonthlyInterestCents`
 *    (`domain/debt/vocabulary.ts`, through `shared.ts`) reads the rate that would apply
 *    *if* it held for exactly one statement — it is not a forecast, and the read-back
 *    says so.
 *
 * Otherwise the same shape as `Loans.tsx`: one row per stored debt with a server-assigned
 * id, so add/edit/remove are `POST`, `PATCH /:id` and `DELETE /:id` naming one row, and
 * removing a stored row is a request rather than a local edit.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { useT } from '../i18n.ts'
import {
  debtKinds,
  estimatedMonthlyInterestCents,
  formatBp,
  formatMoney,
  MAX_DEBTS,
  parseMoneyToCents,
  type Debt,
  type DebtKind,
  type DebtSetting,
} from '../shared.ts'
import { Issue, Panel } from './Panel.tsx'
import type { SettingsPanelProps } from './state.ts'

/** One debt's row while it is being typed: every box is text until it parses. */
interface Draft {
  /** React's key and nothing else — stable across edits, including for an unsaved row. */
  key: string
  /** The server's id, or null for a row that has never been saved. */
  id: string | null
  kind: DebtKind
  label: string
  balanceCents: string
  minimumPaymentCents: string
  /** Empty means "no rate entered", not zero — see `aprBp`'s own doc comment. */
  aprBp: string
}

const draftOf = (debt: DebtSetting): Draft => ({
  key: debt.id,
  id: debt.id,
  kind: debt.kind,
  label: debt.label,
  balanceCents: formatMoney(debt.balanceCents),
  minimumPaymentCents: formatMoney(debt.minimumPaymentCents),
  aprBp: debt.aprBp === null ? '' : String(debt.aprBp),
})

/** A whole basis point, bounded at 100% — the schema's own ceiling. Empty parses as null. */
function parseAprBp(raw: string): { value: number | null; ok: boolean } {
  const trimmed = raw.trim()
  if (trimmed === '') return { value: null, ok: true }
  if (!/^\d{1,5}$/.test(trimmed)) return { value: null, ok: false }
  const value = Number(trimmed)
  return value <= 10_000 ? { value, ok: true } : { value: null, ok: false }
}

/**
 * The row as a `Debt`, or null when something in it isn't a number yet.
 *
 * A whole `Debt` rather than the request body, so the read-back below can run the
 * same `estimatedMonthlyInterestCents` the portfolio page will, off the row as typed.
 * `id` is the empty string for an unsaved draft — the arithmetic never reads it, and
 * the request that creates the row doesn't carry one.
 */
function parseRow(row: Draft): Debt | null {
  const balanceCents = parseMoneyToCents(row.balanceCents)
  const minimumPaymentCents = parseMoneyToCents(row.minimumPaymentCents)
  const apr = parseAprBp(row.aprBp)

  if (balanceCents === null || minimumPaymentCents === null || !apr.ok) return null

  return {
    id: row.id ?? '',
    kind: row.kind,
    label: row.label.trim(),
    balanceCents,
    minimumPaymentCents,
    aprBp: apr.value,
  }
}

/** The body both writes send: the whole debt, minus the id the URL already carries. */
const bodyOf = (debt: Debt): Omit<Debt, 'id'> => ({
  kind: debt.kind,
  label: debt.label,
  balanceCents: debt.balanceCents,
  minimumPaymentCents: debt.minimumPaymentCents,
  aprBp: debt.aprBp,
})

const sameDraft = (a: Draft, b: Draft): boolean =>
  JSON.stringify({ ...a, key: '' }) === JSON.stringify({ ...b, key: '' })

export function DebtsPanel({ settings, state, owner }: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const { debts } = settings
  const locked = !owner || state.busy

  const [drafts, setDrafts] = useState<Draft[] | null>(null)
  // Memoized so an unrelated re-render (another panel's `state.busy` toggling) doesn't
  // regenerate the rows and remount every sub-form mid-edit.
  const stored = useMemo(() => debts.map(draftOf), [debts])
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
        ? (['POST', '/api/settings/debts'] as const)
        : (['PATCH', `/api/settings/debts/${row.id}`] as const)
    state.save('debts', method, path, bodyOf(parsed), () => {
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
    state.save('debts', 'DELETE', `/api/settings/debts/${row.id}`, undefined, () => {
      setDrafts(null)
    })
  }

  const add = (): void => {
    setDrafts([
      ...rows,
      {
        key: crypto.randomUUID(),
        id: null,
        kind: 'creditCard',
        label: '',
        balanceCents: '',
        minimumPaymentCents: '',
        aprBp: '',
      },
    ])
  }

  return (
    <Panel
      title={t('settings:debts.title')}
      hint={t('settings:debts.hint')}
      notice={owner ? null : <p className="panel__meta muted">{t('settings:viewerOnly')}</p>}
    >
      <form
        className="debts-form"
        onSubmit={(event) => {
          // Nothing submits the form as a whole: each row is its own request, and the
          // buttons below say so. Prevented rather than left to reload the page.
          event.preventDefault()
        }}
      >
        {rows.length === 0 ? (
          <p className="muted">{t('settings:debts.none')}</p>
        ) : (
          <ul className="debts">
            {rows.map((row, index) => {
              const parsed = parseRow(row)
              const before = storedByKey.get(row.key)
              const dirty = before === undefined || !sameDraft(before, row)

              const interestCents = parsed === null ? null : estimatedMonthlyInterestCents(parsed)
              const reads: string[] =
                parsed === null
                  ? [t('settings:debts.invalid')]
                  : [
                      interestCents === null
                        ? t('settings:debts.interestUnknown')
                        : t('settings:debts.interestReads', {
                            value: formatMoney(interestCents),
                          }),
                    ]

              return (
                <li className="debt" key={row.key}>
                  <div className="debt__fields">
                    <div className="field">
                      <label className="field__label" htmlFor={`debt-kind-${row.key}`}>
                        {t('settings:debts.kindLabel')}
                      </label>
                      <select
                        id={`debt-kind-${row.key}`}
                        className="field__input"
                        value={row.kind}
                        disabled={locked}
                        onChange={(event) => edit(index, { kind: event.target.value as DebtKind })}
                      >
                        {debtKinds.map((kind) => (
                          <option key={kind} value={kind}>
                            {t(`settings:debts.kind.${kind}`)}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="field">
                      <label className="field__label" htmlFor={`debt-label-${row.key}`}>
                        {t('settings:debts.label')}
                      </label>
                      <input
                        id={`debt-label-${row.key}`}
                        className="field__input"
                        type="text"
                        autoComplete="off"
                        maxLength={80}
                        placeholder={t('settings:debts.labelPlaceholder')}
                        value={row.label}
                        disabled={locked}
                        onChange={(event) => edit(index, { label: event.target.value })}
                      />
                    </div>

                    <div className="field">
                      <label className="field__label" htmlFor={`debt-balance-${row.key}`}>
                        {t('settings:debts.balance')}
                      </label>
                      <input
                        id={`debt-balance-${row.key}`}
                        className="field__input num"
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        value={row.balanceCents}
                        disabled={locked}
                        onChange={(event) => edit(index, { balanceCents: event.target.value })}
                      />
                    </div>

                    <div className="field">
                      <label className="field__label" htmlFor={`debt-minimum-${row.key}`}>
                        {t('settings:debts.minimumPayment')}
                      </label>
                      <input
                        id={`debt-minimum-${row.key}`}
                        className="field__input num"
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        value={row.minimumPaymentCents}
                        disabled={locked}
                        onChange={(event) =>
                          edit(index, { minimumPaymentCents: event.target.value })
                        }
                      />
                    </div>

                    <div className="field">
                      <label className="field__label" htmlFor={`debt-apr-${row.key}`}>
                        {t('settings:debts.apr')}
                      </label>
                      <input
                        id={`debt-apr-${row.key}`}
                        className="field__input num"
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        placeholder={t('settings:debts.aprPlaceholder')}
                        value={row.aprBp}
                        disabled={locked}
                        onChange={(event) => edit(index, { aprBp: event.target.value })}
                      />
                      <p className="debt__reads muted">
                        {row.aprBp.trim() === ''
                          ? t('settings:debts.aprHint')
                          : parseAprBp(row.aprBp).ok
                            ? t('settings:debts.aprReads', {
                                value: formatBp(Number(row.aprBp), { maxFractionDigits: 2 }),
                              })
                            : t('settings:debts.invalid')}
                      </p>
                    </div>
                  </div>

                  <div className="debt__reads">
                    {reads.map((line) => (
                      <p className="muted" key={line}>
                        {line}
                      </p>
                    ))}
                  </div>

                  <div className="debts__actions">
                    <button
                      type="button"
                      className="button button--primary"
                      disabled={locked || parsed === null || !dirty}
                      onClick={() => submit(row)}
                    >
                      {row.id === null ? t('settings:debts.create') : t('settings:debts.save')}
                    </button>
                    <button
                      type="button"
                      className="button button--quiet"
                      disabled={locked}
                      onClick={() => remove(row)}
                    >
                      {t('settings:debts.remove')}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        <Issue message={state.issue('balanceCents')} />

        <div className="debts__actions">
          <button
            type="button"
            className="button button--quiet"
            disabled={locked || rows.length >= MAX_DEBTS}
            onClick={add}
          >
            {t('settings:debts.add')}
          </button>
        </div>
      </form>
    </Panel>
  )
}
