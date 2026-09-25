/**
 * The settings page: the only screen in the application that writes.
 *
 * What is worth asserting here is not that five cards rendered — that is a reading —
 * but the decisions the page makes about a *request*, each of which has a version that
 * looks fine on screen and is wrong:
 *
 *  - **Only what changed is sent.** The thresholds form renders twenty-odd inputs out
 *    of one payload, and a form that PATCHed all of them would work — until the day one
 *    field's stored value fails the schema it was saved under and every unrelated save
 *    starts failing with it. Typing a value and typing it back must leave nothing to
 *    send at all.
 *  - **A grouping mark is refused locally, not sent.** `parseFloat('2.000')` is `2`, so
 *    a basis-points field that accepted Belgian grouping would turn 20% into 0,02% and
 *    save it without an error anywhere. This is the one place the page validates rather
 *    than deferring to the server, and the reason it does.
 *  - **A rejected field says so beside itself.** The server names the field in
 *    `error.issues`; a page that only printed `error.message` at the top would be
 *    telling the truth and leaving the reader to guess which of twenty inputs it meant.
 *  - **One request at a time.** Every write answers with the whole payload, so two in
 *    flight would settle in an order nothing controls and the loser would paint over the
 *    winner. Pressing twice must produce one request — which is also what stops a dry
 *    run, the request here that costs money, from being paid for twice.
 *  - **The answer is the state.** A write's response replaces what is on screen without
 *    a second GET, because the server already sent everything.
 *  - **A viewer sees all of it and changes one thing.** Their own language, and nothing
 *    else — but the thresholds have to stay readable, which rules out hiding the panel
 *    and rules out `opacity` low enough to make its own text fail contrast.
 *
 * The fixture is a full payload rather than a minimal one, and its figures are
 * deliberately not round: an assertion on `€ 25,00` is an assertion that the page
 * printed the server's cents through `formatMoney`, which a page doing its own division
 * would fail.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Settings } from '../src/pages/Settings.tsx'
import { ACCOUNT_KINDS } from '../src/settings/kinds.ts'
import { SHARED_LOCALE } from '../src/shared.ts'
import type {
  AiDryRun,
  AiEstimate,
  AiRun,
  AiRunList,
  AiRunPayload,
  PromptBody,
  PromptDiff,
  Settings as Payload,
} from '../src/shared.ts'
import { i18nReady, renderApp, resetLanguage } from './helpers.tsx'

/**
 * `DEFAULT_PARAMS`, written out.
 *
 * Not two illustrative groups: the payload's type is the domain schema itself, so a
 * partial fixture does not compile — which is the schema doing its job. Written by hand
 * rather than imported because `params.ts` is Zod, and a Zod import from `web/` drags
 * `config.ts` in and throws on a process with no `ACTUAL_PASSWORD`. That the two agree
 * is `test/unit/web-contract.test.ts`'s assertion, not this file's.
 */
const PARAMS = {
  baseline: {
    windowMonths: 12,
    halfLifeMonths: 3,
    winsorLowerPct: 0.05,
    winsorUpperPct: 0.95,
    minMonths: 4,
  },
  overspend: {
    baselineWarnBp: 2_000,
    baselineAlertBp: 5_000,
    materialityFloorCents: 2_500,
    availableFloorCents: 500,
  },
  burnRate: { minMonthProgress: 0.25, toleranceBp: 1_000 },
  dayCurve: { windowMonths: 12, minMonths: 6, maxDispersionBp: 2_500 },
  hygiene: {
    reconcileStaleDays: 45,
    priceStaleDays: 5,
    uncategorisedWarnCount: 5,
    recomputationToleranceCents: 0,
  },
  household: { savingsRateTargetBp: 1_500, emergencyFundTargetMonths: 3 },
  drift: { persistentMonths: 3 },
}

/**
 * The balanced preset, as the server sends it: bands in force plus every preset's numbers.
 *
 * `isPreset` is true and `bands` equals `presets.balanced`, which is the first-run state —
 * the one where the panel has to show a chosen preset rather than a set of edits.
 */
const BANDS = {
  defensive: {
    EQUITY: { minBp: 3_000, targetBp: 4_000, maxBp: 5_000 },
    FIXED_INCOME: { minBp: 4_000, targetBp: 5_500, maxBp: 6_500 },
    REAL_ESTATE: { minBp: 0, targetBp: 500, maxBp: 1_500 },
    COMMODITY: { minBp: 0, targetBp: 0, maxBp: 1_000 },
  },
  balanced: {
    EQUITY: { minBp: 5_500, targetBp: 6_500, maxBp: 7_500 },
    FIXED_INCOME: { minBp: 2_000, targetBp: 3_000, maxBp: 4_000 },
    REAL_ESTATE: { minBp: 0, targetBp: 500, maxBp: 1_500 },
    COMMODITY: { minBp: 0, targetBp: 0, maxBp: 1_000 },
  },
  growth: {
    EQUITY: { minBp: 7_500, targetBp: 8_500, maxBp: 9_500 },
    FIXED_INCOME: { minBp: 500, targetBp: 1_000, maxBp: 2_000 },
    REAL_ESTATE: { minBp: 0, targetBp: 500, maxBp: 1_500 },
    COMMODITY: { minBp: 0, targetBp: 0, maxBp: 1_000 },
  },
}

const ADVICE: Payload['advice'] = {
  profile: 'balanced',
  isPreset: true,
  bands: BANDS.balanced,
  toleranceBp: 100,
  minTradeCents: 50_000,
  presets: BANDS,
}

/**
 * The benchmark side of the payload: the shipped file, a two-person household and a
 * mapping with one of everything the panel has to tell apart.
 *
 * `Rent` is stored as `04.5.1` on purpose. A stored code may be deeper than the picker
 * offers, and a `<select>` whose value matches no option silently displays the first —
 * "Not mapped" — which would tell somebody a category is unmapped while the comparison
 * counts it under housing. `Bank charges` is `00`, which is mapped and deliberately
 * feeds no reference line. `Coffee` is unmapped, and `Salary` is income.
 */
const BENCHMARK_FILE: NonNullable<Payload['benchmark']['file']> = {
  jurisdiction: 'BE',
  source: {
    survey: 'Household Budget Survey (HBS)',
    year: 2024,
    citation: 'Statbel, Household Budget Survey 2024 — structure of household expenditure',
    sourceUrl: 'https://statbel.fgov.be/en/themes/households/household-budget-survey-hbs',
    lastVerified: '2026-09-03',
    status: 'transcribed',
  },
  equivalence: {
    scale: 'modified_oecd',
    firstPersonBp: 10_000,
    additionalPersonBp: 5_000,
    childBp: 3_000,
    childAgeBelow: 14,
    citation: 'Eurostat — equivalised disposable income, modified OECD scale',
    sourceUrl: null,
    lastVerified: '2026-09-03',
    status: 'transcribed',
  },
  groups: [
    { id: 'food', shareBp: 1_400, coicop: ['01'] },
    { id: 'alcohol_tobacco', shareBp: 170, coicop: ['02'] },
    { id: 'clothing', shareBp: 370, coicop: ['03'] },
    { id: 'housing', shareBp: 3_060, coicop: ['04'] },
    { id: 'furnishings', shareBp: 500, coicop: ['05'] },
    { id: 'health', shareBp: 480, coicop: ['06'] },
    { id: 'transport', shareBp: 1_170, coicop: ['07'] },
    { id: 'recreation', shareBp: 790, coicop: ['09'] },
    { id: 'hotels_restaurants', shareBp: 730, coicop: ['11'] },
    { id: 'other', shareBp: 1_330, coicop: ['08', '10', '12'] },
  ],
  referenceHousehold: null,
  transcribed: ['source', 'equivalence'],
}

const BENCHMARK: Payload['benchmark'] = {
  file: BENCHMARK_FILE,
  household: {
    country: 'BE',
    members: [{ birthYear: 2013, custodyBp: 5_000, label: 'Teenager' }],
    // Null, so the panel prints the share it derives from the roster above rather than
    // a stated one — the default, and the state worth having in the fixture (#44).
    sharedCostBp: null,
    // The stored default, so the picker has a current value and Save stays disabled
    // until somebody actually changes something (#289).
    sharedCostDirection: 'whole_invoice',
  },
  // No file figure and no correction, which is the state the "shares only" caveat is
  // about — the panel's own tests type one in (#290).
  referenceOverride: null,
  outsideCode: '00',
  categories: [
    {
      categoryId: 'cat-coffee',
      categoryName: 'Coffee',
      isIncome: false,
      hidden: false,
      coicop: null,
      custodyShared: false,
      nature: null,
      aiVisibility: 'shown',
      spentCents: 8_000,
    },
    {
      categoryId: 'cat-rent',
      categoryName: 'Rent',
      isIncome: false,
      hidden: false,
      coicop: '04.5.1',
      custodyShared: false,
      nature: null,
      aiVisibility: 'shown',
      spentCents: 120_000,
    },
    {
      categoryId: 'cat-bank',
      categoryName: 'Bank charges',
      isIncome: false,
      hidden: false,
      coicop: '00',
      custodyShared: false,
      nature: null,
      aiVisibility: 'shown',
      spentCents: 1_500,
    },
    {
      categoryId: 'cat-salary',
      categoryName: 'Salary',
      isIncome: true,
      hidden: false,
      coicop: null,
      custodyShared: false,
      nature: null,
      aiVisibility: 'shown',
      spentCents: 0,
    },
    // Hidden, so the co-parent box is closed for the second of the two reasons it can
    // be: `splitCustody` skips hidden envelopes exactly as it skips income (#44).
    {
      categoryId: 'cat-old',
      categoryName: 'Old subscription',
      isIncome: false,
      hidden: true,
      coicop: null,
      custodyShared: false,
      nature: null,
      // The one row where the third state is not the default, because it is the row
      // where it matters most: a hidden envelope that saw money is still sent (#278).
      aiVisibility: 'absent',
      spentCents: 0,
    },
  ],
}

const PAYLOAD: Payload = {
  build: { version: '0.5.6', revision: 'abc1234' },
  history: { months: 24, earliest: '2024-09', latest: '2026-08' },
  profile: { email: 'nick@example.com', displayName: 'Nick', locale: 'en', role: 'owner' },
  locales: { supported: ['en', 'nl'], default: 'en' },
  // `full` is the default and what every existing deployment runs (#454). The two locked
  // modes get their own cases below.
  promptEditing: 'full',
  params: PARAMS,
  paramDefaults: PARAMS,
  advice: ADVICE,
  // One entry per key, under the sentinel that means every language — which is what
  // the server sends until someone deliberately writes a version for one language.
  prompts: [
    {
      key: 'analysis.system',
      locale: SHARED_LOCALE,
      base: 'Judge the signals, Balancr’s own way.',
      // `analysis.system` is not gated (#454), so its rows carry no verdict and read as
      // `unvalidated` — which is why no Check section is drawn for this key at all.
      active: {
        id: 'p2',
        version: 2,
        locale: SHARED_LOCALE,
        body: 'Judge the signals.',
        gate: 'unvalidated',
        validatedAt: null,
        rulesVersion: null,
      },
      storedBody: 'Judge the signals.',
      versions: [
        {
          id: 'p2',
          version: 2,
          active: true,
          name: null,
          note: 'Tightened the ordering rule',
          createdBy: 'nick@example.com',
          createdAt: '2026-08-30T09:00:00.000Z',
          chars: 19,
          gate: 'unvalidated',
          validatedAt: null,
          rulesVersion: null,
        },
        {
          id: 'p1',
          version: 1,
          active: false,
          name: null,
          note: null,
          createdBy: null,
          createdAt: '2026-08-01T09:00:00.000Z',
          chars: 12,
          gate: 'unvalidated',
          validatedAt: null,
          rulesVersion: null,
        },
      ],
    },
    {
      key: 'narrative.system',
      locale: SHARED_LOCALE,
      base: 'Write the month up.',
      // The built-in constant: no row anywhere, `id: null`, `version: 0`. `built_in` is the
      // gate a body this build ships always has, which is what keeps a fresh installation
      // from being offered a paid check on Balancr's own text.
      active: {
        id: null,
        version: 0,
        locale: SHARED_LOCALE,
        body: 'Write the month up.',
        gate: 'built_in',
        validatedAt: null,
        rulesVersion: null,
      },
      storedBody: null,
      versions: [],
    },
  ],
  accounts: [
    {
      id: 'a-current',
      source: 'actual',
      name: 'Current account',
      kind: 'checking',
      includeInNetWorth: true,
      dedupeGroup: null,
      isSourceOfTruth: false,
      decidedFields: [],
      netWorthExclusionReason: null,
    },
    {
      id: 'a-mirror',
      source: 'actual',
      name: 'Investments (mirror)',
      kind: 'investment',
      includeInNetWorth: true,
      dedupeGroup: null,
      isSourceOfTruth: false,
      decidedFields: [],
      netWorthExclusionReason: null,
    },
    {
      id: 'g-broker',
      source: 'ghostfolio',
      name: 'Bolero',
      kind: 'investment',
      includeInNetWorth: true,
      dedupeGroup: null,
      isSourceOfTruth: false,
      decidedFields: [],
      netWorthExclusionReason: null,
    },
  ],
  dedupe: [
    { ghostfolioId: 'g-broker', actualId: 'a-mirror', signals: ['name', 'balance'] },
  ],
  benchmark: BENCHMARK,
  categoryTranslations: [],
  property: { properties: [] },
  loans: [],
  debts: [],
  goals: [],
  invites: [],
  integrations: {
    actual: {
      serverUrl: 'https://actual.example.com',
      syncId: 'sync-id',
      passwordConfigured: true,
      e2ePasswordConfigured: false,
      categorySourceLocale: 'en',
    },
    ghostfolio: { url: 'https://ghostfolio.example.com', tokenConfigured: true },
    ai: {
      provider: 'gemini-aistudio',
      apiKeyConfigured: true,
      googleCloudProject: null,
      baseUrl: null,
      modelFast: 'gemini-3.7-flash',
      modelDeep: 'gemini-3.1-pro-preview',
      modelPrices: {},
      budgetEurMicro: 15_000_000,
    },
  },
  ai: {
    availability: { enabled: true, reason: null },
    month: '2026-09',
    spentMicroEur: 2_500_000,
    budgetMicroEur: 15_000_000,
    remainingMicroEur: 12_500_000,
    usedBp: 1_667,
    exceeded: false,
    history: [
      {
        month: '2026-08',
        runCount: 31,
        inputTokens: 92_000,
        outputTokens: 12_400,
        cachedTokens: 61_000,
        costMicroEur: 4_200_000,
      },
    ],
  },
}

const ESTIMATE: AiEstimate = {
  kind: 'findings',
  month: '2026-08',
  model: 'gemini-3.7-flash',
  payloadChars: 3_100,
  estimateMicroEur: 1_800,
  allowed: true,
  reason: null,
}

const DRY_RUN: AiDryRun = {
  status: 'ok',
  reason: 'ok',
  runId: 'run-1',
  month: '2026-08',
  locale: 'en',
  promptId: 'p2',
  promptVersion: 2,
  degraded: false,
  costMicroEur: 2_100,
  findings: [
    {
      code: 'above_baseline',
      categoryId: 'cat-groceries',
      severity: 'warn',
      negative: true,
      text: 'Groceries is 18% above your 12-month norm.',
      confidence: 80,
      metrics: { deltaBp: 1_800 },
    },
  ],
  clarifications: [
    { code: 'nature_unknown', categoryId: 'cat-gifts', categoryName: 'Gifts', guess: 'Discretionary' },
  ],
  dropped: [{ code: 'above_baseline', label: 'Holidays', reason: 'no_signal' }],
}

const DIFF: PromptDiff = {
  active: { id: 'p2', version: 2, locale: SHARED_LOCALE },
  stat: { added: 1, removed: 1, identical: false },
  lines: [
    { op: 'same', text: 'Judge the signals.', oldLine: 1, newLine: 1 },
    { op: 'del', text: 'Old line.', oldLine: 2, newLine: null },
    { op: 'add', text: 'New line.', oldLine: null, newLine: 2 },
  ],
  validationEstimateMicroEur: 1_200,
}

/**
 * An amount as `formatMoney` actually renders it, non-breaking space and all.
 *
 * Only for assertions that read a value straight off the DOM — an `input.value`, an
 * attribute. Testing Library's own text matching normalises whitespace, so `getByText`
 * assertions below are written with an ordinary space and would *fail* against this.
 * The two spellings looking identical on screen is exactly why the distinction needs
 * saying out loud.
 */
const eur = (amount: string): string => `\u20ac\u00a0${amount}`

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const failure = (code: string, message: string, status: number, issues?: unknown): Response =>
  json({ error: { code, message, requestId: 'req-7', ...(issues === undefined ? {} : { issues }) } }, status)

interface Call {
  path: string
  method: string
  body: unknown
}

/**
 * Answers per path, and records what was sent.
 *
 * The body matters more than the path in most of these assertions — "it PATCHed
 * `/api/settings/params`" is true of a form that sent every field — so the recorder
 * parses it rather than leaving the test to read `mock.calls`.
 */
function serve(replies: Record<string, Response | Error | (Response | Error)[]>): Call[] {
  const calls: Call[] = []
  const queues = new Map<string, (Response | Error)[]>()

  vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
    const raw = init?.body
    calls.push({
      path,
      method: init?.method ?? 'GET',
      body: typeof raw === 'string' ? JSON.parse(raw) : undefined,
    })

    const configured = replies[path]
    if (configured === undefined) return Promise.reject(new Error(`unstubbed request: ${path}`))

    let queue = queues.get(path)
    if (queue === undefined) {
      queue = Array.isArray(configured) ? [...configured] : [configured]
      queues.set(path, queue)
    }
    // The last reply repeats: a component asking twice where the test expected once
    // should fail on an assertion, not on an unhandled rejection inside React.
    const reply = (queue.length > 1 ? queue.shift() : queue[0]) ?? configured
    if (Array.isArray(reply)) return Promise.reject(new Error('nested reply queue'))
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply.clone())
  })

  return calls
}

type Replies = Record<string, Response | Error | (Response | Error)[]>

/**
 * The heading each section's own panel puts up first, once its data has landed
 * (#200). `open()` below waits for one of these rather than for the payload itself,
 * because a settings page split into tabs shows only the active tab's panels — the
 * other sections' headings never render at all on a given path.
 */
const SECTION_HEADING: Record<string, string> = {
  '/settings': 'Account',
  '/settings/prompts': 'Assistant instructions',
  '/settings/ai-log': 'Request and response log',
  '/settings/risk': 'Risk profile',
  '/settings/thresholds': 'Thresholds',
  '/settings/accounts': 'Accounts',
  '/settings/benchmark': 'Household',
  '/settings/property': 'Property',
  '/settings/loans': 'Loans',
  '/settings/debts': 'Credit cards',
  '/settings/goals': 'Savings goals',
}

/**
 * The page, on whichever section's path is given, once its payload has landed.
 *
 * Most describe blocks below shadow this with their own `open` bound to one section's
 * path (#200) — `openPage` is the name that shadow calls through, kept exported at
 * this scope so a block that needs more than one section (a viewer's, the page's own
 * shape) can still reach every tab from one helper.
 *
 * `heading` overrides `SECTION_HEADING`'s lookup for a subsection path (#262) — a
 * group's own tab still renders the section's title, so a fixed heading covers every
 * `/settings/thresholds/<group>` and `/settings/benchmark/<tab>` path without growing
 * the map by one entry per subsection.
 */
async function openPage(replies: Replies, path = '/settings', heading?: string): Promise<Call[]> {
  const calls = serve(replies)
  renderApp(<Settings />, { path })
  await screen.findByRole('heading', { level: 2, name: heading ?? SECTION_HEADING[path] ?? 'Account' })
  return calls
}

const open = openPage

/**
 * The status panel's own endpoint, which is not part of the settings payload.
 *
 * A healthy instance, kept minimal: what the panel does with each verdict is
 * `status.test.tsx`'s subject, and duplicating that fixture here would give this file a
 * second thing to keep up to date for no assertion of its own.
 */
const STATUS = {
  ready: true,
  degraded: false,
  at: '2026-09-03T02:00:00.000Z',
  version: '0.5.6',
  revision: 'abc1234',
  jobsEnabled: true,
  checks: [
    { name: 'database', status: 'ok', reason: null },
    { name: 'actual', status: 'ok', reason: null },
    { name: 'ghostfolio', status: 'ok', reason: null },
    { name: 'jobs', status: 'ok', reason: null },
  ],
  jobs: [],
  probes: [],
}

/** The default: a full payload and an estimate the dry-run button can price. */
const READS = {
  '/api/settings': json(PAYLOAD),
  '/api/ai/estimate': json(ESTIMATE),
  '/api/status': json(STATUS),
}

const writes = (calls: Call[]): Call[] => calls.filter((call) => call.method !== 'GET')

/** The input for one threshold, by its label. */
const field = (label: string): HTMLInputElement =>
  screen.getByLabelText(label, { exact: false }) as HTMLInputElement

