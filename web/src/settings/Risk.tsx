/**
 * The risk profile the portfolio advice is measured against (#41).
 *
 * "Some risk, but not super high risk" is an adjective, and an adjective cannot motivate
 * a trade. This panel is where it becomes twelve numbers — a floor, a target and a
 * ceiling per asset class — plus the two thresholds that decide when a drift is worth
 * acting on at all. Everything the portfolio page suggests exists because a share left
 * one of these bands, so this is the one form on the site whose numbers are an argument
 * rather than a preference.
 *
 * Four decisions:
 *
 *  - **The presets arrive with their numbers, from the server.** `PROFILE_PRESETS` lives
 *    beside the settings table and the logger and cannot be imported here, so
 *    `GET /api/settings` ships `presets` — and the picker prints what "defensive" *means*
 *    before anyone commits to it. A hand-written copy in this file would be a second
 *    definition of the profile the advice was actually computed against.
 *  - **Editing a preset makes it `custom`, and the panel says so as it happens.** The
 *    profile in force is the numbers; the name is a label on them. So a hand edit sends
 *    `bands` and no `profile`, which is exactly what the server turns into `custom`.
 *  - **All four bands travel together or not at all.** Zod makes the record exhaustive
 *    on purpose: four targets, one of them left over from the previous profile, is
 *    precisely the state that adds up to 97%. So the patch carries the whole set.
 *  - **The sum is shown live, and the server still checks it.** "Targets add up to
 *    110,00%" as you type beats the same sentence after a round trip — but the refusal
 *    stays on the server, because this panel is not the only thing that can write a
 *    profile and a rule enforced in a form is a rule enforced nowhere.
 *
 * Basis points are typed as plain integers, never formatted, for the reason
 * `ThresholdsPanel` explains at length: `6.500` in a basis-points box means 65% to a
 * Belgian and 0,065% to a parser, and the honest fix is to never render the separator
 * that creates the ambiguity. Each row prints what its three numbers read as instead.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { assetClassLabel } from '../charts/AllocationChart.tsx'
import { useT } from '../i18n.ts'
import {
  BAND_CLASSES,
  formatBp,
  formatMoney,
  parseMoneyToCents,
  PRESET_IDS,
  type BandClass,
  type BandsSetting,
  type PresetId,
} from '../shared.ts'
import { Issue, Panel } from './Panel.tsx'
import type { SettingsPanelProps } from './state.ts'

/**
 * Between the targets on a preset's second line.
 *
 * Not a catalogue key: a middle dot is punctuation rather than language, and a key for it
 * would be one more string for a translator to wonder about and get subtly wrong.
 */
const SEPARATOR = ' · '

/** The three numbers a band is made of, in the order they are read. */
const EDGES = ['minBp', 'targetBp', 'maxBp'] as const
type Edge = (typeof EDGES)[number]

/** `EQUITY.targetBp`, which is also how a typed value is keyed while it is a draft. */
type Path = string

/**
 * A basis-point figure as typed, or null.
 *
 * Deliberately stricter than the thresholds panel's parser: every number here is a whole
 * basis point, so a decimal separator has no valid reading at all and `65,5` is a
 * mistake rather than a rounding. `Number('')` is 0 and would silently become a floor.
 */
function parseBp(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^\d{1,5}$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value <= 10_000 ? value : null
}

/** What a preset means, in one line: its targets, smallest classes dropped. */
function presetSummary(bands: BandsSetting, label: (key: BandClass) => string): string {
  return BAND_CLASSES.filter((key) => bands[key].targetBp > 0)
    .map((key) => `${formatBp(bands[key].targetBp)} ${label(key)}`)
    .join(SEPARATOR)
}

