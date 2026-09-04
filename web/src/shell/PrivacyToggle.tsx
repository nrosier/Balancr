/**
 * A single on/off button, unlike `ThemeToggle`'s three-way group — privacy has no
 * "system" state, see `PrivacyContext.tsx`. `aria-pressed` says which state is
 * current, and the icon changes with it so the state reads at a glance without
 * relying on the pressed styling alone. The `title` carries the caveat this feature
 * needs on the record wherever it is discoverable: this blurs the screen, not the
 * data — see `privacy:toggle.hint`.
 */
import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { usePrivacy } from '../privacy/PrivacyContext.tsx'
import { IconEye, IconEyeOff } from './icons.tsx'

export function PrivacyToggle(): ReactNode {
  const { t } = useT()
  const { enabled, setEnabled } = usePrivacy()
  const state = t(enabled ? 'privacy.toggle.on' : 'privacy.toggle.off')

  return (
    <button
      type="button"
      className="privacy-toggle"
      aria-pressed={enabled}
      aria-label={t('privacy.toggle.label')}
      title={`${state} — ${t('privacy.toggle.hint')}`}
      onClick={() => {
        setEnabled(!enabled)
      }}
    >
      {enabled ? <IconEyeOff /> : <IconEye />}
    </button>
  )
}