/**
 * One panel's form, by the class it carries.
 *
 * Two panels write independently now and both buttons say "Save", which is the right
 * word on each — so the query says which form it means rather than the page growing a
 * longer label for the benefit of a test.
 */
const form = (name: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`form.${name}`)
  if (found === null) throw new Error(`no ${name} form on the page`)
  return found
}

const save = (): HTMLButtonElement =>
  within(form('thresholds')).getByRole('button', { name: 'Save' }) as HTMLButtonElement

const saveRisk = (): HTMLButtonElement =>
  within(form('risk')).getByRole('button', { name: 'Save' }) as HTMLButtonElement

/** One band edge's box, by the name a screen reader would read it out under. */
const band = (name: string, edge: string): HTMLInputElement =>
  screen.getByLabelText(`${name}, ${edge}`) as HTMLInputElement

beforeAll(async () => {
  await i18nReady()
})

afterEach(async () => {
  // Before anything that awaits: one case freezes `Date` to pin the household's "as of"
  // year, and a frozen clock left behind is the kind of failure that lands on the next
  // test written months later.
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  // i18next is a singleton for the whole file, so the language test would otherwise
  // leave every case after it reading Dutch.
  await resetLanguage()
})

describe('the shape of the page', () => {
  it('heads the page before the payload lands, and does not draw a panel over nothing', () => {
    serve(READS)
    renderApp(<Settings />, { path: '/settings' })

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Settings')
    expect(screen.queryByRole('heading', { level: 2, name: 'Account' })).toBeNull()
  })

  it('opens on General, and only General’s own subsection, with the build the answer came from', async () => {
    await open(READS)

    for (const title of ['Account', 'Data window', 'This instance']) {
      expect(screen.getByRole('heading', { level: 2, name: title })).toBeTruthy()
    }
    expect(screen.getByText('abc1234')).toBeTruthy()
    expect(screen.getByText('0.5.6')).toBeTruthy()

    // Status moved to its own subsection tab (#262), and every other section's panel
    // stays off the page until its own tab is open.
    for (const title of [
      'Status of this instance',
      'Assistant instructions',
      'Thresholds',
      'Accounts',
      'Household',
      'AI usage',
    ]) {
      expect(screen.queryByRole('heading', { level: 2, name: title })).toBeNull()
    }
  })

  it('shows only Status on its own subsection tab, not General’s own fields (#262)', async () => {
    await openPage(READS, '/settings/status', 'Status of this instance')

    await screen.findByText('This instance is serving pages.')
    for (const title of ['Account', 'Data window', 'This instance']) {
      expect(screen.queryByRole('heading', { level: 2, name: title })).toBeNull()
    }
  })

  it.each([
    ['/settings/prompts', 'Assistant instructions'],
    ['/settings/thresholds', 'Thresholds'],
    ['/settings/accounts', 'Accounts'],
  ] as const)('shows only %s’s panel on its own tab, not General’s', async (path, title) => {
    await open(READS, path)

    expect(screen.getByRole('heading', { level: 2, name: title })).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 2, name: 'Account' })).toBeNull()
    expect(screen.queryByRole('heading', { level: 2, name: 'Status of this instance' })).toBeNull()
  })

  it('shows only the household on Benchmark’s own household tab (#262)', async () => {
    await openPage(READS, '/settings/benchmark/household', 'Household')
    expect(screen.getByRole('heading', { level: 2, name: 'Household' })).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 2, name: 'Categories' })).toBeNull()
  })

  it('shows only the category mapping on Benchmark’s other tab (#262)', async () => {
    await openPage(READS, '/settings/benchmark/mapping', 'Categories')
    expect(screen.getByRole('heading', { level: 2, name: 'Categories' })).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 2, name: 'Household' })).toBeNull()
  })

  it('lands on Household by default when Benchmark’s own tab is not named', async () => {
    await open(READS, '/settings/benchmark')

    expect(screen.getByRole('heading', { level: 2, name: 'Household' })).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 2, name: 'Categories' })).toBeNull()
    expect(screen.queryByRole('heading', { level: 2, name: 'Account' })).toBeNull()
  })

  it('marks the open tab current, and lands on General for a path it does not recognise', async () => {
    await open(READS, '/settings/risk')
    expect(screen.getByRole('link', { name: 'Risk' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'General' }).getAttribute('aria-current')).toBeNull()

    await open(READS, '/settings/nonsense')
    expect(screen.getByRole('heading', { level: 2, name: 'Account' })).toBeTruthy()
  })

  it('shows the data window, and what the sync pass has actually covered (#162)', async () => {
    await open(READS)

    expect(screen.getByRole('heading', { level: 2, name: 'Data window' })).toBeTruthy()
    expect(screen.getByText('24 months')).toBeTruthy()
    expect(screen.getByText('September 2024 – August 2026')).toBeTruthy()
  })

  it('says nothing has been aggregated yet rather than a range of nothing', async () => {
    await open({
      ...READS,
      '/api/settings': json({ ...PAYLOAD, history: { months: 24, earliest: null, latest: null } }),
    })

    expect(screen.getByText('Nothing aggregated yet')).toBeTruthy()
  })

  it('asks for the payload once, and for the price a run would cost, on every tab', async () => {
    const calls = await openPage(READS, '/settings/status', 'Status of this instance')
    // `/api/status` is Status' own panel and separate from the payload on purpose —
    // `Settings.tsx` says why — so it is a third request here rather than a sixth field.
    await screen.findByText('This instance is serving pages.')

    expect(calls.map((call) => call.path)).toEqual([
      '/api/settings',
      '/api/ai/estimate',
      '/api/status',
    ])
  })

  it('does not fetch the running instance status on a tab that does not show it', async () => {
    const calls = await open(READS, '/settings/prompts')
    await screen.findByRole('button', { name: /^Test on/ })

    // `/api/ai/estimate` is asked for regardless of tab — both Prompts' test run and
    // the AI usage tab's by-hand run price against it — but `/api/status` is never
    // asked for here: only the Status section's own subsections mount the panel that
    // reads it (#262).
    expect(calls.map((call) => call.path)).toEqual(['/api/settings', '/api/ai/estimate'])
  })
})

describe('language', () => {
  it('writes the profile and switches the interface to what came back', async () => {
    const calls = await open({
      ...READS,
      '/api/settings/profile': json({
        ...PAYLOAD,
        profile: { ...PAYLOAD.profile, locale: 'nl' },
      }),
    })

    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'nl' } })

    // "Eigenaar" rather than a heading: the panel that just wrote is the only one
    // General still shows once Thresholds moved to its own tab (#200). A regex, not a
    // plain string: the role text shares a <p> with the "signed in as" line, so no
    // element's own text is the bare word alone.
    await screen.findByText(/Eigenaar/)
    expect(writes(calls)).toEqual([
      { path: '/api/settings/profile', method: 'PATCH', body: { locale: 'nl' } },
    ])

    // Belgian formatting is not a language setting: the euro sign and the comma stay,
    // on a tab that has a euro figure to check it against. AI usage moved from its own
    // nav entry to Status's AI subtab (#325's Spend-into-Status move), so getting there
    // now takes two clicks — General's own Status tab, then Status's own AI tab.
    fireEvent.click(screen.getByRole('link', { name: 'Status van deze instantie' }))
    fireEvent.click(await screen.findByRole('link', { name: 'AI' }))
    expect(await screen.findByText('€ 2,50')).toBeTruthy()
  })

  it('sends nothing when the language chosen is the one already set', async () => {
    const calls = await open(READS)
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'en' } })
    expect(writes(calls)).toEqual([])
  })
})

describe('thresholds', () => {
  /**
   * Thresholds moved to its own tab (#200), then grew one tab per group (#262) — every
   * case here means one of those, `baseline` (the default group) unless it says
   * otherwise.
   */
  const open = (replies: Replies, group = 'baseline'): Promise<Call[]> =>
    openPage(replies, `/settings/thresholds/${group}`, 'Thresholds')

  it('sends only the fields that changed, across the subsections they live in', async () => {
    const calls = await open({ ...READS, '/api/settings/params': json(PAYLOAD) }, 'baseline')

    fireEvent.change(field('Months of history in the norm'), { target: { value: '18' } })
    fireEvent.click(screen.getByRole('link', { name: 'Overspending' }))
    fireEvent.change(await screen.findByLabelText('Warn above the norm', { exact: false }), {
      target: { value: '2500' },
    })
    fireEvent.click(save())

    await waitFor(() => {
      expect(writes(calls)).toHaveLength(1)
    })
    expect(writes(calls)[0]?.body).toEqual({
      baseline: { windowMonths: 18 },
      overspend: { baselineWarnBp: 2_500 },
    })
  })

  it('keeps a typed value after switching to a different subsection tab and back', async () => {
    await open(READS, 'baseline')

    fireEvent.change(field('Months of history in the norm'), { target: { value: '18' } })
    fireEvent.click(screen.getByRole('link', { name: 'Overspending' }))
    await screen.findByLabelText('Warn above the norm', { exact: false })
    fireEvent.click(screen.getByRole('link', { name: 'Your own norm' }))

    const input = (await screen.findByLabelText('Months of history in the norm', {
      exact: false,
    })) as HTMLInputElement
    expect(input.value).toBe('18')
  })

  it('shows only the active group’s fieldset, not the other five', async () => {
    await open(READS, 'drift')

    expect(screen.getByRole('group', { name: 'Portfolio drift' })).toBeTruthy()
    for (const group of ['Your own norm', 'Overspending', 'Pace', 'Data hygiene', 'Household targets']) {
      expect(screen.queryByRole('group', { name: group })).toBeNull()
    }
  })

  it('lands on its own default group when the subsection is not named', async () => {
    await openPage(READS, '/settings/thresholds', 'Thresholds')

    expect(screen.getByRole('group', { name: 'Your own norm' })).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Portfolio drift' })).toBeNull()
  })

  it('parses a money field the Belgian way and sends cents', async () => {
    const calls = await open({ ...READS, '/api/settings/params': json(PAYLOAD) }, 'overspend')

    // Shown as `€ 25,00`, typed back as an amount, sent as an integer number of cents.
    expect(field('Ignore amounts under').value).toBe(eur('25,00'))
    fireEvent.change(field('Ignore amounts under'), { target: { value: '30,50' } })
    fireEvent.click(save())

    await waitFor(() => {
      expect(writes(calls)[0]?.body).toEqual({ overspend: { materialityFloorCents: 3_050 } })
    })
  })

  it('refuses a grouping mark in a plain number rather than reading it as three digits', async () => {
    const calls = await open({ ...READS, '/api/settings/params': json(PAYLOAD) }, 'overspend')

    // `parseFloat('2.000')` is 2 — which would save 0,02% as if it were 20%.
    fireEvent.change(field('Warn above the norm'), { target: { value: '2.000' } })

    expect(
      screen.getByText('Type it without a thousands separator — 2.000 could mean 2000 or 2.'),
    ).toBeTruthy()
    expect(save().disabled).toBe(true)
    expect(writes(calls)).toEqual([])
  })

  it('has nothing to save once a field is typed back to what is stored', async () => {
    await open(READS, 'overspend')

    fireEvent.change(field('Warn above the norm'), { target: { value: '2500' } })
    expect(save().disabled).toBe(false)

    fireEvent.change(field('Warn above the norm'), { target: { value: '2000' } })
    expect(save().disabled).toBe(true)
  })

  it('says what a basis-points field will be read as, so 2000 is not mistaken for money', async () => {
    await open(READS, 'overspend')
    expect(screen.getByText(/reads as 20%/)).toBeTruthy()
  })

  it('reveals an explanation next to a field on hover, in more than one group', async () => {
    await open(READS, 'baseline')

    const baselineLabel = screen.getByText('Months of history in the norm', { selector: 'label' })
    fireEvent.mouseEnter(within(baselineLabel.closest('.thresholds__field') as HTMLElement).getByRole('button', { name: 'More info' }))
    expect(screen.getByRole('tooltip').textContent).toMatch(/months of history/i)

    fireEvent.click(screen.getByRole('link', { name: 'Overspending' }))
    const overspendLabel = await screen.findByText('Ignore amounts under', { selector: 'label', exact: false })
    fireEvent.mouseEnter(within(overspendLabel.closest('.thresholds__field') as HTMLElement).getByRole('button', { name: 'More info' }))
    expect(screen.getByRole('tooltip')).toBeTruthy()
  })

  it('puts a rejected field beside itself rather than at the top of the page', async () => {
    await open(
      {
        ...READS,
        '/api/settings/params': failure('invalidBody', 'That request was not valid.', 400, [
          { path: 'overspend.baselineWarnBp', message: 'must not exceed baselineAlertBp' },
        ]),
      },
      'overspend',
    )

    fireEvent.change(field('Warn above the norm'), { target: { value: '9000' } })
    fireEvent.click(save())

    const issue = await screen.findByText('must not exceed baselineAlertBp')
    expect(issue.closest('.thresholds__field')).not.toBeNull()
    // The generic message would be true and useless next to twenty inputs.
    expect(screen.queryByText('That request was not valid.')).toBeNull()
  })

  it('reports a failure the server did not attribute to a field once, above the panels', async () => {
    await open(
      {
        ...READS,
        '/api/settings/params': failure('rateLimited', 'Too many requests. Try again shortly.', 429),
      },
      'overspend',
    )

    fireEvent.change(field('Warn above the norm'), { target: { value: '2500' } })
    fireEvent.click(save())

    const alert = await screen.findByText('Too many requests. Try again shortly.')
    expect(alert.closest('.notice--error')).not.toBeNull()
    expect(screen.getByText('req-7')).toBeTruthy()
  })
})

describe('the risk profile', () => {
  const open = (replies: Replies): Promise<Call[]> => openPage(replies, '/settings/risk')

  it('prints what each preset means, so the word is not a black box', async () => {
    await open(READS)

    // The server's own numbers, and the zero-target classes dropped: a satellite that
    // is allowed to be nothing says nothing about what "growth" is.
    expect(screen.getByText('65% Equities · 30% Bonds · 5% Property')).toBeTruthy()
    expect(screen.getByText('85% Equities · 10% Bonds · 5% Property')).toBeTruthy()
  })

  it('fills in the preset that is stored, and claims no edit', async () => {
    await open(READS)

    expect((screen.getByRole('radio', { name: /Balanced/ }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: /Growth/ }) as HTMLInputElement).checked).toBe(false)
    expect(screen.queryByText(/no longer match a preset/)).toBeNull()
    // Nothing to send yet.
    expect(saveRisk().disabled).toBe(true)
  })

  it('shows each band as three boxes and what those three read as', async () => {
    await open(READS)

    expect(band('Equities', 'Floor').value).toBe('5500')
    expect(band('Equities', 'Target').value).toBe('6500')
    expect(band('Equities', 'Ceiling').value).toBe('7500')
    // Plain integers in the boxes and the percentages beside them: `6.500` in a
    // basis-points field means 65% to a Belgian and 0,065% to a parser.
    expect(screen.getByText('55% – 65% – 75%')).toBeTruthy()
  })

  it('sends the name of a preset and lets the server supply the numbers', async () => {
    const calls = await open({ ...READS, '/api/settings/advice': json(PAYLOAD) })

    fireEvent.click(screen.getByRole('radio', { name: /Growth/ }))
    // The boxes follow the pick, so what is on screen is what would be saved.
    expect(band('Equities', 'Target').value).toBe('8500')
    fireEvent.click(saveRisk())

    await waitFor(() => {
      expect(writes(calls)).toHaveLength(1)
    })
    expect(writes(calls)[0]?.path).toBe('/api/settings/advice')
    // The name alone. Sending both would be this panel deciding that twelve numbers it
    // did not choose are still "growth".
    expect(writes(calls)[0]?.body).toEqual({ profile: 'growth' })
  })

  it('has nothing to send when the preset picked is the one already stored', async () => {
    await open(READS)
    fireEvent.click(screen.getByRole('radio', { name: /Balanced/ }))
    expect(saveRisk().disabled).toBe(true)
  })

  it('sends all four bands when one number is edited by hand', async () => {
    const calls = await open({ ...READS, '/api/settings/advice': json(PAYLOAD) })

    // Equities down 5 points, bonds up 5, so the targets still add up.
    fireEvent.change(band('Equities', 'Target'), { target: { value: '6000' } })
    fireEvent.change(band('Bonds', 'Target'), { target: { value: '3500' } })
    fireEvent.click(saveRisk())

    await waitFor(() => {
      expect(writes(calls)).toHaveLength(1)
    })
    // The whole set, and no `profile`: four targets with one left over from the previous
    // profile is exactly the state that adds up to 97%.
    expect(writes(calls)[0]?.body).toEqual({
      bands: {
        EQUITY: { minBp: 5_500, targetBp: 6_000, maxBp: 7_500 },
        FIXED_INCOME: { minBp: 2_000, targetBp: 3_500, maxBp: 4_000 },
        REAL_ESTATE: { minBp: 0, targetBp: 500, maxBp: 1_500 },
        COMMODITY: { minBp: 0, targetBp: 0, maxBp: 1_000 },
      },
    })
  })

  it('says the profile has become custom while it is being typed', async () => {
    await open(READS)

    fireEvent.change(band('Equities', 'Target'), { target: { value: '6000' } })
    // Before any round trip: the profile in force is the numbers, and the reader should
    // not have to save to find out what saving would do.
    expect(screen.getByText(/no longer match a preset/)).toBeTruthy()
    // And no radio claims the numbers any more.
    expect((screen.getByRole('radio', { name: /Balanced/ }) as HTMLInputElement).checked).toBe(
      false,
    )
  })

  it('drops the typed numbers when a different preset is picked', async () => {
    await open(READS)

    fireEvent.change(band('Equities', 'Target'), { target: { value: '6000' } })
    fireEvent.click(screen.getByRole('radio', { name: /Defensive/ }))
    // Carrying "6000" into defensive would silently rebuild the band the picker was
    // asked to replace.
    expect(band('Equities', 'Target').value).toBe('4000')
    expect(screen.queryByText(/no longer match a preset/)).toBeNull()
  })

  it('refuses a grouped basis-points figure rather than reading it as four digits', async () => {
    const calls = await open(READS)

    // `6.500` is 65% on screen everywhere else in the app; in this box it has no valid
    // reading at all, and `Number('6.500')` is 6,5 — a floor of 0,065%.
    fireEvent.change(band('Equities', 'Target'), { target: { value: '6.500' } })
    expect(saveRisk().disabled).toBe(true)
    expect(writes(calls)).toEqual([])
  })

  it('adds the targets up live and refuses a set that does not make 100%', async () => {
    const calls = await open(READS)

    expect(screen.getByText('Targets add up to 100%.')).toBeTruthy()
    fireEvent.change(band('Equities', 'Target'), { target: { value: '6000' } })

    // 60 + 30 + 5 + 0. Answered before the save rather than after a round trip — and
    // still refused by the server, which is the only place the rule is enforced.
    expect(screen.getByText('Targets add up to 95%.')).toBeTruthy()
    expect(saveRisk().disabled).toBe(true)
    expect(writes(calls)).toEqual([])
  })

  it('sends the two thresholds in their own units', async () => {
    const calls = await open({ ...READS, '/api/settings/advice': json(PAYLOAD) })

    // Basis points as an integer, money as money — and the money box shows the server's
    // cents through `formatMoney`, which is what a page doing its own division fails.
    expect(screen.getByLabelText('Smallest trade worth making').getAttribute('value')).toBe(
      eur('500,00'),
    )
    fireEvent.change(screen.getByLabelText('Ignore drift under'), { target: { value: '150' } })
    fireEvent.change(screen.getByLabelText('Smallest trade worth making'), {
      target: { value: '750,50' },
    })
    fireEvent.click(saveRisk())

    await waitFor(() => {
      expect(writes(calls)).toHaveLength(1)
    })
    expect(writes(calls)[0]?.body).toEqual({ toleranceBp: 150, minTradeCents: 75_050 })
  })

  it('says what a basis-points threshold will be read as', async () => {
    await open(READS)
    expect(screen.getByText(/In basis points past a band edge, so 1%/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Ignore drift under'), { target: { value: '250' } })
    expect(screen.getByText(/so 2,5%/)).toBeTruthy()
  })

  it('puts a refusal about the bands beside the panel that sent them', async () => {
    await open({
      ...READS,
      '/api/settings/advice': failure('invalidBody', 'That request was not valid.', 400, [
        { path: 'bands', message: 'targets add up to 95,00% instead of 100%' },
      ]),
    })

    fireEvent.change(band('Equities', 'Target'), { target: { value: '6000' } })
    fireEvent.change(band('Bonds', 'Target'), { target: { value: '3500' } })
    fireEvent.click(saveRisk())

    const issue = await screen.findByText('targets add up to 95,00% instead of 100%')
    expect(issue.closest('.risk')).not.toBeNull()
    expect(screen.queryByText('That request was not valid.')).toBeNull()
  })

  it('leaves the whole profile read-only for a viewer', async () => {
    await open({
      ...READS,
      '/api/settings': json({ ...PAYLOAD, profile: { ...PAYLOAD.profile, role: 'viewer' } }),
    })

    expect(band('Equities', 'Target').disabled).toBe(true)
    expect((screen.getByRole('radio', { name: /Growth/ }) as HTMLInputElement).disabled).toBe(true)
    expect(saveRisk().disabled).toBe(true)
    // But every number stays readable: this is the panel that explains the advice.
    expect(band('Equities', 'Target').value).toBe('6500')
  })
})

describe('accounts', () => {
  const open = (replies: Replies): Promise<Call[]> => openPage(replies, '/settings/accounts')

  it('names the pair that may be counted twice and lets either side win', async () => {
    const calls = await open({ ...READS, '/api/settings/accounts/group': json(PAYLOAD) })

    expect(screen.getByText('Bolero may be the same money as Investments (mirror).')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Link, Bolero counts' }))

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/accounts/group',
          method: 'POST',
          body: { accountMapIds: ['g-broker', 'a-mirror'], sourceOfTruthId: 'g-broker' },
        },
      ])
    })
  })

  it('says why the pair is suspected, so the suggestion can be audited', async () => {
    await open(READS)

    // Not decoration. A suggestion nobody can check gets accepted blindly or silenced
    // destructively, and silencing it used to mean grouping two unrelated accounts —
    // which drops real money out of net worth.
    expect(
      screen.getByText(
        'Suggested because: both are called the same thing and the balances agree.',
      ),
    ).toBeTruthy()
  })

  it('offers a dismissal that keeps both accounts counting', async () => {
    const calls = await open({
      ...READS,
      '/api/settings/accounts/g-broker/not-mirrored': json(PAYLOAD),
    })

    fireEvent.click(screen.getByRole('button', { name: 'Not the same money' }))

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/accounts/g-broker/not-mirrored',
          method: 'POST',
          body: {},
        },
      ])
    })
  })

  it('shows a viewer the evidence but none of the three controls', async () => {
    await open({
      ...READS,
      '/api/settings': json({ ...PAYLOAD, profile: { ...PAYLOAD.profile, role: 'viewer' } }),
    })

    expect(
      screen.getByText('Bolero may be the same money as Investments (mirror).'),
    ).toBeTruthy()
    for (const name of ['Link, Bolero counts', 'Link, Investments (mirror) counts', 'Not the same money']) {
      expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true)
    }
  })

  it('writes a kind change straight away, since there is nothing to submit', async () => {
    const calls = await open({ ...READS, '/api/settings/accounts/a-current': json(PAYLOAD) })

    fireEvent.change(screen.getAllByLabelText('Kind')[0] ?? document.createElement('select'), {
      target: { value: 'savings' },
    })

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        { path: '/api/settings/accounts/a-current', method: 'PATCH', body: { kind: 'savings' } },
      ])
    })
  })

  it('offers every kind the server accepts', async () => {
    await open(READS)
    const select = screen.getAllByLabelText('Kind')[0]
    expect([...(select?.querySelectorAll('option') ?? [])].map((o) => o.getAttribute('value'))).toEqual([
      ...ACCOUNT_KINDS,
    ])
  })

  it('drops the net-worth account out of the sum on request', async () => {
    const calls = await open({ ...READS, '/api/settings/accounts/g-broker': json(PAYLOAD) })

    const boxes = screen.getAllByLabelText('Count toward net worth')
    fireEvent.click(boxes[2] ?? document.createElement('input'))

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/accounts/g-broker',
          method: 'PATCH',
          body: { includeInNetWorth: false },
        },
      ])
    })
  })
})