export function RiskPanel({ settings, state, owner }: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const advice = settings.advice

  /** A preset picked but not yet saved. Null means "whatever is stored". */
  const [chosen, setChosen] = useState<PresetId | null>(null)
  const [text, setText] = useState<Record<Path, string>>({})

  /**
   * The bands the form is editing *from*.
   *
   * Picking a preset changes this, which is what makes the numbers on screen the ones
   * that would be saved: a picker that left the previous profile's figures in the boxes
   * would be showing a profile nobody chose.
   */
  const base: BandsSetting = chosen === null ? advice.bands : advice.presets[chosen]

  const { bands, handEdited, invalid } = useMemo(() => {
    const bad = new Set<Path>()
    let edited = false

    const bandOf = (key: BandClass): BandsSetting[BandClass] => {
      const band = { ...base[key] }
      for (const edge of EDGES) {
        const raw = text[`${key}.${edge}`]
        if (raw === undefined) continue
        const value = parseBp(raw)
        if (value === null) {
          bad.add(`${key}.${edge}`)
          continue
        }
        if (value !== band[edge]) edited = true
        band[edge] = value
      }
      return band
    }

    // The four keys spelled out rather than folded from `BAND_CLASSES`, because this is
    // the one place where a fifth asset class has to be a compile error: `BandsSetting`
    // is exhaustive by design, and a `Record<string, …>` built in a loop and cast into
    // shape would let a new class reach the server as three missing numbers.
    const out: BandsSetting = {
      EQUITY: bandOf('EQUITY'),
      FIXED_INCOME: bandOf('FIXED_INCOME'),
      REAL_ESTATE: bandOf('REAL_ESTATE'),
      COMMODITY: bandOf('COMMODITY'),
    }

    return { bands: out, handEdited: edited, invalid: bad }
  }, [base, text])

  const targetSum = BAND_CLASSES.reduce((sum, key) => sum + bands[key].targetBp, 0)

  /** Tolerance and the minimum trade: typed, or as stored. */
  const toleranceText = text['toleranceBp']
  const tolerance = toleranceText === undefined ? advice.toleranceBp : parseBp(toleranceText)
  const minTradeText = text['minTradeCents']
  const minTrade =
    minTradeText === undefined ? advice.minTradeCents : parseMoneyToCents(minTradeText)

  /**
   * What would be sent.
   *
   * `bands` and `profile` are mutually exclusive by construction, and that is the whole
   * of the "editing a preset makes it custom" rule: a hand edit sends the numbers and
   * lets the server name them, and an untouched preset sends the name and lets the
   * server supply the numbers. Sending both would be this panel deciding that its
   * twelve boxes are still "growth", which is exactly the lie the server refuses.
   */
  const patch = useMemo(() => {
    const body: Record<string, unknown> = {}
    if (handEdited) body['bands'] = bands
    else if (chosen !== null && (chosen !== advice.profile || !advice.isPreset)) {
      body['profile'] = chosen
    }
    if (tolerance !== null && tolerance !== advice.toleranceBp) body['toleranceBp'] = tolerance
    if (minTrade !== null && minTrade !== advice.minTradeCents) body['minTradeCents'] = minTrade
    return body
  }, [advice, bands, chosen, handEdited, minTrade, tolerance])

  const broken =
    invalid.size > 0 ||
    tolerance === null ||
    minTrade === null ||
    (handEdited && targetSum !== 10_000)
  const changed = Object.keys(patch).length > 0

  const pick = (preset: PresetId): void => {
    // The typed values go with it. They were edits to the *previous* profile's numbers,
    // and carrying "6500" from balanced into defensive would silently rebuild the band
    // the picker was asked to replace.
    setChosen(preset)
    setText({})
  }

  const submit = (): void => {
    state.save('advice', 'PATCH', '/api/settings/advice', patch, () => {
      setChosen(null)
      setText({})
    })
  }

  const label = (key: BandClass): string => assetClassLabel(t, key)

  /**
   * Which radio is filled in: the unsaved pick, else the stored name.
   *
   * `custom` is not one of them, so a stored custom profile leaves all three empty —
   * which is the truthful answer to "which preset is this?" and is why the note below
   * exists to say what it is instead.
   */
  const selected: PresetId | null =
    chosen ?? (advice.profile === 'custom' ? null : advice.profile)

  return (
    <Panel
      title={t('settings:risk.title')}
      hint={t('settings:risk.hint')}
      notice={owner ? null : <p className="panel__meta muted">{t('settings:viewerOnly')}</p>}
    >
      <form
        className="risk"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <fieldset className="risk__presets">
          <legend className="risk__legend">{t('settings:risk.presets')}</legend>
          {PRESET_IDS.map((preset) => (
            <label className="risk__preset" key={preset}>
              <input
                type="radio"
                name="risk-preset"
                value={preset}
                checked={!handEdited && selected === preset}
                disabled={!owner || state.busy}
                onChange={() => pick(preset)}
              />
              <span className="risk__presetName">{t(`portfolio:advice.profile.${preset}`)}</span>
              <span className="risk__presetBands muted">
                {presetSummary(advice.presets[preset], label)}
              </span>
            </label>
          ))}
          {/*
            Not a radio. `custom` is not a thing to pick, it is what the profile becomes
            the moment a band is edited — so it is reported rather than offered, and it
            appears the instant a box changes rather than after a round trip.
          */}
          {handEdited || !advice.isPreset ? (
            <p className="risk__custom">{t('settings:risk.custom')}</p>
          ) : null}
        </fieldset>

        <Issue message={state.issue('bands')} />

        <div className="table-scroll">
          <table className="table risk__bands">
            <thead>
              <tr>
                <th scope="col">{t('settings:risk.column.class')}</th>
                {EDGES.map((edge) => (
                  <th scope="col" className="table__cell--number" key={edge}>
                    {t(`settings:risk.column.${edge}`)}
                  </th>
                ))}
                <th scope="col">{t('settings:risk.column.reads')}</th>
              </tr>
            </thead>
            <tbody>
              {BAND_CLASSES.map((key) => (
                <tr key={key}>
                  <th scope="row" className="table__cell--name">
                    {label(key)}
                  </th>
                  {EDGES.map((edge) => (
                    <td className="table__cell--number" key={edge}>
                      <input
                        id={`risk-${key}-${edge}`}
                        className="field__input num risk__input"
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        aria-label={t('settings:risk.inputLabel', {
                          name: label(key),
                          edge: t(`settings:risk.column.${edge}`),
                        })}
                        value={text[`${key}.${edge}`] ?? String(base[key][edge])}
                        disabled={!owner || state.busy}
                        onChange={(event) => {
                          const raw = event.target.value
                          setText((current) => ({ ...current, [`${key}.${edge}`]: raw }))
                        }}
                      />
                    </td>
                  ))}
                  <td className="risk__reads muted">
                    {t('settings:risk.reads', {
                      min: formatBp(bands[key].minBp),
                      target: formatBp(bands[key].targetBp),
                      max: formatBp(bands[key].maxBp),
                    })}
                    <Issue message={state.issue(`bands.${key}`)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/*
          The sum, live. It is the one rule a person breaks by accident — moving equities
          down without moving anything up — and the one worth answering before the save.
        */}
        <p
          className={targetSum === 10_000 ? 'risk__sum' : 'risk__sum risk__sum--off'}
          role="status"
        >
          {t('settings:risk.sum', { value: formatBp(targetSum) })}
        </p>

        <div className="risk__fields">
          <div className="field">
            <label className="field__label" htmlFor="risk-tolerance">
              {t('settings:risk.tolerance')}
            </label>
            <input
              id="risk-tolerance"
              className="field__input num"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={text['toleranceBp'] ?? String(advice.toleranceBp)}
              disabled={!owner || state.busy}
              onChange={(event) => {
                const raw = event.target.value
                setText((current) => ({ ...current, toleranceBp: raw }))
              }}
            />
            <p className="risk__note muted">
              {tolerance === null
                ? t('settings:risk.notANumber')
                : t('settings:risk.toleranceHint', { value: formatBp(tolerance) })}
            </p>
            <Issue message={state.issue('toleranceBp')} />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="risk-min-trade">
              {t('settings:risk.minTrade')}
            </label>
            <input
              id="risk-min-trade"
              className="field__input num"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={text['minTradeCents'] ?? formatMoney(advice.minTradeCents)}
              disabled={!owner || state.busy}
              onChange={(event) => {
                const raw = event.target.value
                setText((current) => ({ ...current, minTradeCents: raw }))
              }}
            />
            <p className="risk__note muted">
              {minTrade === null
                ? t('settings:risk.notANumber')
                : t('settings:risk.minTradeHint', { value: formatMoney(minTrade) })}
            </p>
            <Issue message={state.issue('minTradeCents')} />
          </div>
        </div>

        <div className="risk__actions">
          <button
            type="submit"
            className="button button--primary"
            disabled={!owner || state.busy || !changed || broken}
          >
            {state.pending === 'advice' ? t('shell.loading') : t('action.save')}
          </button>
        </div>
      </form>
    </Panel>
  )
}
