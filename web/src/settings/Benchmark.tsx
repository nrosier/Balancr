/**
 * Who lives here, and which reference line each envelope belongs to (#43).
 *
 * Two panels, because the benchmark comparison needs two facts that only a person can
 * supply, and they are different kinds of fact. The household is one small form saved as a
 * whole; the mapping is fifty independent judgements, each written the moment it is made.
 *
 *  - **The file is read-only and shown anyway.** Every share in it is the survey's, and a
 *    screen that let anybody edit them would be a screen that manufactures a reference —
 *    the one failure that would make the whole feature worse than not having it. So the
 *    provenance is displayed and nothing about it is a control. `hasReferenceHousehold`
 *    false means the survey's euro total was never transcribed and only the `mix`
 *    comparison is possible, which is said here rather than left as a mystery on the
 *    budget page.
 *  - **The roster is replaced whole, so it has a save button.** `members` is a list and
 *    the only two gestures on a list are "here is the new one" and "remove a row" — a
 *    merge cannot express the second. That is also why every other control on this page
 *    writes immediately and these do not.
 *  - **The category table carries the co-parent flag too, and is titled for the list
 *    rather than for the benchmark (#44).** `custody_shared` decides which envelopes the
 *    shared-cost split counts, and until it had a control here its only writers needed a
 *    Gemini key — a feature unreachable without AI, which is the one thing the
 *    requirements say a feature may not be. It belongs in this table because it is the
 *    same question asked of the same fifty rows, and somebody going through them should
 *    do it once.
 *  - **Basis points typed as plain integers, as everywhere else on this page.** `5.000` in
 *    a basis-points box means 50% to a Belgian and 5% to a parser; the honest fix is to
 *    never render the separator that creates the ambiguity, and to print what the number
 *    reads as beside the box. `ThresholdsPanel` argues this at length.
 *  - **The picker offers the twelve COICOP divisions plus `00`, not the ten reference
 *    lines.** Three divisions share the survey's "other expenditure items" line, so
 *    picking "other" would store a code nobody could later resolve. The line each division
 *    feeds is shown beside the choice instead, which answers the question the ten-line
 *    picker was trying to answer without losing the information.
 *  - **A year of birth, not a "child" checkbox.** A checkbox is right the day it is ticked
 *    and quietly wrong from the next birthday, with nothing on screen to say so.
 *  - **The first person gets a name, not a row (#215).** `selfLabel` is a plain text field
 *    beside the roster, not a member with a birth year and a custody share — those would
 *    let the one row `household.ts` guarantees always exists become editable, removable,
 *    or ageing, which is the invariant the field is careful not to touch.
 *
 * The classification beside each member is as of *this* year, and says so: the comparison
 * ages the household at the year of the month being compared, so a member who turned
 * fourteen in March was a child in last January's figures and is not in this one's.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { useT } from '../i18n.ts'
import {
  COICOP_DIVISIONS,
  custodyShare,
  divisionOf,
  formatBp,
  formatDate,
  formatList,
  MAX_HOUSEHOLD_MEMBERS,
  OUTSIDE_CONSUMPTION,
  type BenchmarkSetting,
} from '../shared.ts'
import { Money } from '../ui/Money.tsx'
import { Issue, Panel } from './Panel.tsx'
import type { SettingsPanelProps } from './state.ts'

/** One member's row while it is being typed: three boxes, all text until they parse. */
interface Draft {
  label: string
  birthYear: string
  custodyBp: string
}

/** A whole basis point, or null. Same parser the risk bands use, and for the same reason. */
function parseBp(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^\d{1,5}$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value <= 10_000 ? value : null
}

/** A four-digit year, or null. The schema's own bounds, checked before the round trip. */
function parseYear(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^\d{4}$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value >= 1900 && value <= 2200 ? value : null
}

const draftOf = (member: BenchmarkSetting['household']['members'][number]): Draft => ({
  label: member.label ?? '',
  birthYear: String(member.birthYear),
  custodyBp: String(member.custodyBp),
})

// ---------------------------------------------------------------------------
//  The household
// ---------------------------------------------------------------------------

