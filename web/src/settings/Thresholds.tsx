/**
 * The twenty-odd numbers the aggregation engine judges by.
 *
 * **The fields come from the payload, not from a list here.** `GET /api/settings`
 * returns `params` and `paramDefaults` as the domain schema itself, so this panel
 * renders whatever groups and fields exist and a threshold added to
 * `aggregate/params.ts` appears here with no edit — which is the whole reason the
 * response carries the schema rather than a hand-written mirror of it. The labels are
 * catalogue keys built from the same names, and `test/unit/i18n.test.ts` fails if one
 * is missing, so "appears here" cannot mean "appears here untranslated".
 *
 * **The ranges are the server's.** Nothing below re-states that `windowMonths` is 3–60
 * or that the warn threshold must not exceed the alert one. A second copy would drift,
 * and the copy that fell behind would be the one rejecting a valid number — so the
 * only validation here is "is this a number at all", and everything else comes back as
 * `error.issues` and lands under the field that caused it. The cross-field rules can
 * only be checked against the merged result, which is exactly why the server checks
 * them there and reports them per field.
 *
 * **Two kinds of input, and the reason is `parseFloat`.** A field whose name ends in
 * `Cents` is money: it shows `€ 25,00` and is read back by `parseMoneyToCents`, which
 * knows that `1.234` is twelve hundred to a Belgian and not one and a bit. Everything
 * else is a plain number shown unformatted, precisely so no grouping mark can appear
 * in it — `2.000` in a basis-points field has no safe reading, and the honest way to
 * avoid guessing is to never render the separator that creates the ambiguity. Basis
 * points get a "reads as 20%" line instead, which is the part a person is actually
 * checking.
 *
 * Saving changes nothing on screen. The facts these thresholds produce are stored by
 * the nightly pass, not computed per request, and the hint says so — the alternative
 * would be a settings form that quietly queues twelve months of recomputation.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { formatBp, formatDecimal, formatMoney, parseMoneyToCents } from '../shared.ts'
import { Issue, Panel } from './Panel.tsx'
import type { SettingsPanelProps } from './state.ts'

/** `group.field`, which is also the path the server names in `error.issues`. */
type Path = string

const isMoney = (field: string): boolean => field.endsWith('Cents')
const isBp = (field: string): boolean => field.endsWith('Bp')

/** What the input shows when it is not being edited. */
const display = (field: string, value: number): string =>
  isMoney(field) ? formatMoney(value) : String(value)

/** Why a typed value could not be used. Both are catalogue keys under `thresholds`. */
type Rejection = 'notANumber' | 'grouped'

/**
 * A plain number as typed, or why not.
 *
 * A separator in the box is a decimal separator — comma or dot, because a Belgian
 * keyboard produces one and a numeric keypad the other — since this parser only ever
 * sees fields whose value it rendered without grouping. `Number('')` is 0 and
 * `parseFloat('12abc')` is 12; both would be stored as a threshold nobody typed.
 *
 * The exception is the one form that has two readings a thousand apart. `2.000` in a
 * basis-points field is 20% to anyone who types Belgian grouping and 0,02% to this
 * regex, and neither the server nor this panel can tell which was meant — so when the
 * stored value is a whole number and the text is a separator followed by exactly three
 * digits, it is handed back to be retyped rather than guessed at. `integral` is read
 * from the stored value and not from the field's name, so no list here can fall out of
 * step with `aggregate/params.ts`: `winsorLowerPct` is stored as 0,05 and keeps its
 * decimals, `baselineWarnBp` is stored as 2000 and does not.
 */
function parseNumber(raw: string, integral: boolean): number | Rejection {
  const trimmed = raw.trim()
  if (!/^-?\d+(?:[.,]\d{1,6})?$/.test(trimmed)) return 'notANumber'
  if (integral && /^-?\d+[.,]\d{3}$/.test(trimmed)) return 'grouped'
  const value = Number(trimmed.replace(',', '.'))
  return Number.isFinite(value) ? value : 'notANumber'
}

const parseField = (field: string, raw: string, stored: number): number | Rejection =>
  isMoney(field)
    ? (parseMoneyToCents(raw) ?? 'notANumber')
    : parseNumber(raw, Number.isInteger(stored))

