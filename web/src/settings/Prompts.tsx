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
 *
 * **The safety check is about the box, not a row** (#454). `POST /api/ai/prompt-validate` writes
 * a verdict onto one stored version, so checking has to know which version the box's current
 * text matches — its *anchor*, set whenever the box is loaded, opened, or saved, and left
 * untouched by typing (see `Draft.anchorId`/`anchorBody`). Unmodified text checks the anchored
 * row directly, the ordinary cache-reuse path; modified text has nothing stored to check yet, so
 * the button saves the box as a new version first and validates that one, then re-anchors to it.
 * Nothing here names a version number — the person editing never asked to manage one, only to
 * check whatever is in front of them. Offered for gated keys only.
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
  type PromptGate,
  type PromptSetting,
  type PromptValidation,
  type PromptVersionSetting,
  type Settings,
} from '../shared.ts'
import { Issue, Panel } from './Panel.tsx'
import type { SettingsPanelProps } from './state.ts'

/** The only key a dry run accepts, because it is the pass that produces findings. */
const TESTABLE_KEY = 'analysis.system'

/**
 * Whether this key's active body needs a safety verdict before it may run (#454, #468).
 *
 * A duplicate of `isGatedKey` in `src/domain/ai/prompts.ts`, which is the source of truth —
 * `web/` does not import domain modules, so the rule is copied rather than shared. It only
 * decides whether a *section* is drawn; `POST /api/ai/prompt-validate` refuses a check on a
 * key this mode does not gate with a `400` regardless, so a stale copy here is a missing
 * button and never a check that should not have happened — which is why, unlike the rule it
 * mirrors, it does not need to be exact in the direction of gating a key too little.
 *
 * `narrative.system` is gated unconditionally; `analysis.system` only under `locked`, the
 * default — under `full` an edit to it needs no sign-off, so offering the check there would
 * be a button that always 400s.
 */
const isGatedKey = (promptEditing: string, key: string): boolean =>
  key === 'narrative.system' || (key === 'analysis.system' && promptEditing === 'locked')

/**
 * What the editor holds, and which `(key, locale)` it was opened for.
 *
 * `anchorId`/`anchorBody` record which stored row (if any) `body` last matched — set whenever
 * the box is (re)seeded from a known row (initial load, opening a version, or just having saved
 * one), left untouched by free-typing. It is "what the box last matched", not "what is in the
 * box now" — that comparison is `draftDiverged`, computed from these two fields rather than
 * always against the active row, which is what let a check silently reuse a stale verdict once
 * the box had moved on from whatever row it was really about.
 */
interface Draft {
  for: string
  body: string
  note: string
  anchorId: string | null
  anchorBody: string
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
  /**
   * The last verdict, keyed by the row it is about and stamped with the text that was on
   * screen when it was asked for.
   *
   * Two keys because it answers two different questions. `promptId` is what the verdict is
   * *about* — a verdict belongs to a row, and `POST /api/ai/prompt-validate` answers with
   * that row's new `gate`, which is the only fresh gate the client has until the next
   * `GET /api/settings` (`state.ask` does not replace the payload the way `state.save`
   * does). `stamp` is what makes "stale on edit" a comparison rather than a flag something
   * has to remember to clear.
   */
  const [check, setCheck] = useState<
    { promptId: string; stamp: string; result: PromptValidation } | null
  >(null)

  const entry = prompts.find((candidate) => candidate.key === key && candidate.locale === locale)
  const selection = selectionOf(key, locale)

  // Under `locked`, an unedited row's `active.body` is `resolvePrompt`'s built-in
  // fallback — byte-identical to `entry.base` — so it is nothing a household wrote, not
  // an addition to show. Pre-filling the box with it anyway would invite the exact bug
  // this guards against: typing a note at the end and saving would store base+note,
  // which `composeLayeredBody` then sends as the base, then that same base again inside
  // the "addition". Empty means "no addition" here, never "the base, editable".
  const uncustomizedUnderLocked =
    settings.promptEditing === 'locked' &&
    entry !== undefined &&
    entry.active.body.trim() === entry.base.trim()

