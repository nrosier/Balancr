/**
 * System / light / dark, as three buttons rather than a two-state switch.
 *
 * A switch cannot express "follow the system", and following the system is the
 * default most people want — the third state is not a luxury. Icons rather than
 * words because the header is the tightest space in the layout and the Dutch labels
 * ("Systeem", "Donker") are wider than the English ones; each button carries its
 * label as an `aria-label` and a `title`, so nothing is lost to a screen reader or
 * to a hover.
 *
 * `aria-pressed` on three buttons in a group, rather than `role="radiogroup"`: the
 * buttons act immediately and independently, which is what pressed-state means, and
 * a radio group would promise arrow-key semantics this does not implement.
 */
import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { THEME_MODES, type ThemeMode } from '../theme/theme.ts'
import { useTheme } from '../theme/ThemeContext.tsx'
import { IconDark, IconLight, IconSystem, type IconProps } from './icons.tsx'

const ICONS: Record<ThemeMode, (props: IconProps) => ReactNode> = {
  system: IconSystem,
  light: IconLight,
  dark: IconDark,
}

export function ThemeToggle(): ReactNode {
  const { t } = useT()
  const { mode, setMode } = useTheme()

  return (
    <div className="theme-toggle" role="group" aria-label={t('theme.label')}>
      {THEME_MODES.map((option) => {
        const Icon = ICONS[option]
        const label = t(`theme.${option}`)
        return (
          <button
            key={option}
            type="button"
            className="theme-toggle__option"
            aria-pressed={mode === option}
            aria-label={label}
            title={label}
            onClick={() => {
              setMode(option)
            }}
          >
            <Icon />
          </button>
        )
      })}
    </div>
  )
}
