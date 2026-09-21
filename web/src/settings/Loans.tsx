/**
 * Debt with a fixed schedule that isn't a mortgage — a car loan, a personal loan (#441).
 *
 * The same shape of form as `Property.tsx`, and deliberately so: a principal, a rate, a
 * term and a payment are what both ask for, the read-backs are computed locally from the
 * same amortization the server uses (`domain/loan/amortization.ts`, through `shared.ts`),
 * and the rate is a plain integer in basis points with a caption saying what it reads as.
 * Two things are different, and both follow from a loan being a real table row rather than
 * an entry in one settings blob:
 *
 *  - **One row at a time, not the whole list.** A loan has a server-assigned id, so
 *    "add", "edit" and "remove" are `POST`, `PATCH /:id` and `DELETE /:id` naming one
 *    loan. `Property.tsx` replaces its whole list because a row inside a blob cannot be
 *    addressed; here it can, and a whole-list write would make editing one loan a rewrite
 *    of every other one — the shape that loses somebody else's concurrent edit.
 *  - **Remove is a request, not a local edit plus a save.** Dropping an unsaved draft is
 *    local; dropping a stored loan is the one `DELETE` on this page.
 *
 * Re-anchoring rather than a rate-history table, exactly as for a mortgage: when the rate,
 * payment or term changes, the owner types today's real outstanding balance in as the new
 * balance-as-of. The audit trail is what remembers what it said before.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { useT } from '../i18n.ts'
import {
  formatBp,
  formatDate,
  formatMoney,
  loanBalanceCents,
  loanKinds,
  loanPaidOffBp,
  loanPayoffDate,
  MAX_LOANS,
  parseMoneyToCents,
  standardMonthlyPaymentCents,
  type Loan,
  type LoanKind,
  type LoanSetting,
} from '../shared.ts'
import { Issue, Panel } from './Panel.tsx'
import type { SettingsPanelProps } from './state.ts'

/** One loan's row while it is being typed: every box is text until it parses. */
interface Draft {
  /** React's key and nothing else — stable across edits, including for an unsaved row. */
  key: string
  /** The server's id, or null for a row that has never been saved. */
  id: string | null
  kind: LoanKind
  label: string
  openingDate: string
  principalCents: string
  anchorDate: string
  rateBp: string
  monthlyPaymentCents: string
  remainingTermMonths: string
  /** Empty means "not entered", not zero — see `originalPrincipalCents`'s own doc comment. */
  originalPrincipalCents: string
  /** Empty means nothing voluntary is being paid on top, which is not the same as zero. */
  extraMonthlyPaymentCents: string
}

const draftOf = (loan: LoanSetting): Draft => ({
  key: loan.id,
  id: loan.id,
  kind: loan.kind,
  label: loan.label,
  openingDate: loan.openingDate,
  principalCents: formatMoney(loan.principalCents),
  anchorDate: loan.anchorDate,
  rateBp: String(loan.rateBp),
  monthlyPaymentCents: formatMoney(loan.monthlyPaymentCents),
  remainingTermMonths: String(loan.remainingTermMonths),
  originalPrincipalCents:
    loan.originalPrincipalCents === null ? '' : formatMoney(loan.originalPrincipalCents),
  extraMonthlyPaymentCents:
    loan.extraMonthlyPaymentCents === null ? '' : formatMoney(loan.extraMonthlyPaymentCents),
})

/** A whole basis point, bounded at 50% — the schema's own ceiling on a fat-fingered rate. */
function parseRateBp(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^\d{1,4}$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value <= 5_000 ? value : null
}

/** Whole months, bounded at 600 (50 years) — the schema's own ceiling. */
function parseTermMonths(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^\d{1,3}$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value <= 600 ? value : null
}

/** An optional amount: absent is `null`, present must parse. */
function parseOptionalCents(raw: string): { value: number | null; ok: boolean } {
  const trimmed = raw.trim()
  if (trimmed === '') return { value: null, ok: true }
  const parsed = parseMoneyToCents(trimmed)
  return parsed === null ? { value: null, ok: false } : { value: parsed, ok: true }
}