  // Derived rather than reseeded by an effect: when the selection changes the draft no
  // longer belongs to it, so the active body shows through without anything having to
  // notice the change and copy it across.
  const body =
    draft?.for === selection ? draft.body : uncustomizedUnderLocked ? '' : (entry?.active.body ?? '')
  const note = draft?.for === selection ? draft.note : ''
  // Same fallback shape as `body`'s own: on a fresh load, before anything has been typed, the
  // anchor is exactly what the box already shows, so `draftDiverged` starts false.
  const anchorId = draft?.for === selection ? draft.anchorId : (entry?.active.id ?? null)
  const anchorBody =
    draft?.for === selection
      ? draft.anchorBody
      : uncustomizedUnderLocked
        ? ''
        : (entry?.active.body ?? '')
  const stamp = `${selection}\n${body}`

  const edit = (next: Partial<Omit<Draft, 'for' | 'anchorId' | 'anchorBody'>>): void => {
    setDraft({ for: selection, body, note, anchorId, anchorBody, ...next })
  }

  const select = (nextKey: string, nextLocale: string): void => {
    setKey(nextKey)
    // Switching to a key that has no version for the language on screen falls back to
    // the shared text rather than to an empty panel.
    setLocale(localesFor(nextKey).includes(nextLocale) ? nextLocale : SHARED_LOCALE)
    // The run describes a version of what was selected; keeping it on screen under a
    // different prompt's heading would attribute one prompt's findings to another.
    setRun(null)
    // Same reasoning for the verdict: it is about one row.
    setCheck(null)
  }

  // After a write that created or retired an override: the entry the picker needs
  // exists in the answer, which `select`'s clamp — reading the payload this render was
  // built from — would not yet know about.
  const jumpTo = (nextLocale: string): void => {
    setLocale(nextLocale)
    setDraft(null)
    setRun(null)
    setCheck(null)
  }

  if (entry === undefined) {
    return (
      <Panel title={t('settings:prompt.title')} hint={t('settings:prompt.hint')}>
        <p className="muted">{t('settings:prompt.versionsNone')}</p>
      </Panel>
    )
  }

  const gated = isGatedKey(settings.promptEditing, entry.key)

  /**
   * One version's gate, with a verdict obtained since the last read taking precedence.
   *
   * `state.ask` — which is how the check is sent, because its answer is a verdict rather than
   * the settings payload — does not replace `settings`. So immediately after a check every
   * `gate` in this render is still the one the last `GET /api/settings` reported, and a row
   * that has just been cleared would still be badged "Not checked" beside a result saying it
   * is safe. `PromptValidation.gate` exists precisely to close that window.
   */
  const gateOf = (version: { id: string | null; gate: PromptGate }): PromptGate =>
    check !== null && version.id !== null && check.promptId === version.id
      ? check.result.gate
      : version.gate

  /** A row's gate by id, looked up rather than carried around as a whole `PromptVersionSetting`. */
  const gateForId = (id: string | null): PromptGate => {
    if (id === null) return 'built_in'
    if (id === entry.active.id) return gateOf(entry.active)
    const version = entry.versions.find((candidate) => candidate.id === id)
    return version === undefined ? 'built_in' : gateOf(version)
  }

  /**
   * This language has no rows of its own, so what runs for it is the shared text.
   *
   * `buildSettings` emits an entry per supported locale, and for a language nobody has written
   * an override for, that entry has an empty `versions` list and the *shared* row as its
   * `active`. There is nothing here to check — the row belongs to the shared tab.
   */
  const ownActiveVersion = entry.versions.find((version) => version.active) ?? null
  const inheritsShared = ownActiveVersion === null && entry.active.id !== null

  // The row the box last matched may have been deleted since (the point of Part 1): the
  // anchor id survives in the draft, but it names nothing in this fresh `entry.versions` any
  // more. Treated as diverged below rather than as "nothing to check" — the box may still hold
  // real text, there is just no existing row left to reuse a verdict from.
  const anchorRowGone =
    anchorId !== null &&
    anchorId !== entry.active.id &&
    entry.versions.every((version) => version.id !== anchorId)

