/**
 * The prompt editor: which instructions are in use, what a change would look like, and
 * what it would produce before it becomes the ones that run every night.
 *
 * Five things here are deliberate and none of them is obvious.
 *
 * **There is one set of instructions, not one per language.** They are addressed to the
 * model, and the language of the reply is a separate directive appended to every run, so
 * a second translation of them would be two copies of the rule "never produce a number"
 * drifting apart. The picker's first entry is that shared text and it is where the editor
 * opens; a language appears beside it only once someone has deliberately written a
 * version for that language alone, which is why divergence is visible rather than the
 * default.
 *
 * **What is being edited is not always a stored row.** `resolvePrompt` falls back from a
 * language's own active version to the shared text and from there to the built-in
 * constant, and the editor has to say which of the three it is showing. Someone who
 * opens a Dutch prompt, sees text, and saves an edit to it would otherwise have created
 * a Dutch version out of the shared one without ever being told that is what happened.
 *
 * **Saving and activating are separate.** The point of versioning a prompt is that the
 * text which produced last month's output still exists, so the default gesture stores a
 * version and changes nothing. Activating is one click on any row in the history, which
 * is also the rollback: an older version's id, and its text is in use again untouched.
 *
 * **The test runs a stored version, not the textarea.** `POST /api/ai/dry-run` takes a
 * `promptId`, so the order is save, then test, then activate — and the Test button
 * therefore lives on version rows rather than under the editor. That is the honest
 * shape: a dry run costs real money and writes a ledger row, and pricing a run against
 * text that exists only in a browser tab would leave nothing to compare the result to.
 * Only analysis prompts can be tested; the server refuses a narrative one, because the
 * analysis pass is what produces findings.
 *
 * **The estimate is free and the run is not.** `GET /api/ai/estimate` builds the same
 * payload and prices it locally, so it can be shown before anything is spent. On a
 * deployment whose jobs have never run there is no month to price — a 409, not an error
 * worth a red box — and the Test button says so instead of failing when pressed.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { useT, type TFunction } from '../i18n.ts'
import {
  formatDateTime,
  formatDecimal,
  formatMicroEur,
  formatMonth,
  isSharedLocale,
  SHARED_LOCALE,
  type AiAvailabilityWire,
  type AiDryRun,
  type AiEstimate,
  type PromptBody,
  type PromptDiff,
  type PromptSetting,
  type PromptVersionSetting,
} from '../shared.ts'
import { Issue, Panel } from './Panel.tsx'
import type { SettingsPanelProps } from './state.ts'

/** The only key a dry run accepts, because it is the pass that produces findings. */
const TESTABLE_KEY = 'analysis.system'

/** What the editor holds, and which `(key, locale)` it was opened for. */
interface Draft {
  for: string
  body: string
  note: string
}

const selectionOf = (key: string, locale: string): string => `${key}:${locale}`

/**
 * How a language reads, including the sentinel that stands for all of them.
 *
 * `settings:language.*` would be a real key on paper and an odd one on screen, and the
 * shared entry is not a language — it is the absence of a choice of language.
 */
const languageName = (t: TFunction, locale: string): string =>
  isSharedLocale(locale)
    ? t('settings:prompt.language.shared')
    : t(`settings:language.${locale}`, { defaultValue: locale })

