/**
 * The prompt editor: which instructions are in use, what a change would look like, and
 * what it would produce before it becomes the ones that run every night.
 *
 * Four things here are deliberate and none of them is obvious.
 *
 * **What is being edited is not always a stored row.** `resolvePrompt` falls back from
 * the Dutch active version to the English one and from there to the built-in constant,
 * and the editor has to say which of the three it is showing. Someone who opens "the
 * Dutch analysis prompt", sees text, and saves an edit to it would otherwise have
 * created a Dutch version out of the English one without ever being told that is what
 * happened.
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
import { useResource } from '../api/resource.tsx'
import { useT } from '../i18n.ts'
import {
  formatDateTime,
  formatDecimal,
  formatMicroEur,
  formatMonth,
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

export function PromptsPanel({ settings, state, owner }: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const { prompts } = settings

  const keys = useMemo(() => [...new Set(prompts.map((entry) => entry.key))], [prompts])
  const locales = useMemo(() => [...new Set(prompts.map((entry) => entry.locale))], [prompts])

  const [key, setKey] = useState<string>(() => keys[0] ?? '')
  const [locale, setLocale] = useState<string>(() =>
    locales.includes(settings.profile.locale) ? settings.profile.locale : (locales[0] ?? ''),
  )
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
    setLocale(nextLocale)
    // The run describes a version of what was selected; keeping it on screen under a
    // different prompt's heading would attribute one prompt's findings to another.
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
            {locales.map((option) => (
              <option key={option} value={option}>
                {t(`settings:language.${option}`, { defaultValue: option })}
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

      {entry.key === TESTABLE_KEY ? (
        <DryRun
          entry={entry}
          state={state}
          owner={owner}
          run={run?.for === selection ? run.result : null}
          onRun={(result) => setRun({ for: selection, result })}
        />
      ) : null}

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
 * Which text the box actually contains, when it is not this locale's own version.
 *
 * Silent on the ordinary case: a stored version for this locale needs no explanation,
 * and a notice on every prompt would train people to skip the one that matters.
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
      <p className="notice__lead">
        {t('settings:prompt.fallback.otherLocale', {
          version: formatDecimal(active.version, 0),
          locale: t(`settings:language.${active.locale}`, { defaultValue: active.locale }),
        })}
      </p>
    </div>
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

interface DryRunProps {
  entry: PromptSetting
  state: SettingsPanelProps['state']
  owner: boolean
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
 */
function DryRun({ entry, state, owner, run, onRun }: DryRunProps): ReactNode {
  const { t, language } = useT()
  const estimate = useResource<AiEstimate>('/api/ai/estimate')
  const promptId = entry.active.id
  const priced: AiEstimate | null = estimate.data
  // A 409 is the fresh-deployment answer — nothing has been aggregated, so there is no
  // month to price a run against. Anything else is a real failure and says so.
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
                { locale: entry.locale, month: priced.month, ...(promptId === null ? {} : { promptId }) },
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