/**
 * #245: a linked pair used to render as two independent rows, which is what led the
 * user to uncheck the wrong one thinking it was a duplicate. These check that a
 * linked pair now renders — and behaves — as exactly one block.
 */
describe('a linked pair of accounts', () => {
  const open = (replies: Replies): Promise<Call[]> => openPage(replies, '/settings/accounts')

  const LINKED_PAYLOAD: Payload = {
    ...PAYLOAD,
    accounts: [
      PAYLOAD.accounts[0]!,
      {
        ...PAYLOAD.accounts[1]!,
        dedupeGroup: 'broker-1',
        isSourceOfTruth: false,
      },
      {
        ...PAYLOAD.accounts[2]!,
        dedupeGroup: 'broker-1',
        isSourceOfTruth: true,
      },
    ],
    // Already linked — nothing left to suggest.
    dedupe: [],
  }

  it('shows one block for the pair, not two rows', async () => {
    await open({ ...READS, '/api/settings': json(LINKED_PAYLOAD) })

    expect(screen.getAllByRole('heading', { level: 3, name: 'Current account' })).toHaveLength(1)
    expect(screen.getAllByRole('heading', { level: 3, name: 'Bolero' })).toHaveLength(1)
    // The mirror's own name is still visible, just not as a second row.
    expect(screen.getByText('Linked with Investments (mirror) (Actual Budget)')).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 3, name: 'Investments (mirror)' })).toBeNull()
  })

  it('drives the toggle from the source-of-truth side of the pair', async () => {
    const calls = await open({
      ...READS,
      '/api/settings': json(LINKED_PAYLOAD),
      '/api/settings/accounts/g-broker': json(LINKED_PAYLOAD),
    })

    // One toggle for the block, not one per member: current account (ungrouped) + the pair.
    const boxes = screen.getAllByLabelText('Count toward net worth')
    expect(boxes).toHaveLength(2)
    fireEvent.click(boxes[1] ?? document.createElement('input'))

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/accounts/g-broker',
          method: 'PATCH',
          body: { includeInNetWorth: false },
        },
      ])
    })
  })

  it('unlinks the whole pair with one button', async () => {
    const calls = await open({
      ...READS,
      '/api/settings': json(LINKED_PAYLOAD),
      '/api/settings/accounts/g-broker/ungroup': json(PAYLOAD),
    })

    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }))

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        { path: '/api/settings/accounts/g-broker/ungroup', method: 'POST', body: undefined },
      ])
    })
  })

  it('disables Unlink for a viewer', async () => {
    await open({
      ...READS,
      '/api/settings': json({
        ...LINKED_PAYLOAD,
        profile: { ...LINKED_PAYLOAD.profile, role: 'viewer' },
      }),
    })

    expect(screen.getByRole('button', { name: 'Unlink' }).hasAttribute('disabled')).toBe(true)
  })
})

describe('the household', () => {
  const open = (replies: Replies): Promise<Call[]> => openPage(replies, '/settings/benchmark')

  const household = (): HTMLElement => form('household')

  const saveHousehold = (): HTMLButtonElement =>
    within(household()).getByRole('button', { name: 'Save' }) as HTMLButtonElement

  const memberField = (label: string, at = 0): HTMLInputElement =>
    (screen.getAllByLabelText(label)[at] ?? document.createElement('input')) as HTMLInputElement

  const sharedCost = (): HTMLInputElement =>
    screen.getByLabelText('Your share of shared costs') as HTMLInputElement

  const directionPicker = (): HTMLSelectElement =>
    screen.getByLabelText('Which side lands in Actual') as HTMLSelectElement
  const reference = (): HTMLElement => form('reference-form')

  const saveReference = (): HTMLButtonElement =>
    within(reference()).getByRole('button', {
      name: 'Save',
    }) as HTMLButtonElement

  /**
   * `reference()`'s panel, for the tests below it (#290/#327): the Statbel correction
   * form lives on Benchmark's own Comparison tab, a sibling of Household and Categories,
   * and stays mounted but `hidden` while another one shows. `getByRole` treats a
   * `hidden` ancestor as inaccessible even though the node is in the document, so a test
   * that queries the Save button (or clicks it) needs the Comparison tab actually active,
   * not just `open()`'s default landing on Household.
   */
  const openComparison = (replies: Replies): Promise<Call[]> =>
    openPage(replies, '/settings/benchmark/comparison', 'Comparison')

  /** The citation the fixture's file carries, which the boxes prefill from (#290). */
  const FILE_CITATION =
    'Statbel, Household Budget Survey 2024 — mean expenditure per household and per consumption unit'

  /**
   * The same payload with the survey's euro figures filled in.
   *
   * Invented round-ish numbers, like every figure in these tests: € 3.689,19 a month for a
   * household of 1,5066 on the scale. The default fixture deliberately has none, because
   * "only the mix is compared" is the state the provenance list is about.
   */
  const withReference = {
    ...PAYLOAD,
    benchmark: {
      ...PAYLOAD.benchmark,
      file: {
        ...BENCHMARK_FILE,
        referenceHousehold: {
          meanMonthlyCents: 368_919,
          equivalentAdultsBp: 15_066,
          citation: FILE_CITATION,
          sourceUrl: 'https://statbel.fgov.be/en/themes/households/household-budget-survey-hbs',
          lastVerified: '2026-09-07',
          status: 'confirmed' as const,
        },
      },
    },
  }

  it('says what each row reads as on the scale, and as of when', async () => {
    // Only `Date` is faked, so the testing library's own waiting still uses real timers.
    // The year has to be pinned at all: the panel classifies a member by their age *now*,
    // so a test written against the wall clock would pass until the fixture's teenager has
    // a birthday and then fail on a morning nobody touched this code.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-04T12:00:00Z'))

    await open(READS)

    // Born 2013, so thirteen in 2026 and under the file's threshold of fourteen, and here
    // half the time. The row has to say both, because the weight that combination
    // produces is 0,15 and nothing else on screen would explain that figure.
    expect(
      within(household()).getByText(/Counts at the child weight, 50\s?% of the time\./),
    ).toBeTruthy()
    expect(screen.getByText(/The weights below read as of 2026/)).toBeTruthy()
  })

  it('has nothing to save until a box is touched', async () => {
    await open(READS)

    expect(saveHousehold().disabled).toBe(true)
  })

  it('shows a placeholder for the first person until a name is stored (#215)', async () => {
    await open(READS)

    const input = screen.getByLabelText('Your name') as HTMLInputElement
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('You')
    expect(
      within(household()).getByText(/^You — always the first person on the scale/),
    ).toBeTruthy()
  })

  it('reads the stored name in place of the placeholder, and prefills the box (#215)', async () => {
    const named = {
      ...PAYLOAD,
      benchmark: {
        ...PAYLOAD.benchmark,
        household: { ...PAYLOAD.benchmark.household, selfLabel: 'Nick' },
      },
    }
    await open({ ...READS, '/api/settings': json(named) })

    expect((screen.getByLabelText('Your name') as HTMLInputElement).value).toBe('Nick')
    expect(
      within(household()).getByText(/^Nick — always the first person on the scale/),
    ).toBeTruthy()
  })

  it('sends a typed name with the roster, trimmed (#215)', async () => {
    const calls = await open({ ...READS, '/api/settings/household': json(PAYLOAD) })

    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: '  Nick  ' } })
    expect(saveHousehold().disabled).toBe(false)
    fireEvent.click(saveHousehold())

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/household',
          method: 'PATCH',
          body: {
            country: 'BE',
            members: [{ birthYear: 2013, custodyBp: 5_000, label: 'Teenager' }],
            selfLabel: 'Nick',
            sharedCostBp: null,
            sharedCostDirection: 'whole_invoice',
          },
        },
      ])
    })
  })

  it('keeps a typed name after switching to Benchmark’s other tab and back', async () => {
    // Regression: the household roster used to live on the same page as the mapping
    // table, so nothing unmounted it. Splitting them into subsection tabs (#262) made
    // `BenchmarkSection` render one panel or the other, and a naive conditional threw
    // away this exact draft the moment somebody switched to check the mapping and
    // switched back.
    await open(READS)

    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Nick' } })
    fireEvent.click(screen.getByRole('link', { name: 'Categories' }))
    await screen.findByRole('heading', { level: 2, name: 'Categories' })
    fireEvent.click(screen.getByRole('link', { name: 'Household' }))

    const input = (await screen.findByLabelText('Your name')) as HTMLInputElement
    expect(input.value).toBe('Nick')
  })

  it('drops a stored name when the box is cleared, the same direction the shared-cost box takes (#215)', async () => {
    const named = {
      ...PAYLOAD,
      benchmark: {
        ...PAYLOAD.benchmark,
        household: { ...PAYLOAD.benchmark.household, selfLabel: 'Nick' },
      },
    }
    const calls = await open({
      ...READS,
      '/api/settings': json(named),
      '/api/settings/household': json(named),
    })

    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: '' } })
    fireEvent.click(saveHousehold())

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/household',
          method: 'PATCH',
          body: {
            country: 'BE',
            members: [{ birthYear: 2013, custodyBp: 5_000, label: 'Teenager' }],
            sharedCostBp: null,
            sharedCostDirection: 'whole_invoice',
          },
        },
      ])
    })
  })

  it('sends the whole roster, because removing a row cannot be expressed as a merge', async () => {
    const calls = await open({ ...READS, '/api/settings/household': json(PAYLOAD) })

    fireEvent.click(within(household()).getByRole('button', { name: 'Add someone' }))
    fireEvent.change(memberField('Name', 1), { target: { value: 'Lodger' } })
    fireEvent.change(memberField('Year of birth', 1), { target: { value: '1998' } })
    fireEvent.click(saveHousehold())

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/household',
          method: 'PATCH',
          body: {
            country: 'BE',
            members: [
              { birthYear: 2013, custodyBp: 5_000, label: 'Teenager' },
              { birthYear: 1998, custodyBp: 10_000, label: 'Lodger' },
            ],
            // The share travels with the roster for the same reason: the household is one
            // row written wholesale, so a patch that omitted it would drop a stated share
            // on every roster edit without saying so (#44).
            sharedCostBp: null,
            sharedCostDirection: 'whole_invoice',
          },
        },
      ])
    })
  })

  it('refuses a half-typed year rather than sending it', async () => {
    const calls = await open(READS)

    fireEvent.change(memberField('Year of birth'), { target: { value: '20' } })

    expect(screen.getByText(/Year of birth should be four digits/)).toBeTruthy()
    expect(saveHousehold().disabled).toBe(true)
    expect(writes(calls)).toEqual([])
  })

  it('names the empty box on a new row and says why Save is greyed out (#283)', async () => {
    const calls = await open(READS)

    fireEvent.click(within(household()).getByRole('button', { name: 'Add someone' }))
    fireEvent.change(memberField('Name', 1), { target: { value: 'Lodger' } })

    // A name is not what is missing, and the row says which box is — printing the format
    // rule here instead read as a complaint about text nobody had typed.
    expect(screen.getByText('Still to fill in: Year of birth.')).toBeTruthy()
    expect(screen.queryByText(/should be four digits/)).toBeNull()
    // The row has no save of its own, so the reason the only Save is disabled has to be
    // beside that Save rather than left to be inferred.
    expect(saveHousehold().disabled).toBe(true)
    expect(screen.getByText(/details are not complete yet/)).toBeTruthy()

    fireEvent.change(memberField('Time here', 1), { target: { value: '' } })
    expect(screen.getByText('Still to fill in: Year of birth and Time here.')).toBeTruthy()

    fireEvent.change(memberField('Year of birth', 1), { target: { value: '1998' } })
    fireEvent.change(memberField('Time here', 1), { target: { value: '5000' } })
    expect(saveHousehold().disabled).toBe(false)
    expect(screen.queryByText(/details are not complete yet/)).toBeNull()
    expect(writes(calls)).toEqual([])
  })

  it('marks the box holding a date and says what that box wants (#287)', async () => {
    const calls = await open(READS)

    // A date is a reasonable thing to type into a box labelled "Year of birth", and the
    // panel's answer to it used to be one sentence about both boxes, in the same grey a
    // correct row prints in, with nothing on the box itself.
    fireEvent.change(memberField('Year of birth', 0), { target: { value: '1998-05-12' } })

    expect(
      screen.getByText('Year of birth should be four digits — 1998, say, rather than a full date.'),
    ).toBeTruthy()
    expect(memberField('Year of birth', 0).getAttribute('aria-invalid')).toBe('true')
    // The seen cue and the announced one are separate wirings, so both are held: a border
    // that quietly stopped being applied would leave a sighted reader back where they were.
    expect(memberField('Year of birth', 0).className).toContain('field__input--bad')
    // The box the reader got right is not marked, and is not named in the complaint.
    expect(memberField('Time here', 0).getAttribute('aria-invalid')).toBeNull()
    expect(memberField('Time here', 0).className).not.toContain('field__input--bad')
    expect(screen.queryByText(/whole number up to 10000/)).toBeNull()
    expect(saveHousehold().disabled).toBe(true)

    // Both wrong: one sentence each, so neither box is left to be guessed at.
    fireEvent.change(memberField('Time here', 0), { target: { value: '50%' } })
    expect(screen.getByText(/whole number up to 10000/)).toBeTruthy()
    expect(memberField('Time here', 0).getAttribute('aria-invalid')).toBe('true')

    // An empty box is still a different sentence from a wrong one, and both can be true
    // of one row at once.
    fireEvent.change(memberField('Year of birth', 0), { target: { value: '' } })
    expect(screen.getByText(/^Still to fill in: Year of birth\./)).toBeTruthy()
    expect(memberField('Year of birth', 0).getAttribute('aria-invalid')).toBeNull()

    fireEvent.change(memberField('Year of birth', 0), { target: { value: '1998' } })
    fireEvent.change(memberField('Time here', 0), { target: { value: '5000' } })
    expect(screen.getByText('Counts at the adult weight, 50% of the time.')).toBeTruthy()
    expect(saveHousehold().disabled).toBe(false)
    expect(writes(calls)).toEqual([])
  })

  it('refuses a grouped custody share, which would read as five basis points', async () => {
    const calls = await open(READS)

    // `5.000` is 50% in every other reading on this site and `Number('5.000')` is 5 —
    // a child who lives here 0,05% of the time.
    fireEvent.change(memberField('Time here'), { target: { value: '5.000' } })

    expect(saveHousehold().disabled).toBe(true)
    expect(writes(calls)).toEqual([])
  })

  it('prints the share the roster implies while the box is empty (#44)', async () => {
    await open(READS)

    // The fixture states nothing, so the box is empty — and an empty box is not "no
    // share": it is the roster's own mean, and printing it here is what stops this screen
    // from promising a split the budget card does not apply. One member at 50%.
    expect(sharedCost().value).toBe('')
    expect(
      within(household()).getByText(
        /Empty, so it is derived from the 1 member who is here part of the time: 50\s?%\./,
      ),
    ).toBeTruthy()
  })

  it('shows the stored direction and what it will make the budget page say (#289)', async () => {
    await open(READS)

    // A picker with no current value silently changes the answer the first time somebody
    // touches it, so the stored default is selected rather than a blank option — and the
    // note under it quotes the share above, which is what makes it a reading of the form
    // rather than a second claim about the arrangement.
    expect(directionPicker().value).toBe('whole_invoice')
    expect(
      within(household()).getByText(
        /The budget page will print 50\s?% of every shared cost as yours, and the rest as the other household's\./,
      ),
    ).toBeTruthy()
    // Nothing typed yet, so there is nothing to save.
    expect(saveHousehold().disabled).toBe(true)
  })

  it('sends the other direction, and says what that one will read as', async () => {
    const calls = await open({ ...READS, '/api/settings/household': json(PAYLOAD) })

    fireEvent.change(directionPicker(), { target: { value: 'my_share' } })
    // The same 50% now describes a different figure, and the note has to change with it or
    // the picker looks decorative.
    expect(
      within(household()).getByText(
        /read every shared cost as 50\s?% of a larger one and print that larger figure, which Actual has never held\./,
      ),
    ).toBeTruthy()

    expect(saveHousehold().disabled).toBe(false)
    fireEvent.click(saveHousehold())

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/household',
          method: 'PATCH',
          body: {
            country: 'BE',
            members: [{ birthYear: 2013, custodyBp: 5_000, label: 'Teenager' }],
            // Sent on every save, not only when it changed: the household row is written
            // wholesale, so omitting it would quietly take a stated direction back to the
            // default on any unrelated roster edit (#289).
            sharedCostBp: null,
            sharedCostDirection: 'my_share',
          },
        },
      ])
    })
  })

  it('reads back a typed share, and sends it with the roster', async () => {
    const calls = await open({ ...READS, '/api/settings/household': json(PAYLOAD) })

    // 50% of the time, 60% of the costs: the two are separate facts, which is the whole
    // reason this field exists rather than being derived from the row above it.
    fireEvent.change(sharedCost(), { target: { value: '6000' } })
    expect(within(household()).getByText('60% of every shared cost counts as yours.')).toBeTruthy()

    fireEvent.click(saveHousehold())
    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/household',
          method: 'PATCH',
          body: {
            country: 'BE',
            members: [{ birthYear: 2013, custodyBp: 5_000, label: 'Teenager' }],
            sharedCostBp: 6_000,
            sharedCostDirection: 'whole_invoice',
          },
        },
      ])
    })
  })

  it('sends null when the box is cleared, which is how a split is undone', async () => {
    const stated = {
      ...PAYLOAD,
      benchmark: {
        ...PAYLOAD.benchmark,
        household: { ...PAYLOAD.benchmark.household, sharedCostBp: 6_000 },
      },
    }
    const calls = await open({
      ...READS,
      '/api/settings': json(stated),
      '/api/settings/household': json(stated),
    })

    expect(sharedCost().value).toBe('6000')
    fireEvent.change(sharedCost(), { target: { value: '' } })
    fireEvent.click(saveHousehold())

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/household',
          method: 'PATCH',
          body: {
            country: 'BE',
            members: [{ birthYear: 2013, custodyBp: 5_000, label: 'Teenager' }],
            sharedCostBp: null,
            sharedCostDirection: 'whole_invoice',
          },
        },
      ])
    })
  })

  it('refuses a share it cannot read rather than sending it', async () => {
    const calls = await open(READS)

    // Over 100%, and `5.000` for the same reason the custody column refuses it: it is 50%
    // in every other reading on this site and `Number('5.000')` is five basis points.
    for (const typed of ['12000', '5.000', '60%']) {
      fireEvent.change(sharedCost(), { target: { value: typed } })
      expect(saveHousehold().disabled, typed).toBe(true)
      expect(
        within(household()).getByText(/A whole number of basis points up to 10000/),
        typed,
      ).toBeTruthy()
    }
    expect(writes(calls)).toEqual([])
  })

  it('names the source of every figure the comparison uses', async () => {
    await openComparison(READS)

    expect(
      screen.getByText(/Statbel, Household Budget Survey 2024/, { exact: false }),
    ).toBeTruthy()
    expect(screen.getByText(/modified OECD scale/, { exact: false })).toBeTruthy()
    // The two blocks nobody has confirmed, named rather than flagged with a symbol.
    expect(
      screen.getByText(/not yet confirmed at the source: the published shares and the equivalence scale\./),
    ).toBeTruthy()
    // No euro total was transcribed, so the panel says which comparison is impossible
    // rather than leaving the budget page to be mysteriously share-only.
    expect(screen.getByText(/only the mix is compared/)).toBeTruthy()
  })

  it('offers the average household as a correction, starting from the file (#290)', async () => {
    // The fixture's file carries no euro figure, so the panel says so and the boxes start
    // empty — typing a pair here is what switches the euro comparison on at all.
    await openComparison(READS)

    expect(screen.getByText(/The file carries no euro figure/)).toBeTruthy()
    expect(
      (screen.getByLabelText('Average household spending per month') as HTMLInputElement).value,
    ).toBe('')
    expect(saveReference().disabled).toBe(true)
  })

  it('prefills all three boxes from the file when it has the figures (#290)', async () => {
    await openComparison({ ...READS, '/api/settings': json(withReference) })

    expect(
      (screen.getByLabelText('Average household spending per month') as HTMLInputElement).value,
    ).toBe(eur('3.689,19'))
    expect(
      (screen.getByLabelText('Average household size on the scale') as HTMLInputElement).value,
    ).toBe('15066')
    expect(screen.getByText(/1,5066 equivalent adults on the scale/)).toBeTruthy()
    // The file's figure applies, so there is nothing to reset to.
    expect(within(reference()).queryByRole('button', { name: /Use the file/ })).toBeNull()
    // And with a euro figure in play the panel no longer says only the mix is compared.
    expect(screen.queryByText(/only the mix is compared/)).toBeNull()
  })

  it('sends both figures and the citation together (#290)', async () => {
    const calls = await openComparison({
      ...READS,
      '/api/settings': json(withReference),
      '/api/settings/benchmark-reference': json(withReference),
    })

    fireEvent.change(screen.getByLabelText('Average household spending per month'), {
      target: { value: '4000,00' },
    })
    fireEvent.change(screen.getByLabelText('Average household size on the scale'), {
      target: { value: '16000' },
    })
    fireEvent.click(saveReference())

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/benchmark-reference',
          method: 'PATCH',
          body: {
            reference: {
              meanMonthlyCents: 400_000,
              equivalentAdultsBp: 16_000,
              // Carried over from the file rather than retyped: whoever corrects one
              // number should not have to restate the source of the other two.
              citation: FILE_CITATION,
            },
          },
        },
      ])
    })
  })

  it('refuses a size the scale could not use, and a citation that names nothing (#290)', async () => {
    const calls = await openComparison({
      ...READS,
      '/api/settings': json(withReference),
    })

    // 5000 would be half a person: the comparison divides by this, so below one adult it
    // scales the national average *up*. 1000000 is six digits and outside the schema too.
    for (const typed of ['5000', '1000000', '1,5']) {
      fireEvent.change(screen.getByLabelText('Average household size on the scale'), {
        target: { value: typed },
      })
      expect(saveReference().disabled, typed).toBe(true)
    }
    expect(screen.getByText(/A whole number of basis points between 10000 and 200000/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Average household size on the scale'), {
      target: { value: '16000' },
    })
    fireEvent.change(screen.getByLabelText('Where you got it'), {
      target: { value: 'HBS' },
    })
    expect(saveReference().disabled).toBe(true)
    expect(writes(calls)).toEqual([])
  })

  it('offers a way back to the file once a correction is stored (#290)', async () => {
    const overridden = {
      ...withReference,
      benchmark: {
        ...withReference.benchmark,
        referenceOverride: {
          meanMonthlyCents: 400_000,
          equivalentAdultsBp: 16_000,
          citation: 'Statbel, Household Budget Survey 2026 — invented figures',
          savedOn: '2026-09-07',
        },
      },
    }
    const calls = await openComparison({
      ...READS,
      '/api/settings': json(overridden),
      '/api/settings/benchmark-reference': json(withReference),
    })

    // The correction applies, and the file's own figure is still printed beside it.
    expect(screen.getByText(/Your own figure applies instead of the file/)).toBeTruthy()
    expect(screen.getByText(/The file says .* a month for a household of 1,5066/)).toBeTruthy()
    expect(
      (screen.getByLabelText('Average household size on the scale') as HTMLInputElement).value,
    ).toBe('16000')

    fireEvent.click(within(reference()).getByRole('button', { name: /Use the file/ }))

    await waitFor(() => {
      // Null rather than the file's numbers sent back: storing a copy would ignore the
      // next edition of the file while looking like it should not.
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/benchmark-reference',
          method: 'PATCH',
          body: { reference: null },
        },
      ])
    })
  })

  it('leaves the average household read-only for a viewer (#290)', async () => {
    await openComparison({
      ...READS,
      '/api/settings': json({
        ...withReference,
        profile: { ...PAYLOAD.profile, role: 'viewer' },
      }),
    })

    expect(
      (screen.getByLabelText('Average household size on the scale') as HTMLInputElement).disabled,
    ).toBe(true)
    expect(saveReference().disabled).toBe(true)
  })

  it('leaves the roster read-only for a viewer', async () => {
    await open({
      ...READS,
      '/api/settings': json({ ...PAYLOAD, profile: { ...PAYLOAD.profile, role: 'viewer' } }),
    })

    expect(memberField('Year of birth').disabled).toBe(true)
    expect(saveHousehold().disabled).toBe(true)
    // Still readable: the point of showing a viewer the panel is that they can see what
    // the comparison was drawn against.
    expect(memberField('Year of birth').value).toBe('2013')
  })
})

