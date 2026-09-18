/**
 * A plausible Ghostfolio dataset for local dev (#391), matching the shapes
 * `src/adapters/ghostfolio/types.ts` validates: a handful of holdings, a
 * summary, a performance chart and two accounts.
 *
 * Generated once and persisted to `data/fake-backend/ghostfolio.json` — under
 * the existing `/data/` gitignore rule — so numbers stay stable across
 * restarts instead of reshuffling on every boot. Delete the file to regenerate.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_PATH = fileURLToPath(
  new URL('../../data/fake-backend/ghostfolio.json', import.meta.url),
)

export interface FakeHolding {
  symbol: string
  name: string
  currency: string
  quantity: number
  marketPrice: number
  valueInBaseCurrency: number
  allocationInPercentage: number
  assetClass: string
  assetSubClass: string
  dataSource: string
  isin: string
  netPerformancePercent: number
  grossPerformancePercent: number
}

export interface FakeAccount {
  id: string
  name: string
  currency: string
  balance: number
  valueInBaseCurrency: number
  balanceInBaseCurrency: number
  activitiesCount: number
  isExcluded: boolean
}

export interface FakeChartPoint {
  date: string
  value: number
  netPerformanceInPercentage: number
  netPerformanceInPercentageWithCurrencyEffect: number
  totalInvestment: number
}

export interface GhostfolioDataset {
  holdings: FakeHolding[]
  summary: {
    currentValueInBaseCurrency: number
    totalValueInBaseCurrency: number
    totalCashInBaseCurrency: number
    totalInvestment: number
    netPerformance: number
    netPerformancePercent: number
    netPerformancePercentWithCurrencyEffect: number
    cash: number
  }
  performance: {
    chart: FakeChartPoint[]
    performance: {
      currentNetPerformancePercent: number
      netPerformancePercentage: number
    }
  }
  accounts: FakeAccount[]
}

/** Two ETFs real Belgian brokers actually list, so the ISINs are recognisable. */
const HOLDING_SEEDS = [
  {
    symbol: 'IWDA',
    name: 'iShares Core MSCI World UCITS ETF USD (Acc)',
    isin: 'IE00B4L5Y983',
    currency: 'USD',
    quantity: 420,
    marketPrice: 95.32,
  },
  {
    symbol: 'VWCE',
    name: 'Vanguard FTSE All-World UCITS ETF (USD) Accumulating',
    isin: 'IE00BK5BQT80',
    currency: 'USD',
    quantity: 180,
    marketPrice: 128.77,
  },
] as const

function buildChart(months: number, endValue: number, startValue: number): FakeChartPoint[] {
  const chart: FakeChartPoint[] = []
  const end = new Date()
  end.setUTCDate(1)
  for (let i = months - 1; i >= 0; i--) {
    const date = new Date(end)
    date.setUTCMonth(date.getUTCMonth() - i)
    const progress = (months - 1 - i) / (months - 1)
    const value = Math.round((startValue + (endValue - startValue) * progress) * 100) / 100
    const netPerformanceInPercentage = Math.round(((value - startValue) / startValue) * 10_000) / 10_000
    chart.push({
      date: date.toISOString().slice(0, 10),
      value,
      netPerformanceInPercentage,
      netPerformanceInPercentageWithCurrencyEffect: netPerformanceInPercentage,
      totalInvestment: startValue,
    })
  }
  return chart
}

function generate(): GhostfolioDataset {
  const holdings: FakeHolding[] = HOLDING_SEEDS.map((seed) => {
    const valueInBaseCurrency = Math.round(seed.quantity * seed.marketPrice * 100) / 100
    return {
      symbol: seed.symbol,
      name: seed.name,
      isin: seed.isin,
      currency: seed.currency,
      quantity: seed.quantity,
      marketPrice: seed.marketPrice,
      valueInBaseCurrency,
      allocationInPercentage: 0,
      assetClass: 'EQUITY',
      assetSubClass: 'ETF',
      dataSource: 'YAHOO',
      netPerformancePercent: 0.0812,
      grossPerformancePercent: 0.0847,
    }
  })

  const totalHoldingsValue = holdings.reduce((sum, h) => sum + h.valueInBaseCurrency, 0)
  for (const holding of holdings) {
    holding.allocationInPercentage =
      Math.round((holding.valueInBaseCurrency / totalHoldingsValue) * 10_000) / 10_000
  }

  const cash = 4_250.5
  const totalValueInBaseCurrency = Math.round((totalHoldingsValue + cash) * 100) / 100
  const totalInvestment = Math.round(totalHoldingsValue * 0.92 * 100) / 100
  const netPerformance = Math.round((totalHoldingsValue - totalInvestment) * 100) / 100

  const summary: GhostfolioDataset['summary'] = {
    currentValueInBaseCurrency: totalHoldingsValue,
    totalValueInBaseCurrency,
    totalCashInBaseCurrency: cash,
    totalInvestment,
    netPerformance,
    netPerformancePercent: Math.round((netPerformance / totalInvestment) * 10_000) / 10_000,
    netPerformancePercentWithCurrencyEffect: Math.round((netPerformance / totalInvestment) * 10_000) / 10_000,
    cash,
  }

  const chart = buildChart(24, totalHoldingsValue, totalInvestment)

  const accounts: FakeAccount[] = [
    {
      id: 'fake-account-broker',
      name: 'Fake broker',
      currency: 'EUR',
      balance: cash,
      valueInBaseCurrency: totalValueInBaseCurrency,
      balanceInBaseCurrency: cash,
      activitiesCount: 37,
      isExcluded: false,
    },
    {
      id: 'fake-account-savings',
      name: 'Fake savings account',
      currency: 'EUR',
      balance: 12_000,
      valueInBaseCurrency: 12_000,
      balanceInBaseCurrency: 12_000,
      activitiesCount: 0,
      isExcluded: false,
    },
  ]

  return {
    holdings,
    summary,
    performance: {
      chart,
      performance: {
        currentNetPerformancePercent: summary.netPerformancePercent,
        netPerformancePercentage: summary.netPerformancePercent,
      },
    },
    accounts,
  }
}

/** Reuses `data/fake-backend/ghostfolio.json` if present; generates and persists it otherwise. */
export function loadOrCreateGhostfolioData(): GhostfolioDataset {
  try {
    return JSON.parse(readFileSync(DATA_PATH, 'utf8')) as GhostfolioDataset
  } catch {
    const dataset = generate()
    mkdirSync(dirname(DATA_PATH), { recursive: true })
    writeFileSync(DATA_PATH, JSON.stringify(dataset, null, 2))
    return dataset
  }
}