/**
 * The row as a `Loan`, or null when something in it isn't a number yet.
 *
 * A whole `Loan` rather than the request body, so the read-backs below can run the same
 * `loanBalanceCents`/`loanPayoffDate` the portfolio page will, off the row as typed. `id`
 * is the empty string for an unsaved draft — the arithmetic never reads it, and the
 * request that creates the row doesn't carry one.
 */
function parseRow(row: Draft): Loan | null {
  const principalCents = parseMoneyToCents(row.principalCents)
  const monthlyPaymentCents = parseMoneyToCents(row.monthlyPaymentCents)
  const rateBp = parseRateBp(row.rateBp)
  const remainingTermMonths = parseTermMonths(row.remainingTermMonths)
  const original = parseOptionalCents(row.originalPrincipalCents)
  const extra = parseOptionalCents(row.extraMonthlyPaymentCents)
  const openingDate = row.openingDate.trim()
  const anchorDate = row.anchorDate.trim()

  if (
    principalCents === null ||
    monthlyPaymentCents === null ||
    rateBp === null ||
    remainingTermMonths === null ||
    !original.ok ||
    !extra.ok ||
    openingDate === '' ||
    anchorDate === ''
  ) {
    return null
  }

  return {
    id: row.id ?? '',
    kind: row.kind,
    label: row.label.trim(),
    openingDate,
    principalCents,
    anchorDate,
    rateBp,
    monthlyPaymentCents,
    remainingTermMonths,
    originalPrincipalCents: original.value,
    extraMonthlyPaymentCents: extra.value,
  }
}

/** The body both writes send: the whole loan, minus the id the URL already carries. */
const bodyOf = (loan: Loan): Omit<Loan, 'id'> => ({
  kind: loan.kind,
  label: loan.label,
  openingDate: loan.openingDate,
  principalCents: loan.principalCents,
  anchorDate: loan.anchorDate,
  rateBp: loan.rateBp,
  monthlyPaymentCents: loan.monthlyPaymentCents,
  remainingTermMonths: loan.remainingTermMonths,
  originalPrincipalCents: loan.originalPrincipalCents,
  extraMonthlyPaymentCents: loan.extraMonthlyPaymentCents,
})

const sameDraft = (a: Draft, b: Draft): boolean =>
  JSON.stringify({ ...a, key: '' }) === JSON.stringify({ ...b, key: '' })

