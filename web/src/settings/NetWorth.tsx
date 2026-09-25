/**
 * The five net-worth building blocks in one section (#528): accounts, property,
 * loans, credit cards and goals used to be five separate top-level tabs despite
 * being the same kind of thing — a single-purpose panel that feeds net worth.
 * Each panel below is unchanged; this only adds the subsection tab strip around
 * them.
 *
 * Mounted-hidden, not conditionally rendered, for the same reason
 * `BenchmarkSection` is: `PropertyPanel`, `LoansPanel`, `DebtsPanel` and
 * `GoalsPanel` each hold a typed-but-unsaved row in their own `useState`, and
 * switching tabs must not throw it away.
 */
import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { AccountsPanel } from './Accounts.tsx'
import { DebtsPanel } from './Debts.tsx'
import { GoalsPanel } from './Goals.tsx'
import { LoansPanel } from './Loans.tsx'
import { PropertyPanel } from './Property.tsx'
import type { SettingsPanelProps } from './state.ts'
import { SectionNav } from '../ui/SectionNav.tsx'
import { useSubsection, type Section } from '../ui/sections.ts'

type NetWorthSubsectionId = 'accounts' | 'property' | 'loans' | 'debts' | 'goals'

const NET_WORTH_SUBSECTIONS: readonly Section<NetWorthSubsectionId>[] = [
  { id: 'accounts', path: '/settings/net-worth', labelKey: 'settings:nav.accounts' },
  { id: 'property', path: '/settings/net-worth/property', labelKey: 'settings:nav.property' },
  { id: 'loans', path: '/settings/net-worth/loans', labelKey: 'settings:nav.loans' },
  { id: 'debts', path: '/settings/net-worth/debts', labelKey: 'settings:nav.debts' },
  { id: 'goals', path: '/settings/net-worth/goals', labelKey: 'settings:nav.goals' },
]

export function NetWorthSection(props: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const active = useSubsection(NET_WORTH_SUBSECTIONS)

  return (
    <SectionNav sections={NET_WORTH_SUBSECTIONS} variant="sub" ariaLabel={t('settings:nav.netWorth')}>
      <div hidden={active !== 'accounts'}>
        <AccountsPanel {...props} />
      </div>
      <div hidden={active !== 'property'}>
        <PropertyPanel {...props} />
      </div>
      <div hidden={active !== 'loans'}>
        <LoansPanel {...props} />
      </div>
      <div hidden={active !== 'debts'}>
        <DebtsPanel {...props} />
      </div>
      <div hidden={active !== 'goals'}>
        <GoalsPanel {...props} />
      </div>
    </SectionNav>
  )
}
