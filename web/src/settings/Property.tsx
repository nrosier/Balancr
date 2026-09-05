/**
 * What the household owns — the home it lives in, and whatever it rents out (#227).
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
 *  - **A mortgage is optional per property, not a feature toggle for the panel.** Paid
 *    off, bought outright, or simply not yet financed are all "no mortgage", so the
 *    checkbox on each row means exactly that and nothing about the property itself.
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
  MAX_PROPERTIES,
  netCashFlowCents,
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
  principalCents: string
  anchorDate: string
  rateBp: string
  monthlyPaymentCents: string
  remainingTermMonths: string
}

/** One property's row while it is being typed: every box is text until it parses. */
interface Draft {
  id: string
  kind: PropertyKind
  label: string
  propertyValueCents: string
  rentCents: string
  /** Null means no mortgage — the checkbox on the row, not a separate draft state. */
  mortgage: MortgageDraft | null
}

const mortgageDraftOf = (mortgage: Mortgage): MortgageDraft => ({
  principalCents: formatMoney(mortgage.principalCents),
  anchorDate: mortgage.anchorDate,
  rateBp: String(mortgage.rateBp),
  monthlyPaymentCents: formatMoney(mortgage.monthlyPaymentCents),
  remainingTermMonths: String(mortgage.remainingTermMonths),
})