export function LoansPanel({ settings, state, owner }: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const { loans } = settings
  const locked = !owner || state.busy
  // Not the month being aggregated — this panel has no month. Every read-back is "as of
  // right now", because that is the balance the owner would see on a statement today.
  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])

  const [drafts, setDrafts] = useState<Draft[] | null>(null)
  // Memoized so an unrelated re-render (another panel's `state.busy` toggling) doesn't
  // regenerate the rows and remount every sub-form mid-edit.
  const stored = useMemo(() => loans.map(draftOf), [loans])
  const rows = drafts ?? stored
  const storedByKey = useMemo(
    () => new Map(stored.map((row) => [row.key, row])),
    [stored],
  )

  const edit = (index: number, patch: Partial<Draft>): void => {
    setDrafts(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)))
  }

  const applyStandardPayment = (index: number): void => {
    const row = rows[index]
    if (row === undefined) return
    const principalCents = parseMoneyToCents(row.principalCents)
    const rateBp = parseRateBp(row.rateBp)
    const termMonths = parseTermMonths(row.remainingTermMonths)
    if (principalCents === null || rateBp === null || termMonths === null) return
    edit(index, {
      monthlyPaymentCents: formatMoney(standardMonthlyPaymentCents(principalCents, rateBp, termMonths)),
    })
  }

  /** Create or replace, depending on whether the server has ever seen this row. */
  const submit = (row: Draft): void => {
    const parsed = parseRow(row)
    if (parsed === null) return
    const [method, path] =
      row.id === null
        ? (['POST', '/api/settings/loans'] as const)
        : (['PATCH', `/api/settings/loans/${row.id}`] as const)
    state.save('loans', method, path, bodyOf(parsed), () => {
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
    state.save('loans', 'DELETE', `/api/settings/loans/${row.id}`, undefined, () => {
      setDrafts(null)
    })
  }

  const add = (): void => {
    setDrafts([
      ...rows,
      {
        key: crypto.randomUUID(),
        id: null,
        kind: 'car',
        label: '',
        openingDate: today,
        principalCents: '',
        anchorDate: today,
        rateBp: '',
        monthlyPaymentCents: '',
        remainingTermMonths: '',
        originalPrincipalCents: '',
        extraMonthlyPaymentCents: '',
      },
    ])
  }

  return (
    <Panel
      title={t('settings:loans.title')}
      hint={t('settings:loans.hint')}
      notice={owner ? null : <p className="panel__meta muted">{t('settings:viewerOnly')}</p>}
    >
      <form
        className="loans-form"
        onSubmit={(event) => {
          // Nothing submits the form as a whole: each row is its own request, and the
          // buttons below say so. Prevented rather than left to reload the page.
          event.preventDefault()
        }}
      >
        {rows.length === 0 ? (
          <p className="muted">{t('settings:loans.none')}</p>
        ) : (
          <ul className="loans">
            {rows.map((row, index) => {
              const parsed = parseRow(row)
              const rateBp = parseRateBp(row.rateBp)
              const canUseStandardPayment =
                parseMoneyToCents(row.principalCents) !== null &&
                rateBp !== null &&
                parseTermMonths(row.remainingTermMonths) !== null
              const before = storedByKey.get(row.key)
              const dirty = before === undefined || !sameDraft(before, row)

              const reads: string[] = []
              if (parsed === null) {
                reads.push(t('settings:loans.invalid'))
              } else {
                reads.push(
                  t('settings:loans.balanceReads', {
                    value: formatMoney(loanBalanceCents(parsed, today)),
                  }),
                )
                const paidOff = loanPaidOffBp(parsed, today)
                if (paidOff !== null) {
                  reads.push(t('settings:loans.paidOffReads', { value: formatBp(paidOff) }))
                }
                const payoff = loanPayoffDate(parsed)
                reads.push(
                  payoff === null
                    ? t('settings:loans.payoffUnknown')
                    : t('settings:loans.payoffReads', { value: formatDate(payoff) }),
                )
              }

              return (
                <li className="loan" key={row.key}>
                  <div className="loan__fields">
                    <div className="field">
                      <label className="field__label" htmlFor={`loan-kind-${row.key}`}>
                        {t('settings:loans.kindLabel')}
                      </label>
                      <select
                        id={`loan-kind-${row.key}`}
                        className="field__input"
                        value={row.kind}
                        disabled={locked}
                        onChange={(event) => edit(index, { kind: event.target.value as LoanKind })}
                      >
                        {loanKinds.map((kind) => (
                          <option key={kind} value={kind}>
                            {t(`settings:loans.kind.${kind}`)}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="field">
                      <label className="field__label" htmlFor={`loan-label-${row.key}`}>
                        {t('settings:loans.label')}
                      </label>
                      <input
                        id={`loan-label-${row.key}`}
                        className="field__input"
                        type="text"
                        autoComplete="off"
                        maxLength={80}
                        placeholder={t('settings:loans.labelPlaceholder')}
                        value={row.label}
                        disabled={locked}
                        onChange={(event) => edit(index, { label: event.target.value })}
                      />
                    </div>

                    <div className="field">
                      <label className="field__label" htmlFor={`loan-opened-${row.key}`}>
                        {t('settings:loans.openingDate')}
                      </label>
                      <input
                        id={`loan-opened-${row.key}`}
                        className="field__input"
                        type="date"
                        value={row.openingDate}
                        disabled={locked}
                        onChange={(event) => edit(index, { openingDate: event.target.value })}
                      />
                    </div>

                    <div className="field">
                      <label className="field__label" htmlFor={`loan-principal-${row.key}`}>
                        {t('settings:loans.principal')}
                      </label>
                      <input
                        id={`loan-principal-${row.key}`}
                        className="field__input num"
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        value={row.principalCents}
                        disabled={locked}
                        onChange={(event) => edit(index, { principalCents: event.target.value })}
                      />
                    </div>

                    <div className="field">
                      <label className="field__label" htmlFor={`loan-anchor-${row.key}`}>
                        {t('settings:loans.anchorDate')}
                      </label>
                      <input
                        id={`loan-anchor-${row.key}`}
                        className="field__input"
                        type="date"
                        value={row.anchorDate}
                        disabled={locked}
                        onChange={(event) => edit(index, { anchorDate: event.target.value })}
                      />
                    </div>

                    <div className="field">
                      <label className="field__label" htmlFor={`loan-rate-${row.key}`}>
                        {t('settings:loans.rate')}
                      </label>
                      <input
                        id={`loan-rate-${row.key}`}
                        className="field__input num"
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        value={row.rateBp}
                        disabled={locked}
                        onChange={(event) => edit(index, { rateBp: event.target.value })}
                      />
                      <p className="loan__reads muted">
                        {rateBp === null
                          ? t('settings:loans.invalid')
                          : t('settings:loans.rateReads', {
                              value: formatBp(rateBp, { maxFractionDigits: 2 }),
                            })}
                      </p>
                    </div>

                    <div className="field">
                      <label className="field__label" htmlFor={`loan-term-${row.key}`}>
                        {t('settings:loans.term')}
                      </label>
                      <input
                        id={`loan-term-${row.key}`}
                        className="field__input num"
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        value={row.remainingTermMonths}
                        disabled={locked}
                        onChange={(event) =>
                          edit(index, { remainingTermMonths: event.target.value })
                        }
                      />
                    </div>

                    <div className="field">
                      <label className="field__label" htmlFor={`loan-payment-${row.key}`}>
                        {t('settings:loans.payment')}
                      </label>
                      <input
                        id={`loan-payment-${row.key}`}
                        className="field__input num"
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        value={row.monthlyPaymentCents}
                        disabled={locked}
                        onChange={(event) =>
                          edit(index, { monthlyPaymentCents: event.target.value })
                        }
                      />
                      <button
                        type="button"
                        className="button button--quiet"
                        disabled={locked || !canUseStandardPayment}
                        onClick={() => applyStandardPayment(index)}
                      >
                        {t('settings:loans.useStandardPayment')}
                      </button>
                    </div>

                    <div className="field">
                      <label className="field__label" htmlFor={`loan-extra-${row.key}`}>
                        {t('settings:loans.extra')}
                      </label>
                      <input
                        id={`loan-extra-${row.key}`}
                        className="field__input num"
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        value={row.extraMonthlyPaymentCents}
                        disabled={locked}
                        onChange={(event) =>
                          edit(index, { extraMonthlyPaymentCents: event.target.value })
                        }
                      />
                      <p className="loan__reads muted">{t('settings:loans.extraHint')}</p>
                    </div>

                    <div className="field">
                      <label className="field__label" htmlFor={`loan-original-${row.key}`}>
                        {t('settings:loans.originalPrincipal')}
                      </label>
                      <input
                        id={`loan-original-${row.key}`}
                        className="field__input num"
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder={t('settings:loans.originalPrincipalPlaceholder')}
                        value={row.originalPrincipalCents}
                        disabled={locked}
                        onChange={(event) =>
                          edit(index, { originalPrincipalCents: event.target.value })
                        }
                      />
                      <p className="loan__reads muted">
                        {t('settings:loans.originalPrincipalHint')}
                      </p>
                    </div>
                  </div>

                  <div className="loan__reads">
                    {reads.map((line) => (
                      <p className="muted" key={line}>
                        {line}
                      </p>
                    ))}
                  </div>

                  <div className="loans__actions">
                    <button
                      type="button"
                      className="button button--primary"
                      disabled={locked || parsed === null || !dirty}
                      onClick={() => submit(row)}
                    >
                      {row.id === null ? t('settings:loans.create') : t('settings:loans.save')}
                    </button>
                    <button
                      type="button"
                      className="button button--quiet"
                      disabled={locked}
                      onClick={() => remove(row)}
                    >
                      {t('settings:loans.remove')}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        <Issue message={state.issue('principalCents')} />

        <div className="loans__actions">
          <button
            type="button"
            className="button button--quiet"
            disabled={locked || rows.length >= MAX_LOANS}
            onClick={add}
          >
            {t('settings:loans.add')}
          </button>
        </div>
      </form>
    </Panel>
  )
}