describe('property', () => {
  const open = (replies: Replies): Promise<Call[]> => openPage(replies, '/settings/property')

  const property = (): HTMLElement => form('property-form')

  const saveProperty = (): HTMLButtonElement =>
    within(property()).getByRole('button', { name: 'Save' }) as HTMLButtonElement

  const addProperty = (): void => {
    fireEvent.click(within(property()).getByRole('button', { name: 'Add a property' }))
  }

  /** A payload with one property already on the roster, for the edit/remove cases. */
  const withOneProperty = (extra: Partial<Payload['property']['properties'][number]> = {}): Payload => ({
    ...PAYLOAD,
    property: {
      properties: [
        {
          id: 'prop-1',
          kind: 'primary',
          label: 'Home',
          propertyValueCents: 40_000_000,
          rentCents: null,
          mortgages: [],
          ...extra,
        },
      ],
    },
  })

  it('shows the empty state when nothing is stored yet', async () => {
    await open(READS)

    expect(within(property()).getByText('No properties yet. Add the one you live in, or one you rent out.')).toBeTruthy()
    expect(saveProperty().disabled).toBe(true)
  })

  it('has nothing to save until a row is touched', async () => {
    await open(READS)

    expect(saveProperty().disabled).toBe(true)
  })

  it('sends a new row on save, with an id it made up itself', async () => {
    const calls = await open({ ...READS, '/api/settings/property': json(PAYLOAD) })

    addProperty()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Home' } })
    fireEvent.change(screen.getByLabelText('Estimated value'), { target: { value: '400000' } })
    fireEvent.click(saveProperty())

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/property',
          method: 'PATCH',
          body: {
            properties: [
              {
                id: expect.any(String),
                kind: 'primary',
                label: 'Home',
                propertyValueCents: 40_000_000,
                rentCents: null,
                mortgages: [],
              },
            ],
          },
        },
      ])
    })
  })

  it('only asks for rent once the row is a rental', async () => {
    await open(READS)

    addProperty()
    expect(screen.queryByLabelText('Monthly rent')).toBeNull()

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'rental' } })
    expect(screen.getByLabelText('Monthly rent')).toBeTruthy()
  })

  it('offers a third kind, owned outright, that also asks for no rent', async () => {
    await open(READS)

    addProperty()
    const typeSelect = screen.getByLabelText('Type') as HTMLSelectElement
    expect(Array.from(typeSelect.options, (option) => option.value)).toEqual([
      'primary',
      'rental',
      'owned',
    ])

    fireEvent.change(typeSelect, { target: { value: 'owned' } })
    expect(screen.queryByLabelText('Monthly rent')).toBeNull()
  })

  it('reads back the equity a stated value implies', async () => {
    await open({ ...READS, '/api/settings': json(withOneProperty()) })

    expect(within(property()).getByText('€ 400.000,00 of equity today.')).toBeTruthy()
  })

  it('sends the whole list, because removing a row cannot be expressed as a merge', async () => {
    const stated = withOneProperty()
    const calls = await open({
      ...READS,
      '/api/settings': json(stated),
      '/api/settings/property': json(stated),
    })

    fireEvent.click(within(property()).getByRole('button', { name: 'Remove' }))
    fireEvent.click(saveProperty())

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        { path: '/api/settings/property', method: 'PATCH', body: { properties: [] } },
      ])
    })
  })

  it('shows the mortgage sub-form only once "Add a mortgage" is clicked, and includes it on save', async () => {
    const stated = withOneProperty()
    const calls = await open({
      ...READS,
      '/api/settings': json(stated),
      '/api/settings/property': json(stated),
    })

    expect(screen.queryByLabelText('Outstanding balance')).toBeNull()

    fireEvent.click(within(property()).getByRole('button', { name: 'Add a mortgage' }))
    expect(screen.getByLabelText('Outstanding balance')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Outstanding balance'), { target: { value: '200000' } })
    fireEvent.change(screen.getByLabelText('Balance as of'), { target: { value: '2026-09-01' } })
    fireEvent.change(screen.getByLabelText('Interest rate'), { target: { value: '350' } })
    fireEvent.change(screen.getByLabelText('Months remaining'), { target: { value: '180' } })
    fireEvent.change(screen.getByLabelText('Monthly payment'), { target: { value: '1500' } })
    fireEvent.click(saveProperty())

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/property',
          method: 'PATCH',
          body: {
            properties: [
              {
                id: 'prop-1',
                kind: 'primary',
                label: 'Home',
                propertyValueCents: 40_000_000,
                rentCents: null,
                mortgages: [
                  {
                    principalCents: 20_000_000,
                    anchorDate: '2026-09-01',
                    rateBp: 350,
                    monthlyPaymentCents: 150_000,
                    remainingTermMonths: 180,
                    originalPrincipalCents: null,
                  },
                ],
              },
            ],
          },
        },
      ])
    })
  })

  it('reads the rate back in percent, right beside the box that holds basis points', async () => {
    await open(READS)

    addProperty()
    fireEvent.click(within(property()).getByRole('button', { name: 'Add a mortgage' }))
    fireEvent.change(screen.getByLabelText('Interest rate'), { target: { value: '350' } })

    expect(within(property()).getByText('Reads as 3,5%.')).toBeTruthy()
  })

  it('fills the standard payment without submitting anything', async () => {
    const calls = await open(READS)

    addProperty()
    fireEvent.click(within(property()).getByRole('button', { name: 'Add a mortgage' }))
    fireEvent.change(screen.getByLabelText('Outstanding balance'), { target: { value: '200000' } })
    fireEvent.change(screen.getByLabelText('Interest rate'), { target: { value: '350' } })
    fireEvent.change(screen.getByLabelText('Months remaining'), { target: { value: '180' } })

    fireEvent.click(
      within(property()).getByRole('button', {
        name: 'Use the standard payment for this rate and term',
      }),
    )

    expect((screen.getByLabelText('Monthly payment') as HTMLInputElement).value).not.toBe('')
    expect(writes(calls)).toEqual([])
  })

  it('refuses a mortgage left half-typed rather than sending it', async () => {
    const calls = await open(READS)

    addProperty()
    fireEvent.click(within(property()).getByRole('button', { name: 'Add a mortgage' }))
    fireEvent.change(screen.getByLabelText('Outstanding balance'), { target: { value: '200000' } })
    // Rate, term and payment are left empty — an incomplete mortgage, not a missing one.

    expect(within(property()).getAllByText("Something in this row isn't a valid number yet.").length).toBeGreaterThan(0)
    expect(saveProperty().disabled).toBe(true)
    expect(writes(calls)).toEqual([])
  })

  it('adds a second mortgage independently of the first, and removes either on its own', async () => {
    await open(READS)

    addProperty()
    fireEvent.click(within(property()).getByRole('button', { name: 'Add a mortgage' }))
    fireEvent.change(screen.getByLabelText('Outstanding balance'), { target: { value: '200000' } })

    fireEvent.click(within(property()).getByRole('button', { name: 'Add a mortgage' }))
    const balances = screen.getAllByLabelText('Outstanding balance') as HTMLInputElement[]
    expect(balances).toHaveLength(2)
    expect(balances[0]?.value).toBe('200000')
    expect(balances[1]?.value).toBe('')

    fireEvent.change(balances[1] as HTMLInputElement, { target: { value: '50000' } })
    expect((screen.getAllByLabelText('Outstanding balance')[0] as HTMLInputElement).value).toBe('200000')

    fireEvent.click(within(property()).getAllByRole('button', { name: 'Remove mortgage' })[0] as HTMLElement)
    const remaining = screen.getAllByLabelText('Outstanding balance') as HTMLInputElement[]
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.value).toBe('50000')
  })

  it('stops offering "Add a mortgage" once a property already has three (#393)', async () => {
    await open(READS)

    addProperty()
    const addMortgage = (): HTMLButtonElement =>
      within(property()).getByRole('button', { name: 'Add a mortgage' }) as HTMLButtonElement

    fireEvent.click(addMortgage())
    fireEvent.click(addMortgage())
    fireEvent.click(addMortgage())

    expect(screen.getAllByLabelText('Outstanding balance')).toHaveLength(3)
    expect(addMortgage().disabled).toBe(true)
  })

  it('leaves the list read-only for a viewer', async () => {
    await open({
      ...READS,
      '/api/settings': json({
        ...withOneProperty(),
        profile: { ...PAYLOAD.profile, role: 'viewer' },
      }),
    })

    expect((screen.getByLabelText('Name') as HTMLInputElement).disabled).toBe(true)
    expect(saveProperty().disabled).toBe(true)
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Home')
  })
})

describe('integrations', () => {
  const open = (replies: Replies): Promise<Call[]> => openPage(replies, '/settings/integrations', 'Actual')

  /**
   * All three sub-forms share one class (`integrations-form`), unlike every other
   * panel's unique form name — they are three of the same shape, not three different
   * things — so a query has to reach a form through its own heading rather than
   * through `form()`'s class lookup, which would only ever find the first one.
   */
  const panel = (title: string): HTMLElement => {
    const found = screen.getByRole('heading', { level: 2, name: title }).closest('section')
    if (found === null) throw new Error(`no ${title} panel on the page`)
    return found as HTMLElement
  }

  const saveButton = (title: string): HTMLButtonElement =>
    within(panel(title)).getByRole('button', { name: 'Save' }) as HTMLButtonElement

  const testButton = (title: string): HTMLButtonElement =>
    within(panel(title)).getByRole('button', { name: 'Test connection' }) as HTMLButtonElement

  it('shows what is stored, and which secrets are set without ever showing one', async () => {
    await open(READS)

    expect((screen.getByLabelText('Server URL') as HTMLInputElement).value).toBe('https://actual.example.com')
    expect((screen.getByLabelText('Sync ID') as HTMLInputElement).value).toBe('sync-id')
    expect((screen.getByLabelText(/^Password/) as HTMLInputElement).value).toBe('')
    expect(within(panel('Actual')).getByText('Configured')).toBeTruthy()
    expect(within(panel('Actual')).getByText('Not configured')).toBeTruthy()
  })

  it('has nothing to save until a field is touched', async () => {
    await open(READS)

    expect(saveButton('Actual').disabled).toBe(true)
    expect(saveButton('Ghostfolio').disabled).toBe(true)
    expect(saveButton('AI provider').disabled).toBe(true)
  })

  it('shows certified OpenAI and Anthropic settings separately from best-effort compatible endpoints', async () => {
    await open(READS)

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openai' } })
    const official = screen.getByLabelText('Base URL') as HTMLInputElement
    expect(official.value).toBe('https://api.openai.com/v1')
    expect(official.readOnly).toBe(true)
    expect(screen.queryByLabelText('Google Cloud project')).toBeNull()
    expect((screen.getByLabelText('Analysis model') as HTMLInputElement).value).toBe('gpt-5.4-mini')
    expect(within(panel('AI provider')).getByRole('button', {
      name: 'Test model + structured output (small paid call)',
    })).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openai-compatible' } })
    const custom = screen.getByLabelText('Base URL') as HTMLInputElement
    expect(custom.readOnly).toBe(false)
    expect(within(panel('AI provider')).getByText(/Best-effort compatibility/)).toBeTruthy()
    expect(within(panel('AI provider')).getByText('Prices in EUR per 1M tokens')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'anthropic' } })
    const anthropic = screen.getByLabelText('Base URL') as HTMLInputElement
    expect(anthropic.value).toBe('https://api.anthropic.com/v1')
    expect(anthropic.readOnly).toBe(true)
    expect((screen.getByLabelText('Analysis model') as HTMLInputElement).value).toBe('claude-sonnet-5')
    expect((screen.getByLabelText('Narrative model') as HTMLInputElement).value).toBe('claude-opus-5')
    expect(within(panel('AI provider')).getByText('Prices in EUR per 1M tokens')).toBeTruthy()
    expect(within(panel('AI provider')).getByRole('button', {
      name: 'Test model + structured output (small paid call)',
    })).toBeTruthy()
  })

  it('tests Anthropic with the native preset candidate shown on screen', async () => {
    const calls = await open({
      ...READS,
      '/api/settings/integrations/ai/test': json({ ok: true, message: null }),
    })

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'anthropic' } })
    fireEvent.change(screen.getByLabelText(/^API key/), { target: { value: 'candidate-claude-key' } })
    fireEvent.click(within(panel('AI provider')).getByRole('button', {
      name: 'Test model + structured output (small paid call)',
    }))

    await screen.findByText('Connected successfully.')
    expect(writes(calls)).toEqual([
      {
        path: '/api/settings/integrations/ai/test',
        method: 'POST',
        body: {
          provider: 'anthropic',
          apiKey: 'candidate-claude-key',
          baseUrl: null,
          model: 'claude-sonnet-5',
        },
      },
    ])
  })

  it('saves only what changed, and sends no password at all rather than a blank one', async () => {
    const calls = await open({ ...READS, '/api/settings/integrations/actual': json(PAYLOAD) })

    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://actual2.example.com' } })
    fireEvent.click(saveButton('Actual'))

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/integrations/actual',
          method: 'PATCH',
          body: { serverUrl: 'https://actual2.example.com', syncId: 'sync-id', categorySourceLocale: 'en' },
        },
      ])
    })
  })

  it('sends a typed password, since typing it is the one thing that means "replace"', async () => {
    const calls = await open({ ...READS, '/api/settings/integrations/actual': json(PAYLOAD) })

    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'new-pw' } })
    fireEvent.click(saveButton('Actual'))

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/integrations/actual',
          method: 'PATCH',
          body: {
            serverUrl: 'https://actual.example.com',
            syncId: 'sync-id',
            password: 'new-pw',
            categorySourceLocale: 'en',
          },
        },
      ])
    })
  })

  it('can test immediately against a stored password, without retyping it (#382)', async () => {
    await open(READS)

    expect(testButton('Actual').disabled).toBe(false)
  })

  it('will not test a connection with no password typed and none stored, and says why (#382)', async () => {
    await open({
      ...READS,
      '/api/settings': json({
        ...PAYLOAD,
        integrations: {
          ...PAYLOAD.integrations,
          actual: { ...PAYLOAD.integrations.actual, passwordConfigured: false },
        },
      }),
    })

    expect(testButton('Actual').disabled).toBe(true)
    expect(within(panel('Actual')).getByText('Retype the value to test, or save one first.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'secret' } })
    expect(testButton('Actual').disabled).toBe(false)
  })

  it('tests against the stored password when the field is left blank (#382)', async () => {
    const calls = await open({
      ...READS,
      '/api/settings/integrations/actual/test': json({ ok: true, message: null }),
    })

    fireEvent.click(testButton('Actual'))

    await screen.findByText('Connected successfully.')
    expect(writes(calls)).toEqual([
      {
        path: '/api/settings/integrations/actual/test',
        method: 'POST',
        body: { serverUrl: 'https://actual.example.com', syncId: 'sync-id' },
      },
    ])
  })

  it('tests the candidate on screen, not the stored value, and reports the result inline', async () => {
    const calls = await open({
      ...READS,
      '/api/settings/integrations/actual/test': json({ ok: true, message: null }),
    })

    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'secret' } })
    fireEvent.click(testButton('Actual'))

    await screen.findByText('Connected successfully.')
    expect(writes(calls)).toEqual([
      {
        path: '/api/settings/integrations/actual/test',
        method: 'POST',
        body: { serverUrl: 'https://actual.example.com', syncId: 'sync-id', password: 'secret' },
      },
    ])
  })

  it('reports why a test failed rather than throwing the message away', async () => {
    await open({
      ...READS,
      '/api/settings/integrations/actual/test': json({ ok: false, message: 'Wrong password.' }),
    })

    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'wrong' } })
    fireEvent.click(testButton('Actual'))

    await screen.findByText('Wrong password.')
  })

  it('saves Ghostfolio independently of Actual', async () => {
    const calls = await open({ ...READS, '/api/settings/integrations/ghostfolio': json(PAYLOAD) })

    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://gf2.example.com' } })
    fireEvent.click(saveButton('Ghostfolio'))

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        { path: '/api/settings/integrations/ghostfolio', method: 'PATCH', body: { url: 'https://gf2.example.com' } },
      ])
    })
  })

  it('sends null rather than an empty string once the Google Cloud project is cleared', async () => {
    const calls = await open({ ...READS, '/api/settings/integrations/ai': json(PAYLOAD) })

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'gemini-vertex' } })
    fireEvent.click(saveButton('AI provider'))

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/integrations/ai',
          method: 'PATCH',
          body: {
            provider: 'gemini-vertex',
            googleCloudProject: null,
            baseUrl: null,
            modelFast: 'gemini-3.7-flash',
            modelDeep: 'gemini-3.1-pro-preview',
            modelPrices: {},
            budgetEur: 15,
          },
        },
      ])
    })
  })

  it('leaves every field read-only for a viewer', async () => {
    await open({
      ...READS,
      '/api/settings': json({ ...PAYLOAD, profile: { ...PAYLOAD.profile, role: 'viewer' } }),
    })

    expect(screen.getAllByText('Only the owner can change this.').length).toBeGreaterThan(0)
    expect((screen.getByLabelText('Server URL') as HTMLInputElement).disabled).toBe(true)
    expect(saveButton('Actual').disabled).toBe(true)
    expect(testButton('Actual').disabled).toBe(true)
  })
})

