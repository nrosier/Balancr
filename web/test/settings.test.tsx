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
import { fireEvent, screen, waitFor } from '@testing-library/react'
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
}

const PAYLOAD: Payload = {
  build: { version: '0.5.6', revision: 'abc1234' },
  profile: { email: 'nick@example.com', displayName: 'Nick', locale: 'en', role: 'owner' },
  locales: { supported: ['en', 'nl'], default: 'en' },
  params: PARAMS,
  paramDefaults: PARAMS,
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
  ai: {
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

/** The page, once its payload has landed. */
async function open(replies: Record<string, Response | Error | (Response | Error)[]>): Promise<Call[]> {
  const calls = serve(replies)
  renderApp(<Settings />, { path: '/settings' })
  await screen.findByRole('heading', { level: 2, name: 'Thresholds' })
  return calls
}

/** The default: a full payload and an estimate the dry-run button can price. */
const READS = {
  '/api/settings': json(PAYLOAD),
  '/api/ai/estimate': json(ESTIMATE),
}

const writes = (calls: Call[]): Call[] => calls.filter((call) => call.method !== 'GET')

/** The input for one threshold, by its label. */
const field = (label: string): HTMLInputElement =>
  screen.getByLabelText(label, { exact: false }) as HTMLInputElement

const save = (): HTMLButtonElement => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement

beforeAll(async () => {
  await i18nReady()
})

afterEach(async () => {
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
    expect(screen.queryByRole('heading', { level: 2, name: 'Thresholds' })).toBeNull()
  })

  it('shows every panel, and the build the answer came from', async () => {
    await open(READS)

    for (const title of ['Account', 'Assistant instructions', 'Thresholds', 'Accounts', 'AI usage']) {
      expect(screen.getByRole('heading', { level: 2, name: title })).toBeTruthy()
    }
    expect(screen.getByText('abc1234')).toBeTruthy()
    expect(screen.getByText('0.5.6')).toBeTruthy()
  })

  it('asks for the payload once, and for the estimate the test button needs', async () => {
    const calls = await open(READS)
    await screen.findByRole('button', { name: /^Test on/ })

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

    await screen.findByRole('heading', { level: 2, name: 'Drempels' })
    expect(writes(calls)).toEqual([
      { path: '/api/settings/profile', method: 'PATCH', body: { locale: 'nl' } },
    ])
    // Belgian formatting is not a language setting: the euro sign and the comma stay.
    expect(screen.getByText('€ 2,50')).toBeTruthy()
  })

  it('sends nothing when the language chosen is the one already set', async () => {
    const calls = await open(READS)
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'en' } })
    expect(writes(calls)).toEqual([])
  })
})

describe('thresholds', () => {
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

describe('accounts', () => {
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

describe('prompts', () => {
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
})

describe('a viewer', () => {
  const VIEWER: Payload = {
    ...PAYLOAD,
    profile: { ...PAYLOAD.profile, role: 'viewer' },
  }

  it('can read every threshold and change none of them', async () => {
    await open({ '/api/settings': json(VIEWER), '/api/ai/estimate': json(ESTIMATE) })

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