  // The box, not a row: has what is on screen moved on from the row it was last checked
  // against? This is the fix for the reported bug — comparing only to `entry.active.body`
  // missed every case where the anchor was some other, already-checked row.
  const draftDiverged = anchorRowGone || body.trim() !== anchorBody.trim()

  const anchorGate: PromptGate = anchorRowGone ? 'unvalidated' : gateForId(anchorId)

  // Nothing stored anywhere and nothing typed either, or what is on screen is text this build
  // ships and never needs a paid verdict. `!draftDiverged` is what keeps this from also
  // catching a box someone has just started writing into with nothing saved yet — there is
  // something to check the moment the box says something the anchor doesn't, even with no
  // anchor at all; the save-then-check path exists precisely for that case.
  const nothingToCheck = !inheritsShared && !draftDiverged && (anchorId === null || anchorGate === 'built_in')

  const canCheck = !nothingToCheck && !inheritsShared && body.trim() !== ''

  // Re-anchors the draft to whichever row a save just produced (versions are ordered newest
  // first, and nothing else could have created one in between), so a second, unmodified press
  // of Check afterwards is the ordinary cache-reuse path.
  const reanchorAfterSave = (saved: Settings): PromptVersionSetting | null => {
    const savedEntry = saved.prompts.find((candidate) => candidate.key === key && candidate.locale === locale)
    const newest = savedEntry?.versions[0] ?? null
    setDraft({ for: selection, body, note: '', anchorId: newest?.id ?? null, anchorBody: body.trim() })
    return newest
  }