/** Four invites, one per status `statusOf` computes from timestamps alone. */
const INVITES: Payload['invites'] = [
  {
    id: 'inv-pending',
    label: 'For Jo',
    createdAt: '2026-09-01T09:00:00.000Z',
    expiresAt: '2030-01-01T00:00:00.000Z',
    redeemedAt: null,
    revokedAt: null,
  },
  {
    id: 'inv-redeemed',
    label: null,
    createdAt: '2026-08-20T09:00:00.000Z',
    expiresAt: '2030-01-01T00:00:00.000Z',
    redeemedAt: '2026-08-21T09:00:00.000Z',
    revokedAt: null,
  },
  {
    id: 'inv-revoked',
    label: 'Old',
    createdAt: '2026-08-01T09:00:00.000Z',
    expiresAt: '2030-01-01T00:00:00.000Z',
    redeemedAt: null,
    revokedAt: '2026-08-02T09:00:00.000Z',
  },
  {
    id: 'inv-expired',
    label: 'Stale',
    createdAt: '2020-01-01T09:00:00.000Z',
    expiresAt: '2020-02-01T00:00:00.000Z',
    redeemedAt: null,
    revokedAt: null,
  },
]

describe('loans (#441)', () => {
  const open = (replies: Replies): Promise<Call[]> => openPage(replies, '/settings/loans')

  const loans = (): HTMLElement => form('loans-form')

  const addLoan = (): void => {
    fireEvent.click(within(loans()).getByRole('button', { name: 'Add a loan' }))
  }

  const saveNew = (): HTMLButtonElement =>
    within(loans()).getByRole('button', { name: 'Add this loan' }) as HTMLButtonElement

  const saveExisting = (): HTMLButtonElement =>
    within(loans()).getByRole('button', { name: 'Save this loan' }) as HTMLButtonElement

  const removeLoan = (): void => {
    fireEvent.click(within(loans()).getByRole('button', { name: 'Remove this loan' }))
  }

  /**
   * One box's value, with the currency separator normalised.
   *
   * Belgian money separates the symbol with a NO-BREAK SPACE (U+00A0) or a NARROW one
   * (U+202F), so a comparison against a typed literal fails on two strings that are
   * visually identical — the same trap `test/helpers/text.ts` exists for on the server
   * side. `getByText` normalises whitespace itself; an `input.value` comparison does not.
   */
  const boxValue = (label: string): string =>
    (screen.getByLabelText(label) as HTMLInputElement).value.replace(/[\u202f\u00a0]/g, ' ')

  /**
   * A stored loan, as `/api/settings` sends it.
   *
   * No interest and no payment, so the balance read-back is exactly `principalCents`
   * whatever day the suite runs on — the panel prices every row against the real clock,
   * and a fixture that let it amortize would drift with the calendar (the same reason
   * `server-api.test.ts`'s property fixtures are built this way). The payoff cases below
   * give it a payment of their own: a payoff date is measured from the anchor, so it is
   * clock-independent regardless.
   */
  const STORED: Payload['loans'][number] = {
    id: 'loan-1',
    kind: 'car',
    label: 'Car',
    openingDate: '2026-01-01',
    principalCents: 1_500_000,
    anchorDate: '2026-01-01',
    rateBp: 0,
    monthlyPaymentCents: 0,
    remainingTermMonths: 60,
    originalPrincipalCents: 3_000_000,
    extraMonthlyPaymentCents: null,
  }

  const withOneLoan = (extra: Partial<Payload['loans'][number]> = {}): Payload => ({
    ...PAYLOAD,
    loans: [{ ...STORED, ...extra }],
  })

  /** Fills every required box of the row just added. */
  const fillNewRow = (): void => {
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Car' } })
    fireEvent.change(screen.getByLabelText('Taken out on'), { target: { value: '2026-01-01' } })
    fireEvent.change(screen.getByLabelText('Outstanding balance'), { target: { value: '15000' } })
    fireEvent.change(screen.getByLabelText('Balance as of'), { target: { value: '2026-01-01' } })
    fireEvent.change(screen.getByLabelText('Interest rate'), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText('Months remaining'), { target: { value: '60' } })
    fireEvent.change(screen.getByLabelText('Monthly payment'), { target: { value: '1000' } })
  }

  it('shows the empty state when nothing is stored yet', async () => {
    await open(READS)

    expect(
      within(loans()).getByText(
        'No loans yet. Add a car loan or a personal loan to see it in net worth.',
      ),
    ).toBeTruthy()
    expect(within(loans()).queryByRole('button', { name: 'Save this loan' })).toBeNull()
  })

  it('offers the two fixed-schedule kinds, and no mortgage among them', async () => {
    await open(READS)

    addLoan()
    const typeSelect = screen.getByLabelText('Type') as HTMLSelectElement
    expect(Array.from(typeSelect.options, (option) => option.value)).toEqual(['car', 'personal'])
  })

  it('POSTs a new row, with no id of its own — the server assigns that', async () => {
    const calls = await open({ ...READS, '/api/settings/loans': json(withOneLoan()) })

    addLoan()
    fillNewRow()
    fireEvent.click(saveNew())

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/loans',
          method: 'POST',
          body: {
            kind: 'car',
            label: 'Car',
            openingDate: '2026-01-01',
            principalCents: 1_500_000,
            anchorDate: '2026-01-01',
            rateBp: 0,
            monthlyPaymentCents: 100_000,
            remainingTermMonths: 60,
            originalPrincipalCents: null,
            extraMonthlyPaymentCents: null,
          },
        },
      ])
    })
  })

  it('has nothing to save until a stored row is actually changed', async () => {
    await open({ ...READS, '/api/settings': json(withOneLoan()) })

    expect(saveExisting().disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Outstanding balance'), { target: { value: '7000' } })
    expect(saveExisting().disabled).toBe(false)
  })

  it('PATCHes the one loan it edited, at its own URL', async () => {
    const stored = withOneLoan()
    const calls = await open({
      ...READS,
      '/api/settings': json(stored),
      '/api/settings/loans/loan-1': json(stored),
    })

    fireEvent.change(screen.getByLabelText('Outstanding balance'), { target: { value: '7000' } })
    fireEvent.change(screen.getByLabelText('Balance as of'), { target: { value: '2026-09-01' } })
    fireEvent.click(saveExisting())

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/loans/loan-1',
          method: 'PATCH',
          body: {
            kind: 'car',
            label: 'Car',
            openingDate: '2026-01-01',
            principalCents: 700_000,
            anchorDate: '2026-09-01',
            rateBp: 0,
            monthlyPaymentCents: 0,
            remainingTermMonths: 60,
            originalPrincipalCents: 3_000_000,
            extraMonthlyPaymentCents: null,
          },
        },
      ])
    })
  })

  it('DELETEs a stored row rather than patching a list without it', async () => {
    const stored = withOneLoan()
    const calls = await open({
      ...READS,
      '/api/settings': json(stored),
      '/api/settings/loans/loan-1': json({ ...PAYLOAD, loans: [] }),
    })

    removeLoan()

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        { path: '/api/settings/loans/loan-1', method: 'DELETE', body: undefined },
      ])
    })
  })

  it('drops an unsaved row locally, with no request at all', async () => {
    const calls = await open(READS)

    addLoan()
    removeLoan()

    expect(writes(calls)).toEqual([])
    expect(
      within(loans()).getByText(
        'No loans yet. Add a car loan or a personal loan to see it in net worth.',
      ),
    ).toBeTruthy()
  })

  it('reads back the balance and the paid-off share the row implies', async () => {
    await open({ ...READS, '/api/settings': json(withOneLoan()) })

    // 15 000,00 owed of an original 30 000,00: half of it paid off already.
    expect(within(loans()).getByText('€ 15.000,00 still owed today.')).toBeTruthy()
    expect(within(loans()).getByText('50% of the original loan paid off.')).toBeTruthy()
  })

  it('reads back the payoff date the schedule implies, measured from the anchor', async () => {
    await open({ ...READS, '/api/settings': json(withOneLoan({ monthlyPaymentCents: 100_000 })) })

    // 15 000,00 at 1 000,00 a month with no interest: fifteen months from 01/01/2026.
    expect(within(loans()).getByText('Paid off around 01/04/2027 at this rate.')).toBeTruthy()
  })

  it('brings the payoff read-back forward when an extra payment is typed in', async () => {
    await open({ ...READS, '/api/settings': json(withOneLoan({ monthlyPaymentCents: 100_000 })) })

    fireEvent.change(screen.getByLabelText('Extra each month'), { target: { value: '2000' } })

    // 3 000,00 a month rather than 1 000,00: five months instead of fifteen.
    expect(within(loans()).getByText('Paid off around 01/06/2026 at this rate.')).toBeTruthy()
  })

  it('says so rather than inventing a date when the payment never clears the loan', async () => {
    await open({ ...READS, '/api/settings': json(withOneLoan()) })

    expect(
      within(loans()).getByText('This payment never clears the balance within the term.'),
    ).toBeTruthy()
  })

  it('refuses to send a row whose numbers do not parse yet', async () => {
    await open({ ...READS, '/api/settings': json(withOneLoan()) })

    // Belgian grouping in a basis-points box, the case `Property.tsx` refuses locally too.
    fireEvent.change(screen.getByLabelText('Interest rate'), { target: { value: '3.50' } })

    expect(saveExisting().disabled).toBe(true)
    // Twice over: the caption under the rate box, and the row's own read-back line.
    expect(
      within(loans()).getAllByText("Something in this row isn't a valid number yet."),
    ).toHaveLength(2)
  })

  it('offers the standard payment for the rate and term entered', async () => {
    await open({ ...READS, '/api/settings': json(withOneLoan()) })

    fireEvent.change(screen.getByLabelText('Months remaining'), { target: { value: '15' } })
    fireEvent.click(
      within(loans()).getByRole('button', {
        name: 'Use the standard payment for this rate and term',
      }),
    )

    // 15 000,00 over fifteen months at no interest.
    expect(boxValue('Monthly payment')).toBe('€ 1.000,00')
  })

  it('leaves every control read-only for a viewer, and still readable', async () => {
    await open({
      ...READS,
      '/api/settings': json({
        ...withOneLoan(),
        profile: { ...PAYLOAD.profile, role: 'viewer' },
      }),
    })

    expect((screen.getByLabelText('Outstanding balance') as HTMLInputElement).disabled).toBe(true)
    expect(saveExisting().disabled).toBe(true)
    expect(boxValue('Outstanding balance')).toBe('€ 15.000,00')
  })
})

describe('debts (#442)', () => {
  const open = (replies: Replies): Promise<Call[]> => openPage(replies, '/settings/debts')

  const debts = (): HTMLElement => form('debts-form')

  const addDebt = (): void => {
    fireEvent.click(within(debts()).getByRole('button', { name: 'Add a card' }))
  }

  const saveNew = (): HTMLButtonElement =>
    within(debts()).getByRole('button', { name: 'Add this card' }) as HTMLButtonElement

  const saveExisting = (): HTMLButtonElement =>
    within(debts()).getByRole('button', { name: 'Save this card' }) as HTMLButtonElement

  const removeDebt = (): void => {
    fireEvent.click(within(debts()).getByRole('button', { name: 'Remove this card' }))
  }

  /** One box's value, with the currency separator normalised — see the loans block above. */
  const boxValue = (label: string): string =>
    (screen.getByLabelText(label) as HTMLInputElement).value.replace(/[  ]/g, ' ')

  /** A stored card, as `/api/settings` sends it. */
  const STORED: Payload['debts'][number] = {
    id: 'debt-1',
    kind: 'creditCard',
    label: 'Card',
    balanceCents: 200_000,
    minimumPaymentCents: 10_000,
    aprBp: 1_800,
  }

  const withOneDebt = (extra: Partial<Payload['debts'][number]> = {}): Payload => ({
    ...PAYLOAD,
    debts: [{ ...STORED, ...extra }],
  })

  /** Fills every required box of the row just added. */
  const fillNewRow = (): void => {
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Card' } })
    fireEvent.change(screen.getByLabelText('Outstanding balance'), { target: { value: '2000' } })
    fireEvent.change(screen.getByLabelText('Minimum payment'), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText('Interest rate (APR)'), { target: { value: '1800' } })
  }

  it('shows the empty state when nothing is stored yet', async () => {
    await open(READS)

    expect(
      within(debts()).getByText('No credit cards yet. Add one to see its balance subtracted from net worth.'),
    ).toBeTruthy()
    expect(within(debts()).queryByRole('button', { name: 'Save this card' })).toBeNull()
  })

  it('offers both kinds', async () => {
    await open(READS)

    addDebt()
    const typeSelect = screen.getByLabelText('Type') as HTMLSelectElement
    expect(Array.from(typeSelect.options, (option) => option.value)).toEqual(['creditCard', 'other'])
  })

  it('POSTs a new row, with no id of its own — the server assigns that', async () => {
    const calls = await open({ ...READS, '/api/settings/debts': json(withOneDebt()) })

    addDebt()
    fillNewRow()
    fireEvent.click(saveNew())

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/debts',
          method: 'POST',
          body: {
            kind: 'creditCard',
            label: 'Card',
            balanceCents: 200_000,
            minimumPaymentCents: 10_000,
            aprBp: 1_800,
          },
        },
      ])
    })
  })

  it('has nothing to save until a stored row is actually changed', async () => {
    await open({ ...READS, '/api/settings': json(withOneDebt()) })

    expect(saveExisting().disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Outstanding balance'), { target: { value: '1500' } })
    expect(saveExisting().disabled).toBe(false)
  })

  it('PATCHes the one debt it edited, at its own URL', async () => {
    const stored = withOneDebt()
    const calls = await open({
      ...READS,
      '/api/settings': json(stored),
      '/api/settings/debts/debt-1': json(stored),
    })

    fireEvent.change(screen.getByLabelText('Outstanding balance'), { target: { value: '1500' } })
    fireEvent.click(saveExisting())

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/debts/debt-1',
          method: 'PATCH',
          body: {
            kind: 'creditCard',
            label: 'Card',
            balanceCents: 150_000,
            minimumPaymentCents: 10_000,
            aprBp: 1_800,
          },
        },
      ])
    })
  })

  it('DELETEs a stored row rather than patching a list without it', async () => {
    const stored = withOneDebt()
    const calls = await open({
      ...READS,
      '/api/settings': json(stored),
      '/api/settings/debts/debt-1': json({ ...PAYLOAD, debts: [] }),
    })

    removeDebt()

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        { path: '/api/settings/debts/debt-1', method: 'DELETE', body: undefined },
      ])
    })
  })

  it('drops an unsaved row locally, with no request at all', async () => {
    const calls = await open(READS)

    addDebt()
    removeDebt()

    expect(writes(calls)).toEqual([])
    expect(
      within(debts()).getByText('No credit cards yet. Add one to see its balance subtracted from net worth.'),
    ).toBeTruthy()
  })

  it('reads back an estimated month of interest at the rate entered', async () => {
    await open({ ...READS, '/api/settings': json(withOneDebt()) })

    // 2 000,00 at 18% APR: 2 000,00 * 0.18 / 12 = 30,00.
    expect(within(debts()).getByText('€ 30,00 estimated interest next month at this rate.')).toBeTruthy()
  })

  it('says no rate was entered rather than estimating zero interest', async () => {
    await open({ ...READS, '/api/settings': json(withOneDebt({ aprBp: null })) })

    expect(within(debts()).getByText('No rate entered, so no interest estimate.')).toBeTruthy()
  })

  it('refuses to send a row whose numbers do not parse yet', async () => {
    await open({ ...READS, '/api/settings': json(withOneDebt()) })

    fireEvent.change(screen.getByLabelText('Interest rate (APR)'), { target: { value: '3.50' } })

    expect(saveExisting().disabled).toBe(true)
    // Twice over: the caption under the rate box, and the row's own read-back line.
    expect(
      within(debts()).getAllByText("Something in this row isn't a valid number yet."),
    ).toHaveLength(2)
  })

  it('leaves every control read-only for a viewer, and still readable', async () => {
    await open({
      ...READS,
      '/api/settings': json({
        ...withOneDebt(),
        profile: { ...PAYLOAD.profile, role: 'viewer' },
      }),
    })

    expect((screen.getByLabelText('Outstanding balance') as HTMLInputElement).disabled).toBe(true)
    expect(saveExisting().disabled).toBe(true)
    expect(boxValue('Outstanding balance')).toBe('€ 2.000,00')
  })
})