/** The default for every field, by path, so a hint can name it. */
function defaultsByPath(defaults: Record<string, Record<string, number>>): Map<Path, number> {
  const out = new Map<Path, number>()
  for (const [group, fields] of Object.entries(defaults)) {
    for (const [field, value] of Object.entries(fields)) out.set(`${group}.${field}`, value)
  }
  return out
}

interface Draft {
  /** What has been typed, by path. Absent means "as stored". */
  text: Record<Path, string>
}

export function ThresholdsPanel({ settings, state, owner }: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const [draft, setDraft] = useState<Draft>({ text: {} })

  // The payload's own shape: every group is an object of numbers, which is what makes
  // rendering it generically honest rather than a cast.
  const groups: Record<string, Record<string, number>> = settings.params
  const defaults = useMemo(() => defaultsByPath(settings.paramDefaults), [settings.paramDefaults])

  /**
   * What would be sent, and what cannot be.
   *
   * A field is in the patch only when it parses *and* differs from what is stored — so
   * typing a value, thinking better of it and typing the original back leaves nothing
   * to save, and the button says so.
   */
  const { patch, changed, invalid } = useMemo(() => {
    const body: Record<string, Record<string, number>> = {}
    const bad = new Map<Path, Rejection>()
    let count = 0

    for (const [path, raw] of Object.entries(draft.text)) {
      const [group, field] = path.split('.')
      if (group === undefined || field === undefined) continue
      const stored = groups[group]?.[field]
      if (stored === undefined) continue

      const value = parseField(field, raw, stored)
      if (typeof value === 'string') {
        bad.set(path, value)
        continue
      }
      if (value === stored) continue

      body[group] = { ...body[group], [field]: value }
      count += 1
    }

    return { patch: body, changed: count, invalid: bad }
  }, [draft, groups])

  const type = (path: Path, text: string): void => {
    setDraft((current) => ({ text: { ...current.text, [path]: text } }))
  }

  const submit = (): void => {
    state.save('params', 'PATCH', '/api/settings/params', patch, () => setDraft({ text: {} }))
  }

  return (
    <Panel
      title={t('settings:thresholds.title')}
      hint={t('settings:thresholds.hint')}
      notice={
        owner ? null : (
          <p className="panel__meta muted">{t('settings:viewerOnly')}</p>
        )
      }
    >
      <form
        className="thresholds"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        {Object.entries(groups).map(([group, fields]) => (
          <fieldset className="thresholds__group" key={group}>
            <legend className="thresholds__legend">{t(`settings:thresholds.group.${group}`)}</legend>
            {Object.entries(fields).map(([field, value]) => {
              const path = `${group}.${field}`
              const raw = draft.text[path]
              const shown = raw ?? display(field, value)
              const parsed = raw === undefined ? value : parseField(field, raw, value)
              const rejection = invalid.get(path)

              return (
                <div className="field thresholds__field" key={path}>
                  <label className="field__label" htmlFor={`threshold-${group}-${field}`}>
                    {t(`settings:thresholds.field.${group}.${field}`)}
                  </label>
                  <input
                    id={`threshold-${group}-${field}`}
                    className="field__input num"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={shown}
                    disabled={!owner || state.busy}
                    onChange={(event) => type(path, event.target.value)}
                  />
                  <p className="thresholds__note muted">
                    {isBp(field) && typeof parsed === 'number'
                      ? `${t('settings:thresholds.reads', { value: formatBp(parsed) })} · `
                      : null}
                    {t('settings:thresholds.default', {
                      value: defaultText(field, defaults.get(path)),
                    })}
                  </p>
                  {rejection === undefined ? (
                    <Issue message={state.issue(path)} />
                  ) : (
                    <Issue message={t(`settings:thresholds.${rejection}`)} />
                  )}
                </div>
              )
            })}
          </fieldset>
        ))}

        <div className="thresholds__actions">
          <button
            type="submit"
            className="button button--primary"
            disabled={!owner || state.busy || changed === 0 || invalid.size > 0}
          >
            {state.pending === 'params' ? t('shell.loading') : t('action.save')}
          </button>
        </div>
      </form>
    </Panel>
  )
}

/**
 * The stored default, as text.
 *
 * Four decimals rather than one: `winsorLowerPct` is 0,05 and a hint reading
 * "Default 0,1" would be worse than no hint at all.
 */
function defaultText(field: string, value: number | undefined): string {
  if (value === undefined) return '—'
  return isMoney(field) ? formatMoney(value) : formatDecimal(value, 4)
}