export function PromptsPanel({ settings, state, owner, estimate }: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const { prompts } = settings

  const keys = useMemo(() => [...new Set(prompts.map((entry) => entry.key))], [prompts])
  // Per key, not across all of them: one key can have a Dutch version while another has
  // none, and offering Dutch for a key that has no Dutch row would select nothing.
  const localesFor = (forKey: string): string[] =>
    prompts.filter((entry) => entry.key === forKey).map((entry) => entry.locale)

  const [key, setKey] = useState<string>(() => keys[0] ?? '')
  // The shared text, whatever the reader's own language: it is what runs unless someone
  // has written an override, so it is what "the instructions" means.
  const [locale, setLocale] = useState<string>(SHARED_LOCALE)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [diff, setDiff] = useState<{ stamp: string; diff: PromptDiff } | null>(null)
  const [run, setRun] = useState<{ for: string; result: AiDryRun } | null>(null)

  const entry = prompts.find((candidate) => candidate.key === key && candidate.locale === locale)
  const selection = selectionOf(key, locale)

  // Derived rather than reseeded by an effect: when the selection changes the draft no
  // longer belongs to it, so the active body shows through without anything having to
  // notice the change and copy it across.
  const body = draft?.for === selection ? draft.body : (entry?.active.body ?? '')
  const note = draft?.for === selection ? draft.note : ''
  const stamp = `${selection}\n${body}`

  const edit = (next: Partial<Omit<Draft, 'for'>>): void => {
    setDraft({ for: selection, body, note, ...next })
  }

  const select = (nextKey: string, nextLocale: string): void => {
    setKey(nextKey)
    // Switching to a key that has no version for the language on screen falls back to
    // the shared text rather than to an empty panel.
    setLocale(localesFor(nextKey).includes(nextLocale) ? nextLocale : SHARED_LOCALE)
    // The run describes a version of what was selected; keeping it on screen under a
    // different prompt's heading would attribute one prompt's findings to another.
    setRun(null)
  }

  // After a write that created or retired an override: the entry the picker needs
  // exists in the answer, which `select`'s clamp — reading the payload this render was
  // built from — would not yet know about.
  const jumpTo = (nextLocale: string): void => {
    setLocale(nextLocale)
    setDraft(null)
    setRun(null)
  }

  if (entry === undefined) {
    return (
      <Panel title={t('settings:prompt.title')} hint={t('settings:prompt.hint')}>
        <p className="muted">{t('settings:prompt.versionsNone')}</p>
      </Panel>
    )
  }

  return (
    <Panel
      title={t('settings:prompt.title')}
      hint={t('settings:prompt.hint')}
      notice={owner ? null : <p className="panel__meta muted">{t('settings:viewerOnly')}</p>}
    >
      <div className="prompt__pickers">
        <div className="field">
          <label className="field__label" htmlFor="prompt-key">
            {t('settings:prompt.which')}
          </label>
          <select
            id="prompt-key"
            className="field__input"
            value={key}
            disabled={state.busy}
            onChange={(event) => select(event.target.value, locale)}
          >
            {keys.map((option) => (
              <option key={option} value={option}>
                {t(`settings:prompt.key.${option}`)}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="prompt-locale">
            {t('settings:prompt.locale')}
          </label>
          <select
            id="prompt-locale"
            className="field__input"
            value={locale}
            disabled={state.busy}
            onChange={(event) => select(key, event.target.value)}
          >
            {localesFor(key).map((option) => (
              <option key={option} value={option}>
                {languageName(t, option)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Fallback entry={entry} locale={locale} />

      <div className="field">
        <label className="field__label" htmlFor="prompt-body">
          {t('settings:prompt.body')}
        </label>
        <textarea
          id="prompt-body"
          className="field__input prompt__body"
          rows={14}
          spellCheck={false}
          value={body}
          disabled={!owner || state.busy}
          onChange={(event) => edit({ body: event.target.value })}
        />
        <Issue message={state.issue('body')} />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="prompt-note">
          {t('settings:prompt.note')}
        </label>
        <input
          id="prompt-note"
          className="field__input"
          type="text"
          value={note}
          placeholder={t('settings:prompt.notePlaceholder')}
          disabled={!owner || state.busy}
          onChange={(event) => edit({ note: event.target.value })}
        />
        <Issue message={state.issue('note')} />
      </div>

      <div className="prompt__actions">
        <button
          type="button"
          className="button button--quiet"
          disabled={state.busy || body.trim() === ''}
          onClick={() => {
            state.ask<PromptDiff>(
              'diff',
              'POST',
              '/api/settings/prompts/diff',
              { key, locale, body },
              (result) => setDiff({ stamp, diff: result }),
            )
          }}
        >
          {t('settings:prompt.diff.compare')}
        </button>

        {(['save', 'saveAndActivate'] as const).map((action) => (
          <button
            key={action}
            type="button"
            className={action === 'save' ? 'button button--quiet' : 'button button--primary'}
            disabled={!owner || state.busy || body.trim() === ''}
            onClick={() => {
              state.save(
                action,
                'POST',
                '/api/settings/prompts',
                {
                  key,
                  locale,
                  body,
                  ...(note.trim() === '' ? {} : { note }),
                  ...(action === 'saveAndActivate' ? { activate: true } : {}),
                },
                // The text stays in the box, the note does not: the version now exists
                // and carries it, and leaving it there invites saving it twice.
                () => setDraft({ for: selection, body, note: '' }),
              )
            }}
          >
            {t(`settings:prompt.${action}`)}
          </button>
        ))}
      </div>

      {diff === null || diff.stamp !== stamp ? null : <DiffView diff={diff.diff} />}

      <Overrides
        entry={entry}
        promptKey={key}
        locale={locale}
        body={body}
        written={localesFor(key)}
        supported={settings.locales.supported}
        state={state}
        owner={owner}
        onJump={jumpTo}
      />

      {entry.key !== TESTABLE_KEY ? null : settings.ai.availability.enabled ? (
        <DryRun
          entry={entry}
          state={state}
          owner={owner}
          estimate={estimate}
          run={run?.for === selection ? run.result : null}
          onRun={(result) => setRun({ for: selection, result })}
        />
      ) : (
        // The editor stays usable without a model — writing and versioning the text costs
        // nothing and is worth doing before buying a key — but the one control that would
        // call Gemini says why it cannot instead of failing when pressed (#165).
        <DryRunOff availability={settings.ai.availability} />
      )}

      <Versions
        entry={entry}
        state={state}
        owner={owner}
        onOpen={(loaded) =>
          setDraft({ for: selection, body: loaded.body, note: loaded.note ?? '' })
        }
      />
    </Panel>
  )
}

/**
 * Which text the box actually contains, when it is not the selection's own version.
 *
 * Silent on the two ordinary cases — the shared prompt with a stored version, and a
 * language with an active override — because a notice on every prompt would train
 * people to skip the one that matters. What is left is the two states someone could
 * otherwise edit without noticing: nothing is stored anywhere, so the box holds a
 * constant compiled into the build; or this language has versions but none of them is
 * active, so what runs for it is the shared text and not what is on screen above.
 */
function Fallback({ entry, locale }: { entry: PromptSetting; locale: string }): ReactNode {
  const { t } = useT()
  const { active } = entry

  if (active.id === null) {
    return (
      <div className="notice notice--info" role="status">
        <p className="notice__lead">{t('settings:prompt.fallback.builtIn')}</p>
      </div>
    )
  }
  if (active.locale === locale) return null

  return (
    <div className="notice notice--info" role="status">
      <p className="notice__lead">{t('settings:prompt.override.off')}</p>
    </div>
  )
}

interface OverridesProps {
  entry: PromptSetting
  promptKey: string
  locale: string
  body: string
  /** The locales this key already has an entry for, the shared sentinel included. */
  written: string[]
  supported: string[]
  state: SettingsPanelProps['state']
  owner: boolean
  onJump: (locale: string) => void
}

/**
 * Making one language diverge, and undoing it.
 *
 * The whole point of the shared prompt is that there is normally nothing to decide here,
 * so this is a button rather than an entry in the picker: a language cannot be selected
 * until someone has deliberately given it a version, and the act of doing so is what
 * puts it in the picker. Divergence stays possible and becomes visible, in that order.
 *
 * Going back is `deactivateOverride` rather than a delete, so the versions written for
 * that language survive and activating one is the way back — the same rollback gesture
 * as everywhere else on this panel, and no gesture here destroys text.
 */
function Overrides({
  entry,
  promptKey,
  locale,
  body,
  written,
  supported,
  state,
  owner,
  onJump,
}: OverridesProps): ReactNode {
  const { t } = useT()
  const missing = supported.filter((candidate) => !written.includes(candidate))
  const overriding = !isSharedLocale(locale) && entry.active.locale === locale

  // Nothing to offer: every language already has a version and this is the shared text.
  if (!overriding && missing.length === 0) return null

  return (
    <section className="prompt__override">
      <h3 className="panel__subtitle">{t('settings:prompt.override.title')}</h3>
      <p className="muted">{t('settings:prompt.override.hint')}</p>
      <div className="prompt__actions">
        {overriding ? (
          <button
            type="button"
            className="button button--quiet"
            disabled={!owner || state.busy}
            onClick={() => {
              state.save(
                `shared:${locale}`,
                'POST',
                `/api/settings/prompts/${promptKey}/${locale}/shared`,
                undefined,
                () => onJump(SHARED_LOCALE),
              )
            }}
          >
            {t('settings:prompt.override.drop')}
          </button>
        ) : (
          missing.map((candidate) => (
            <button
              key={candidate}
              type="button"
              className="button button--quiet"
              disabled={!owner || state.busy || body.trim() === ''}
              onClick={() => {
                // The box, like every other button on this panel that sends text: what
                // is on screen becomes that language's first version, and it starts
                // active because an inactive override changes nothing and would leave
                // the language reading the shared text with no sign of why.
                state.save(
                  `override:${candidate}`,
                  'POST',
                  '/api/settings/prompts',
                  { key: promptKey, locale: candidate, body, activate: true },
                  () => onJump(candidate),
                )
              }}
            >
              {t('settings:prompt.override.create', { language: languageName(t, candidate) })}
            </button>
          ))
        )}
      </div>
    </section>
  )
}

/** `same` | `add` | `del` as the catalogue words them. */
const OP_KEY: Record<string, string> = {
  same: 'unchanged',
  add: 'added',
  del: 'removed',
}

function DiffView({ diff }: { diff: PromptDiff }): ReactNode {
  const { t } = useT()

  return (
    <section className="prompt__diff">
      <h3 className="panel__subtitle">{t('settings:prompt.diff.title')}</h3>
      <p className="muted">
        {diff.stat.identical
          ? t('settings:prompt.diff.identical')
          : t('settings:prompt.diff.stat', {
              added: formatDecimal(diff.stat.added, 0),
              removed: formatDecimal(diff.stat.removed, 0),
            })}
      </p>
      {diff.stat.identical ? null : (
        <ol className="diff">
          {diff.lines.map((line, index) => (
            <li className={`diff__line diff__line--${line.op}`} key={`${String(index)}:${line.op}`}>
              <span className="sr-only">{t(`settings:prompt.diff.${OP_KEY[line.op] ?? 'unchanged'}`)}</span>
              <span className="diff__gutter num" aria-hidden="true">
                {line.oldLine === null ? '' : formatDecimal(line.oldLine, 0)}
              </span>
              <span className="diff__gutter num" aria-hidden="true">
                {line.newLine === null ? '' : formatDecimal(line.newLine, 0)}
              </span>
              <span className="diff__text">{line.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

/**
 * The test run's heading with the reason in place of the button.
 *
 * The same three sentences the insights panel prints, from the same `ai:off.*` keys: a
 * reader who has just written a prompt and cannot test it needs the variable to set, not
 * a control that has quietly gone missing.
 */
function DryRunOff({ availability }: { availability: AiAvailabilityWire }): ReactNode {
  const { t } = useT()
  // Never null while `enabled` is false; the type cannot prove it at this point.
  const reason = availability.reason ?? 'notConfigured'

  return (
    <section className="prompt__dryrun">
      <h3 className="panel__subtitle">{t('settings:prompt.dryRun.title')}</h3>
      <p className="muted">{t(`ai:off.reason.${reason}`)}</p>
      <p className="muted">{t(`ai:off.how.${reason}`)}</p>
    </section>
  )
}

interface DryRunProps {
  entry: PromptSetting
  state: SettingsPanelProps['state']
  owner: boolean
  estimate: SettingsPanelProps['estimate']
  run: AiDryRun | null
  onRun: (result: AiDryRun) => void
}

/**
 * The test run, priced before it happens.
 *
 * Mounted only for the analysis prompt, which is also the only key the server will
 * run: pricing an estimate costs a request, and asking for one while the narrative
 * prompt is on screen would spend it on a button that cannot appear.
 *
 * The button is on the active version rather than on every row for one reason: pressing
 * it spends money, and a row of identical buttons down a version history is how one
 * gets pressed by accident. Testing an older version is still a click — activate it,
 * or open it and save it as the newest — and neither of those costs anything.
 *
 * `promptId` pins which text runs, so the `locale` on the request decides only which
 * language the findings come back in. Testing a language's override asks for that
 * language, because reading its output is the point of having written it; testing the
 * shared text asks for nothing and lets the server answer in the reader's own, which
 * is what the nightly job would do for them.
 */
function DryRun({ entry, state, owner, estimate, run, onRun }: DryRunProps): ReactNode {
  const { t, language } = useT()
  const promptId = entry.active.id
  const priced: AiEstimate | null = estimate.data
  // A 409 is the fresh-deployment answer — nothing has been aggregated, so there is no
  // month to price a run against. Anything else is a real failure and says so. The
  // endpoint's other 409, an unavailable model, cannot arrive here: this component is
  // not mounted in that case, which is what keeps one code to one sentence (#165).
  const noMonth = estimate.error?.code === 'conflict'

  return (
    <section className="prompt__dryrun">
      <h3 className="panel__subtitle">{t('settings:prompt.dryRun.title')}</h3>
      <p className="muted">{t('settings:prompt.dryRun.warning')}</p>

      {noMonth ? <p className="muted">{t('settings:prompt.dryRun.noMonth')}</p> : null}
      {priced === null ? null : (
        <>
          <p className="muted">
            {t('settings:prompt.dryRun.estimate', {
              month: formatMonth(priced.month, language),
              cost: formatMicroEur(priced.estimateMicroEur),
            })}
          </p>
          {priced.allowed || priced.reason === null ? null : (
            <p className="notice notice--warn" role="status">
              {t(`settings:ai.reason.${priced.reason}`)}
            </p>
          )}
          <button
            type="button"
            className="button button--quiet"
            disabled={!owner || state.busy || !priced.allowed || promptId === null}
            onClick={() => {
              state.ask<AiDryRun>(
                'dry-run',
                'POST',
                '/api/ai/dry-run',
                {
                  month: priced.month,
                  ...(isSharedLocale(entry.locale) ? {} : { locale: entry.locale }),
                  ...(promptId === null ? {} : { promptId }),
                },
                onRun,
              )
            }}
          >
            {state.pending === 'dry-run'
              ? t('settings:prompt.dryRun.running')
              : t('settings:prompt.dryRun.run', { month: formatMonth(priced.month, language) })}
          </button>
        </>
      )}

      {run === null ? null : <Outcome run={run} />}
    </section>
  )
}

/** What the run produced, and what it threw away. */
function Outcome({ run }: { run: AiDryRun }): ReactNode {
  const { t } = useT()
  const nothing =
    run.findings.length === 0 && run.clarifications.length === 0 && run.dropped.length === 0

  return (
    <div className="dryrun">
      <p className="dryrun__head">
        <span className={`badge badge--${run.status}`}>{t(`status.${run.status}`)}</span>{' '}
        {t(`settings:ai.reason.${run.reason}`)}
      </p>
      <p className="muted">
        {t('settings:prompt.dryRun.cost', { cost: formatMicroEur(run.costMicroEur) })}
      </p>
      {run.degraded ? <p className="muted">{t('settings:prompt.dryRun.degraded')}</p> : null}

      {nothing ? <p className="muted">{t('settings:prompt.dryRun.nothing')}</p> : null}

      {run.findings.length === 0 ? null : (
        <>
          <h4 className="dryrun__subtitle">{t('settings:prompt.dryRun.findings')}</h4>
          <ul className="dryrun__list">
            {run.findings.map((finding) => (
              <li key={`${finding.code}:${finding.categoryId ?? ''}`}>
                <span className={`badge badge--${finding.severity}`}>
                  {t(`severity.${finding.severity}`)}
                </span>{' '}
                {finding.text}
                {finding.confidence === null ? null : (
                  <span className="muted">
                    {' · '}
                    {t('settings:prompt.dryRun.confidence', {
                      confidence: formatDecimal(finding.confidence, 0),
                    })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {run.clarifications.length === 0 ? null : (
        <>
          <h4 className="dryrun__subtitle">{t('settings:prompt.dryRun.clarifications')}</h4>
          <ul className="dryrun__list">
            {run.clarifications.map((question) => (
              <li key={`${question.code}:${question.categoryId}`}>
                {question.categoryName} — {question.guess}
              </li>
            ))}
          </ul>
        </>
      )}

      {run.dropped.length === 0 ? null : (
        <>
          <h4 className="dryrun__subtitle">{t('settings:prompt.dryRun.dropped')}</h4>
          <ul className="dryrun__list">
            {run.dropped.map((entry, index) => (
              <li key={`${entry.code}:${entry.label}:${String(index)}`}>
                {entry.label} — {t(`settings:prompt.dryRun.droppedReason.${entry.reason}`)}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

interface VersionsProps {
  entry: PromptSetting
  state: SettingsPanelProps['state']
  owner: boolean
  onOpen: (loaded: PromptBody) => void
}

function Versions({ entry, state, owner, onOpen }: VersionsProps): ReactNode {
  const { t } = useT()

  if (entry.versions.length === 0) {
    return (
      <section>
        <h3 className="panel__subtitle">{t('settings:prompt.versions')}</h3>
        <p className="muted">{t('settings:prompt.versionsNone')}</p>
      </section>
    )
  }

  return (
    <section>
      <h3 className="panel__subtitle">{t('settings:prompt.versions')}</h3>
      <ul className="versions">
        {entry.versions.map((version) => (
          <Version
            key={version.id}
            version={version}
            busy={state.busy}
            owner={owner}
            onOpen={() => {
              state.ask<PromptBody>(
                `open:${version.id}`,
                'GET',
                `/api/settings/prompts/${version.id}`,
                undefined,
                onOpen,
              )
            }}
            onActivate={() => {
              state.save(
                `activate:${version.id}`,
                'POST',
                `/api/settings/prompts/${version.id}/activate`,
                undefined,
              )
            }}
          />
        ))}
      </ul>
    </section>
  )
}

interface VersionProps {
  version: PromptVersionSetting
  busy: boolean
  owner: boolean
  onOpen: () => void
  onActivate: () => void
}

function Version({ version, busy, owner, onOpen, onActivate }: VersionProps): ReactNode {
  const { t } = useT()

  return (
    <li className="version">
      <div className="version__head">
        <span className="version__number">
          {t('settings:prompt.version', { version: formatDecimal(version.version, 0) })}
        </span>
        {version.active ? (
          <span className="badge badge--truth">{t('settings:prompt.active')}</span>
        ) : null}
      </div>
      <p className="version__meta muted num">
        {t('settings:prompt.chars', { chars: formatDecimal(version.chars, 0) })} ·{' '}
        {t('settings:prompt.created', { when: formatDateTime(version.createdAt) })}
      </p>
      {version.note === null ? null : <p className="version__note">{version.note}</p>}
      <div className="version__actions">
        <button type="button" className="button button--quiet" disabled={busy} onClick={onOpen}>
          {t('action.edit')}
        </button>
        {version.active ? null : (
          <button
            type="button"
            className="button button--quiet"
            disabled={!owner || busy}
            onClick={onActivate}
          >
            {t('settings:prompt.activate')}
          </button>
        )}
      </div>
    </li>
  )
}