describe('goals (#407)', () => {
  const open = (replies: Replies): Promise<Call[]> => openPage(replies, '/settings/goals')

  const goals = (): HTMLElement => form('goals-form')

  const addGoal = (): void => {
    fireEvent.click(within(goals()).getByRole('button', { name: 'Add a goal' }))
  }

  const saveNew = (): HTMLButtonElement =>
    within(goals()).getByRole('button', { name: 'Add this goal' }) as HTMLButtonElement

  const saveExisting = (): HTMLButtonElement =>
    within(goals()).getByRole('button', { name: 'Save this goal' }) as HTMLButtonElement

  const removeGoal = (): void => {
    fireEvent.click(within(goals()).getByRole('button', { name: 'Remove this goal' }))
  }

  const boxValue = (label: string): string =>
    (screen.getByLabelText(label) as HTMLInputElement).value.replace(/[  ]/g, ' ')

  /** A stored goal, as `/api/settings` sends it. */
  const STORED: Payload['goals'][number] = {
    id: 'goal-1',
    kind: 'liquid',
    categoryId: null,
    priority: 'normal',
    label: 'Emergency fund',
    targetCents: 500_000,
    targetDate: '2027-06-01',
    status: 'active',
    doneAt: null,
  }

  const withOneGoal = (extra: Partial<Payload['goals'][number]> = {}): Payload => ({
    ...PAYLOAD,
    goals: [{ ...STORED, ...extra }],
  })

  /** Fills every required box of the row just added. */
  const fillNewRow = (): void => {
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Emergency fund' } })
    fireEvent.change(screen.getByLabelText('Target amount'), { target: { value: '5000' } })
  }

  it('shows the empty state when nothing is stored yet', async () => {
    await open(READS)

    expect(
      within(goals()).getByText(
        'No savings goals yet. Add one to track progress toward it on the overview page.',
      ),
    ).toBeTruthy()
    expect(within(goals()).queryByRole('button', { name: 'Save this goal' })).toBeNull()
  })

  it('offers every kind and priority', async () => {
    await open(READS)

    addGoal()
    const kindSelect = screen.getByLabelText('Measured against') as HTMLSelectElement
    expect(Array.from(kindSelect.options, (option) => option.value)).toEqual([
      'liquid',
      'invested',
      'total',
      'category',
    ])
    const prioritySelect = screen.getByLabelText('Priority') as HTMLSelectElement
    expect(Array.from(prioritySelect.options, (option) => option.value)).toEqual([
      'high',
      'normal',
      'low',
    ])
  })

  it('POSTs a new row, with no id of its own — the server assigns that', async () => {
    const calls = await open({ ...READS, '/api/settings/goals': json(withOneGoal({ targetDate: null })) })

    addGoal()
    fillNewRow()
    fireEvent.click(saveNew())

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/goals',
          method: 'POST',
          body: {
            kind: 'liquid',
            categoryId: null,
            priority: 'normal',
            label: 'Emergency fund',
            targetCents: 500_000,
            targetDate: null,
          },
        },
      ])
    })
  })

  it('has nothing to save until a stored row is actually changed', async () => {
    await open({ ...READS, '/api/settings': json(withOneGoal()) })

    expect(saveExisting().disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Target amount'), { target: { value: '6000' } })
    expect(saveExisting().disabled).toBe(false)
  })

  it('PATCHes the one goal it edited, at its own URL', async () => {
    const stored = withOneGoal()
    const calls = await open({
      ...READS,
      '/api/settings': json(stored),
      '/api/settings/goals/goal-1': json(stored),
    })

    fireEvent.change(screen.getByLabelText('Target amount'), { target: { value: '6000' } })
    fireEvent.click(saveExisting())

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/goals/goal-1',
          method: 'PATCH',
          body: {
            kind: 'liquid',
            categoryId: null,
            priority: 'normal',
            label: 'Emergency fund',
            targetCents: 600_000,
            targetDate: '2027-06-01',
          },
        },
      ])
    })
  })

  it('DELETEs a stored row rather than patching a list without it', async () => {
    const stored = withOneGoal()
    const calls = await open({
      ...READS,
      '/api/settings': json(stored),
      '/api/settings/goals/goal-1': json({ ...PAYLOAD, goals: [] }),
    })

    removeGoal()

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        { path: '/api/settings/goals/goal-1', method: 'DELETE', body: undefined },
      ])
    })
  })

  it('drops an unsaved row locally, with no request at all', async () => {
    const calls = await open(READS)

    addGoal()
    removeGoal()

    expect(writes(calls)).toEqual([])
    expect(
      within(goals()).getByText(
        'No savings goals yet. Add one to track progress toward it on the overview page.',
      ),
    ).toBeTruthy()
  })

  it('refuses to send a row whose target amount does not parse yet', async () => {
    await open({ ...READS, '/api/settings': json(withOneGoal()) })

    fireEvent.change(screen.getByLabelText('Target amount'), { target: { value: 'not a number' } })

    expect(saveExisting().disabled).toBe(true)
    expect(within(goals()).getByText("Something in this row isn't valid yet.")).toBeTruthy()
  })

  it('leaves every control read-only for a viewer, and still readable', async () => {
    await open({
      ...READS,
      '/api/settings': json({
        ...withOneGoal(),
        profile: { ...PAYLOAD.profile, role: 'viewer' },
      }),
    })

    expect((screen.getByLabelText('Target amount') as HTMLInputElement).disabled).toBe(true)
    expect(saveExisting().disabled).toBe(true)
    expect(boxValue('Target amount')).toBe(eur('5.000,00'))
  })
})

describe('members', () => {
  const open = (replies: Replies): Promise<Call[]> => openPage(replies, '/settings/members', 'Members')

  const row = (label: string): HTMLElement => {
    const found = screen.getByText(label).closest('li')
    if (found === null) throw new Error(`no invite row for ${label}`)
    return found as HTMLElement
  }

  it("shows each invite's status, computed from its own timestamps", async () => {
    await open({ ...READS, '/api/settings': json({ ...PAYLOAD, invites: INVITES }) })

    expect(within(row('For Jo')).getByText('Pending')).toBeTruthy()
    expect(within(row('Unlabeled')).getByText('Redeemed')).toBeTruthy()
    expect(within(row('Old')).getByText('Revoked')).toBeTruthy()
    expect(within(row('Stale')).getByText('Expired')).toBeTruthy()
  })

  it('disables revoke once an invite is no longer pending, but not while it still is', async () => {
    await open({ ...READS, '/api/settings': json({ ...PAYLOAD, invites: INVITES }) })

    expect((within(row('For Jo')).getByRole('button', { name: 'Revoke' }) as HTMLButtonElement).disabled).toBe(false)
    expect((within(row('Unlabeled')).getByRole('button', { name: 'Revoke' }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(row('Old')).getByRole('button', { name: 'Revoke' }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(row('Stale')).getByRole('button', { name: 'Revoke' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('creates an invite, shows the code exactly once, and lists the new invite without a refetch', async () => {
    const calls = await open({
      ...READS,
      '/api/settings/invites': json({
        invite: {
          id: 'inv-new',
          label: 'For Jo',
          createdAt: '2026-09-10T09:00:00.000Z',
          expiresAt: '2030-01-01T00:00:00.000Z',
          redeemedAt: null,
          revokedAt: null,
        },
        code: 'A1B2-C3D4-E5F6-A7B8',
      }),
    })

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'For Jo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }))

    await screen.findByText('A1B2-C3D4-E5F6-A7B8')
    expect(within(row('For Jo')).getByText('Pending')).toBeTruthy()
    expect(writes(calls)).toEqual([
      { path: '/api/settings/invites', method: 'POST', body: { label: 'For Jo' } },
    ])
    // The narrow response, not the whole payload — no second GET of /api/settings.
    expect(calls.filter((call) => call.path === '/api/settings')).toHaveLength(1)
  })

  it('omits the label entirely rather than sending a blank one', async () => {
    const calls = await open({
      ...READS,
      '/api/settings/invites': json({
        invite: {
          id: 'inv-new',
          label: null,
          createdAt: '2026-09-10T09:00:00.000Z',
          expiresAt: '2030-01-01T00:00:00.000Z',
          redeemedAt: null,
          revokedAt: null,
        },
        code: 'A1B2-C3D4-E5F6-A7B8',
      }),
    })

    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }))

    await screen.findByText('A1B2-C3D4-E5F6-A7B8')
    expect(writes(calls)).toEqual([{ path: '/api/settings/invites', method: 'POST', body: {} }])
  })

  it('revokes through the whole payload, like every other action route on this page', async () => {
    const calls = await open({
      ...READS,
      '/api/settings': json({ ...PAYLOAD, invites: INVITES }),
      '/api/settings/invites/inv-pending/revoke': json({
        ...PAYLOAD,
        invites: [{ ...INVITES[0], revokedAt: '2026-09-11T09:00:00.000Z' }, ...INVITES.slice(1)],
      }),
    })

    fireEvent.click(within(row('For Jo')).getByRole('button', { name: 'Revoke' }))

    await waitFor(() => {
      expect((within(row('For Jo')).getByRole('button', { name: 'Revoke' }) as HTMLButtonElement).disabled).toBe(true)
    })
    expect(writes(calls)).toEqual([
      { path: '/api/settings/invites/inv-pending/revoke', method: 'POST', body: undefined },
    ])
  })

  it('leaves every control disabled for a viewer', async () => {
    await open({
      ...READS,
      '/api/settings': json({
        ...PAYLOAD,
        invites: INVITES,
        profile: { ...PAYLOAD.profile, role: 'viewer' },
      }),
    })

    expect(screen.getByText('Only the owner can change this.')).toBeTruthy()
    expect((screen.getByLabelText('Label') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Create invite' }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(row('For Jo')).getByRole('button', { name: 'Revoke' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('the category table', () => {
  /** The mapping moved to Benchmark's own subsection tab (#262), apart from Household. */
  const open = (replies: Replies): Promise<Call[]> =>
    openPage(replies, '/settings/benchmark/mapping', 'Categories')

  const picker = (name: string): HTMLSelectElement =>
    screen.getByLabelText(`COICOP division for ${name}`) as HTMLSelectElement

  const shared = (name: string): HTMLInputElement =>
    screen.getByLabelText(`Shared with a co-parent: ${name}`) as HTMLInputElement

  const nature = (name: string): HTMLSelectElement =>
    screen.getByLabelText(`Savings or investments envelope for ${name}`) as HTMLSelectElement

  const visibility = (name: string): HTMLSelectElement =>
    screen.getByLabelText(`What the AI may see of ${name}`) as HTMLSelectElement

  /** The payload with one envelope already flagged, for the checked state (#44). */
  const withFlagged = (categoryId: string): Payload => ({
    ...PAYLOAD,
    benchmark: {
      ...BENCHMARK,
      categories: BENCHMARK.categories.map((category) =>
        category.categoryId === categoryId ? { ...category, custodyShared: true } : category,
      ),
    },
  })

  /** The payload with one envelope already tagged, for the selected state (#252). */
  const withNature = (categoryId: string, value: 'savings' | 'investments'): Payload => ({
    ...PAYLOAD,
    benchmark: {
      ...BENCHMARK,
      categories: BENCHMARK.categories.map((category) =>
        category.categoryId === categoryId ? { ...category, nature: value } : category,
      ),
    },
  })

  it('shows a deeper stored code as the division it counts as', async () => {
    await open(READS)

    // `04.5.1` is what is stored and `04` is what the comparison reads. A picker that
    // could not match the value would fall back to its first option and say "Not
    // mapped" about a category that is being counted under housing.
    expect(picker('Rent').value).toBe('04')
    expect(screen.getByText('Housing, water and energy')).toBeTruthy()
  })

  it('says which reference line a division feeds, and that `00` feeds none', async () => {
    await open(READS)

    expect(picker('Bank charges').value).toBe('00')
    expect(screen.getByText('Not compared')).toBeTruthy()
  })

  it('counts only what a comparison would call unmapped', async () => {
    await open(READS)

    // Five categories, but income and hidden ones are not compared and two are mapped:
    // only `Coffee` is missing a division, and a count that included `Salary` would send
    // somebody looking for a mapping that changes nothing.
    expect(screen.getByText('1 of 5 categories has no division yet.')).toBeTruthy()
  })

  it('writes one division as soon as it is picked', async () => {
    const calls = await open({
      ...READS,
      '/api/settings/categories/cat-coffee/coicop': json(PAYLOAD),
    })

    fireEvent.change(picker('Coffee'), { target: { value: '01' } })

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/categories/cat-coffee/coicop',
          method: 'PATCH',
          body: { coicop: '01' },
        },
      ])
    })
  })

  it('sends null to take a wrong mapping back', async () => {
    const calls = await open({
      ...READS,
      '/api/settings/categories/cat-rent/coicop': json(PAYLOAD),
    })

    fireEvent.change(picker('Rent'), { target: { value: '' } })

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/categories/cat-rent/coicop',
          method: 'PATCH',
          body: { coicop: null },
        },
      ])
    })
  })

  it('offers the twelve divisions plus the one code that means "not consumption"', async () => {
    await open(READS)

    const options = Array.from(picker('Coffee').options, (option) => option.value)
    expect(options).toEqual([
      '',
      '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12',
      '00',
    ])
  })

  it('flags a category as shared the moment the box is ticked (#44)', async () => {
    // The whole reason this control exists: `custody_shared` was settable only by
    // approving a proposal or answering a clarification, both of which need a key, so a
    // deployment with no AI configured could not switch the split on at all.
    const calls = await open({
      ...READS,
      '/api/settings/categories/cat-coffee/custody-shared': json(PAYLOAD),
    })

    expect(shared('Coffee').checked).toBe(false)
    fireEvent.click(shared('Coffee'))

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/categories/cat-coffee/custody-shared',
          method: 'PATCH',
          body: { custodyShared: true },
        },
      ])
    })
  })

  it('sends false to take the flag back off a category', async () => {
    const calls = await open({
      ...READS,
      '/api/settings': json(withFlagged('cat-rent')),
      '/api/settings/categories/cat-rent/custody-shared': json(PAYLOAD),
    })

    expect(shared('Rent').checked).toBe(true)
    fireEvent.click(shared('Rent'))

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/categories/cat-rent/custody-shared',
          method: 'PATCH',
          body: { custodyShared: false },
        },
      ])
    })
  })

  it('closes the box for income and hidden categories, which the split skips', async () => {
    await open(READS)

    expect(shared('Coffee').disabled).toBe(false)
    expect(shared('Salary').disabled).toBe(true)
    expect(shared('Old subscription').disabled).toBe(true)
  })

  it('tags a category as savings the moment it is picked (#252)', async () => {
    const calls = await open({
      ...READS,
      '/api/settings/categories/cat-coffee/nature': json(PAYLOAD),
    })

    expect(nature('Coffee').value).toBe('')
    fireEvent.change(nature('Coffee'), { target: { value: 'savings' } })

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/categories/cat-coffee/nature',
          method: 'PATCH',
          body: { nature: 'savings' },
        },
      ])
    })
  })

  it('sends null to take a wrong tag back', async () => {
    const calls = await open({
      ...READS,
      '/api/settings': json(withNature('cat-rent', 'investments')),
      '/api/settings/categories/cat-rent/nature': json(PAYLOAD),
    })

    expect(nature('Rent').value).toBe('investments')
    fireEvent.change(nature('Rent'), { target: { value: '' } })

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/categories/cat-rent/nature',
          method: 'PATCH',
          body: { nature: null },
        },
      ])
    })
  })

  it('offers only the two tags plus "neither"', async () => {
    await open(READS)

    const options = Array.from(nature('Coffee').options, (option) => option.value)
    expect(options).toEqual(['', 'savings', 'investments'])
  })

  it('closes the tag for income and hidden categories, same as the shared box', async () => {
    await open(READS)

    expect(nature('Coffee').disabled).toBe(false)
    expect(nature('Salary').disabled).toBe(true)
    expect(nature('Old subscription').disabled).toBe(true)
  })

  it('withholds an envelope from the AI the moment it is picked (#278)', async () => {
    const calls = await open({
      ...READS,
      '/api/settings/categories/cat-coffee/ai-visibility': json(PAYLOAD),
    })

    expect(visibility('Coffee').value).toBe('shown')
    fireEvent.change(visibility('Coffee'), { target: { value: 'absent' } })

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/categories/cat-coffee/ai-visibility',
          method: 'PATCH',
          body: { aiVisibility: 'absent' },
        },
      ])
    })
  })

  it('shows the stored state, including on a row that is already withheld', async () => {
    await open(READS)
    expect(visibility('Old subscription').value).toBe('absent')
  })

  it('offers the three states in order of what they give away', async () => {
    await open(READS)

    const options = Array.from(visibility('Coffee').options, (option) => option.value)
    expect(options).toEqual(['shown', 'label_only', 'absent'])
  })

  it('leaves the control open for income and hidden rows, unlike the two beside it', async () => {
    // The custody box and the nature tag are closed for both, because the split and the
    // savings nudge skip them. This one is not: a hidden envelope with money in it is
    // still sent, and an income envelope always is — so closing the control would take
    // away the answer on exactly the rows somebody would want it for (#278).
    await open(READS)

    expect(visibility('Salary').disabled).toBe(false)
    expect(visibility('Old subscription').disabled).toBe(false)
  })

  it('says what each state costs, rather than only what it withholds', async () => {
    await open(READS)

    expect(screen.getByText(/a broad guess at what the envelope is for remains possible/)).toBeTruthy()
    expect(screen.getByText(/declared as a count and one combined figure/)).toBeTruthy()
  })

  it('says beside the boxes that no budget figure is adjusted', async () => {
    // The one thing this column has to get across. A person who read a tick as an edit
    // to their budget would be right to be alarmed, and wrong about what happens.
    await open(READS)

    expect(screen.getByText(/the amount Actual holds is never adjusted/)).toBeTruthy()
  })

  it('leaves the mapping and the flag read-only for a viewer', async () => {
    await open({
      ...READS,
      '/api/settings': json({ ...PAYLOAD, profile: { ...PAYLOAD.profile, role: 'viewer' } }),
    })

    expect(picker('Coffee').disabled).toBe(true)
    expect(shared('Coffee').disabled).toBe(true)
    expect(nature('Coffee').disabled).toBe(true)
    expect(visibility('Coffee').disabled).toBe(true)
  })
})

describe('prompts', () => {
  const open = (replies: Replies): Promise<Call[]> => openPage(replies, '/settings/prompts')

  /** One Dutch version, deliberately written and active: the diverged state. */
  const DUTCH: Payload['prompts'][number] = {
    key: 'analysis.system',
    locale: 'nl',
    base: 'Judge the signals, Balancr’s own way.',
    active: {
      id: 'p3',
      version: 1,
      locale: 'nl',
      body: 'Beoordeel de signalen.',
      gate: 'unvalidated',
      validatedAt: null,
      rulesVersion: null,
    },
    storedBody: 'Beoordeel de signalen.',
    versions: [
      {
        id: 'p3',
        version: 1,
        active: true,
        name: null,
        note: null,
        createdBy: 'nick@example.com',
        createdAt: '2026-09-01T09:00:00.000Z',
        chars: 22,
        gate: 'unvalidated',
        validatedAt: null,
        rulesVersion: null,
      },
    ],
  }

  const DIVERGED: Payload = { ...PAYLOAD, prompts: [...PAYLOAD.prompts, DUTCH] }

  /**
   * The same Dutch version, switched off.
   *
   * The entry stays in the payload — deactivating does not delete the versions, and
   * activating one is how it comes back — so the editor has to distinguish "Dutch runs
   * its own text" from "Dutch has text nobody is using", which look identical in a box.
   */
  const RETIRED: Payload = {
    ...PAYLOAD,
    prompts: [
      ...PAYLOAD.prompts,
      {
        ...DUTCH,
        active: PAYLOAD.prompts[0]?.active ?? DUTCH.active,
        versions: [{ ...(DUTCH.versions[0] ?? { id: 'p3' }), active: false }],
      } as Payload['prompts'][number],
    ],
  }

  const applies = (): HTMLSelectElement => screen.getByLabelText('Applies to') as HTMLSelectElement

  it('opens on the shared instructions, with no language to choose between', async () => {
    await open(READS)

    // One option, and it is not a language: until someone writes a version for Dutch
    // there is nothing a language picker could usefully select.
    expect([...applies().options].map((option) => option.text)).toEqual(['All languages'])
    expect(applies().value).toBe(SHARED_LOCALE)
    expect((screen.getByLabelText('Instructions') as HTMLTextAreaElement).value).toBe(
      'Judge the signals.',
    )
  })

  it('forks the text on screen into one language, and switches to it', async () => {
    const calls = await open({ ...READS, '/api/settings/prompts': json(DIVERGED) })

    fireEvent.click(screen.getByRole('button', { name: 'Write a version for Dutch only' }))

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/prompts',
          method: 'POST',
          body: {
            key: 'analysis.system',
            locale: 'nl',
            body: 'Judge the signals.',
            activate: true,
          },
        },
      ])
    })
    // And the answer's new entry is what is on screen: the gesture that created the
    // divergence is what puts the language in the picker, so it has to land there.
    await waitFor(() => expect(applies().value).toBe('nl'))
    expect([...applies().options].map((option) => option.text)).toEqual([
      'All languages',
      'Dutch',
    ])
  })

  it('offers no fork for a language that already has one', async () => {
    await open({ ...READS, '/api/settings': json(DIVERGED) })

    expect(screen.queryByRole('button', { name: 'Write a version for Dutch only' })).toBeNull()
    // English is still on offer, and deliberately: the shared text is written in
    // English but is not English's own, so English can diverge from it like any other.
    expect(screen.getByRole('button', { name: 'Write a version for English only' })).toBeTruthy()
  })

  it('sends a language back to the shared instructions without deleting its versions', async () => {
    const calls = await open({
      ...READS,
      '/api/settings': json(DIVERGED),
      '/api/settings/prompts/analysis.system/nl/shared': json(PAYLOAD),
    })

    fireEvent.change(applies(), { target: { value: 'nl' } })
    expect((screen.getByLabelText('Instructions') as HTMLTextAreaElement).value).toBe(
      'Beoordeel de signalen.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Go back to the shared instructions' }))

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/prompts/analysis.system/nl/shared',
          method: 'POST',
          body: undefined,
        },
      ])
    })
    await waitFor(() => expect(applies().value).toBe(SHARED_LOCALE))
  })

  it('says a language’s own version is switched off rather than showing it as what runs', async () => {
    await open({ ...READS, '/api/settings': json(RETIRED) })

    fireEvent.change(applies(), { target: { value: 'nl' } })
    expect(
      screen.getByText(
        'Switched off: this language uses the shared instructions. Making a version active below turns it back on.',
      ),
    ).toBeTruthy()
    // Nothing to switch off, so the way back is the version list's Make active.
    expect(screen.queryByRole('button', { name: 'Go back to the shared instructions' })).toBeNull()
  })

  it('falls back to the shared text when the key changes under a language', async () => {
    await open({ ...READS, '/api/settings': json(DIVERGED) })

    fireEvent.change(applies(), { target: { value: 'nl' } })
    fireEvent.change(screen.getByLabelText('Which instructions'), {
      target: { value: 'narrative.system' },
    })

    // The narrative prompt has no Dutch version, and an empty panel would be the
    // alternative to landing on the text that actually runs.
    expect(applies().value).toBe(SHARED_LOCALE)
    expect((screen.getByLabelText('Instructions') as HTMLTextAreaElement).value).toBe(
      'Write the month up.',
    )
  })

  it('says when the text on screen is the built-in one rather than a stored version', async () => {
    await open(READS)

    fireEvent.change(screen.getByLabelText('Which instructions'), {
      target: { value: 'narrative.system' },
    })
    expect(
      screen.getByText('Nothing is stored yet, so the built-in instructions are in use.'),
    ).toBeTruthy()
  })

  it('stores a version without activating it unless asked', async () => {
    const calls = await open({ ...READS, '/api/settings/prompts': json(PAYLOAD) })

    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'Judge harder.' } })
    fireEvent.change(screen.getByLabelText('What changed'), { target: { value: 'sharper' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save as a new version' }))

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/prompts',
          method: 'POST',
          body: {
            key: 'analysis.system',
            locale: SHARED_LOCALE,
            body: 'Judge harder.',
            note: 'sharper',
          },
        },
      ])
    })
  })

  it('stores a household-chosen name alongside the note (#530)', async () => {
    const calls = await open({ ...READS, '/api/settings/prompts': json(PAYLOAD) })

    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'Judge harder.' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sharper tone' } })
    fireEvent.change(screen.getByLabelText('What changed'), { target: { value: 'sharper' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save as a new version' }))

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        {
          path: '/api/settings/prompts',
          method: 'POST',
          body: {
            key: 'analysis.system',
            locale: SHARED_LOCALE,
            body: 'Judge harder.',
            name: 'Sharper tone',
            note: 'sharper',
          },
        },
      ])
    })
  })

  it('activates in the same request when asked to', async () => {
    const calls = await open({ ...READS, '/api/settings/prompts': json(PAYLOAD) })

    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'Judge harder.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Make it active straight away' }))

    await waitFor(() => {
      expect(writes(calls)[0]?.body).toEqual({
        key: 'analysis.system',
        locale: SHARED_LOCALE,
        body: 'Judge harder.',
        activate: true,
      })
    })
  })

  it('rolls back by activating an older version, which is one request and no text', async () => {
    const calls = await open({ ...READS, '/api/settings/prompts/p1/activate': json(PAYLOAD) })

    fireEvent.click(screen.getByRole('button', { name: 'Make active' }))

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        { path: '/api/settings/prompts/p1/activate', method: 'POST', body: undefined },
      ])
    })
  })

  it('shows a diff, and hides it the moment the text it described changes', async () => {
    await open({ ...READS, '/api/settings/prompts/diff': json(DIFF) })

    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'New line.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Compare with the active version' }))

    await screen.findByText('1 added, 1 removed')
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'Newer line.' } })
    // A diff of text nobody is looking at any more is worse than no diff: it invites
    // activating a version on the strength of a comparison against something else.
    expect(screen.queryByText('1 added, 1 removed')).toBeNull()
  })
})

