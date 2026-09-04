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
import type { AiDryRun, AiEstimate, PromptDiff, Settings as Payload } from '../src/shared.ts'
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
const BENCHMARK: Payload['benchmark'] = {
  file: {
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
    hasReferenceHousehold: false,
    transcribed: ['source', 'equivalence'],
  },
  household: {
    members: [{ birthYear: 2013, custodyBp: 5_000, label: 'Teenager' }],
    // Null, so the panel prints the share it derives from the roster above rather than
    // a stated one — the default, and the state worth having in the fixture (#44).
    sharedCostBp: null,
  },
  outsideCode: '00',
  categories: [
    {
      categoryId: 'cat-coffee',
      categoryName: 'Coffee',
      isIncome: false,
      hidden: false,
      coicop: null,
      custodyShared: false,
      spentCents: 8_000,
    },
    {
      categoryId: 'cat-rent',
      categoryName: 'Rent',
      isIncome: false,
      hidden: false,
      coicop: '04.5.1',
      custodyShared: false,
      spentCents: 120_000,
    },
    {
      categoryId: 'cat-bank',
      categoryName: 'Bank charges',
      isIncome: false,
      hidden: false,
      coicop: '00',
      custodyShared: false,
      spentCents: 1_500,
    },
    {
      categoryId: 'cat-salary',
      categoryName: 'Salary',
      isIncome: true,
      hidden: false,
      coicop: null,
      custodyShared: false,
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
      spentCents: 0,
    },
  ],
}

const PAYLOAD: Payload = {
  build: { version: '0.5.6', revision: 'abc1234' },
  history: { months: 24, earliest: '2024-09', latest: '2026-08' },
  profile: { email: 'nick@example.com', displayName: 'Nick', locale: 'en', role: 'owner' },
  locales: { supported: ['en', 'nl'], default: 'en' },
  params: PARAMS,
  paramDefaults: PARAMS,
  advice: ADVICE,
  // One entry per key, under the sentinel that means every language — which is what
  // the server sends until someone deliberately writes a version for one language.
  prompts: [
    {
      key: 'analysis.system',
      locale: SHARED_LOCALE,
      active: { id: 'p2', version: 2, locale: SHARED_LOCALE, body: 'Judge the signals.' },
      versions: [
        {
          id: 'p2',
          version: 2,
          active: true,
          note: 'Tightened the ordering rule',
          createdBy: 'nick@example.com',
          createdAt: '2026-08-30T09:00:00.000Z',
          chars: 19,
        },
        {
          id: 'p1',
          version: 1,
          active: false,
          note: null,
          createdBy: null,
          createdAt: '2026-08-01T09:00:00.000Z',
          chars: 12,
        },
      ],
    },
    {
      key: 'narrative.system',
      locale: SHARED_LOCALE,
      // The built-in constant: no row anywhere, `id: null`, `version: 0`.
      active: { id: null, version: 0, locale: SHARED_LOCALE, body: 'Write the month up.' },
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
    },
  ],
  dedupe: [
    { ghostfolioId: 'g-broker', actualId: 'a-mirror', signals: ['name', 'balance'] },
  ],
  benchmark: BENCHMARK,
  ai: {
    availability: { enabled: true, reason: null },
    models: { fast: 'gemini-3.7-flash', deep: 'gemini-3.1-pro-preview' },
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
  '/settings/risk': 'Risk profile',
  '/settings/thresholds': 'Thresholds',
  '/settings/accounts': 'Accounts',
  '/settings/benchmark': 'Household',
  '/settings/spend': 'AI usage',
}

/**
 * The page, on whichever section's path is given, once its payload has landed.
 *
 * Most describe blocks below shadow this with their own `open` bound to one section's
 * path (#200) — `openPage` is the name that shadow calls through, kept exported at
 * this scope so a block that needs more than one section (a viewer's, the page's own
 * shape) can still reach every tab from one helper.
 */
async function openPage(replies: Replies, path = '/settings'): Promise<Call[]> {
  const calls = serve(replies)
  renderApp(<Settings />, { path })
  await screen.findByRole('heading', { level: 2, name: SECTION_HEADING[path] ?? 'Account' })
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

  it('opens on General, and only General, with the build the answer came from', async () => {
    await open(READS)

    for (const title of ['Account', 'Data window', 'This instance', 'Status of this instance']) {
      expect(screen.getByRole('heading', { level: 2, name: title })).toBeTruthy()
    }
    expect(screen.getByText('abc1234')).toBeTruthy()
    expect(screen.getByText('0.5.6')).toBeTruthy()

    // Every other section's panel stays off the page until its own tab is open.
    for (const title of ['Assistant instructions', 'Thresholds', 'Accounts', 'Household', 'AI usage']) {
      expect(screen.queryByRole('heading', { level: 2, name: title })).toBeNull()
    }
  })

  it.each([
    ['/settings/prompts', 'Assistant instructions'],
    ['/settings/thresholds', 'Thresholds'],
    ['/settings/accounts', 'Accounts'],
    ['/settings/spend', 'AI usage'],
  ] as const)('shows only %s’s panel on its own tab, not General’s', async (path, title) => {
    await open(READS, path)

    expect(screen.getByRole('heading', { level: 2, name: title })).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 2, name: 'Account' })).toBeNull()
    expect(screen.queryByRole('heading', { level: 2, name: 'Status of this instance' })).toBeNull()
  })

  it('shows the household and the category mapping together on Benchmark', async () => {
    await open(READS, '/settings/benchmark')

    expect(screen.getByRole('heading', { level: 2, name: 'Household' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: 'Categories' })).toBeTruthy()
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
    const calls = await open(READS)
    // `/api/status` is General's own panel and separate from the payload on purpose —
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
    // Spend's by-hand run price against it — but `/api/status` is never asked for here:
    // only General mounts the panel that reads it.
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
    // on a tab that has a euro figure to check it against.
    fireEvent.click(screen.getByRole('link', { name: 'AI-gebruik' }))
    expect(await screen.findByText('€ 2,50')).toBeTruthy()
  })

  it('sends nothing when the language chosen is the one already set', async () => {
    const calls = await open(READS)
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'en' } })
    expect(writes(calls)).toEqual([])
  })
})