const draftOf = (property: Property): Draft => ({
  id: property.id,
  kind: property.kind,
  label: property.label,
  propertyValueCents:
    property.propertyValueCents === null ? '' : formatMoney(property.propertyValueCents),
  rentCents: property.rentCents === null ? '' : formatMoney(property.rentCents),
  mortgage: property.mortgage === null ? null : mortgageDraftOf(property.mortgage),
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
  return { principalCents, anchorDate, rateBp, monthlyPaymentCents, remainingTermMonths }
}

interface ParsedRow {
  kind: PropertyKind
  label: string
  propertyValueCents: number | null
  rentCents: number | null
  mortgage: Mortgage | null
  ok: boolean
}

function parseRow(row: Draft): ParsedRow {
  const propertyValueText = row.propertyValueCents.trim()
  const propertyValueCents = propertyValueText === '' ? null : parseMoneyToCents(propertyValueText)
  const propertyValueInvalid = propertyValueText !== '' && propertyValueCents === null

  const rentText = row.rentCents.trim()
  const rentCents = rentText === '' ? null : parseMoneyToCents(rentText)
  const rentInvalid = rentText !== '' && rentCents === null

  const mortgage = row.mortgage === null ? null : parseMortgage(row.mortgage)
  const mortgageInvalid = row.mortgage !== null && mortgage === null

  return {
    kind: row.kind,
    label: row.label.trim(),
    propertyValueCents,
    rentCents,
    mortgage,
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
  const rows = drafts ?? property.properties.map(draftOf)

  const edit = (index: number, patch: Partial<Draft>): void => {
    setDrafts(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)))
  }

  const editMortgage = (index: number, patch: Partial<MortgageDraft>): void => {
    setDrafts(
      rows.map((row, at) =>
        at !== index || row.mortgage === null
          ? row
          : { ...row, mortgage: { ...row.mortgage, ...patch } },
      ),
    )
  }

  const toggleMortgage = (index: number, has: boolean): void => {
    edit(index, {
      mortgage: has
        ? {
            principalCents: '',
            anchorDate: today,
            rateBp: '',
            monthlyPaymentCents: '',
            remainingTermMonths: '',
          }
        : null,
    })
  }

  const useStandardPayment = (index: number): void => {
    const row = rows[index]
    if (row === undefined || row.mortgage === null) return
    const principalCents = parseMoneyToCents(row.mortgage.principalCents)
    const rateBp = parseRateBp(row.mortgage.rateBp)
    const termMonths = parseTermMonths(row.mortgage.remainingTermMonths)
    if (principalCents === null || rateBp === null || termMonths === null) return
    const payment = standardMonthlyPaymentCents(principalCents, rateBp, termMonths)
    editMortgage(index, { monthlyPaymentCents: formatMoney(payment) })
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
        mortgage: parsed.mortgage,
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
                mortgage: parsed.mortgage,
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
              }

              const rateBp = row.mortgage === null ? null : parseRateBp(row.mortgage.rateBp)
              const canUseStandardPayment =
                row.mortgage !== null &&
                parseMoneyToCents(row.mortgage.principalCents) !== null &&
                rateBp !== null &&
                parseTermMonths(row.mortgage.remainingTermMonths) !== null

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

                  <label className="account__toggle" htmlFor={`property-mortgage-${row.id}`}>
                    <input
                      id={`property-mortgage-${row.id}`}
                      type="checkbox"
                      checked={row.mortgage !== null}
                      disabled={locked}
                      onChange={(event) => toggleMortgage(index, event.target.checked)}
                    />
                    {t('settings:property.hasMortgage')}
                  </label>

                  {row.mortgage !== null && (
                    <div className="property__mortgage">
                      <div className="field">
                        <label
                          className="field__label"
                          htmlFor={`mortgage-principal-${row.id}`}
                        >
                          {t('settings:property.mortgage.principal')}
                        </label>
                        <input
                          id={`mortgage-principal-${row.id}`}
                          className="field__input num"
                          type="text"
                          inputMode="decimal"
                          autoComplete="off"
                          value={row.mortgage.principalCents}
                          disabled={locked}
                          onChange={(event) =>
                            editMortgage(index, { principalCents: event.target.value })
                          }
                        />
                      </div>

                      <div className="field">
                        <label className="field__label" htmlFor={`mortgage-anchor-${row.id}`}>
                          {t('settings:property.mortgage.anchorDate')}
                        </label>
                        <input
                          id={`mortgage-anchor-${row.id}`}
                          className="field__input"
                          type="date"
                          value={row.mortgage.anchorDate}
                          disabled={locked}
                          onChange={(event) =>
                            editMortgage(index, { anchorDate: event.target.value })
                          }
                        />
                      </div>

                      <div className="field">
                        <label className="field__label" htmlFor={`mortgage-rate-${row.id}`}>
                          {t('settings:property.mortgage.rate')}
                        </label>
                        <input
                          id={`mortgage-rate-${row.id}`}
                          className="field__input num"
                          type="text"
                          inputMode="numeric"
                          autoComplete="off"
                          value={row.mortgage.rateBp}
                          disabled={locked}
                          onChange={(event) => editMortgage(index, { rateBp: event.target.value })}
                        />
                        <p className="property__reads muted">
                          {rateBp === null
                            ? t('settings:property.invalid')
                            : t('settings:property.mortgage.rateReads', {
                                value: formatBp(rateBp),
                              })}
                        </p>
                      </div>

                      <div className="field">
                        <label className="field__label" htmlFor={`mortgage-term-${row.id}`}>
                          {t('settings:property.mortgage.term')}
                        </label>
                        <input
                          id={`mortgage-term-${row.id}`}
                          className="field__input num"
                          type="text"
                          inputMode="numeric"
                          autoComplete="off"
                          value={row.mortgage.remainingTermMonths}
                          disabled={locked}
                          onChange={(event) =>
                            editMortgage(index, { remainingTermMonths: event.target.value })
                          }
                        />
                      </div>

                      <div className="field">
                        <label className="field__label" htmlFor={`mortgage-payment-${row.id}`}>
                          {t('settings:property.mortgage.payment')}
                        </label>
                        <input
                          id={`mortgage-payment-${row.id}`}
                          className="field__input num"
                          type="text"
                          inputMode="decimal"
                          autoComplete="off"
                          value={row.mortgage.monthlyPaymentCents}
                          disabled={locked}
                          onChange={(event) =>
                            editMortgage(index, { monthlyPaymentCents: event.target.value })
                          }
                        />
                        <button
                          type="button"
                          className="button button--quiet"
                          disabled={locked || !canUseStandardPayment}
                          onClick={() => useStandardPayment(index)}
                        >
                          {t('settings:property.mortgage.useStandardPayment')}
                        </button>
                      </div>
                    </div>
                  )}

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
                  mortgage: null,
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