describe('the test run', () => {
  const open = (replies: Replies): Promise<Call[]> => openPage(replies, '/settings/prompts')

  /**
   * The button, once the estimate has landed.
   *
   * Awaited rather than read straight after `open()`: pricing the run is a second
   * request, and a `getByRole` racing it would pass or fail on how fast the stub
   * resolved. The button not existing until the price does is the behaviour under test.
   */
  const testButton = (): Promise<HTMLElement> =>
    screen.findByRole('button', { name: 'Test on August 2026' })

  it('prices the run before offering it, and reports what it actually cost', async () => {
    const calls = await open({ ...READS, '/api/ai/dry-run': json(DRY_RUN) })

    await screen.findByText('A test run on August 2026 would cost about € 0,0018.')
    fireEvent.click(await testButton())

    await screen.findByText('That run cost € 0,0021.')
    // No `locale`: `promptId` already pins the text, so the field would only choose the
    // language the findings come back in, and the shared prompt has no language of its
    // own to ask for. The server answers in the reader's, as the nightly job does.
    expect(writes(calls)).toEqual([
      {
        path: '/api/ai/dry-run',
        method: 'POST',
        body: { month: '2026-08', promptId: 'p2' },
      },
    ])
  })

  it('shows what the run would have reported, asked and thrown away', async () => {
    await open({ ...READS, '/api/ai/dry-run': json(DRY_RUN) })
    fireEvent.click(await testButton())

    await screen.findByText('Groceries is 18% above your 12-month norm.')
    expect(screen.getByText('Attention')).toBeTruthy()
    expect(screen.getByText(/Gifts/)).toBeTruthy()
    // A prompt whose findings get dropped is the prompt not to activate, so the count
    // is on screen rather than in a log.
    expect(screen.getByText(/Holidays — no signal backs it up/)).toBeTruthy()
  })

  it('will not be pressed twice while it is running', async () => {
    const calls = await open({ ...READS, '/api/ai/dry-run': json(DRY_RUN) })

    const button = await testButton()
    fireEvent.click(button)
    fireEvent.click(button)

    await screen.findByText('That run cost € 0,0021.')
    expect(writes(calls)).toHaveLength(1)
  })

  it('says there is nothing to test against rather than failing when pressed', async () => {
    await open({
      '/api/settings': json(PAYLOAD),
      '/api/ai/estimate': failure('conflict', 'No month has been aggregated.', 409),
    })

    await screen.findByText('No month has been aggregated yet, so there is nothing to test against.')
    expect(screen.queryByRole('button', { name: /^Test on/ })).toBeNull()
  })

  it('says why it cannot run rather than offering a button that would fail (#165)', async () => {
    // The editor stays fully usable without a key — writing and versioning the text is
    // worth doing before buying one — so the heading stays and only the control goes.
    await open({
      ...READS,
      '/api/settings': json({
        ...PAYLOAD,
        ai: { ...PAYLOAD.ai, availability: { enabled: false, reason: 'notConfigured' } },
      } satisfies Payload),
    })

    await screen.findByRole('heading', { name: 'Test run' })
    expect(screen.queryByRole('button', { name: /^Test on/ })).toBeNull()
    // The variable to set, in the one place that would have offered to spend money —
    // the AI usage panel's own reason renders on a different page now (#325), so only
    // Prompts' copy of this text is mounted here.
    expect(screen.getAllByText(/Set GEMINI_API_KEY/)).toHaveLength(1)
  })

  it('is not offered for the narrative prompt, which the server will not run', async () => {
    await open(READS)
    await testButton()

    fireEvent.change(screen.getByLabelText('Which instructions'), {
      target: { value: 'narrative.system' },
    })
    expect(screen.queryByRole('heading', { name: 'Test run' })).toBeNull()
  })
})

describe('the prompt safety check (#454)', () => {
  const open = (replies: Replies): Promise<Call[]> => openPage(replies, '/settings/prompts')

  const selectNarrative = (): void => {
    fireEvent.change(screen.getByLabelText('Which instructions'), {
      target: { value: 'narrative.system' },
    })
  }

  const EDITED = 'My own narrative instructions, rules and all.'
  const BUILT_IN = 'Write the month up.'

  type Version = Payload['prompts'][number]['versions'][number]

  const version = (over: Partial<Version> & Pick<Version, 'id' | 'version'>): Version => ({
    active: false,
    name: null,
    note: null,
    createdBy: 'nick@example.com',
    createdAt: '2026-09-01T09:00:00.000Z',
    chars: EDITED.length,
    gate: 'unvalidated',
    validatedAt: null,
    rulesVersion: null,
    ...over,
  })

  /** A narrative entry with a chosen active body and version list. */
  const narrativeWith = (
    active: { id: string | null; version: number; body: string; gate: string },
    versions: Version[],
  ): Payload => ({
    ...PAYLOAD,
    prompts: PAYLOAD.prompts.map((entry) =>
      entry.key === 'narrative.system'
        ? {
            ...entry,
            active: {
              ...active,
              locale: SHARED_LOCALE,
              validatedAt: null,
              rulesVersion: null,
            },
            storedBody: active.body,
            versions,
          }
        : entry,
    ) as Payload['prompts'],
  })

  /**
   * What an owner actually has after editing the text and pressing Save: the built-in body
   * still active, and a newer saved version holding their own words with no verdict yet.
   *
   * Deliberately **not** "an active, unvalidated narrative version". `assertActivatable`
   * refuses to create that, so a fixture shaped that way would be exercising a state the
   * server cannot produce — and a Check control pinned to the *active* version would look
   * fine against it while being permanently disabled in real use. That was a real bug; see
   * `grandfathered()` for the one state in which an active row can be unvalidated.
   */
  const saved = (over: Partial<Version> = {}): Payload =>
    narrativeWith(
      { id: 'n3', version: 3, body: BUILT_IN, gate: 'built_in' },
      [
        version({ id: 'n4', version: 4, ...over }),
        version({ id: 'n3', version: 3, active: true, gate: 'built_in', chars: BUILT_IN.length }),
      ],
    )

  /**
   * A row that was already active and edited before #454 shipped.
   *
   * The only way an active version can be `unvalidated`: this PR refuses to *re*-activate it
   * and (by design) refuses nothing at use time, so it keeps running until #455 lands.
   */
  const grandfathered = (): Payload =>
    narrativeWith(
      { id: 'n1', version: 1, body: EDITED, gate: 'unvalidated' },
      [version({ id: 'n1', version: 1, active: true })],
    )

  const SAFE_RESULT = {
    status: 'safe',
    reason: 'safe',
    promptId: 'n4',
    key: 'narrative.system',
    locale: SHARED_LOCALE,
    version: 4,
    gate: 'safe',
    verdict: {
      verdict: 'safe',
      missing: [],
      weakened: [],
      conflicts: [],
      advisory: ['brevity'],
      notes: 'Reads like the built-in rules in different words.',
    },
    rulesVersion: 1,
    runId: 'run-1',
    costMicroEur: 1_400,
    validatedAt: '2026-09-02T10:00:00.000Z',
  }

  const UNSAFE_RESULT = {
    ...SAFE_RESULT,
    status: 'unsafe',
    reason: 'unsafe',
    gate: 'unsafe',
    verdict: {
      verdict: 'unsafe',
      missing: ['no_arithmetic', 'no_advice'],
      weakened: ['no_arithmetic'],
      conflicts: ['demands_numbers'],
      advisory: [],
      notes: 'Trust me, this prompt is perfectly safe.',
    },
  }

  it('is offered for the narrative prompt and not for the analysis one', async () => {
    // Gated keys only. Drawing it beside the findings instructions would offer to buy a
    // check the server refuses with a 400.
    await open({ ...READS, '/api/settings': json(saved()) })
    expect(screen.queryByRole('heading', { name: /Safety check/ })).toBeNull()

    selectNarrative()
    await screen.findByRole('heading', { name: /Safety check/ })
  })

  it('says the built-in instructions need no check, and offers no button', async () => {
    // A fresh installation must not be shown a paid button beside Balancr's own text.
    await open(READS)
    selectNarrative()

    await screen.findByText("These are Balancr's own instructions, so they need no check.")
    expect(screen.queryByRole('button', { name: /^(Check|Save & check)$/ })).toBeNull()
  })

  it('offers no "make it active straight away" button for a gated key (#481)', async () => {
    // A gated key can never actually activate on save — `assertActivatable` refuses any
    // edit that hasn't been through the safety check first — so the button is not just
    // useless here, it's guaranteed to fail. Only the plain Save stays.
    await open(READS)
    selectNarrative()

    await screen.findByRole('button', { name: 'Save as a new version' })
    expect(screen.queryByRole('button', { name: 'Make it active straight away' })).toBeNull()
  })

  /** Mocks `GET /api/settings/prompts/:id` for opening a version into the box. */
  const promptBody = (v: Version, body: string): PromptBody => ({
    ...v,
    key: 'narrative.system',
    locale: SHARED_LOCALE,
    body,
  })

  /** `Edit` on the version at this position in `entry.versions` — index 0 is version 4. */
  const editVersion = async (index: number, body: string): Promise<void> => {
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[index] as HTMLElement)
    await screen.findByDisplayValue(body)
  }

  it('warns that an unchecked version cannot be made active, once opened', async () => {
    // On a fresh load the box shows the *active* row — here, the built-in text, which needs
    // no check at all. The unvalidated warning is about whichever row is actually on screen,
    // so it only appears once the unchecked saved version has been opened into the box.
    await open({
      ...READS,
      '/api/settings': json(saved()),
      '/api/settings/prompts/n4': json(promptBody(version({ id: 'n4', version: 4 }), EDITED)),
    })
    selectNarrative()
    expect(screen.queryByText('This has not been checked yet, so it cannot be made active.')).toBeNull()

    await editVersion(0, EDITED)

    await screen.findByText('This has not been checked yet, so it cannot be made active.')
    expect(await screen.findByRole('button', { name: 'Check' })).toBeTruthy()
  })

  it('warns immediately when the active row itself is unvalidated (a pre-#454 legacy state)', async () => {
    // `grandfathered()`: the one state in which an active row can be unvalidated at all —
    // this PR refuses to *re*-activate one and refuses nothing at use time, so it keeps
    // running until #455 lands. Here the anchor on a fresh load already is that row, so the
    // warning and an ordinary (non-diverged) Check button show up without opening anything.
    const calls = await open({
      ...READS,
      '/api/settings': json(grandfathered()),
      '/api/ai/prompt-validate': json({ ...SAFE_RESULT, promptId: 'n1', version: 1 }),
    })
    selectNarrative()

    await screen.findByText('This has not been checked yet, so it cannot be made active.')
    const button = await screen.findByRole('button', { name: 'Check' })
    expect(button.getAttribute('disabled')).toBeNull()

    fireEvent.click(button)
    await screen.findByText('This still imposes every rule the monthly narrative depends on.')
    expect(writes(calls)).toEqual([
      { method: 'POST', path: '/api/ai/prompt-validate', body: { promptId: 'n1' } },
    ])
  })

  it('checks whichever version was opened, not the active one', async () => {
    // The regression this pins: a gated body with no verdict *cannot be active*, because
    // `assertActivatable` refuses exactly that. So a Check button pinned to the active version
    // would be permanently disabled for every prompt anyone actually edits. The box, once
    // version 4 has been opened, is anchored to it rather than to the active version 3.
    const calls = await open({
      ...READS,
      '/api/settings': json(saved()),
      '/api/settings/prompts/n4': json(promptBody(version({ id: 'n4', version: 4 }), EDITED)),
      '/api/ai/prompt-validate': json(SAFE_RESULT),
    })
    selectNarrative()
    // Nothing to check yet: the box still shows the active, built-in text.
    expect(screen.queryByRole('button', { name: /^(Check|Save & check)$/ })).toBeNull()

    await editVersion(0, EDITED)

    const button = await screen.findByRole('button', { name: 'Check' })
    expect(button.getAttribute('disabled')).toBeNull()

    fireEvent.click(button)
    await screen.findByText('This still imposes every rule the monthly narrative depends on.')
    expect(writes(calls)).toEqual([
      { method: 'POST', path: '/api/ai/prompt-validate', body: { promptId: 'n4' } },
    ])
  })

  it('refreshes the gate badge from the verdict it just received', async () => {
    // `state.ask` does not replace the settings payload the way `state.save` does, so every
    // `gate` in the render after a check is still the one the last GET reported. Without
    // reading `PromptValidation.gate`, a row that has just been cleared stays badged
    // "Not checked" directly above a result saying it is safe.
    await open({
      ...READS,
      '/api/settings': json(saved()),
      '/api/settings/prompts/n4': json(promptBody(version({ id: 'n4', version: 4 }), EDITED)),
      '/api/ai/prompt-validate': json(SAFE_RESULT),
    })
    selectNarrative()
    await editVersion(0, EDITED)
    // Two badges read the same gate before the check: the section heading (which describes
    // whichever row the box is anchored to) and that row in the version list.
    expect(screen.getAllByText('Not checked')).toHaveLength(2)

    fireEvent.click(await screen.findByRole('button', { name: 'Check' }))
    await screen.findByText('This still imposes every rule the monthly narrative depends on.')

    // Both are now current, and the stale warning is gone.
    expect(screen.queryByText('Not checked')).toBeNull()
    expect(screen.getAllByText('Checked')).toHaveLength(2)
    expect(
      screen.queryByText('This has not been checked yet, so it cannot be made active.'),
    ).toBeNull()
  })

  it('checks the opened version and reports a safe verdict', async () => {
    const calls = await open({
      ...READS,
      '/api/settings': json(saved()),
      '/api/settings/prompts/n4': json(promptBody(version({ id: 'n4', version: 4 }), EDITED)),
      '/api/ai/prompt-validate': json(SAFE_RESULT),
    })
    selectNarrative()
    await editVersion(0, EDITED)

    fireEvent.click(await screen.findByRole('button', { name: 'Check' }))

    await screen.findByText('This still imposes every rule the monthly narrative depends on.')
    // The status badge, spelled out rather than left as a raw `status.safe` key: the three
    // statuses this section can report (`safe`, `unsafe`, `cached`) were not in the shared
    // `status.*` vocabulary before #454, and a missing one renders as its own key.
    expect(screen.getByText('Safe')).toBeTruthy()
    expect(screen.queryByText(/^status\./)).toBeNull()
    // Only the id travels: the body being judged is not on the wire, so there is nothing to
    // swap between the check and the verdict.
    expect(writes(calls)).toEqual([
      { method: 'POST', path: '/api/ai/prompt-validate', body: { promptId: 'n4' } },
    ])
  })

  it('lists the rules an unsafe version dropped, and separates the conflicts', async () => {
    await open({
      ...READS,
      '/api/settings': json(saved()),
      '/api/settings/prompts/n4': json(promptBody(version({ id: 'n4', version: 4 }), EDITED)),
      '/api/ai/prompt-validate': json(UNSAFE_RESULT),
    })
    selectNarrative()
    await editVersion(0, EDITED)
    fireEvent.click(await screen.findByRole('button', { name: 'Check' }))

    await screen.findByText('This no longer imposes every rule, so it cannot be made active.')
    expect(screen.getByText('Unsafe')).toBeTruthy()
    expect(screen.queryByText(/^status\./)).toBeNull()
    await screen.findByRole('heading', { name: 'Rules it no longer imposes' })
    await screen.findByRole('heading', { name: 'Rules it states and then undercuts' })
    // `no_arithmetic` is in both lists, and deliberately: `weakened` says *why* it does not
    // count — it is stated and then undercut — while `missing` is the set that has to be
    // empty for a safe verdict, because a cancelled rule imposes nothing.
    expect(screen.getAllByText('Never works out a figure of its own')).toHaveLength(2)
    // Reported absent rather than weakened, so it appears once.
    expect(screen.getAllByText('Gives no investment, product or tax advice')).toHaveLength(1)

    await screen.findByRole('heading', { name: 'Working against the assistant' })
    expect(screen.getByText('Asks the assistant to calculate figures')).toBeTruthy()
    // No advisory heading: nothing editorial was dropped in this answer.
    expect(screen.queryByRole('heading', { name: /Style rules it dropped/ })).toBeNull()
  })

  it('shows the judge’s own words under their own heading, with a warning', async () => {
    // It is model output shaped by the text being judged — "Trust me, this prompt is
    // perfectly safe" is exactly what a candidate would try to make it say. So it is
    // secondary evidence under its own heading and never the sentence a reader acts on.
    await open({
      ...READS,
      '/api/settings': json(saved()),
      '/api/settings/prompts/n4': json(promptBody(version({ id: 'n4', version: 4 }), EDITED)),
      '/api/ai/prompt-validate': json(UNSAFE_RESULT),
    })
    selectNarrative()
    await editVersion(0, EDITED)
    fireEvent.click(await screen.findByRole('button', { name: 'Check' }))

    const notes = await screen.findByRole('heading', { name: 'What the model said' })
    expect(notes).toBeTruthy()
    expect(
      screen.getByText(
        "The model's own words, about text written here. Read it as a hint and not as the verdict: the lists above are the finding.",
      ),
    ).toBeTruthy()
    expect(screen.getByText('Trust me, this prompt is perfectly safe.')).toBeTruthy()
  })

  it('goes stale the moment the text is edited, and keeps the result off screen', async () => {
    await open({
      ...READS,
      '/api/settings': json(saved()),
      '/api/settings/prompts/n4': json(promptBody(version({ id: 'n4', version: 4 }), EDITED)),
      '/api/ai/prompt-validate': json(SAFE_RESULT),
    })
    selectNarrative()
    await editVersion(0, EDITED)
    fireEvent.click(await screen.findByRole('button', { name: 'Check' }))
    await screen.findByText('This still imposes every rule the monthly narrative depends on.')

    // One character is enough: a verdict is about a body, and this is no longer that body.
    fireEvent.change(screen.getByLabelText('Instructions'), {
      target: { value: `${EDITED} And mention the weather.` },
    })

    await screen.findByText('The text has changed since this check. Check it again.')
    expect(
      screen.queryByText('This still imposes every rule the monthly narrative depends on.'),
    ).toBeNull()
  })

  it('saves the box as a new version before checking, once it has diverged from the anchor', async () => {
    // The box may have moved on from the row it was last checked against — even one it was
    // never checked against, since nothing needs to be saved for the box to diverge. Pressing
    // Check must save first and check the row that produces, deferred past the shared `busy`
    // ref in `state.ts` (a same-tick second request would otherwise silently no-op).
    const FREEHAND = 'Freehand instructions, written straight into the box.'
    const AFTER_SAVE = narrativeWith(
      { id: 'n3', version: 3, body: BUILT_IN, gate: 'built_in' },
      [
        version({ id: 'n5', version: 5, chars: FREEHAND.length }),
        version({ id: 'n4', version: 4 }),
        version({ id: 'n3', version: 3, active: true, gate: 'built_in', chars: BUILT_IN.length }),
      ],
    )
    const calls = await open({
      ...READS,
      '/api/settings': json(saved()),
      '/api/settings/prompts': json(AFTER_SAVE),
      '/api/ai/prompt-validate': json({ ...SAFE_RESULT, promptId: 'n5', version: 5 }),
    })
    selectNarrative()

    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: FREEHAND } })
    fireEvent.click(await screen.findByRole('button', { name: 'Save & check' }))

    await screen.findByText('This still imposes every rule the monthly narrative depends on.')
    expect(writes(calls)).toEqual([
      {
        method: 'POST',
        path: '/api/settings/prompts',
        body: { key: 'narrative.system', locale: SHARED_LOCALE, body: FREEHAND },
      },
      { method: 'POST', path: '/api/ai/prompt-validate', body: { promptId: 'n5' } },
    ])
  })

  it('can save and check a brand-new prompt with no stored versions at all', async () => {
    // Complaint #1's point extended to checking: the built-in prompt always runs, so there
    // being no stored version yet must not be why a first edit cannot be checked.
    const FIRST = 'My very first version of this prompt.'
    const AFTER_SAVE = narrativeWith(
      { id: null, version: 0, body: BUILT_IN, gate: 'built_in' },
      [version({ id: 'n1', version: 1, chars: FIRST.length })],
    )
    const calls = await open({
      ...READS,
      '/api/settings/prompts': json(AFTER_SAVE),
      '/api/ai/prompt-validate': json({ ...SAFE_RESULT, promptId: 'n1', version: 1 }),
    })
    selectNarrative()
    expect(screen.queryByRole('button', { name: /^(Check|Save & check)$/ })).toBeNull()

    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: FIRST } })
    fireEvent.click(await screen.findByRole('button', { name: 'Save & check' }))

    await screen.findByText('This still imposes every rule the monthly narrative depends on.')
    expect(writes(calls)).toEqual([
      {
        method: 'POST',
        path: '/api/settings/prompts',
        body: { key: 'narrative.system', locale: SHARED_LOCALE, body: FIRST },
      },
      { method: 'POST', path: '/api/ai/prompt-validate', body: { promptId: 'n1' } },
    ])
  })

  it('deletes a version after a confirm step, and does nothing on cancel', async () => {
    const calls = await open({
      ...READS,
      '/api/settings': json(saved()),
      '/api/settings/prompts/n4': json(
        narrativeWith(
          { id: 'n3', version: 3, body: BUILT_IN, gate: 'built_in' },
          [version({ id: 'n3', version: 3, active: true, gate: 'built_in', chars: BUILT_IN.length })],
        ),
      ),
    })
    selectNarrative()

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0] as HTMLElement)
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(writes(calls)).toEqual([])
    expect(screen.getAllByRole('button', { name: 'Delete' })[0]).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0] as HTMLElement)
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, delete this version' }))

    expect(writes(calls)).toEqual([
      { method: 'DELETE', path: '/api/settings/prompts/n4', body: undefined },
    ])
  })

  it("clamps back to the shared tab after deleting a language override's last version", async () => {
    const NL_BODY = 'Nederlandse tekst.'
    const nlOverride: Payload = {
      ...saved(),
      prompts: [
        ...saved().prompts,
        {
          key: 'narrative.system',
          locale: 'nl',
          active: {
            id: 'nl1',
            version: 1,
            locale: 'nl',
            body: NL_BODY,
            gate: 'unvalidated',
            validatedAt: null,
            rulesVersion: null,
          },
          storedBody: NL_BODY,
          versions: [version({ id: 'nl1', version: 1, active: true, chars: NL_BODY.length })],
        },
      ] as Payload['prompts'],
    }

    await open({
      ...READS,
      '/api/settings': json(nlOverride),
      '/api/settings/prompts/nl1': json(saved()),
    })
    selectNarrative()
    fireEvent.change(screen.getByLabelText('Applies to'), { target: { value: 'nl' } })
    await screen.findByDisplayValue(NL_BODY)

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, delete this version' }))

    await waitFor(() =>
      expect((screen.getByLabelText('Applies to') as HTMLSelectElement).value).toBe(SHARED_LOCALE),
    )
  })

  it('shows the price once a diff has been fetched', async () => {
    await open({
      ...READS,
      '/api/settings': json(saved()),
      '/api/settings/prompts/n4': json(promptBody(version({ id: 'n4', version: 4 }), EDITED)),
      '/api/settings/prompts/diff': json({ ...DIFF, validationEstimateMicroEur: 1_500 }),
    })
    selectNarrative()
    await editVersion(0, EDITED)

    // The price rides on the free diff request rather than an endpoint of its own, so it
    // appears once that has been asked for — and not before, which is honest about the fact
    // that nobody has priced this body yet.
    expect(screen.queryByText(/A check costs about/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Compare with the active version' }))

    await screen.findByText('A check costs about € 0,0015.')
  })

  it('badges each version row with its gate, so a cleared one is visible before activating', async () => {
    await open({ ...READS, '/api/settings': json(saved({ gate: 'safe', rulesVersion: 1 })) })
    selectNarrative()

    // Scoped to the version list rather than counted across the panel: the Check section's own
    // heading badge already reads a gate, so a document-wide `findAllByText` would pass with
    // the per-row badge deleted — which is the thing this test exists to pin.
    const rows = document.querySelectorAll('.version')
    expect(rows).toHaveLength(2)
    // Version 4 is the cleared one; version 3 is Balancr's own text.
    expect(rows[0]?.querySelector('.badge--truth')?.textContent).toBe('Checked')
    expect(rows[1]?.textContent).toContain("Balancr's own")
  })

  it('shows a version’s chosen name in the version list (#530)', async () => {
    await open({ ...READS, '/api/settings': json(saved({ name: 'Gentler tone' })) })
    selectNarrative()

    const rows = document.querySelectorAll('.version')
    expect(rows[0]?.textContent).toContain('Gentler tone')
    // The other row has no name and shows none — not the empty string, not "null".
    expect(rows[1]?.querySelector('.version__name')).toBeNull()
  })

  it('retires a verdict when the box is anchored to a different version', async () => {
    // A verdict belongs to the row it was about. Opening a different row changes what the
    // section is about, and the old answer is no longer this section's answer — showing it
    // would attribute one version's clearance to another.
    await open({
      ...READS,
      '/api/settings': json(saved()),
      '/api/settings/prompts/n4': json(promptBody(version({ id: 'n4', version: 4 }), EDITED)),
      '/api/settings/prompts/n3': json(
        promptBody(version({ id: 'n3', version: 3, active: true, gate: 'built_in', chars: BUILT_IN.length }), BUILT_IN),
      ),
      '/api/ai/prompt-validate': json(SAFE_RESULT),
    })
    selectNarrative()
    await editVersion(0, EDITED)
    fireEvent.click(await screen.findByRole('button', { name: 'Check' }))
    await screen.findByText('This still imposes every rule the monthly narrative depends on.')

    // Opening version 3 re-anchors the box to Balancr's own text, which needs no check.
    await editVersion(1, BUILT_IN)

    expect(
      screen.queryByText('This still imposes every rule the monthly narrative depends on.'),
    ).toBeNull()
    await screen.findByText("These are Balancr's own instructions, so they need no check.")
  })

  it('points a language that only inherits the shared text at the shared tab', async () => {
    // `buildSettings` emits an entry per supported locale, and one with no override of its own has
    // an empty version list and the *shared* row as its `active`. There is nothing here to check,
    // and describing that row as built-in would be a claim about text this tab does not own.
    const inheriting: Payload = {
      ...saved(),
      prompts: [
        ...saved().prompts,
        {
          key: 'narrative.system',
          locale: 'nl',
          active: {
            id: 'n4',
            version: 4,
            locale: SHARED_LOCALE,
            body: EDITED,
            gate: 'unvalidated',
            validatedAt: null,
            rulesVersion: null,
          },
          versions: [],
        },
      ] as Payload['prompts'],
    }
    await open({ ...READS, '/api/settings': json(inheriting) })
    selectNarrative()
    fireEvent.change(screen.getByLabelText('Applies to'), { target: { value: 'nl' } })

    await screen.findByText(
      'This language uses the shared instructions, so there is nothing of its own to check — check them under “All languages”.',
    )
    expect(screen.queryByRole('button', { name: /^(Check|Save & check)$/ })).toBeNull()
    // And no badge: the gate belongs to the shared row, so claiming one here would be a
    // statement about a row this tab does not own.
    expect(screen.queryByText('Not checked')).toBeNull()
    expect(screen.queryByText("Balancr's own")).toBeNull()
  })

  it('still lets a deactivated override be opened and checked, since its own version is real', async () => {
    // Unlike the language above, this one *has* written its own text — `deactivateOverride`
    // only stops it from running, it does not delete the row. `entry.active` resolves to the
    // shared text either way, so "inherits shared" has to be judged on `versions.length`, not
    // on whether one of those versions happens to be active right now.
    const withDeactivatedOverride: Payload = {
      ...saved(),
      prompts: [
        ...saved().prompts,
        {
          key: 'narrative.system',
          locale: 'nl',
          active: {
            id: 'n3',
            version: 3,
            locale: SHARED_LOCALE,
            body: BUILT_IN,
            gate: 'built_in',
            validatedAt: null,
            rulesVersion: null,
          },
          versions: [version({ id: 'n5', version: 1 })],
        },
      ] as Payload['prompts'],
    }
    await open({
      ...READS,
      '/api/settings': json(withDeactivatedOverride),
      '/api/settings/prompts/n5': json(promptBody(version({ id: 'n5', version: 1 }), EDITED)),
    })
    selectNarrative()
    fireEvent.change(screen.getByLabelText('Applies to'), { target: { value: 'nl' } })
    await editVersion(0, EDITED)

    expect(await screen.findByRole('button', { name: 'Check' })).not.toBeNull()
  })

  it('draws no gate badge on a version of a key this mode does not gate', async () => {
    // `PAYLOAD.promptEditing` is `full` (#468), under which `analysis.system` is not gated —
    // so a warn-tone "Not checked" beside an edited findings prompt would advertise a check
    // the endpoint refuses (400) and a restriction that does not apply to it here.
    await open({ ...READS, '/api/settings': json(saved()) })

    const rows = document.querySelectorAll('.version')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.textContent).not.toContain('Not checked')
    expect(screen.queryByRole('heading', { name: /Safety check/ })).toBeNull()
  })

  it('leaves activation clickable, since nothing about editing is ever blocked (#468)', async () => {
    await open({ ...READS, '/api/settings': json(saved()) })
    selectNarrative()

    const activate = screen.getAllByRole('button', { name: 'Make active' })
    expect(activate.length).toBeGreaterThan(0)
    for (const button of activate) expect(button.getAttribute('disabled')).toBeNull()
  })
})