describe('thresholds', () => {
  /** Thresholds moved to its own tab (#200); every case here means that tab. */
  const open = (replies: Replies): Promise<Call[]> => openPage(replies, '/settings/thresholds')

  it('sends only the fields that changed, in their groups', async () => {
    const calls = await open({ ...READS, '/api/settings/params': json(PAYLOAD) })

    fireEvent.change(field('Warn above the norm'), { target: { value: '2500' } })
    fireEvent.change(field('Months of history in the norm'), { target: { value: '18' } })
    fireEvent.click(save())

    await waitFor(() => {
      expect(writes(calls)).toHaveLength(1)
    })
    expect(writes(calls)[0]?.body).toEqual({
      overspend: { baselineWarnBp: 2_500 },
      baseline: { windowMonths: 18 },
    })
  })

  it('parses a money field the Belgian way and sends cents', async () => {
    const calls = await open({ ...READS, '/api/settings/params': json(PAYLOAD) })

    // Shown as `€ 25,00`, typed back as an amount, sent as an integer number of cents.
    expect(field('Ignore amounts under').value).toBe(eur('25,00'))
    fireEvent.change(field('Ignore amounts under'), { target: { value: '30,50' } })
    fireEvent.click(save())

    await waitFor(() => {
      expect(writes(calls)[0]?.body).toEqual({ overspend: { materialityFloorCents: 3_050 } })
    })
  })

  it('refuses a grouping mark in a plain number rather than reading it as three digits', async () => {
    const calls = await open({ ...READS, '/api/settings/params': json(PAYLOAD) })

    // `parseFloat('2.000')` is 2 — which would save 0,02% as if it were 20%.
    fireEvent.change(field('Warn above the norm'), { target: { value: '2.000' } })

    expect(
      screen.getByText('Type it without a thousands separator — 2.000 could mean 2000 or 2.'),
    ).toBeTruthy()
    expect(save().disabled).toBe(true)
    expect(writes(calls)).toEqual([])
  })

  it('has nothing to save once a field is typed back to what is stored', async () => {
    await open(READS)

    fireEvent.change(field('Warn above the norm'), { target: { value: '2500' } })
    expect(save().disabled).toBe(false)

    fireEvent.change(field('Warn above the norm'), { target: { value: '2000' } })
    expect(save().disabled).toBe(true)
  })

  it('says what a basis-points field will be read as, so 2000 is not mistaken for money', async () => {
    await open(READS)
    expect(screen.getByText(/reads as 20%/)).toBeTruthy()
  })

  it('puts a rejected field beside itself rather than at the top of the page', async () => {
    await open({
      ...READS,
      '/api/settings/params': failure('invalidBody', 'That request was not valid.', 400, [
        { path: 'overspend.baselineWarnBp', message: 'must not exceed baselineAlertBp' },
      ]),
    })

    fireEvent.change(field('Warn above the norm'), { target: { value: '9000' } })
    fireEvent.click(save())

    const issue = await screen.findByText('must not exceed baselineAlertBp')
    expect(issue.closest('.thresholds__field')).not.toBeNull()
    // The generic message would be true and useless next to twenty inputs.
    expect(screen.queryByText('That request was not valid.')).toBeNull()
  })

  it('reports a failure the server did not attribute to a field once, above the panels', async () => {
    await open({
      ...READS,
      '/api/settings/params': failure('rateLimited', 'Too many requests. Try again shortly.', 429),
    })

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
    fireEvent.click(screen.getByRole('button', { name: 'Group, Bolero counts' }))

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
    for (const name of ['Group, Bolero counts', 'Group, Investments (mirror) counts', 'Not the same money']) {
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

describe('the household', () => {
  const open = (replies: Replies): Promise<Call[]> => openPage(replies, '/settings/benchmark')

  const household = (): HTMLElement => form('household')

  const saveHousehold = (): HTMLButtonElement =>
    within(household()).getByRole('button', { name: 'Save' }) as HTMLButtonElement

  const memberField = (label: string, at = 0): HTMLInputElement =>
    (screen.getAllByLabelText(label)[at] ?? document.createElement('input')) as HTMLInputElement

  const sharedCost = (): HTMLInputElement =>
    screen.getByLabelText('Your share of shared costs') as HTMLInputElement

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
            members: [
              { birthYear: 2013, custodyBp: 5_000, label: 'Teenager' },
              { birthYear: 1998, custodyBp: 10_000, label: 'Lodger' },
            ],
            // The share travels with the roster for the same reason: the household is one
            // row written wholesale, so a patch that omitted it would drop a stated share
            // on every roster edit without saying so (#44).
            sharedCostBp: null,
          },
        },
      ])
    })
  })

  it('refuses a half-typed year rather than sending it', async () => {
    const calls = await open(READS)

    fireEvent.change(memberField('Year of birth'), { target: { value: '20' } })

    expect(screen.getByText(/A four-digit year/)).toBeTruthy()
    expect(saveHousehold().disabled).toBe(true)
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
            members: [{ birthYear: 2013, custodyBp: 5_000, label: 'Teenager' }],
            sharedCostBp: 6_000,
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
            members: [{ birthYear: 2013, custodyBp: 5_000, label: 'Teenager' }],
            sharedCostBp: null,
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
    await open(READS)

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

describe('the category table', () => {
  const open = (replies: Replies): Promise<Call[]> => openPage(replies, '/settings/benchmark')

  const picker = (name: string): HTMLSelectElement =>
    screen.getByLabelText(`COICOP division for ${name}`) as HTMLSelectElement

  const shared = (name: string): HTMLInputElement =>
    screen.getByLabelText(`Shared with a co-parent: ${name}`) as HTMLInputElement

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
  })
})

