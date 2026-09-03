/**
 * The one page that writes.
 *
 * Everything else in the application reads Balancr's own SQLite and shows it. Here a
 * form changes what the next aggregation pass computes, which instructions the next
 * analysis runs under, and which of two accounts holding the same positions counts
 * toward net worth. That difference sets the whole shape of the screen:
 *
 *  - **The payload is the state.** `GET /api/settings` returns all five panels' data
 *    and every write returns it again, so a panel never patches its own copy of a
 *    field. `useSettings` in `../settings/state.ts` holds that single payload and the
 *    one request in flight; the panels are given it and a way to write.
 *  - **A viewer sees everything and changes one thing.** The role is on the payload,
 *    and the only write a viewer may make is their own interface language. Rather than
 *    hiding panels — which would leave someone unable to see what the thresholds are
 *    set to, or read the prompt that produced last night's findings — every control is
 *    rendered and disabled, with the reason said once per panel.
 *  - **Nothing here takes effect on this screen.** No figure on this page is recomputed
 *    by anything on it, so each panel says when its change lands instead of pretending
 *    to show a result.
 *
 * The status panel is the exception to the first rule and says so in its own header:
 * it reads `/api/status`, not the settings payload, because readiness decays while the
 * page is open and because it has to be able to be the thing that failed while the
 * rest of the page loaded. The build block below it stays separate for the same reason
 * in reverse — the version and revision come from the settings payload, so they are
 * still on screen when `/api/status` is what is broken, which is when a bug report
 * needs them most.
 *
 * Panel order is the order someone arrives with a reason to be here: the language
 * control first because it is the one thing everyone changes and the only thing a
 * viewer can; then the prompt editor, which is the point of the page; then thresholds
 * and account mapping, which are set once and revisited rarely; then AI spend, which
 * is read, not set. The build block is last because it exists for a bug report.
 */
import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { AccountsPanel } from '../settings/Accounts.tsx'
import { LanguagePanel } from '../settings/Language.tsx'
import { PromptsPanel } from '../settings/Prompts.tsx'
import { SpendPanel } from '../settings/Spend.tsx'
import { StatusPanel } from '../settings/Status.tsx'
import { ThresholdsPanel } from '../settings/Thresholds.tsx'
import { useSettings } from '../settings/state.ts'
import { DataState } from '../ui/DataState.tsx'
import { PageHeader } from './PageHeader.tsx'
import '../settings/settings.css'

export function Settings(): ReactNode {
  const { t } = useT()
  const state = useSettings()

  return (
    <>
      <PageHeader title={t('nav.settings')} lede={t('page.settings.lede')} />

      <DataState resource={state.resource}>
        {(settings) => {
          const owner = settings.profile.role === 'owner'
          const props = { settings, state, owner }

          return (
            <>
              {/*
                The failure of a *write*, above the panels rather than inside the one
                that caused it. A rejected field is already reported beside itself by
                `state.issue`; what lands here is what the server did not attribute to
                a field — a rate limit, a lost session, an upstream that went away —
                and none of those belong under a single input.
              */}
              {state.error === null || state.error.issues.length > 0 ? null : (
                <div className="notice notice--error" role="alert">
                  {state.error.message}
                  {state.error.requestId === null ? null : (
                    <p className="notice__meta">{state.error.requestId}</p>
                  )}
                </div>
              )}

              <LanguagePanel {...props} />
              <PromptsPanel {...props} />
              <ThresholdsPanel {...props} />
              <AccountsPanel {...props} />
              <SpendPanel {...props} />
              <StatusPanel />

              <section className="card panel">
                <h2 className="card__title">{t('settings:build.title')}</h2>
                <dl className="build">
                  <dt>{t('settings:build.version')}</dt>
                  <dd className="num">{settings.build.version ?? t('empty.unknown')}</dd>
                  <dt>{t('settings:build.revision')}</dt>
                  <dd className="num">{settings.build.revision ?? t('empty.unknown')}</dd>
                </dl>
              </section>
            </>
          )
        }}
      </DataState>
    </>
  )
}
