/**
 * The one paragraph on this application that a model wrote.
 *
 * Everything else on every screen is a figure Balancr computed or a sentence assembled
 * from the catalogue. This is prose, generated in the language it is read in, and it is
 * inserted as HTML — which is the one thing in `web/` worth arguing for at the call
 * site rather than in a commit message.
 *
 * **Why `dangerouslySetInnerHTML` is the safe option here.** The field arrives from
 * `/api/insights` already rendered: `util/markdown.ts` escapes the model's text
 * *first* and only then emits a fixed list of tags, none of which take attributes —
 * no `href`, no `src`, no `style`, so there is nothing for a payload to hang an
 * injection on. Doing it that way round is what makes the output safe, and it has to
 * happen on the server anyway, because the stored Markdown says `c7` where a category
 * name belongs and only the server can resolve the label. A second Markdown parser in
 * the bundle would be a second sanitiser to keep correct, and would render the labels
 * verbatim.
 *
 * The byline is not decoration. A reader has to be able to tell last night's analysis
 * from one written three weeks ago by a model that has since been swapped out, so the
 * model is named beside the date. `model` is null only if the run behind the narrative
 * has been pruned, which the schema's cascade prevents — the fallback prints the date
 * alone rather than the word "null" or an em dash nobody can interpret.
 */
import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { formatDateTime, type Insights } from '../shared.ts'

export interface NarrativeProps {
  narrative: Insights['narrative']
}

export function Narrative({ narrative }: NarrativeProps): ReactNode {
  const { t } = useT()

  return (
    <section className="card">
      <h2 className="card__title">{t('ai:narrative.title')}</h2>
      {narrative === null ? (
        <p className="muted">{t('ai:narrative.none')}</p>
      ) : (
        <>
          {/* Sanitised server-side by `util/markdown.ts`; see the note above. */}
          <div className="prose" dangerouslySetInnerHTML={{ __html: narrative.html }} />
          <p className="muted">
            {narrative.model === null
              ? t('time.lastUpdated', { when: formatDateTime(narrative.generatedAt) })
              : t('ai:narrative.generatedAt', {
                  when: formatDateTime(narrative.generatedAt),
                  model: narrative.model,
                })}
          </p>
        </>
      )}
    </section>
  )
}