describe('prompts', () => {
  const open = (replies: Replies): Promise<Call[]> => openPage(replies, '/settings/prompts')

  /** One Dutch version, deliberately written and active: the diverged state. */
  const DUTCH = {
    key: 'analysis.system',
    locale: 'nl',
    active: { id: 'p3', version: 1, locale: 'nl', body: 'Beoordeel de signalen.' },
    versions: [
      {
        id: 'p3',
        version: 1,
        active: true,
        note: null,
        createdBy: 'nick@example.com',
        createdAt: '2026-09-01T09:00:00.000Z',
        chars: 22,
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
    // once flat, this and the Spend panel's own reason both rendered on the same page
    // and this asserted two; the tab split (#200) means only Prompts is mounted here.
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

describe('AI spend', () => {
  const open = (replies: Replies): Promise<Call[]> => openPage(replies, '/settings/spend')

  it('prints the month to date and the months behind it from the server’s figures', async () => {
    await open(READS)

    expect(screen.getByText('€ 2,50 of € 15,00 this month')).toBeTruthy()
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
    // would show on its own tab (#200) — before the split both rendered on one page
    // and this asserted two.
    expect(screen.getAllByText(/Raise GEMINI_MONTHLY_BUDGET_EUR/)).toHaveLength(1)
    // No price on a run that cannot start.
    expect(screen.queryByText(/would cost about/)).toBeNull()
    expect(screen.getByText('€ 2,50 of € 15,00 this month')).toBeTruthy()
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
      '/settings/thresholds',
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
