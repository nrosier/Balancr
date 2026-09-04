/**
 * What's changed, opened by clicking the running version number in the header.
 *
 * A native `<dialog>` rather than a hand-rolled modal: `showModal()` gives focus
 * trapping, `::backdrop`, and Escape-to-close for free, and this is the one place
 * in the shell that needs any of them. Escape fires the dialog's own `close`
 * event; a click on the backdrop is detected the standard way — `<dialog>` has no
 * padding of its own, so a click whose target is the dialog element itself (not
 * one of its children) can only have landed outside the content.
 *
 * Focus is returned to the button that opened this explicitly, in the `close`
 * handler, rather than left to the browser's own return-focus behaviour: this
 * component unmounts on close (`AppShell` only renders it while open), and doing
 * it ourselves means it happens before that unmount rather than racing it.
 */
import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { useResource } from '../api/resource.tsx'
import { useT } from '../i18n.ts'
import type { Changelog } from '../shared.ts'

export interface ChangelogDialogProps {
  /** Null when the running build could not read its own `package.json`. */
  version: string | null
  onClose: () => void
  returnFocusTo: RefObject<HTMLButtonElement | null>
}

export function ChangelogDialog({ version, onClose, returnFocusTo }: ChangelogDialogProps): ReactNode {
  const { t } = useT()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { data, error, loading } = useResource<Changelog>('/api/changelog')

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  const close = (): void => {
    returnFocusTo.current?.focus()
    onClose()
  }

  return (
    <dialog
      ref={dialogRef}
      className="changelog-dialog"
      aria-labelledby="changelog-title"
      onClose={close}
      onClick={(event) => {
        if (event.target === dialogRef.current) dialogRef.current?.close()
      }}
    >
      <div className="changelog-dialog__panel">
        <div className="changelog-dialog__head">
          <h2 id="changelog-title">
            {t('changelog.title')}
            {version === null ? null : <span className="num"> · v{version}</span>}
          </h2>
          <button
            type="button"
            className="changelog-dialog__close"
            onClick={() => dialogRef.current?.close()}
          >
            {t('changelog.close')}
          </button>
        </div>

        <div className="changelog-dialog__body">
          {loading ? (
            <p className="muted">{t('shell.loading')}</p>
          ) : error !== null ? (
            <p className="muted">{t('changelog.loadError')}</p>
          ) : data === null || !data.available || data.entries.length === 0 ? (
            <p className="muted">{t('changelog.empty')}</p>
          ) : (
            data.entries.map((entry) => (
              <article key={entry.version} className="changelog-entry">
                <h3 className="changelog-entry__heading">
                  <span className="num">v{entry.version}</span>
                  <span className="changelog-entry__date">{entry.date}</span>
                </h3>
                {/* Sanitised server-side by `util/markdown.ts`; see `Narrative.tsx`. */}
                <div className="prose" dangerouslySetInnerHTML={{ __html: entry.html }} />
                <a
                  className="changelog-entry__link"
                  href={entry.releaseUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('changelog.viewOnGithub', { version: entry.version })}
                </a>
              </article>
            ))
          )}
          {data?.available === true && data.entries.length > 0 ? (
            <p className="muted changelog-dialog__note">{t('changelog.englishOnly')}</p>
          ) : null}
        </div>
      </div>
    </dialog>
  )
}
