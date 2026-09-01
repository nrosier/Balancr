# Changelog

All notable changes to Balancr, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the
scheme in [README](README.md#versioning) — a minor lands when its milestone is
complete, patches carry the work in between, and 1.0.0 ships when testing says so
rather than when the feature list ends.

## [0.3.2] — 2026-09-02

### Added
- **The Gemini adapter** (`src/adapters/gemini/client.ts`): the only thing that
  puts a payload on the wire, so it is the second half of the privacy review —
  `redact.ts` decides what a payload may contain, this decides that nothing else
  is ever sent. Financial data goes inside a delimited block and the system
  instruction states, in as many words, that the block is data and never
  instructions; a payload containing the fence markers is **refused rather than
  escaped**, because a payload that can close the fence can write instructions
  outside it. The fence contract is composed in code rather than stored with the
  prompt, so a prompt saved without it cannot exist. Provider choice
  (`aistudio` / `vertex`) is a pure exported function, since that decision is
  where the data physically goes.
- **Context caching** for the stable system prompt, with the failure path treated
  as a cost problem rather than a correctness one: a prompt below the provider's
  minimum cacheable size falls back to an inline instruction, and the outcome is
  remembered so a nightly pass does not retry a doomed `caches.create` every run.
  The cache key hashes the prompt text, so an edited prompt is never served from a
  stale cache.
- **A closed response schema** (`src/adapters/gemini/schemas.ts`): the model
  returns codes, labels and severities — never prose and never a number. Two
  layers, because one is not enough. The wire schema restricts `code` to the
  vocabulary, so an invented code is a parse failure; then `groundResponse`
  requires every finding to match a `(code, label)` pair that actually exists in
  the payload's signals, which is what catches the plausible hallucination — a
  *real* code about a *real* category that nothing computed. Dropped items are
  recorded with a reason, so that is visible rather than silent. Severity may be
  lowered by the model and never raised: the threshold that would justify an alert
  lives in `settings`, not in a sentence. A parse failure is an error, never a
  rendered guess.
- **The price table and cost arithmetic** (`src/adapters/gemini/pricing.ts`) in
  integer micro-euros, with dated per-model rates and longest-prefix matching so a
  dated or preview suffix prices as its family and `flash-lite` is never billed as
  `flash`. An unrecognised model is priced at the **most expensive** tier, so the
  guard overstates rather than understates what a call will cost.
- **Versioned prompts** (`src/domain/ai/prompts.ts`): the prompt lives in the
  database because a web app cannot edit `.env`, and it is versioned rather than
  overwritten — every edit is a new row, activation is a flag, and rollback is
  activating an older row, so no edit destroys the text that produced last month's
  output. At most one active version per `(key, locale)` is enforced by a partial
  unique index rather than by remembering to clear the old flag. Resolution steps
  down three levels — the locale's active version, then `DEFAULT_LOCALE`'s, then
  the built-in text — so a Dutch prompt nobody has written yet is served by the
  English one, and a database whose prompt rows were deleted can still produce a
  run. The built-in defaults are seeded at startup, idempotently, so a fresh
  install boots with a prompt that can be read in the UI instead of a hidden
  constant.
- **The run ledger** (`src/domain/ai/runs.ts`): one row per attempt, whether or
  not it reached Google. `payload_json` is exactly what was prepared for the call,
  stored verbatim — the record that makes the privacy claim checkable by opening a
  row rather than by argument. A refused attempt is still a row (`capped` when over
  budget, `blocked` when the call was refused before it went out), carrying the
  payload it would have sent, so a missing answer explains itself instead of just
  being absent. Cost is derived inside the writer from the model and the token
  counts, so no call site can record a call as free by forgetting a field.
- **The cost guard** (`src/domain/ai/budget.ts`) over a new `ai_spend_monthly`
  view: month-to-date spend is summed from the ledger and nowhere else, so there
  is no second counter to drift. Over budget serves the last stored answer with a
  banner and never fails hard; an estimate is checked against what is *left*, not
  just against the total, so a month at 95% cannot start a run costing half the
  budget again. `GEMINI_MONTHLY_BUDGET_EUR=0` reads as "no AI spend at all", since
  that is the one interpretation of a zero budget that cannot produce a bill
  nobody asked for. The view groups by **UTC** month deliberately — SQLite has no
  timezone database, and a fixed offset would be wrong half the year — and the
  guard computes its month key from the same rule.
- **A line diff** (`src/util/diff.ts`) for the prompt editor: LCS over lines,
  deletion-first on a tie, and a hard line cap so a pasted document cannot make the
  editor allocate a table nobody wants.
- Tests for all of it (140 new): the grounding refusals one by one, the fence
  refusal for a marker buried at any depth, the caching fall-back and its
  no-retry memo, thinking tokens billed as output, prompt rollback leaving exactly
  one active row, the three-step resolution, the ledger's verbatim payload, the
  view summing across statuses and grouping by UTC, and every branch of the budget
  decision including the zero budget.

### Changed
- Startup seeds the built-in prompts after migrations and before i18n, so the
  documented startup order still describes what happens.

## [0.3.1] — 2026-09-02

### Added
- **The redaction boundary** (`src/domain/ai/redact.ts`): one pure function from
  everything the aggregation layer computed to the exact object that is sent to
  Gemini, and the only path there. Amounts, baselines, deltas, allocation shares
  and category names cross; payees, memos, transaction ids, account names and
  numbers, instrument names, symbols and ISINs never do. Every field is written
  out by hand — no spreads, no `JSON.parse(JSON.stringify(x))` — because a spread
  is how a field added upstream rides along with no test failing. Categories and
  accounts are addressed by an opaque label (`c7`, `a2`) assigned in id order, so
  a stored payload still reads against today's data and the stable half of the
  prompt stays cacheable. A category flagged `sensitive` keeps its amounts and
  loses its name and description, so the model can still reason about the money
  without learning it is a therapist.
- **Finding assembly** (`src/domain/ai/findings.ts`): the editor between the
  producers and the page. One signal per code and category, keeping the most
  serious and breaking ties by size so a re-run cannot change the answer; hygiene
  findings first regardless of severity, because "312 transactions are
  uncategorised" is the reason not to trust the alert beneath it; then two per
  category and two dozen in total. Household findings are exempt from the
  per-category cap, since they are each about a different thing. Nothing is
  computed here.
- **Local rendering of every finding** (`src/domain/ai/render.ts`): a code plus
  numbers becomes a sentence from the i18n catalogue, so both languages come for
  free and output can never end up half-translated. One table maps each code's
  metrics to its sentence variables, exhaustive over `FindingCode` by type, and
  every value goes through `src/i18n/format.ts`. An account that was never
  reconciled says so instead of reporting `-1` days.
- `test/unit/ai-redact.test.ts` — the privacy guarantee, and load-bearing. A
  denylist built from the fixture's own account names, source ids, IBANs, ISINs
  and fund names, asserted absent from the serialised payload; a second assertion
  that the fixture really contains them, so the first cannot pass by testing
  nothing; and a key allowlist walked to any depth, which catches the field
  somebody adds later without deciding whether it is safe to send.
- `test/unit/ai-render.test.ts` walks the whole vocabulary in both languages,
  because a finding whose metric keys do not match its producer renders as
  nothing at all, and nobody notices a finding that is missing.
- **The signal orchestrator** (`src/domain/aggregate/signals.ts`): the one place
  that decides which deterministic producers run over a month and in what order,
  and the last purely computational step — everything after it only selects, hides
  or explains what it produced. Output is sorted but uncapped: these rows are
  facts, and capping them here would mean a threshold change rewrote history. The
  trailing window must end at the month being judged, and is asserted dense before
  anything reads a trend off it.
- **Month-level persistence** (`src/domain/aggregate/month-store.ts`): totals, the
  uncategorised backlog and recompute drift, so every pass after the sync reads a
  month from SQLite rather than downloading a budget again. `loadTrailingTotals`
  returns the unbroken run of months ending at the one being judged — a gap can
  exist legitimately, and the honest answer to a hole is a shorter window, not an
  average taken across it. Drift rows are replaced per month rather than derived
  from the mismatches passed in, so a month that has *stopped* drifting is cleared
  instead of showing yesterday's fixed problem forever.
- **Signal persistence** (`src/domain/aggregate/signals-store.ts`): a month's
  findings and its hygiene score, replaced wholesale on every run because a
  finding that has stopped being true has to disappear. The hygiene row is written
  even for a month with nothing to report, which is what lets a later pass tell
  "clean" apart from "not analysed". Reads are defensive: a code dropped from the
  vocabulary in a later version, or a metrics blob that will not parse, drops that
  row rather than making an old month unopenable.
- **The nightly signals job** (`src/jobs/signals.ts`): judges the current month
  and the one before it, so the month that just ended is seen once in its final
  state. Reads SQLite and nothing else, with one documented exception — Actual's
  account list, for `last_reconciled`, because a reconciliation is an event that
  exists only there. Actual stores that column as epoch milliseconds in a text
  field, so `reconciledDate` accepts both shapes and degrades to "never
  reconciled", which overstates the problem rather than hiding it.
- **The analysis collector** (`src/domain/ai/bundle.ts`): everything the model may
  see, gathered out of the fact tables. The counterpart to `redact.ts`, and it
  comes first — a field never collected cannot leak, whatever anyone adds
  downstream. It recomputes nothing: the hygiene score is read, not recalculated,
  and its window comes from the same `loadTrailingTotals` call the signals job
  makes, so the figure the model explains is the figure the page shows. A month
  that has not been judged returns null rather than a bundle of zeroes. Hidden
  categories with no money in them are dropped; hidden categories that saw money
  are kept, because that is worth knowing about.
- `loadFacts`, `loadCategoryMeta` (`src/domain/aggregate/facts.ts`),
  `loadLatestNetWorth` (`networth-store.ts`), `loadPortfolioMetrics` and
  `countSnapshotHoldings` (`src/domain/portfolio/store.ts`) — the read side the
  collector and the signals job need. The category name comes from
  `category_meta`, stored once, so a rename in Actual relabels every historical
  month at the same time.
- Four tables and six columns: `monthly_totals`, `recompute_mismatches`,
  `monthly_signals`, `monthly_hygiene`, and the baseline companion columns on
  `monthly_category_facts` (migration `0001_young_domino.sql`).
  `monthly_signals.subject_key` holds `''` rather than NULL for a household-level
  signal, because SQLite treats NULLs as distinct in a unique index and two
  household signals of one code would both be stored.
- `test/unit/ai-bundle.test.ts`, `month-store.test.ts`, `signals-store.test.ts`
  and `signals-orchestrator.test.ts` — 66 tests, including an end-to-end pass that
  builds a bundle out of the database, runs it through the real redaction
  boundary, and asserts both the key allowlist and the absence of every name that
  was in the tables.

### Changed
- `signalMagnitude` is exported from `src/domain/aggregate/overspend.ts`. The
  ranking breaks ties the same way the sort does, and two definitions of "which of
  these matters more" that can disagree would put the caps and the order out of
  step.
- `emergency_fund_short` reports `targetMonthsBp` rather than `targetBp`.
  `savings_rate_low` already had a `targetBp` measured in basis points of income,
  and one metric name whose unit depends on which code carries it is how a chart
  eventually prints "3 months" as "0,3%".
- Renovate proposes version bumps, never digests. A `uses: actions/checkout@abc123`
  diff cannot be reviewed — a patch bump and a hijacked tag read identically — so
  `pinDigests` is off explicitly, in case a preset turns it on.
- `BundlePortfolio` carries `holdingCount: number` instead of the holdings
  themselves, and the collector never puts a holding in a bundle at all. Which
  funds someone owns is the most identifying data in the set, so it is excluded a
  layer earlier than the redaction boundary: there is then no instrument name for
  a future field to carry out by accident, and asset-class shares plus a count say
  everything that can usefully be said about the shape of a portfolio. The
  privacy claim is structural rather than a matter of remembering to strip a
  field.
- `NetWorthSummary` and the `LIQUID` kind set are exported from
  `src/domain/aggregate/networth.ts`, so the stored snapshot can be summed back
  into the same summary shape the live computation produces. One authority per
  figure: the signals job reads the snapshot the net-worth pass wrote earlier in
  the same queue rather than recomputing net worth itself.
- `unreconciled_account` carries the account id as its subject. With a null
  subject two stale accounts landed in the household group, deduped into one
  finding, and left the redaction boundary with no id to turn into a label.
- The Docker build moved out of `ci.yml` into `image.yml`, and no longer runs on
  every pull request. On a source-only change it re-verified nothing: the image's
  build stage runs the same `npm run build` the `verify` job already ran, and every
  merge to main publishes `edge` from `release.yml` regardless, so the
  pull-request build was a third build of the same artefact. It now triggers on the
  paths that decide how the image is *assembled* — `Dockerfile`, `.dockerignore`,
  the lockfile, `tsconfig.build.json`, the two build scripts. `package.json` is on
  that list, which makes it the milestone gate too: the version bump that closes a
  milestone builds the image before it merges.
- Slices of an unfinished milestone now release as patches of the current minor.
  A minor keeps its meaning — `0.4.0` will be the version where the AI-layer
  milestone is *complete* — while work merged on the way there still ships under a
  version of its own, instead of sitting on main unreleased for weeks. So this is
  `0.3.1`: the aggregation milestone is what is finished, and two slices of the AI
  layer are on top of it.
- Workflow actions are referenced by version tag rather than by pinned digest, so
  the files match the rule `renovate.json` already states. A `@<40 hex> # v7` diff
  cannot be reviewed — a patch bump and a hijacked tag read identically — and
  Renovate would have kept proposing exactly those diffs.

### Fixed
- The release and licence badges no longer read "repo not found". Both were
  shields.io `github/…` endpoints, which fetch over the *public* GitHub API — on a
  private repository that is a 404, and a badge reading "repo not found" looks
  like a broken project rather than a closed one. Both are now static badges, and
  `npm run badges:check` (in CI) fails if either drifts from `package.json` or if a
  dynamic one is reintroduced. The CI badge is GitHub's own `badge.svg`, which a
  signed-in viewer with access can read, so it stays dynamic.
- Pluralised sentences print a Belgian number. i18next writes an interpolated
  value with `String()`, so `{{count}} months` rendered `2.4 months` in a UI that
  spells every other number `2,4`; `count` now selects the plural form and
  `{{value}}` prints it. The formatting lives in `t()` rather than in
  `interpolation.format`, which looks like the place for it and is not — i18next
  installs its own formatter during `init` and discards the hook. `npm run
  i18n:check` fails a plural key that reaches for `{{count}}` again.

## [0.3.0] — 2026-09-01

### Added
- Month arithmetic utilities (`src/util/month.ts`) — string-based `YYYY-MM`
  handling with timezone-correct month progress for burn-rate projection.
- Tunable aggregation parameters (`src/domain/aggregate/params.ts`) stored in
  `settings`: baseline window and half-life, winsorisation bounds, overspend
  thresholds with an absolute materiality floor, burn-rate tolerance, hygiene
  staleness limits. A malformed stored row degrades to defaults and logs, rather
  than taking the nightly job down.
- Baseline engine (`src/domain/aggregate/baseline.ts`): EWMA with a 3-month
  half-life over winsorised values, and frequency-aware smoothing so an annual
  premium is compared as a rate rather than flagged every year.
- The 53 roadmap issues on GitHub, seeded idempotently by
  `scripts/seed-issues.mjs` so the tracker can be rebuilt from the file.
- **Spend aggregation** (`src/domain/aggregate/spend.ts`): dense facts per
  (month, category), Actual's own figure alongside our AQL sum on one sign
  convention, the uncategorised backlog, and a signed report of any difference
  between the two — a wrong hygiene rule announces itself instead of quietly
  feeding every baseline downstream.
- **Overspend signals** (`src/domain/aggregate/overspend.ts`): the four questions
  kept separate — over assigned, over available, over your own baseline, over the
  external benchmark — plus a mid-month burn-rate projection, good news when a
  category drops below its norm, and `irregular_expense` for a first-ever cost.
  Every relative signal is gated on an absolute floor, because a EUR 7 envelope
  40% over is EUR 2.80.
- **Hygiene signals and score** (`src/domain/aggregate/hygiene.ts`): uncategorised
  backlog, recomputation mismatch, accounts whose balance has become a guess for
  want of reconciling, and portfolio snapshots past their staleness limit. The
  score is an explicit capped-deduction model from 10000 bp rather than a weighted
  average, and reports what it deducted and why, so a number the AI narrates is
  never unexplainable. Snapshot staleness is documented as the age of *our*
  snapshot, because Ghostfolio's API exposes no as-of date for a market price.
- **Net worth** (`src/domain/aggregate/networth.ts`): one figure out of two systems
  that both think they know it. `account_map.dedupe_group` plus
  `is_source_of_truth` stops an Actual investment mirror and the same Ghostfolio
  positions being added together, which would overstate net worth by the size of
  the portfolio — wrong in the flattering direction and entirely plausible. A
  group with no source of truth is reported explicitly rather than silently
  counted as nothing, because too-low net worth has no symptom.
- **Household signals** (`src/domain/aggregate/household.ts`): savings rate against
  target, income moved against its own norm, emergency fund in months of
  *typical* spend, and a new net-worth high. Every ratio with a zero denominator
  produces nothing at all rather than an infinity.
- `daysBetween` and `assertDate` in `src/util/month.ts`, for staleness measured in
  calendar days rather than in instants.
- **Idempotent fact persistence** (`src/domain/aggregate/facts.ts`): upsert rather
  than delete-then-insert, so no page load can catch a month mid-rebuild; stale
  rows for categories that vanished are removed explicitly. `category_meta`
  tracks renames without ever overwriting what the user typed.
- `assertDenseMonths` in `src/util/month.ts`, shared with the baseline engine.
- `recompute_mismatch` finding code — the cross-check had no way to speak.
- `capSeverity`, so the ceiling declared in `FINDING_SPECS` is a rule that applies
  to the model's output and our own signals alike, not documentation.
- `GET /` answers with the version and where the UI will be, instead of a bare
  Fastify 404 that reads as a broken deployment.
- Golden tests throughout: hand-computed EWMA and interpolated quantiles, the
  annual-premium case the frequency window exists to handle, the Brussels midnight
  case where UTC still says the previous month, sign normalisation in both
  directions, the chunk boundary in the writer, each overspend signal proven to
  fire on its own, the dedupe cases that would misstate net worth in either
  direction, and the annual-premium month that must not shorten the emergency
  fund on paper.

- **Account mapping** (`src/domain/aggregate/accounts.ts`): both tools' accounts
  into one table, under one rule — a sync may create rows and follow renames, but
  may never overwrite a decision. Dedupe candidates are only offered where a
  mirror plausibly exists, and marking a group picks exactly one source of truth.
- **Portfolio snapshots and metrics** (`src/domain/portfolio/`): Ghostfolio's
  floats become integer cents exactly once, at the boundary, while quantities stay
  text so a fractional share survives the round trip. Two positions in the same
  ISIN merge into one instrument. Allocation shares are apportioned by largest
  remainder so they sum to exactly 10000 bp — a pie chart labelled 99.97% invites
  the reader to distrust every other figure on the page. Return is *copied* from
  Ghostfolio rather than recomputed, because two implementations that can disagree
  is the problem and not the fix; `mwrBp`, `driftJson` and `terAnnualCents` stay
  null with the missing input named, since a guess would render as a number.
- **Job layer** (`src/jobs/`): `isDue` over `{interval}` and `{daily}` schedules,
  compared on the *local* calendar day and hour, so a DST change can neither skip
  the nightly pass nor run it twice — and no cron dependency. `nextRunAt` probes
  that same predicate forward instead of re-deriving calendar arithmetic that
  would be free to disagree with it.
- Every job shares one queue, because Actual's `dataDir` makes no concurrency
  promises; a job never throws at the ticker, the `jobs` row is written on failure
  too, and `lastSuccessAt` is deliberately left alone so it keeps meaning "how
  stale the data is" rather than "when we last tried". Rows left `running` by a
  killed container become errors at startup — otherwise the one field an operator
  reads is the one nobody believes.
- Three jobs, registered in dependency order because one queue is all the
  sequencing needed: `sync` (read-only Actual pass, facts rebuild, account map),
  `portfolio` (holdings snapshot and metrics, stamped with the *local* date so a
  night-time run cannot overwrite yesterday), and `networth` nightly. A Ghostfolio
  outage degrades each of them to stale-but-labelled data instead of aborting the
  pass, and a failed earlier job still lets the later ones run.
- `historyDepth`: each pass loads `windowMonths + 11` months of budget history
  before the first target month, pinned by a test against `computeBaseline` itself
  rather than against a number — too little history makes every annual baseline
  null, and that failure is completely silent.
- Scheduler wired into startup behind `JOBS_ENABLED`, and stopped before the HTTP
  server on shutdown so a pass in flight is never cut off mid-write.
- `JOBS_ENABLED`, `JOBS_SYNC_INTERVAL_MINUTES`, `JOBS_NIGHTLY_HOUR` and
  `JOBS_HISTORY_MONTHS` in `.env.example`, with what each one costs.
- `dateIn` and `hourIn` in `src/util/month.ts` — the scheduler's "is it past
  03:00 yet" has to be asked in Brussels, not in UTC.

### Changed
- `BaselineResult` reports `winsorEffectBp` — how far winsorisation moved the
  norm — instead of a `clamped` boolean. Because the quantiles are interpolated,
  the p5/p95 clamp nudges the extremes of every series that is not perfectly
  flat, so the boolean was true for nearly every category and told a reader
  nothing.
- `above_baseline` may now carry `alert`. It was capped at `warn`, which made
  `overspend.baselineAlertBp` a threshold that could not change anything.

## [0.2.0] — 2026-09-01

### Added
- **Actual Budget adapter.** Sole owner of the sync `dataDir`, with all
  operations serialised because the API makes no concurrency guarantees. Exposes
  reads only — a test scans the module against a denylist of mutating methods, so
  an accidental write is a failing build.
- **ActualQL queries** for accounts, categories, groups, budget months, account
  balances and a recomputed monthly spend used as a cross-check. Every response
  is schema-validated, since `aqlQuery` returns `unknown`.
- **Ghostfolio adapter** with anonymous-token auth, JWT caching, exactly one
  re-authentication on a 401, and a request timeout so a hung upstream cannot
  hang the nightly job.
- **Capability probe** (`npm run probe`) that validates every response shape and
  distinguishes *unreachable* (retry later) from *shape-mismatch* (stop writing
  snapshots — the contract changed). It also reconciles every category total
  against Actual's own figures, which is the acceptance test this app's
  credibility rests on.
- Version alignment check between `@actual-app/api` and the Actual server, warned
  rather than fatal: taking Balancr down on every server upgrade is its own
  failure mode.
- CI (typecheck, i18n parity, tests, image build), gitleaks secret scanning,
  Renovate configuration, Dockerfile and compose stack, README.

### Fixed
- `/healthz` reported `"version": null` inside the container: npm sets
  `npm_package_version` only for processes it starts, and the image runs
  `node dist/main.js`. The version is now read from the shipped `package.json`.
- Replaced Fastify's deprecated top-level `disableRequestLogging` with a
  `LogController` instance — the option is removed in Fastify 6.
- Runtime image carried 27 MB of the TypeScript 7 Go compiler: npm does not mark
  an *optional* dependency of a *dev* dependency as dev, so `--omit=dev` kept it.
  `scripts/prune-runtime-deps.mjs` now drops it along with the native prebuilds
  for platforms this image cannot run.

## [0.1.0] — 2026-09-01

### Added
- Environment configuration validated at import time, with cross-field rules
  reported all at once.
- SQLite schema (Drizzle): identity, source mapping, category knowledge, computed
  facts, AI audit trail, ops.
- i18n with English and Dutch catalogues (209 keys each), generated from one tree
  so parity is structural, and enforced by `npm run i18n:check`.
- Formatting split from language: amounts and dates stay Belgian in every UI
  language, because `Intl` with `en-BE` yields `€1,234.56`.
- Closed AI vocabulary (16 finding codes, 5 clarification codes) with sentences
  rendered locally from the catalogues.
- Logging with a redaction denylist at the sink.