  // Save-then-check: `state.ts`'s shared `busy.current` ref stays true until *after* the first
  // call's `after` returns, so a same-tick second `state.save`/`state.ask` would silently no-op.
  // Deferring with `setTimeout` is the simplest correct fix — there is no other chaining
  // precedent in this codebase to match instead.
  const runCheck = (): void => {
    if (!draftDiverged) {
      if (anchorId === null) return
      state.ask<PromptValidation>(
        'prompt-validate',
        'POST',
        '/api/ai/prompt-validate',
        { promptId: anchorId },
        (value) => setCheck({ promptId: anchorId, stamp, result: value }),
      )
      return
    }

    state.save(
      'prompt-save-and-check',
      'POST',
      '/api/settings/prompts',
      { key, locale, body, ...(note.trim() === '' ? {} : { note }) },
      (saved) => {
        const newest = reanchorAfterSave(saved)
        if (newest === null) return
        setTimeout(() => {
          state.ask<PromptValidation>(
            'prompt-validate',
            'POST',
            '/api/ai/prompt-validate',
            { promptId: newest.id },
            (value) => setCheck({ promptId: newest.id, stamp, result: value }),
          )
        }, 0)
      },
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

      {settings.promptEditing !== 'locked' ? null : <BaseBlock base={entry.base} />}

      <div className="field">
        <label className="field__label" htmlFor="prompt-body">
          {t(settings.promptEditing === 'locked' ? 'settings:prompt.bodyLocked' : 'settings:prompt.body')}
        </label>
        <textarea
          id="prompt-body"
          className="field__input prompt__body"
          rows={14}
          spellCheck={false}
          placeholder={
            settings.promptEditing === 'locked' ? t('settings:prompt.bodyPlaceholder') : undefined
          }
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
                // and carries it, and leaving it there invites saving it twice. Also
                // re-anchors the draft to the row just saved.
                reanchorAfterSave,
              )
            }}
          >
            {t(`settings:prompt.${action}`)}
          </button>
        ))}
      </div>

      {diff === null || diff.stamp !== stamp ? null : <DiffView diff={diff.diff} />}

      {!gated ? null : (
        <Check
          anchorGate={anchorGate}
          inheritsShared={inheritsShared}
          nothingToCheck={nothingToCheck}
          canCheck={canCheck}
          draftDiverged={draftDiverged}
          state={state}
          owner={owner}
          // Only ever the price the server quoted for text that is still on screen: a
          // figure from a diff of something else would be a number beside the wrong button.
          estimateMicroEur={
            diff === null || diff.stamp !== stamp ? null : diff.diff.validationEstimateMicroEur
          }
          // Shown only while it is still about the row the box is anchored to. A verdict for a
          // row a newer save has superseded is not this section's answer any more.
          result={check !== null && check.promptId === anchorId ? check.result : null}
          // Two ways a result stops being current, and neither discards it — being told the
          // answer has moved on is the point. The box has been edited since it was obtained,
          // or a newer version is now the anchor instead.
          stale={check !== null && (check.stamp !== stamp || check.promptId !== anchorId)}
          onRun={runCheck}
        />
      )}

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
        // call the provider says why it cannot instead of failing when pressed (#165).
        <DryRunOff availability={settings.ai.availability} />
      )}

      <Versions
        entry={entry}
        gated={gated}
        gateOf={gateOf}
        state={state}
        owner={owner}
        onOpen={(loaded) =>
          setDraft({
            for: selection,
            body: loaded.body,
            note: loaded.note ?? '',
            anchorId: loaded.id,
            anchorBody: loaded.body,
          })
        }
        onDeleted={(nextSettings) => {
          // A deleted override's last version drops that locale from `buildSettings`'
          // per-locale list entirely (it only keeps entries with versions.length > 0) —
          // land back on the shared tab rather than on a selection that no longer exists.
          if (locale === SHARED_LOCALE) return
          const stillExists = nextSettings.prompts.some(
            (candidate) => candidate.key === key && candidate.locale === locale,
          )
          if (stillExists) return
          setLocale(SHARED_LOCALE)
          setDraft(null)
          setRun(null)
          setCheck(null)
        }}
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
function Fallback({
  entry,
  locale,
}: {
  entry: PromptSetting
  locale: string
}): ReactNode {
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

/**
 * Balancr's own instructions, read-only and collapsed by default.
 *
 * Shown only under `locked`, where the textarea below no longer holds the whole prompt —
 * this is the part that always runs before it, so what is actually sent is this text plus
 * whatever is typed below, not the box alone. Collapsed by default because most edits here
 * are a tone note that has nothing to do with the base; `<details>` needs no state of its
 * own to remember whether it was opened.
 */
function BaseBlock({ base }: { base: string }): ReactNode {
  const { t } = useT()

  return (
    <details className="prompt__builtin">
      <summary>{t('settings:prompt.base.summary')}</summary>
      <p className="muted">{t('settings:prompt.base.hint')}</p>
      <pre className="prompt__builtin-body">{base}</pre>
    </details>
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

/** A gate badge. `truth` for the two cleared states, `warn`/`alert` for the two that block. */
function GateBadge({ gate }: { gate: PromptGate }): ReactNode {
  const { t } = useT()
  const tone = gate === 'unsafe' ? 'alert' : gate === 'unvalidated' ? 'warn' : 'truth'

  return <span className={`badge badge--${tone}`}>{t(`settings:prompt.gate.${gate}`)}</span>
}

interface CheckProps {
  /** The gate of whatever row the box is anchored to — `'built_in'` when there is none. */
  anchorGate: PromptGate
  inheritsShared: boolean
  nothingToCheck: boolean
  canCheck: boolean
  /** Whether the box has moved on from the row it is anchored to. */
  draftDiverged: boolean
  state: SettingsPanelProps['state']
  owner: boolean
  /** From the last diff of this exact text, or null when none has been fetched. */
  estimateMicroEur: number | null
  result: PromptValidation | null
  /** True when a result exists but the text has moved on since it was obtained. */
  stale: boolean
  onRun: () => void
}

/**
 * The safety check, priced before it happens (#454).
 *
 * Mirrors `DryRun` above in shape, but about the box, not a stored row (reworked from the
 * original #468/#474 shape, which named the row a check would run against — the version
 * numbers that produced turned out to be an implementation detail nobody asked to manage, and
 * comparing the box only to the *active* row rather than to whichever row it last matched let a
 * check silently reuse a stale cached verdict once that row and the active one had parted ways).
 * `POST /api/ai/prompt-validate` still takes a `promptId` and writes the verdict onto a stored
 * row — nothing on the backend changed, since its cache is already keyed by row content — but
 * the button now decides for itself whether that row already matches the box (an ordinary
 * check) or has to be created first (`runCheck`'s save-then-check leg, deferred with
 * `setTimeout` past the shared `busy` ref in `state.ts`).
 *
 * The state machine is derived rather than stored: idle (no result), validating
 * (`state.pending`), a verdict, or stale — and stale is a comparison against the text on
 * screen, so editing one character retires a result without anything having to notice the
 * edit and clear it.
 */
function Check({
  anchorGate,
  inheritsShared,
  nothingToCheck,
  canCheck,
  draftDiverged,
  state,
  owner,
  estimateMicroEur,
  result,
  stale,
  onRun,
}: CheckProps): ReactNode {
  const { t } = useT()
  const running = state.pending === 'prompt-validate' || state.pending === 'prompt-save-and-check'

  return (
    <section className="prompt__check">
      <h3 className="panel__subtitle">
        {t('settings:prompt.check.title')}{' '}
        {/* Suppressed for a language that only inherits: the gate belongs to the shared row,
            and badging it here reads as a claim about this tab. */}
        {inheritsShared ? null : <GateBadge gate={anchorGate} />}
      </h3>
      <p className="muted">{t('settings:prompt.check.hint')}</p>

      {inheritsShared ? (
        <p className="muted">{t('settings:prompt.check.usesShared')}</p>
      ) : nothingToCheck ? (
        // No button at all rather than a disabled one with nothing explaining it: nothing has
        // been typed and what is on screen is Balancr's own text, which needs no check.
        <p className="muted">{t('settings:prompt.check.builtIn')}</p>
      ) : (
        <>
          {anchorGate === 'unvalidated' && !draftDiverged ? (
            <p className="notice notice--warn" role="status">
              {t('settings:prompt.check.unvalidated')}
            </p>
          ) : null}

          {estimateMicroEur === null ? null : (
            <p className="muted">
              {t('settings:prompt.check.estimate', {
                cost: formatMicroEur(estimateMicroEur),
              })}
            </p>
          )}

          <button
            type="button"
            className="button button--quiet"
            disabled={!owner || state.busy || !canCheck}
            onClick={onRun}
          >
            {running
              ? t('settings:prompt.check.running')
              : t(draftDiverged ? 'settings:prompt.check.saveAndRun' : 'settings:prompt.check.run')}
          </button>

          {stale ? <p className="muted">{t('settings:prompt.check.stale')}</p> : null}
          {result === null || stale ? null : <CheckOutcome result={result} />}
        </>
      )}
    </section>
  )
}

/**
 * What the check found.
 *
 * Three tiers, in descending authority, and the order is the point: the decision, then the
 * per-rule codes that produced it, then — under its own heading and visually quiet — the
 * judge's own sentence. That last one is model output about text the reader may have
 * written themselves, so it can be steered; it is evidence beside the finding and never the
 * finding, which is why it carries its own warning line rather than sitting in the lead.
 */
function CheckOutcome({ result }: { result: PromptValidation }): ReactNode {
  const { t } = useT()
  const { verdict } = result

  return (
    <div className="dryrun">
      <p className="dryrun__head">
        <span className={`badge badge--${result.status}`}>{t(`status.${result.status}`)}</span>{' '}
        {t(`settings:ai.reason.${result.reason}`)}
      </p>
      {result.costMicroEur === 0 ? null : (
        <p className="muted">
          {t('settings:prompt.dryRun.cost', { cost: formatMicroEur(result.costMicroEur) })}
        </p>
      )}
      {result.validatedAt === null ? null : (
        <p className="muted">
          {t('settings:prompt.check.checkedAt', { when: formatDateTime(result.validatedAt) })}
        </p>
      )}

      {verdict === null ? null : (
        <>
          <p className={verdict.verdict === 'safe' ? 'muted' : 'notice notice--alert'}>
            {t(`settings:prompt.check.${verdict.verdict}`)}
          </p>

          <RuleList
            title={t('settings:prompt.check.missing')}
            items={verdict.missing}
            labelKey="ai:promptCheck.rule"
          />
          <RuleList
            title={t('settings:prompt.check.weakened')}
            items={verdict.weakened}
            labelKey="ai:promptCheck.rule"
          />
          <RuleList
            title={t('settings:prompt.check.conflicts')}
            items={verdict.conflicts}
            labelKey="ai:promptCheck.conflict"
          />
          <RuleList
            title={t('settings:prompt.check.advisory')}
            items={verdict.advisory}
            labelKey="ai:promptCheck.rule"
          />

          {verdict.notes === '' ? null : (
            <div className="prompt__check-notes">
              <h4 className="dryrun__subtitle">{t('settings:prompt.check.notes')}</h4>
              <p className="muted">{t('settings:prompt.check.notesWarning')}</p>
              <blockquote className="muted">{verdict.notes}</blockquote>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** One labelled group of rule or conflict codes, or nothing when the group is empty. */
function RuleList({
  title,
  items,
  labelKey,
}: {
  title: string
  items: readonly string[]
  labelKey: string
}): ReactNode {
  const { t } = useT()
  if (items.length === 0) return null

  return (
    <>
      <h4 className="dryrun__subtitle">{title}</h4>
      <ul className="dryrun__list">
        {items.map((code) => (
          <li key={code}>{t(`${labelKey}.${code}`, { defaultValue: code })}</li>
        ))}
      </ul>
    </>
  )
}

interface VersionsProps {
  entry: PromptSetting
  /** Whether this key's bodies need a verdict at all. Badges are drawn only when they do. */
  gated: boolean
  gateOf: (version: { id: string | null; gate: PromptGate }) => PromptGate
  state: SettingsPanelProps['state']
  owner: boolean
  onOpen: (loaded: PromptBody) => void
  onDeleted: (settings: Settings) => void
}

function Versions({
  entry,
  gated,
  gateOf,
  state,
  owner,
  onOpen,
  onDeleted,
}: VersionsProps): ReactNode {
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
            gate={gated ? gateOf(version) : null}
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
            onDelete={() => {
              state.save(
                `delete:${version.id}`,
                'DELETE',
                `/api/settings/prompts/${version.id}`,
                undefined,
                onDeleted,
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
  /** Null for a key nothing gates, where a gate badge would describe a rule that is not one. */
  gate: PromptGate | null
  busy: boolean
  owner: boolean
  onOpen: () => void
  onActivate: () => void
  onDelete: () => void
}

function Version({
  version,
  gate,
  busy,
  owner,
  onOpen,
  onActivate,
  onDelete,
}: VersionProps): ReactNode {
  const { t } = useT()
  // Its own arm/confirm step, the same shape `ResetControl` in `Status.tsx` uses for the
  // full recompute: a delete is not the rollback gesture (`onActivate` is), so it should
  // cost a deliberate second click, not a single accidental one.
  const [armed, setArmed] = useState(false)

  return (
    <li className="version">
      <div className="version__head">
        <span className="version__number">
          {t('settings:prompt.version', { version: formatDecimal(version.version, 0) })}
        </span>
        {version.active ? (
          <span className="badge badge--truth">{t('settings:prompt.active')}</span>
        ) : null}{' '}
        {/* Every version of a *gated* key, not only the active one: the badge is what makes
            "this one was already checked" visible before someone activates it, which is the
            whole reason rolling back to a cleared version costs nothing (#454). Absent for a
            key nothing gates — a warn-tone "Not checked" beside an edited analysis prompt
            would advertise a check that endpoint refuses and a restriction that does not
            apply to it. */}
        {gate === null ? null : <GateBadge gate={gate} />}
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
        {armed ? (
          <>
            <button
              type="button"
              className="button"
              disabled={!owner || busy}
              onClick={() => {
                setArmed(false)
                onDelete()
              }}
            >
              {t('settings:prompt.deleteVersionConfirm')}
            </button>
            <button
              type="button"
              className="button button--quiet"
              disabled={busy}
              onClick={() => setArmed(false)}
            >
              {t('settings:prompt.deleteVersionCancel')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button button--quiet"
            disabled={!owner || busy}
            onClick={() => setArmed(true)}
          >
            {t('settings:prompt.deleteVersion')}
          </button>
        )}
      </div>
    </li>
  )
}
