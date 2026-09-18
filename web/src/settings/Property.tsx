/**
 * What the household owns — the home it lives in, whatever it rents out, and anything
 * else it holds outright but neither lives in nor rents (#227, #390).
 *
 * Ghostfolio has no liability type that can model a rate that changes, and a paid-down
 * room in an actual house is not a fund position `advice/{drift,suggest}.ts` could ever
 * buy or sell to correct drift — so this stays its own settings record, out of the
 * `REAL_ESTATE` allocation band entirely. The arithmetic (`outstandingBalanceCents`,
 * `propertyEquityCents`, `netCashFlowCents`, `grossYieldBp`) lives in
 * `domain/property/vocabulary.ts`, re-exported through `shared.ts`, so this panel's own
 * job is just the form.
 *
 *  - **A list, replaced whole, same as the household roster.** Add and remove are the
 *    only two gestures a list has, and neither is a merge — so like `HouseholdPanel`,
 *    every field here is a draft until one submit sends the lot.
 *  - **A property carries zero or more mortgages, not one optional one (#393).** Paid
 *    off, bought outright, or simply not yet financed are all "no mortgages" — an empty
 *    list, not a special case — and a second mortgage/HELOC/renovation loan is just
 *    another row in that same list, added and removed the same way properties are.
 *  - **Rent is a field on the row, not a second form.** Only a `rental` reads it back as
 *    a cash flow or a yield, but the schema allows it either way — nothing here forces a
 *    primary residence's rent to empty just because the picker moved off `rental`.
 *  - **The rate is a plain integer, as everywhere else on this page.** `3.50` in a
 *    basis-points box is ambiguous the same way `Benchmark.tsx` describes; the box holds
 *    `350` and a caption underneath says what that reads as.
 *  - **Re-anchoring, not a rate-history table.** When a mortgage's rate, payment or term
 *    changes, the owner edits the row with today's actual outstanding balance as the new
 *    anchor — the same convention `properties.ts` documents.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { useT } from '../i18n.ts'
import {
  formatBp,
  formatMoney,
  grossYieldBp,
  MAX_MORTGAGES_PER_PROPERTY,
  MAX_PROPERTIES,
  netCashFlowCents,
  paidOffBp,
  parseMoneyToCents,
  propertyEquityCents,
  propertyKinds,
  standardMonthlyPaymentCents,
  type Mortgage,
  type Property,
  type PropertyKind,
} from '../shared.ts'
import { Issue, Panel } from './Panel.tsx'
import type { SettingsPanelProps } from './state.ts'

interface MortgageDraft {
  /** Stable across edits — mortgages have no server-side id, so a draft invents one. */
  id: string
  principalCents: string
  anchorDate: string
  rateBp: string
  monthlyPaymentCents: string
  remainingTermMonths: string
  /** Empty means "not entered", not zero — see `originalPrincipalCents`'s own doc comment. */
  originalPrincipalCents: string
}

/** One property's row while it is being typed: every box is text until it parses. */
interface Draft {
  id: string
  kind: PropertyKind
  label: string
  propertyValueCents: string
  rentCents: string
  /** Empty means no mortgage — the list itself, not a separate draft state (#393). */
  mortgages: MortgageDraft[]
}

const mortgageDraftOf = (mortgage: Mortgage): MortgageDraft => ({
  id: crypto.randomUUID(),
  principalCents: formatMoney(mortgage.principalCents),
  anchorDate: mortgage.anchorDate,
  rateBp: String(mortgage.rateBp),
  monthlyPaymentCents: formatMoney(mortgage.monthlyPaymentCents),
  remainingTermMonths: String(mortgage.remainingTermMonths),
  originalPrincipalCents:
    mortgage.originalPrincipalCents === null ? '' : formatMoney(mortgage.originalPrincipalCents),
})