export function HouseholdPanel({ settings, state, owner }: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const { benchmark } = settings
  const { file } = benchmark

  /** The roster being edited, or null for "whatever is stored". */
  const [drafts, setDrafts] = useState<Draft[] | null>(null)
  const rows = drafts ?? benchmark.household.members.map(draftOf)
  const locked = !owner || state.busy

  /**
   * The first person's own name as typed, or null for "whatever is stored" (#215).
   *
   * Same shape as `sharedDraft` below: the outer null is "untouched", so a save doesn't
   * have to know whether this box has been touched to decide whether to send it — it
   * always sends the household wholesale, and the panel just needs to know what to show.
   */
  const [selfLabelDraft, setSelfLabelDraft] = useState<string | null>(null)
  const selfLabelText = selfLabelDraft ?? benchmark.household.selfLabel ?? ''

  /**
   * The stated shared-cost share as typed, or null for "whatever is stored" (#44).
   *
   * Empty text is a value here rather than an absence: clearing the box means "derive it
   * from the roster again", which is a change somebody has to be able to make. So the
   * draft is `string | null` — the outer null is "untouched", the inner empty string is
   * "deliberately nothing".
   */
  const [sharedDraft, setSharedDraft] = useState<string | null>(null)
  const stored = benchmark.household.sharedCostBp
  const sharedText = sharedDraft ?? (stored === null ? '' : String(stored))
  const sharedBp = sharedText.trim() === '' ? null : parseBp(sharedText)
  const sharedInvalid = sharedText.trim() !== '' && sharedBp === null

  const { members, invalid } = useMemo(() => {
    const bad = new Set<number>()
    const parsed: { birthYear: number; custodyBp: number; label?: string }[] = []
    rows.forEach((row, index) => {
      const birthYear = parseYear(row.birthYear)
      const custodyBp = parseBp(row.custodyBp)
      if (birthYear === null || custodyBp === null) {
        bad.add(index)
        return
      }
      const label = row.label.trim()
      parsed.push({ birthYear, custodyBp, ...(label === '' ? {} : { label }) })
    })
    return { members: parsed, invalid: bad }
  }, [rows])

  /**
   * What the box above currently means, in the smallest type on the panel.
   *
   * Four states, and the third is the one worth having: an empty box is not "no share",
   * it is the roster's own mean, and printing that figure here is what stops the settings
   * screen from promising a split the budget card does not apply. `custodyShare` is the
   * same function the split uses, imported rather than reimplemented for that reason.
   */
  const derived = custodyShare({ members, sharedCostBp: null })
  const sharedReads = sharedInvalid
    ? t('settings:benchmark.household.sharedCostNotANumber')
    : sharedBp !== null
      ? t('settings:benchmark.household.sharedCostReads', { share: formatBp(sharedBp) })
      : derived === null
        ? t('settings:benchmark.household.sharedCostNone')
        : t('settings:benchmark.household.sharedCostDerived', {
            count: derived.members,
            share: formatBp(derived.shareBp),
          })

  const edit = (index: number, field: keyof Draft, value: string): void => {
    setDrafts(rows.map((row, at) => (at === index ? { ...row, [field]: value } : row)))
  }

  const submit = (): void => {
    const selfLabel = selfLabelText.trim()
    const body = {
      members,
      ...(selfLabel === '' ? {} : { selfLabel }),
      sharedCostBp: sharedBp,
    }
    state.save('household', 'PATCH', '/api/settings/household', body, () => {
      // Back to "whatever is stored", which the answer has just replaced. Keeping the
      // drafts would leave the form showing text that happens to agree with the server
      // until it silently stops agreeing.
      setDrafts(null)
      setSharedDraft(null)
      setSelfLabelDraft(null)
    })
  }

  /**
   * The year the classification below is as of.
   *
   * Not the month being compared — this panel has no month. The comparison ages the
   * household at the year of the month it is comparing, so the note beside the form says
   * which year these words describe rather than implying they are timeless.
   */
  const thisYear = new Date().getFullYear()

  /**
   * The age the scale calls a child, from the file.
   *
   * Null when no benchmark is configured, and then the row says what share of the time
   * somebody is here and nothing about their weight — there is no scale to weigh them on,
   * and `14` written in here would be this panel inventing the threshold.
   */
  const childAgeBelow = file?.equivalence.childAgeBelow ?? null

  return (
    <Panel
      title={t('settings:benchmark.household.title')}
      hint={t('settings:benchmark.household.hint')}
      notice={owner ? null : <p className="panel__meta muted">{t('settings:viewerOnly')}</p>}
    >
      {file === null ? (
        <div className="notice notice--info" role="status">
          <p className="notice__lead">{t('settings:benchmark.noFile')}</p>
          <p className="notice__hint">{t('settings:benchmark.noFileHint')}</p>
        </div>
      ) : null}

      <form
        className="household"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="field">
          <label className="field__label" htmlFor="self-label">
            {t('settings:benchmark.household.selfLabel')}
          </label>
          <input
            id="self-label"
            className="field__input"
            type="text"
            autoComplete="off"
            maxLength={40}
            placeholder={t('settings:benchmark.household.selfLabelPlaceholder')}
            value={selfLabelText}
            disabled={locked}
            onChange={(event) => setSelfLabelDraft(event.target.value)}
          />
          <p className="panel__meta muted">{t('settings:benchmark.household.selfLabelHint')}</p>
        </div>

        <p className="panel__meta muted">
          {t('settings:benchmark.household.you', {
            year: String(thisYear),
            name: selfLabelText.trim() || t('settings:benchmark.household.selfLabelPlaceholder'),
          })}
        </p>

        {rows.length === 0 ? (
          <p className="muted">{t('settings:benchmark.household.none')}</p>
        ) : (
          <ul className="members">
            {rows.map((row, index) => {
              const birthYear = parseYear(row.birthYear)
              const custodyBp = parseBp(row.custodyBp)
              const weight =
                birthYear === null || childAgeBelow === null
                  ? null
                  : thisYear - birthYear < childAgeBelow
                    ? 'asChild'
                    : 'asAdult'
              return (
                // The index is the key because a row has no id: it is a position in a
                // list that is replaced whole, and two members can be identical.
                <li className="member" key={index}>
                  <div className="member__fields">
                    <div className="field">
                      <label className="field__label" htmlFor={`member-label-${String(index)}`}>
                        {t('settings:benchmark.household.label')}
                      </label>
                      <input
                        id={`member-label-${String(index)}`}
                        className="field__input"
                        type="text"
                        autoComplete="off"
                        maxLength={40}
                        value={row.label}
                        disabled={locked}
                        onChange={(event) => edit(index, 'label', event.target.value)}
                      />
                    </div>

                    <div className="field">
                      <label className="field__label" htmlFor={`member-year-${String(index)}`}>
                        {t('settings:benchmark.household.birthYear')}
                      </label>
                      <input
                        id={`member-year-${String(index)}`}
                        className="field__input num"
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        value={row.birthYear}
                        disabled={locked}
                        onChange={(event) => edit(index, 'birthYear', event.target.value)}
                      />
                    </div>

                    <div className="field">
                      <label className="field__label" htmlFor={`member-custody-${String(index)}`}>
                        {t('settings:benchmark.household.custody')}
                      </label>
                      <input
                        id={`member-custody-${String(index)}`}
                        className="field__input num"
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        value={row.custodyBp}
                        disabled={locked}
                        onChange={(event) => edit(index, 'custodyBp', event.target.value)}
                      />
                    </div>
                  </div>

                  <p className="member__reads muted">
                    {birthYear === null || custodyBp === null
                      ? t('settings:benchmark.household.notANumber')
                      : weight === null
                        ? t('settings:benchmark.household.readsShare', {
                            share: formatBp(custodyBp),
                          })
                        : t('settings:benchmark.household.reads', {
                            weight: t(`settings:benchmark.household.${weight}`),
                            share: formatBp(custodyBp),
                          })}
                  </p>

                  <button
                    type="button"
                    className="button button--quiet"
                    disabled={locked}
                    onClick={() => setDrafts(rows.filter((_, at) => at !== index))}
                  >
                    {t('settings:benchmark.household.remove')}
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {/*
          The share, under the roster it is derived from. One number for the household
          rather than one per category, because the arrangement people actually have is
          one split applied to the things that are shared — the flag on a category says
          which things, and this says how much (#44).
        */}
        <div className="field">
          <label className="field__label" htmlFor="shared-cost">
            {t('settings:benchmark.household.sharedCost')}
          </label>
          <input
            id="shared-cost"
            className="field__input num"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={sharedText}
            disabled={locked}
            onChange={(event) => setSharedDraft(event.target.value)}
          />
          <p className="member__reads muted">{sharedReads}</p>
          <p className="panel__meta muted">
            {t('settings:benchmark.household.sharedCostHint')}
          </p>
        </div>

        <Issue message={state.issue('members')} />
        <Issue message={state.issue('sharedCostBp')} />

        <div className="members__actions">
          <button
            type="button"
            className="button button--quiet"
            disabled={locked || rows.length >= MAX_HOUSEHOLD_MEMBERS}
            onClick={() =>
              // Full time by default: the common row is somebody who lives here, and a
              // custody share is the exception that gets typed.
              setDrafts([...rows, { label: '', birthYear: '', custodyBp: '10000' }])
            }
          >
            {t('settings:benchmark.household.add')}
          </button>
          <button
            type="submit"
            className="button button--primary"
            disabled={
              locked ||
              (drafts === null && sharedDraft === null && selfLabelDraft === null) ||
              invalid.size > 0 ||
              sharedInvalid
            }
          >
            {state.pending === 'household' ? t('shell.loading') : t('action.save')}
          </button>
        </div>
      </form>

      {file === null ? null : <Provenance file={file} />}
    </Panel>
  )
}

/**
 * Where every figure in the comparison comes from, and which parts nobody has checked.
 *
 * Always visible rather than behind a disclosure, for the reason the tax block gives: a
 * number nobody can trace is a number this app made up.
 */
function Provenance({ file }: { file: NonNullable<BenchmarkSetting['file']> }): ReactNode {
  const { t, language } = useT()
  const { equivalence, source, transcribed } = file

  return (
    <div className="stack">
      <p className="panel__subtitle">{t('settings:benchmark.provenance.title')}</p>
      <ul className="provenance">
        <li>
          {t('settings:benchmark.provenance.survey', {
            citation: source.citation,
            verified: formatDate(source.lastVerified),
          })}
        </li>
        <li>
          {t('settings:benchmark.provenance.scale', {
            citation: equivalence.citation,
            verified: formatDate(equivalence.lastVerified),
          })}
        </li>
        <li>
          {t('settings:benchmark.provenance.weights', {
            first: formatBp(equivalence.firstPersonBp),
            adult: formatBp(equivalence.additionalPersonBp),
            child: formatBp(equivalence.childBp),
            age: String(equivalence.childAgeBelow),
          })}
        </li>
        {file.hasReferenceHousehold ? null : (
          <li>{t('settings:benchmark.provenance.mixOnly')}</li>
        )}
        {transcribed.length === 0 ? null : (
          <li>
            {t('settings:benchmark.provenance.transcribed', {
              blocks: formatList(
                transcribed.map((block) => t(`budget:benchmark.block.${block}`)),
                language,
              ),
            })}
          </li>
        )}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------
//  The mapping
// ---------------------------------------------------------------------------

export function MappingPanel({ settings, state, owner }: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const { benchmark } = settings
  const { categories, file } = benchmark
  const locked = !owner || state.busy

  /** Which reference line a division feeds, from the file rather than from a copy of it. */
  const lineOf = (division: string): string | null =>
    file?.groups.find((group) => group.coicop.some((code) => code === division))?.id ?? null

  /**
   * The stored code as a division the picker can actually show as selected.
   *
   * A stored code may be `04.5.1` — `loadMapping` says so, and a proposal is allowed to
   * write one — and a `<select>` whose value matches no option falls back to displaying
   * the first, which here is "not mapped". That would tell somebody their category is
   * unmapped while the comparison is happily counting it under housing. `divisionOf` is
   * the same reader the comparison uses, so the two cannot disagree; anything it cannot
   * read, or reads as a division outside the choices, is shown as unmapped because that
   * is what the comparison does with it.
   */
  const choiceOf = (code: string | null): string => {
    const division = code === null ? null : divisionOf(code)
    if (division === null) return ''
    return division === OUTSIDE_CONSUMPTION ||
      (COICOP_DIVISIONS as readonly string[]).includes(division)
      ? division
      : ''
  }

  // Counted with the same reader the column uses, so the number above the table cannot
  // disagree with what the rows show — a category whose stored code nothing can read is
  // unmapped as far as the comparison is concerned, and so it is here.
  const unmapped = categories.filter(
    (category) => choiceOf(category.coicop) === '' && !category.isIncome && !category.hidden,
  ).length

  return (
    <Panel
      title={t('settings:benchmark.mapping.title')}
      hint={t('settings:benchmark.mapping.hint')}
      notice={owner ? null : <p className="panel__meta muted">{t('settings:viewerOnly')}</p>}
    >
      {categories.length === 0 ? (
        <p className="muted">{t('settings:benchmark.mapping.none')}</p>
      ) : (
        <>
          <p className="panel__meta muted">
            {t('settings:benchmark.mapping.progress', {
              count: unmapped,
              total: String(categories.length),
            })}
          </p>
          {/*
            What ticking the box does, said next to the boxes. The one thing it has to
            get across is that nothing is adjusted: the split adds a second figure beside
            Actual's, and a person who reads it as an edit to their budget would be right
            to be alarmed (#44).
          */}
          <p className="panel__meta muted">{t('settings:benchmark.mapping.sharedNote')}</p>

          <div className="table-scroll">
            <table className="table">
              <caption className="table__caption">
                {t('settings:benchmark.mapping.caption')}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t('settings:benchmark.mapping.column.category')}</th>
                  <th scope="col" className="table__cell--number">
                    {t('settings:benchmark.mapping.column.spent')}
                  </th>
                  <th scope="col">{t('settings:benchmark.mapping.column.division')}</th>
                  <th scope="col">{t('settings:benchmark.mapping.column.line')}</th>
                  <th scope="col">{t('settings:benchmark.mapping.column.shared')}</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((category) => {
                  const choice = choiceOf(category.coicop)
                  const line = choice === '' ? null : lineOf(choice)
                  return (
                    <tr key={category.categoryId}>
                      <th scope="row" className="table__cell--name">
                        {category.categoryName}
                        {category.isIncome || category.hidden ? (
                          <span className="badge mapping__flag">
                            {t(
                              `settings:benchmark.mapping.${category.isIncome ? 'income' : 'hidden'}`,
                            )}
                          </span>
                        ) : null}
                      </th>
                      <td className="table__cell--number">
                        <Money cents={category.spentCents} options={{ whole: true }} />
                      </td>
                      <td>
                        <select
                          className="field__input"
                          aria-label={t('settings:benchmark.mapping.inputLabel', {
                            name: category.categoryName,
                          })}
                          value={choice}
                          disabled={locked}
                          onChange={(event) => {
                            const raw = event.target.value
                            state.save(
                              `coicop:${category.categoryId}`,
                              'PATCH',
                              `/api/settings/categories/${category.categoryId}/coicop`,
                              // The empty option is a real answer, not an absence: taking
                              // a wrong mapping back is the correction this route exists
                              // for, which is why it is the only path that writes null.
                              { coicop: raw === '' ? null : raw },
                            )
                          }}
                        >
                          <option value="">{t('settings:benchmark.mapping.unmapped')}</option>
                          <optgroup label={t('settings:benchmark.mapping.consumption')}>
                            {COICOP_DIVISIONS.map((division) => (
                              <option key={division} value={division}>
                                {t(`settings:benchmark.coicop.${division}`)}
                              </option>
                            ))}
                          </optgroup>
                          <optgroup label={t('settings:benchmark.mapping.outside')}>
                            <option value={OUTSIDE_CONSUMPTION}>
                              {t(`settings:benchmark.coicop.${OUTSIDE_CONSUMPTION}`)}
                            </option>
                          </optgroup>
                        </select>
                      </td>
                      {/*
                        Which of the survey's ten lines this choice feeds, so a division
                        picked from a menu of twelve can be checked against the table it
                        will appear in. `00` feeds none by design and says so.
                      */}
                      <td className="muted">
                        {choice === ''
                          ? '—'
                          : line === null
                            ? t('settings:benchmark.mapping.notCompared')
                            : t(`budget:benchmark.group.${line}`)}
                      </td>
                      {/*
                        Disabled for income and hidden categories because `splitCustody`
                        excludes both, so a tick there would store a flag with no effect
                        and read as one that had one. The badge in the first column
                        already says which kind of row this is, which is why the box needs
                        no explanation of its own.
                      */}
                      <td className="mapping__shared">
                        <input
                          type="checkbox"
                          aria-label={t('settings:benchmark.mapping.sharedLabel', {
                            name: category.categoryName,
                          })}
                          checked={category.custodyShared}
                          disabled={locked || category.isIncome || category.hidden}
                          onChange={(event) => {
                            state.save(
                              `custodyShared:${category.categoryId}`,
                              'PATCH',
                              `/api/settings/categories/${category.categoryId}/custody-shared`,
                              { custodyShared: event.target.checked },
                            )
                          }}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  )
}