describe('AI spend', () => {
  // Moved off its own Settings tab onto the Status page, behind the AI service card
  // (#325's follow-on): reached at `/settings/status/ai`, a sibling of Services/Queue
  // under the same "Status of this instance" heading rather than a page of its own.
  const open = (replies: Replies): Promise<Call[]> =>
    openPage(replies, '/settings/status/ai', 'Status of this instance')

  it('prints the month to date and the months behind it from the server’s figures', async () => {
    await open(READS)

    // `openPage` only waits for the page's own h2; the AI tab's content sits behind a
    // second, separate `/api/status` fetch (`StatusPanel`'s own `DataState`), which can
    // still be pending when that heading first renders.
    expect(await screen.findByText('€ 2,50 of € 15,00 this month')).toBeTruthy()
    // `formatBp` keeps one decimal, so 1667 basis points is 16,7% and not 16,67%.
    expect(screen.getByText('16,7% of the monthly budget')).toBeTruthy()
    expect(screen.getByText('August 2026')).toBeTruthy()
    expect(screen.getByText('€ 4,20')).toBeTruthy()
    // Token counts through the formatter, not `String(number)`.
    expect(screen.getByText(/Analyses 31 · In 92\.000 · Out 12\.400 · Cached 61\.000/)).toBeTruthy()
  })

  it('replaces the by-hand run with the reason it cannot happen (#165)', async () => {
    // Not a hidden control: a heading that disappears reads as a feature taken away,
    // and the budget printed just above it invites exactly this question. The figures
    // stay, because a history of what was spent is still worth reading.
    await open({
      ...READS,
      '/api/settings': json({
        ...PAYLOAD,
        ai: { ...PAYLOAD.ai, availability: { enabled: false, reason: 'budgetZero' } },
      } satisfies Payload),
    })

    await screen.findByRole('heading', { name: 'Run by hand' })
    expect(screen.queryByRole('button', { name: 'Run the analysis now' })).toBeNull()
    // Once: this panel's own reason, from the same key the prompt editor's test run
    // shows on its own tab (#200) — the two are on different pages now and neither
    // ever doubled the other's count.
    expect(screen.getAllByText(/Raise GEMINI_MONTHLY_BUDGET_EUR/)).toHaveLength(1)
    // No price on a run that cannot start.
    expect(screen.queryByText(/would cost about/)).toBeNull()
    expect(screen.getByText('€ 2,50 of € 15,00 this month')).toBeTruthy()
  })
})

/**
 * The AI log (#497): the debug view of the exact text sent to the model and the exact
 * text it sent back, on its own tab.
 *
 * `Ledger.tsx`'s own tests already cover the list/expand mechanics this reuses — what
 * is worth pinning here is the two things that are new to this endpoint: it is not
 * part of the settings payload (its own `/api/settings/ai/runs` fetch, like Status'
 * own panel), and a `capped` row's transcript is a request with no response rather
 * than an error.
 */
describe('the AI log', () => {
  const RUN: AiRun = {
    id: 'run-findings',
    kind: 'findings',
    period: '2026-08',
    model: 'gemini-3.7-flash',
    locale: 'en',
    status: 'ok',
    inputTokens: 3_120,
    outputTokens: 480,
    cachedTokens: 2_048,
    costMicroEur: 1_240,
    durationMs: 1_900,
    error: null,
    reusedFromRunId: null,
    createdAt: '2026-09-01T04:12:00Z',
  }

  const CAPPED_RUN: AiRun = {
    ...RUN,
    id: 'run-narrative',
    kind: 'narrative',
    status: 'capped',
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costMicroEur: 0,
    durationMs: null,
    createdAt: '2026-08-31T23:05:00Z',
  }

  it('lists every recorded call, newest first, without needing a month', async () => {
    await open({
      ...READS,
      '/api/settings/ai/runs': json({ runs: [RUN, CAPPED_RUN], nextCursor: null } satisfies AiRunList),
    }, '/settings/ai-log')

    expect(await screen.findByText('Analysis')).toBeTruthy()
    expect(screen.getByText('Narrative')).toBeTruthy()
    expect(screen.getByText('OK')).toBeTruthy()
    expect(screen.getByText('Budget cap reached')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Show the request and response' })).toHaveLength(2)
  })

  it('shows the exact request and response text once a row is opened', async () => {
    await open({
      ...READS,
      '/api/settings/ai/runs': json({ runs: [RUN], nextCursor: null } satisfies AiRunList),
      '/api/insights/runs/run-findings/payload': json({
        ...RUN,
        payload: { month: '2026-08' },
        requestText: 'system + instruction + fenced data, exactly as sent',
        responseText: '{"findings":[]}',
      } satisfies AiRunPayload),
    }, '/settings/ai-log')

    fireEvent.click(await screen.findByRole('button', { name: 'Show the request and response' }))

    expect(
      await screen.findByText('system + instruction + fenced data, exactly as sent'),
    ).toBeTruthy()
    expect(screen.getByText('{"findings":[]}')).toBeTruthy()
  })

  it("shows a capped run's prepared-but-unsent request, with no response to show", async () => {
    await open({
      ...READS,
      '/api/settings/ai/runs': json({ runs: [CAPPED_RUN], nextCursor: null } satisfies AiRunList),
      '/api/insights/runs/run-narrative/payload': json({
        ...CAPPED_RUN,
        payload: {},
        requestText: 'prepared but never sent',
        responseText: null,
      } satisfies AiRunPayload),
    }, '/settings/ai-log')

    fireEvent.click(await screen.findByRole('button', { name: 'Show the request and response' }))

    expect(await screen.findByText('prepared but never sent')).toBeTruthy()
    expect(screen.getByText('No response is recorded for this run.')).toBeTruthy()
  })

  it('says no calls have been made yet, rather than drawing an empty table', async () => {
    await open(
      { ...READS, '/api/settings/ai/runs': json({ runs: [], nextCursor: null } satisfies AiRunList) },
      '/settings/ai-log',
    )

    expect(await screen.findByText('No calls have been made yet.')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('has no "load older calls" button once the first page is already everything (#502)', async () => {
    await open({
      ...READS,
      '/api/settings/ai/runs': json({ runs: [RUN, CAPPED_RUN], nextCursor: null } satisfies AiRunList),
    }, '/settings/ai-log')

    await screen.findByText('Analysis')
    expect(screen.queryByRole('button', { name: 'Load older calls' })).toBeNull()
  })

  it('appends the next page onto the first without losing it, then hides the button (#502)', async () => {
    await open({
      ...READS,
      '/api/settings/ai/runs': json({ runs: [RUN], nextCursor: 'run-findings' } satisfies AiRunList),
      '/api/settings/ai/runs?before=run-findings': json({
        runs: [CAPPED_RUN],
        nextCursor: null,
      } satisfies AiRunList),
    }, '/settings/ai-log')

    await screen.findByText('Analysis')
    fireEvent.click(await screen.findByRole('button', { name: 'Load older calls' }))

    expect(await screen.findByText('Narrative')).toBeTruthy()
    // The first page's row is still there — "load more" appends, it does not replace.
    expect(screen.getByText('Analysis')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Load older calls' })).toBeNull()
  })

  it('lets a failed "load more" be retried without losing the first page (#502)', async () => {
    await open({
      ...READS,
      '/api/settings/ai/runs': json({ runs: [RUN], nextCursor: 'run-findings' } satisfies AiRunList),
      '/api/settings/ai/runs?before=run-findings': [
        new Error('network blip'),
        json({ runs: [CAPPED_RUN], nextCursor: null } satisfies AiRunList),
      ],
    }, '/settings/ai-log')

    await screen.findByText('Analysis')
    fireEvent.click(await screen.findByRole('button', { name: 'Load older calls' }))

    const retry = await screen.findByRole('button', { name: 'Try again' })
    expect(screen.getByText('Analysis')).toBeTruthy()

    fireEvent.click(retry)

    expect(await screen.findByText('Narrative')).toBeTruthy()
    expect(screen.getByText('Analysis')).toBeTruthy()
  })
})

describe('a viewer', () => {
  const VIEWER: Payload = {
    ...PAYLOAD,
    profile: { ...PAYLOAD.profile, role: 'viewer' },
  }

  it('can read every threshold and change none of them', async () => {
    await openPage(
      { '/api/settings': json(VIEWER), '/api/ai/estimate': json(ESTIMATE) },
      '/settings/thresholds/overspend',
      'Thresholds',
    )

    expect(screen.getAllByText('Only the owner can change this.').length).toBeGreaterThan(0)
    expect(field('Warn above the norm').value).toBe('2000')
    expect(field('Warn above the norm').disabled).toBe(true)
    expect(save().disabled).toBe(true)
  })

  it('can still change their own interface language', async () => {
    const calls = await open({
      '/api/settings': json(VIEWER),
      '/api/ai/estimate': json(ESTIMATE),
      '/api/settings/profile': json(VIEWER),
    })

    const select = screen.getByLabelText('Language') as HTMLSelectElement
    expect(select.disabled).toBe(false)
    fireEvent.change(select, { target: { value: 'nl' } })

    await waitFor(() => {
      expect(writes(calls)).toEqual([
        { path: '/api/settings/profile', method: 'PATCH', body: { locale: 'nl' } },
      ])
    })
  })
})