const draftOf = (property: Property): Draft => ({
  id: property.id,
  kind: property.kind,
  label: property.label,
  propertyValueCents:
    property.propertyValueCents === null ? '' : formatMoney(property.propertyValueCents),
  rentCents: property.rentCents === null ? '' : formatMoney(property.rentCents),
  mortgages: property.mortgages.map(mortgageDraftOf),
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

function parseMortgage(draft: MortgageDraft): Mortgage | null {
  const principalCents = parseMoneyToCents(draft.principalCents)
  const rateBp = parseRateBp(draft.rateBp)
  const monthlyPaymentCents = parseMoneyToCents(draft.monthlyPaymentCents)
  const remainingTermMonths = parseTermMonths(draft.remainingTermMonths)
  const anchorDate = draft.anchorDate.trim()
  if (
    principalCents === null ||
    rateBp === null ||
    monthlyPaymentCents === null ||
    remainingTermMonths === null ||
    anchorDate === ''
  ) {
    return null
  }
  // Optional, unlike every other mortgage field: empty means "not entered" rather than
  // invalid, since most mortgages already on file predate this field (#392).
  const originalText = draft.originalPrincipalCents.trim()
  if (originalText === '') {
    return { principalCents, anchorDate, rateBp, monthlyPaymentCents, remainingTermMonths, originalPrincipalCents: null }
  }
  const originalPrincipalCents = parseMoneyToCents(originalText)
  if (originalPrincipalCents === null) return null
  return {
    principalCents,
    anchorDate,
    rateBp,
    monthlyPaymentCents,
    remainingTermMonths,
    originalPrincipalCents,
  }
}

interface ParsedRow {
  kind: PropertyKind
  label: string
  propertyValueCents: number | null
  rentCents: number | null
  mortgages: Mortgage[]
  ok: boolean
}

function parseRow(row: Draft): ParsedRow {
  const propertyValueText = row.propertyValueCents.trim()
  const propertyValueCents = propertyValueText === '' ? null : parseMoneyToCents(propertyValueText)
  const propertyValueInvalid = propertyValueText !== '' && propertyValueCents === null

  const rentText = row.rentCents.trim()
  const rentCents = rentText === '' ? null : parseMoneyToCents(rentText)
  const rentInvalid = rentText !== '' && rentCents === null

  const parsedMortgages = row.mortgages.map(parseMortgage)
  const mortgageInvalid = parsedMortgages.some((mortgage) => mortgage === null)
  const mortgages = parsedMortgages.filter((mortgage): mortgage is Mortgage => mortgage !== null)

  return {
    kind: row.kind,
    label: row.label.trim(),
    propertyValueCents,
    rentCents,
    mortgages,
    ok: !propertyValueInvalid && !rentInvalid && !mortgageInvalid,
  }
}

export function PropertyPanel({ settings, state, owner }: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const { property } = settings
  const locked = !owner || state.busy
  // Not the month being aggregated — this panel has no month. Every read-back is "as of
  // right now", because that is the balance the owner would see on a statement today.
  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])

  const [drafts, setDrafts] = useState<Draft[] | null>(null)
  // Memoized so an unrelated re-render (any other panel's `state.busy` toggling) doesn't
  // regenerate fresh mortgage draft ids before the first edit — that would change every
  // `key={mortgage.id}` below and remount the sub-forms mid-edit.
  const initialRows = useMemo(() => property.properties.map(draftOf), [property.properties])
  const rows = drafts ?? initialRows

  const edit = (index: number, patch: Partial<Draft>): void => {
    setDrafts(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)))
  }

  const editMortgage = (index: number, mortgageIndex: number, patch: Partial<MortgageDraft>): void => {
    setDrafts(
      rows.map((row, at) =>
        at !== index
          ? row
          : {
              ...row,
              mortgages: row.mortgages.map((mortgage, at2) =>
                at2 === mortgageIndex ? { ...mortgage, ...patch } : mortgage,
              ),
            },
      ),
    )
  }

  const addMortgage = (index: number): void => {
    const row = rows[index]
    if (row === undefined) return
    edit(index, {
      mortgages: [
        ...row.mortgages,
        {
          id: crypto.randomUUID(),
          principalCents: '',
          anchorDate: today,
          rateBp: '',
          monthlyPaymentCents: '',
          remainingTermMonths: '',
          originalPrincipalCents: '',
        },
      ],
    })
  }

  const removeMortgage = (index: number, mortgageIndex: number): void => {
    const row = rows[index]
    if (row === undefined) return
    edit(index, { mortgages: row.mortgages.filter((_, at) => at !== mortgageIndex) })
  }

  const useStandardPayment = (index: number, mortgageIndex: number): void => {
    const mortgage = rows[index]?.mortgages[mortgageIndex]
    if (mortgage === undefined) return
    const principalCents = parseMoneyToCents(mortgage.principalCents)
    const rateBp = parseRateBp(mortgage.rateBp)
    const termMonths = parseTermMonths(mortgage.remainingTermMonths)
    if (principalCents === null || rateBp === null || termMonths === null) return
    const payment = standardMonthlyPaymentCents(principalCents, rateBp, termMonths)
    editMortgage(index, mortgageIndex, { monthlyPaymentCents: formatMoney(payment) })
  }

  const { properties, invalid } = useMemo(() => {
    const bad = new Set<number>()
    const list: Property[] = []
    rows.forEach((row, index) => {
      const parsed = parseRow(row)
      if (!parsed.ok) {
        bad.add(index)
        return
      }
      list.push({
        id: row.id,
        kind: parsed.kind,
        label: parsed.label,
        propertyValueCents: parsed.propertyValueCents,
        rentCents: parsed.rentCents,
        mortgages: parsed.mortgages,
      })
    })
    return { properties: list, invalid: bad }
  }, [rows])

  const submit = (): void => {
    state.save('property', 'PATCH', '/api/settings/property', { properties }, () => {
      setDrafts(null)
    })
  }

  return (
    <Panel
      title={t('settings:property.title')}
      hint={t('settings:property.hint')}
      notice={owner ? null : <p className="panel__meta muted">{t('settings:viewerOnly')}</p>}
    >
      <form
        className="property-form"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        {rows.length === 0 ? (
          <p className="muted">{t('settings:property.none')}</p>
        ) : (
          <ul className="properties">
            {rows.map((row, index) => {
              const parsed = parseRow(row)
              const asProperty: Property = {
                id: row.id,
                kind: parsed.kind,
                label: parsed.label,
                propertyValueCents: parsed.propertyValueCents,
                rentCents: parsed.rentCents,
                mortgages: parsed.mortgages,
              }
              const equity = propertyEquityCents(asProperty, today)
              const cashFlow = netCashFlowCents(asProperty)
              const yieldBp = grossYieldBp(asProperty)

              const reads: string[] = []
              if (!parsed.ok) {
                reads.push(t('settings:property.invalid'))
              } else {
                reads.push(
                  equity === null
                    ? t('settings:property.propertyValueUnset')
                    : t('settings:property.equityReads', { value: formatMoney(equity) }),
                )
                if (parsed.kind === 'rental' && cashFlow !== null) {
                  reads.push(t('settings:property.cashFlowReads', { value: formatMoney(cashFlow) }))
                }
                if (parsed.kind === 'rental' && yieldBp !== null) {
                  reads.push(t('settings:property.yieldReads', { value: formatBp(yieldBp) }))
                }
                const paidOff = paidOffBp(asProperty.mortgages, today)
                if (paidOff !== null) {
                  reads.push(t('settings:property.mortgage.paidOffReads', { value: formatBp(paidOff) }))
                }
              }

              return (
                <li className="property" key={row.id}>
                  <div className="property__fields">
                    <div className="field">
                      <label className="field__label" htmlFor={`property-kind-${row.id}`}>
                        {t('settings:property.kindLabel')}
                      </label>
                      <select
                        id={`property-kind-${row.id}`}
                        className="field__input"
                        value={row.kind}
                        disabled={locked}
                        onChange={(event) =>
                          edit(index, { kind: event.target.value as PropertyKind })
                        }
                      >
                        {propertyKinds.map((kind) => (
                          <option key={kind} value={kind}>
                            {t(`settings:property.kind.${kind}`)}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="field">
                      <label className="field__label" htmlFor={`property-label-${row.id}`}>
                        {t('settings:property.label')}
                      </label>
                      <input
                        id={`property-label-${row.id}`}
                        className="field__input"
                        type="text"
                        autoComplete="off"
                        maxLength={80}
                        placeholder={t('settings:property.labelPlaceholder')}
                        value={row.label}
                        disabled={locked}
                        onChange={(event) => edit(index, { label: event.target.value })}
                      />
                    </div>

                    <div className="field">
                      <label className="field__label" htmlFor={`property-value-${row.id}`}>
                        {t('settings:property.propertyValue')}
                      </label>
                      <input
                        id={`property-value-${row.id}`}
                        className="field__input num"
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        value={row.propertyValueCents}
                        disabled={locked}
                        onChange={(event) =>
                          edit(index, { propertyValueCents: event.target.value })
                        }
                      />
                    </div>

                    {row.kind === 'rental' && (
                      <div className="field">
                        <label className="field__label" htmlFor={`property-rent-${row.id}`}>
                          {t('settings:property.rent')}
                        </label>
                        <input
                          id={`property-rent-${row.id}`}
                          className="field__input num"
                          type="text"
                          inputMode="decimal"
                          autoComplete="off"
                          value={row.rentCents}
                          disabled={locked}
                          onChange={(event) => edit(index, { rentCents: event.target.value })}
                        />
                      </div>
                    )}
                  </div>

                  <div className="property__reads">
                    {reads.map((line) => (
                      <p className="muted" key={line}>
                        {line}
                      </p>
                    ))}
                  </div>

                  {row.mortgages.map((mortgage, mortgageIndex) => {
                    const rateBp = parseRateBp(mortgage.rateBp)
                    const canUseStandardPayment =
                      parseMoneyToCents(mortgage.principalCents) !== null &&
                      rateBp !== null &&
                      parseTermMonths(mortgage.remainingTermMonths) !== null
                    const idPrefix = `${row.id}-${mortgage.id}`

                    return (
                      <div className="property__mortgage" key={mortgage.id}>
                        <div className="field">
                          <label className="field__label" htmlFor={`mortgage-principal-${idPrefix}`}>
                            {t('settings:property.mortgage.principal')}
                          </label>
                          <input
                            id={`mortgage-principal-${idPrefix}`}
                            className="field__input num"
                            type="text"
                            inputMode="decimal"
                            autoComplete="off"
                            value={mortgage.principalCents}
                            disabled={locked}
                            onChange={(event) =>
                              editMortgage(index, mortgageIndex, { principalCents: event.target.value })
                            }
                          />
                        </div>

                        <div className="field">
                          <label className="field__label" htmlFor={`mortgage-anchor-${idPrefix}`}>
                            {t('settings:property.mortgage.anchorDate')}
                          </label>
                          <input
                            id={`mortgage-anchor-${idPrefix}`}
                            className="field__input"
                            type="date"
                            value={mortgage.anchorDate}
                            disabled={locked}
                            onChange={(event) =>
                              editMortgage(index, mortgageIndex, { anchorDate: event.target.value })
                            }
                          />
                        </div>

                        <div className="field">
                          <label className="field__label" htmlFor={`mortgage-rate-${idPrefix}`}>
                            {t('settings:property.mortgage.rate')}
                          </label>
                          <input
                            id={`mortgage-rate-${idPrefix}`}
                            className="field__input num"
                            type="text"
                            inputMode="numeric"
                            autoComplete="off"
                            value={mortgage.rateBp}
                            disabled={locked}
                            onChange={(event) =>
                              editMortgage(index, mortgageIndex, { rateBp: event.target.value })
                            }
                          />
                          <p className="property__reads muted">
                            {rateBp === null
                              ? t('settings:property.invalid')
                              : t('settings:property.mortgage.rateReads', {
                                  value: formatBp(rateBp, { maxFractionDigits: 2 }),
                                })}
                          </p>
                        </div>

                        <div className="field">
                          <label className="field__label" htmlFor={`mortgage-term-${idPrefix}`}>
                            {t('settings:property.mortgage.term')}
                          </label>
                          <input
                            id={`mortgage-term-${idPrefix}`}
                            className="field__input num"
                            type="text"
                            inputMode="numeric"
                            autoComplete="off"
                            value={mortgage.remainingTermMonths}
                            disabled={locked}
                            onChange={(event) =>
                              editMortgage(index, mortgageIndex, { remainingTermMonths: event.target.value })
                            }
                          />
                        </div>

                        <div className="field">
                          <label className="field__label" htmlFor={`mortgage-payment-${idPrefix}`}>
                            {t('settings:property.mortgage.payment')}
                          </label>
                          <input
                            id={`mortgage-payment-${idPrefix}`}
                            className="field__input num"
                            type="text"
                            inputMode="decimal"
                            autoComplete="off"
                            value={mortgage.monthlyPaymentCents}
                            disabled={locked}
                            onChange={(event) =>
                              editMortgage(index, mortgageIndex, { monthlyPaymentCents: event.target.value })
                            }
                          />
                          <button
                            type="button"
                            className="button button--quiet"
                            disabled={locked || !canUseStandardPayment}
                            onClick={() => useStandardPayment(index, mortgageIndex)}
                          >
                            {t('settings:property.mortgage.useStandardPayment')}
                          </button>
                        </div>

                        <div className="field">
                          <label className="field__label" htmlFor={`mortgage-original-${idPrefix}`}>
                            {t('settings:property.mortgage.originalPrincipal')}
                          </label>
                          <input
                            id={`mortgage-original-${idPrefix}`}
                            className="field__input num"
                            type="text"
                            inputMode="decimal"
                            autoComplete="off"
                            placeholder={t('settings:property.mortgage.originalPrincipalPlaceholder')}
                            value={mortgage.originalPrincipalCents}
                            disabled={locked}
                            onChange={(event) =>
                              editMortgage(index, mortgageIndex, { originalPrincipalCents: event.target.value })
                            }
                          />
                          <p className="property__reads muted">
                            {t('settings:property.mortgage.originalPrincipalHint')}
                          </p>
                        </div>

                        <button
                          type="button"
                          className="button button--quiet"
                          disabled={locked}
                          onClick={() => removeMortgage(index, mortgageIndex)}
                        >
                          {t('settings:property.mortgage.remove')}
                        </button>
                      </div>
                    )
                  })}

                  <button
                    type="button"
                    className="button button--quiet"
                    disabled={locked || row.mortgages.length >= MAX_MORTGAGES_PER_PROPERTY}
                    onClick={() => addMortgage(index)}
                  >
                    {t('settings:property.mortgage.add')}
                  </button>

                  <button
                    type="button"
                    className="button button--quiet"
                    disabled={locked}
                    onClick={() => setDrafts(rows.filter((_, at) => at !== index))}
                  >
                    {t('settings:property.remove')}
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        <Issue message={state.issue('properties')} />

        <div className="properties__actions">
          <button
            type="button"
            className="button button--quiet"
            disabled={locked || rows.length >= MAX_PROPERTIES}
            onClick={() =>
              setDrafts([
                ...rows,
                {
                  id: crypto.randomUUID(),
                  kind: 'primary',
                  label: '',
                  propertyValueCents: '',
                  rentCents: '',
                  mortgages: [],
                },
              ])
            }
          >
            {t('settings:property.add')}
          </button>
          <button
            type="submit"
            className="button button--primary"
            disabled={locked || drafts === null || invalid.size > 0}
          >
            {state.pending === 'property' ? t('shell.loading') : t('action.save')}
          </button>
        </div>
      </form>
    </Panel>
  )
}
