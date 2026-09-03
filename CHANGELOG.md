# Changelog

All notable changes to Balancr, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the
scheme in [README](README.md#versioning) — a minor lands when its milestone is
complete, patches carry the work in between, and 1.0.0 ships when testing says so
rather than when the feature list ends.

## [Unreleased]

### Added

- **A month's spending, compared with Belgian households**
  ([#43](https://github.com/nrosier/Balancr/issues/43)). Your own twelve-month norm cannot
  answer "is €650 a month on food a lot", so the budget page gained the card that can.
  Statbel's Household Budget Survey publishes the share of its total an average household
  spends on each of ten lines; `config/statbel-benchmark.yaml` carries those shares with
  the survey, the year, a citation, the day somebody last checked them and a `status` per
  block, and `BENCHMARK_PATH` selects it. A path that does not exist removes the comparison
  and leaves every other figure untouched — not everybody wants an average held up against
  their spending. Nothing in the app can edit a share: a screen that let anybody type over
  the reference would be a screen that manufactures one, which is the single failure that
  would make the feature worse than its absence.
- **A COICOP division per category, and a thirteenth answer for what is not consumption**
  (`src/domain/benchmark/mapping.ts`, Settings → Benchmark mapping). The picker offers the
  twelve divisions the survey is classified against rather than the survey's ten lines,
  because three divisions share its "other expenditure" line and "other" would store a code
  nothing could later resolve; the line each division feeds is shown beside the choice
  instead. `00` is Balancr's own code for savings, investments, taxes, transfers and debt
  repayment: those are set aside from the comparison rather than counted at zero, since a
  budget holds plenty of them and counting them would make every real share look small. A
  stored code deeper than a division (`04.5.1`) is read at the division and shown as
  selected, so a category the comparison counts under housing can never read as unmapped.
- **An equivalence scale, with the one part of it that is Balancr's own labelled as such**
  (`src/domain/benchmark/household.ts`, Settings → Household). A single parent spends less
  than the average household and is not being frugal, so the reference is scaled by who
  lives here: the modified OECD scale out of the same file, 1,0 for the first person, 0,5
  per additional adult and 0,3 for a child under fourteen. Members are years of birth
  rather than "child" checkboxes — a checkbox is right on the day it is ticked and quietly
  wrong from the next birthday — and ages are taken as of the year being compared, so
  somebody who turned fourteen in March is a child in last January's figures. Custody is a
  share of the time per member, and prorating a weight by it is *not* something the
  published scale supports: `prorated` travels with the result and every screen that prints
  a prorated figure says the assumption out loud.
- **Two bases out of one file** (`src/domain/benchmark/compare.ts`). With only the shares
  transcribed the comparison is `mix` — how your month divides against how theirs does,
  stating that nothing in it claims you spend more than they do. Fill in the optional
  `reference_household` block and the same card becomes `level`, euro for euro, scaled to
  your household's size on the scale. Both carry the citation, the year, the verification
  date and the list of blocks nobody has confirmed at the source.
- **Two refusals, so a comparison is never a chart about the mapping**
  (`src/domain/benchmark/vocabulary.ts`). Under 70% of the month mapped nothing is drawn
  and the card says what to go and map: 100% would mean the feature never switches on
  because nobody maps every envelope, and 50% would mean a figure about the bookkeeping.
  A group with no reference share, a month with no spending and a month mapped entirely to
  `00` each come back as an explicit unavailability reason rather than as a zero.
- **`above_benchmark` emits at last, and can only ever be `info`**
  (`src/domain/aggregate/overspend.ts`). The fourth overspend signal was a stub returning
  nothing since `0.3.1`; it now fires per group above the reference by more than 20% *and*
  more than the shared materiality floor in euros. There is deliberately no opposite code:
  spending less than average on transport is what not owning a car looks like. The severity
  is capped in the payload rather than by convention, and `web/src/budget/benchmark.css`
  has no red cell to render a difference in — a household above the transport line has done
  nothing wrong, and neither has one below the restaurants line.

### Changed

- **`computeSignals` takes the comparison as an input** (`src/domain/aggregate/signals.ts`).
  The module is pure and the comparison reads a YAML file, a settings row and the category
  mapping, so `jobs/signals.ts` reads all three once per pass — none of them is a fact about
  a particular month — and hands the result in, the same arrangement `netWorth` already had.
- **The household roster is replaced whole, not merged**
  (`PATCH /api/settings/household`). Unlike the risk bands and the aggregation parameters:
  `members` is a list, and the only two gestures a form makes on a list are "here is the new
  one" and "remove a row". A merge cannot express the second.

## [0.8.0] — 2026-09-03

### Added

- **A risk profile, in numbers rather than an adjective**
  ([#41](https://github.com/nrosier/Balancr/issues/41)). "Some risk, but not super high
  risk" cannot motivate a trade, so Settings → Risk profile is where it becomes twelve
  numbers: a floor, a target and a ceiling for equities, bonds, property and commodities,
  plus the two thresholds that decide when a drift is worth acting on at all. Three presets
  arrive with their own figures shown before anything is committed to, and they come from
  the server rather than being written out again in the browser — a second copy of
  "balanced" is a second definition of the profile the advice was computed against.
- **Editing a band makes the profile `custom`, and the panel says so as it happens**
  ([#41](https://github.com/nrosier/Balancr/issues/41)). The profile in force is the
  numbers; the name is a label on them. So a hand edit sends the bands and no name, an
  untouched preset sends the name and no bands, and the two are mutually exclusive by
  construction. All four bands travel together, because four targets with one left over
  from the previous profile is precisely the state that adds up to 97%.
- **The drift from it, one row per band class, worst first**
  (`src/domain/advice/drift.ts`). Including the classes worth nothing: zero bonds against
  a 30% target is the most actionable row the page can draw, and a table built from what
  is held would leave it out entirely. Shares are of the *invested* value, which the
  caption states — cash at a broker is not an asset class, and on an instance whose
  Ghostfolio holds a synced bank balance measuring against the total would drop every
  class below its floor at once. A class Ghostfolio has and the profile has no band for
  comes back as `unmapped` with its share, never quietly folded into a neighbour.
- **A trade per class that left its band, carrying the figure that motivates it**
  (`src/domain/advice/suggest.ts`). #41 asks for no suggestion without its drift figure,
  so `Suggestion` holds the whole `DriftLine` it came from and cannot be constructed
  without it — the reason on the card and the row in the table are one function over one
  field rather than two paragraphs that can drift apart. A purchase may only name an
  instrument that came through `assertProposable`, so a class with no fresh fund in the
  universe produces a card saying which of the two reasons it is instead of a plausible
  ticker.
- **`funding`, because the size of a trade depends on where the money comes from**
  (`src/domain/advice/suggest.ts`). Buying from cash grows the base the share is a share
  of, so closing an apparent gap at a 65% target takes nearly three times the gap; when
  the same report also wants a sale, the two fund each other and the gap *is* the trade.
  Each suggestion states which case it is. One figure quoted for both would be wrong by a
  factor of three in whichever case it was not written for.
- **What acting would cost, from the tax module, on every card**
  ([#42](https://github.com/nrosier/Balancr/issues/42) put to work). The same
  `describeTaxEstimate` a digest would call, so the estimate reads identically everywhere
  and the browser holds no second copy of the tax vocabulary. `taxOmits` is never empty on
  a sale: the realised gain needs a cost base this app never sees, and a total that
  quietly dropped it would read as complete.
- **A band outside its edge and left alone says which threshold suppressed it**
  (`skipped`). A red row with no suggestion under it is a bug report waiting to be filed,
  so the page names the threshold, the distance past the edge and the size of the trade —
  the three numbers needed to judge whether the threshold is set right.
- **Ghostfolio's class labels, per position** (`0012_old_rhino.sql`). `asset_class` and
  `asset_sub_class` on `portfolio_snapshots`: a sale has to name the position it would
  come out of, and the sub-class is what beurstaks turns on — 0,35% on a share against
  0,12–1,32% on a fund, so pricing every position as a fund overstates a share's exit by
  nearly four times. No backfill and no default: today's holdings are re-fetched every
  pass, and a historical row whose label was never recorded stays null and is simply not a
  candidate, which is the honest reading of "we do not know what this is".

### Changed

- **`GET /api/portfolio` computes the drift rather than reading it**
  (`src/server/routes/api/portfolio.ts`). The one exception to that route's rule, stated
  where it is broken: drift is a comparison against a profile the settings page can change
  at any moment, so a figure written by the nightly job would disagree with the bands on
  screen for up to a day. `portfolio_metrics.drift_json` stays null for the same reason.
  The profile, the fund universe and the tax rules are three cheap reads, each of which
  degrades to "no advice" rather than to a 500.
- **The tax wire types spell `| undefined` on their optional fields**
  (`src/domain/tax/estimate.ts`). JSON has one way to be absent and
  `exactOptionalPropertyTypes` has two, so a line parsed back out of the response schema
  was not assignable to the one function that has to run on both sides of the wire.
  Producers are unaffected. `UNKNOWN_REASONS` and `ASSUMPTIONS` became const arrays at the
  same time, so the response schema enumerates them from the domain rather than repeating
  them.

## [0.7.2] — 2026-09-03

### Added

- **What a trade actually costs, in euros, before it is made**
  ([#42](https://github.com/nrosier/Balancr/issues/42)). The Belgian taxes on a concrete
  transaction: beurstaks on the way in and out, roerende voorheffing on a dividend, the
  Reynders levy on a bond fund's interest component, and the capital-gains tax that arrived
  in 2026. Every figure is computed in TypeScript from a dated rules file — the model is
  never asked for a rate and never asked for arithmetic.
- **Dated rulesets, selected by the transaction's own date**
  (`config/belgian-tax.yaml`, `src/domain/tax/rules.ts`). A sale in December 2025 is taxed
  under 2025's rules and one in January 2026 under 2026's, which is the difference between
  a €0 capital-gains bill and a real one. The shipped file carries both. A transaction
  before the oldest ruleset is refused rather than estimated, because the alternative is an
  estimate under rules that were not in force.
- **A `status` field instead of a disclaimer in a comment**
  ([#42](https://github.com/nrosier/Balancr/issues/42)). Every rate carries the article it
  came from (`WDRT art. 1262`, `WIB92 art. 19bis`), the day it was last checked, and
  `status: confirmed | transcribed`. Everything shipped is `transcribed` — transcribed from
  published guidance, not verified against the law by anyone — and that field drives a
  sentence on screen naming the taxes in play, in both languages. A citation was chosen
  over a URL as the required field because an article number does not rot.
- **A range where a guess would be cheaper than the truth**
  (`src/domain/tax/estimate.ts`). Whether an accumulating fund pays 1.32% or 0.12%
  beurstaks turns on Belgian registration, which nothing in the ISIN, the domicile or the
  exchange reveals. Left unrecorded, the estimate reads "between € 1,20 and € 13,20" and
  never either end of it: falling through to the low fallback rate would understate the
  cost elevenfold, in the one direction that makes a trade look cheap. The same holds for a
  bond fund's interest component, which only the fund publishes — unknown reads as unknown,
  with a line saying what to go and find out.
- **A rules file that cannot answer "no rate found"** (`src/domain/tax/schema.ts`). Two
  structural refusals at load, each naming the tier and stating the fix: an instrument kind
  with no unconditional fallback tier, and a tier whose conditions are satisfied by
  everything below it, which can therefore never apply. Both are the failure mode where an
  edited file keeps working and starts being quietly wrong.
- **`fsma_registered` and `debt_claims_percent` on a fund universe entry**
  (`src/domain/universe/schema.ts`). Both optional, both replacing an inference rather than
  a default: the first decides the beurstaks tier, and the second replaces guessing a mixed
  fund's debt-claim share from its asset class — which the estimate records as an assumption
  on the line when it has to.
- **`TAX_RULES_PATH`** (default `./config/belgian-tax.yaml`). Unlike the fund universe, the
  default points at a real file inside the image, because nobody curates their own tax code
  — and there is deliberately no companion max-age variable: tax staleness is displayed on
  every line and in the startup log, and never enforced. A rate that changed last month,
  shown with the date it was last checked, still beats no estimate; CI proves the shipped
  file loads in the built image.
- **The glossary finally has a consumer** (`src/domain/tax/describe.ts`). Each line is
  named with the wording a Belgian broker statement uses — `Beurstaks (TOB)`,
  `Reynders-taks`, `Roerende voorheffing` — in the English UI too, and the catalogue is
  asserted to contain no percentage at all: a rate written into a translation is one the
  next government makes wrong, in the last place anybody looks. `formatBp` grew a
  `maxFractionDigits` option for the same reason, because 0,12% and 1,32% both round to
  one decimal and stop being eleven-fold apart.

### Changed

- **The YAML reader and the "not in the future" date are shared** (`src/yaml-file.ts`,
  `src/domain/verified-date.ts`), extracted from the fund universe rather than copied for
  the tax rules. The parts worth having twice are the ones that make a message fixable — a
  YAML error's line and column, the path in every sentence, and an empty file parsing to
  the value the caller meant rather than to a schema violation about a missing key.

## [0.7.1] — 2026-09-03

### Added

- **A curated fund universe: the only instruments advice may propose**
  ([#40](https://github.com/nrosier/Balancr/issues/40)). A YAML file, written by the person
  whose money it is, read fresh on every use so an edit needs no restart. `assertProposable`
  is the only way to turn an ISIN into a fund a proposal may act on, and the same gate is
  exported as a Zod schema (`proposableIsinSchema`) so a payload type cannot be written that
  skips it — the alternative, a plain string field plus a call somewhere in a handler, is one
  refactor away from being forgotten. Absent file means empty universe means advice proposes
  nothing and says so at startup; a malformed file is a warning at boot and an exception at
  the point of use, because "the fund list was broken so I ignored it" is not a thing to do
  quietly when the next step is a trade.
- **ISIN check-digit validation**
  ([#40](https://github.com/nrosier/Balancr/issues/40)). The only claim in a hand-written
  fund list that code can verify without a network. A transposed pair of characters is
  otherwise a valid-looking reference to a different instrument, and the refusal says which
  mistake it was — wrong length, wrong shape, or `ends in 4 but its check digit is 3` —
  because the fix differs and the reader has a KID in front of them.
- **Three rules the loader enforces, and a fourth that expires**
  ([#40](https://github.com/nrosier/Balancr/issues/40)). Accumulating share classes only
  (a distributing one pays out dividends that Belgian roerende voorheffing taxes at 30%
  every year, which is a different decision and not an interchangeable one); EEA-domiciled
  UCITS only (the passport that means a KID exists and a Belgian broker can sell it — why
  `IWDA` qualifies and `VTI` cannot); `ter_percent` rather than `ter`, because a factor of a
  hundred in that field is invisible in every screen that shows it. And `last_verified`,
  which past `FUND_UNIVERSE_MAX_AGE_DAYS` (365) makes an entry unproposable rather than
  merely flagged — and leaves it out of what the model is shown at all, so a stale fund is
  never offered and then refused.
- **`FUND_UNIVERSE_PATH` and `FUND_UNIVERSE_MAX_AGE_DAYS`**
  ([#40](https://github.com/nrosier/Balancr/issues/40)). The path defaults to
  `./config/fund-universe.yaml`, which nothing creates: `config/fund-universe.example.yaml`
  is a template of eleven accumulating UCITS funds that ships in the image beside it, and
  copying a template is not the same as having vetted it. Both values appear in the startup
  configuration summary, because "advice proposed nothing" is answered by one of them.
  `scripts/verify-image.sh` boots the built image pointed at the shipped template, so the
  file people copy out of the image is proven to parse under the schema as published.

## [0.7.0] — 2026-09-03

### Added

- **Deployment hardening, verified rather than declared**
  ([#39](https://github.com/nrosier/Balancr/issues/39)). Non-root, a read-only root
  filesystem, `cap_drop: ALL` and `no-new-privileges` were already in the Dockerfile and
  `compose.yaml` — as configuration, which is to say as claims. `scripts/verify-image.sh`
  now starts the built image with exactly those flags and asks the running container: is
  this uid non-root and is it `node`, does `/app` really refuse a write, does `/data`
  really accept one, is `CapEff` all zeroes, is `NoNewPrivs` set, do both native modules
  load, and does the image's own `HEALTHCHECK` command work — a broken one makes Docker
  restart a healthy container every interval, forever. CI runs it on every image build.
  Runnable by hand, which is why it is a script rather than workflow YAML.
- **Egress restricted to the hosts this deployment is configured for**
  ([#39](https://github.com/nrosier/Balancr/issues/39)). `EGRESS_MODE=enforce` by
  default: a connection to anything that is not Actual, Ghostfolio, the OIDC issuer or
  Google's Gemini endpoint is refused, and the host is logged. The allowlist is derived
  from the same `.env` values the adapters read, so it cannot drift from the
  configuration — moving Ghostfolio to a new hostname needs no second edit. `warn` allows
  and logs instead, which is how you see what a newly added dependency wants before
  deciding whether it should have it; `EGRESS_EXTRA_HOSTS` covers an outbound proxy. A
  denial logs the host and never the path or query, because on an exfiltration attempt
  the query string is the data. What it defends against is a dependency rather than a
  network: it wraps global `fetch`, so it covers the Ghostfolio adapter, the Gemini SDK
  and `openid-client`, and it does not cover a library reaching for `node:http` directly,
  a native module, or a child process — stated plainly in `src/egress.ts` rather than
  oversold, and the reason the network-level rule is still worth having.
- **The mode of `.env` is checked at every start**
  ([#39](https://github.com/nrosier/Balancr/issues/39)). One line if the file holding the
  Actual password, Ghostfolio token, Gemini key, session secret and backup passphrase is
  group- or world-readable, naming the mode and the command that fixes it. A warning, not
  a refusal. Silent in a container, where compose reads `.env` on the host and there is
  no such file to have a mode.
- **Image size and startup time recorded in the job summary**
  ([#39](https://github.com/nrosier/Balancr/issues/39)) — 410 MB and one second to the
  first `/healthz` on amd64 today — with ceilings a little above those. Not targets:
  tripwires, so a change that doubles either has to be a deliberate edit to the script
  rather than something nobody noticed.

### Fixed

- **The runtime prune understood one of the two prebuild layouts, and shipped seven
  unloadable binaries per image** ([#39](https://github.com/nrosier/Balancr/issues/39)).
  `scripts/prune-runtime-deps.mjs` handled `prebuilds/<platform>-<arch>/` directories,
  which is what `argon2` ships, and not flat `prebuilds/<platform>-<arch>.node` files,
  which is what `better-sqlite3` 13 ships — so every image up to this one carried all
  eight of its platform binaries, including Windows and macOS. Vendored C sources go too:
  10 MB of SQLite amalgamation per copy of `better-sqlite3`, read only by `node-gyp` at
  install time, and there are three copies. Seventy megabytes in total. The pruner also
  takes the target architecture as an argument now instead of assuming amd64, because the
  same bug in reverse deletes the only binary an arm64 build can load, and it refuses to
  leave a native package with no binary at all rather than letting that surface as a
  container that will not start. All of it covered by
  `test/unit/prune-runtime-deps.test.ts`, which asserts what survives as well as what
  goes: deleting too little was silent for six milestones.

## [0.6.4] — 2026-09-03

### Added

- **Nightly encrypted backups, and a restore that has been performed rather than
  assumed** ([#38](https://github.com/nrosier/Balancr/issues/38)). Almost everything in
  the database is recomputed from Actual and Ghostfolio by morning; what is not is the
  part you typed — every category description, COICOP code and sensitivity flag built up
  by answering questions about your own budget, plus the prompt versions and the cost
  ledger. `BACKUP_PASSPHRASE` switches it on and is the only flag there is: empty means
  off, which is the right setting when the volume is already covered elsewhere. Each
  night, last in the job order so it captures that night's work, the database is copied
  with `VACUUM INTO` — through SQLite, rather than a file grabbed from underneath a live
  WAL — and encrypted with AES-256-GCM under a scrypt-derived key, header authenticated
  as associated data so the cost parameters cannot be edited into a denial of service.
  `/data/actual` is excluded: it is a cache of a budget the Actual server still holds.
  `BACKUP_DIR` defaults inside the one volume, with the limit that implies stated in the
  README rather than left to be discovered.
- **`npm run backup:verify`**, which answers the question a nightly job cannot answer
  about itself: that the passphrase in `.env` today is the one those files were written
  with, that they decrypt, and that what comes out is this deployment's data and not an
  empty schema. It decrypts into a private temp directory, runs `PRAGMA integrity_check`,
  counts eight tables and deletes the copy — safe against production.
- **`npm run backup:restore`**, which exists because the format is Balancr's own and no
  `openssl` incantation opens one of these files. It verifies the snapshot in full
  *before* anything moves, so a wrong passphrase or a damaged file fails while the live
  database is still in place, and it never deletes: the database being replaced is
  renamed to `balancr.db.pre-restore-<stamp>`, `-wal` and `-shm` sidecars moved with it.
  The README documents the procedure; `test/unit/backup-restore.test.ts` runs it on every
  test run, including the refusals, asserting each time that the target was left
  byte-for-byte unchanged.
- **`backup` on the refresh control**, for taking a copy by hand before doing something
  risky. Retention is deliberately not fooled by that: a file is deleted only when it is
  both older than `BACKUP_KEEP` days *and* surplus to `BACKUP_KEEP` files, so a manual
  backup never evicts a scheduled one, and an instance switched off for a month does not
  come back and delete its own history for being old.

## [0.6.3] — 2026-09-03

### Added

- **The AI layer is optional, and an instance without it says so instead of refusing
  to start** ([#165](https://github.com/nrosier/Balancr/issues/165)). `vertex` is the
  default provider and needs `GOOGLE_CLOUD_PROJECT`, so a copied `.env.example` with
  the Gemini block untouched could not boot at all — a paid dependency demanded of
  someone who wanted the budget figures. Missing credentials now switch the model off
  silently; only a *contradiction* is still refused, where the provider names one
  credential and the other one is the one that is set. `AI_ENABLED` is the second half:
  a way to pause spending without editing a key out of `.env` and back in.
- **One reason code, five surfaces.** `aiAvailability()` distinguishes no credential,
  `AI_ENABLED=false` and a budget of zero, in that order of precedence, and it reaches
  the pages on `/api/insights` and `/api/settings` as a code rather than a sentence, so
  both catalogues carry the wording. The insights page prints what is missing, what is
  unaffected — the signals, the burn rate, the net worth, none of which ever involved a
  model — and the one line of `.env` that changes it. The three sections only a model
  can fill are dropped rather than printing their own "nothing pending yet", which on a
  deployment without a key is a lie by omission; anything already stored still renders,
  because switching the model off is not a reason to throw away last month's narrative.
- **The two controls that spend money check first.** The by-hand analysis and the prompt
  editor's test run explain the state in place of their button, rather than discovering
  the refusal by being pressed. The prompt editor otherwise stays fully usable: writing
  and versioning the instructions is worth doing before buying a key.

### Changed

- **The nightly AI pass reports `ok` with a reason instead of failing.** An instance
  that never bought a key does not want a red job row every night for a dependency it
  deliberately does not have, and the ops row names the variable to change rather than
  saying "0 findings" for the third night running. The three paid endpoints answer
  `409` with the reason spelled out — not `503`, which would invite a retry of a request
  that will fail identically until someone edits `.env`.

## [0.6.2] — 2026-09-03

### Fixed

- **Context caching is no longer asked for at a size it cannot be granted**
  ([#121](https://github.com/nrosier/Balancr/issues/121)). Google will not cache a
  context below 1024 tokens. Balancr's system prompts are 453 and 589 tokens, so every
  process start spent a failed `caches.create` per model to rediscover that, and wrote
  `context caching unavailable` into the log of a system that was working exactly as
  designed.

  The minimum is now a local rule rather than a discovered error: the instruction's
  token count is estimated before the call and the create is skipped when it is plainly
  short, logged once at debug as a statement of fact. The estimate deliberately
  over-states English prose — three characters per token against a real four — because
  the two errors are not symmetric: guessing high can only make Balancr attempt a create
  the provider then refuses, which is one round trip and the old behaviour, while
  guessing low would silently skip a cache that would have worked. The provider stays
  the authority, and a create that is attempted and rejected still falls back to sending
  the instruction inline.

  The mechanism stays. The fund universe ([#40](https://github.com/nrosier/Balancr/issues/40))
  is what caching was built for and what will push the prompt past the floor, at which
  point this check stops firing and nothing else changes.

### Added

- `GEMINI_CACHE_MIN_TOKENS` (default `1024`). Google changing the floor becomes a
  config edit rather than a release, and `0` disables the check entirely — ask, and take
  the provider's answer.


## [0.6.1] — 2026-09-03

### Added

- **Refresh on demand, all of it or one source**
  ([#122](https://github.com/nrosier/Balancr/issues/122)). Until now the only way to
  make a figure current was to wait for the schedule or restart the container. Every
  page already says how old its numbers are; this puts the control next to the
  sentence, and each page starts only the jobs whose figures it shows — the budget
  page does not wait through a Ghostfolio download to re-read a category total.

  `POST /api/refresh` takes no body for "everything the figures come from" — `sync`,
  `portfolio`, `networth`, `signals` — or `{"jobs":[…]}` for a subset. **Selective
  refresh runs the dependents rather than leaving them behind**: `sync` also runs
  `networth` and `signals`, because a budget re-read that left net worth computed
  from the previous one would make the two halves of the overview disagree. The
  response separates `requested` from `accepted`, and the screen names the
  difference — *"Net worth, Signals ran as well"* — so nothing moves unexplained. An
  empty array and an unknown job name are both rejected; neither is quietly read as
  "all of them".

  **`ai` is refused by name**, with a `403` that says where its control is. It is
  the one job that spends money, and a page-level "refresh everything" that quietly
  called Gemini would be a button with a price the reader cannot see. It has an
  endpoint of its own — `POST /api/ai/refresh`, owner-only, in the strict AI bucket —
  and a control of its own on the settings panel that already prints what the month
  has cost: priced first from `GET /api/ai/estimate`, then confirmed with the amount
  in the button's own label. Over budget it stays pressable on purpose, because the
  cost guard's documented answer is a cached result with a banner and the endpoint is
  the single place that decides.

  **One refresh at a time, and "running" is not read from a row.** A second request
  answers `409`; what makes that answer safe is that in-flight work is tracked in the
  process, so a `running` row left behind by a crash blocks nothing after a restart.
  Every start is audited as `jobs.refresh` with the actor and the job names, which the
  `jobs` table cannot record — it holds one row per job, overwritten by every run.

  On screen, progress is **read from the job rows rather than timed**. "Refreshed" is
  said only once every accepted job has a row newer than the request, where a row
  still marked `running` and a job with no row at all both count as unfinished — the
  first because `runJob` writes `lastRunAt` when a job *starts*, the second because a
  queued job has not written one yet. After a minute of waiting the bar stops polling
  and says the job is still going, which is the honest thing to say about a first sync
  over two years of history, and hands the button back. Where the scheduler is
  switched off there is no button at all, since the endpoint would answer `403`.

### Changed

- A fourth rate-limit bucket, thirty an hour, in front of the refresh routes. The
  concurrency question is already answered by the `409`; this is about the client that
  starts one the instant the last finished, since every accepted refresh reaches into
  someone else's Actual and Ghostfolio and can starve the nightly pass without ever
  overlapping itself.
- `buildApp` takes the job registry as an option, defaulting to the real one. An HTTP
  test of the refresh endpoint would otherwise dial Actual and Ghostfolio to assert
  something about a `202`.

## [0.6.0] — 2026-09-03

### Added

- **The insights page — findings, the narrative, both queues, and the ledger of
  every call** ([#32](https://github.com/nrosier/Balancr/issues/32)). The last of
  the five views, and the one that had to show its own workings: it renders what a
  model concluded about a month, so it also renders every call that was made and
  exactly what went out in each one. The five sections are in that order on purpose
  — conclusions, then the reasoning, then what is still being asked, then what is
  being proposed, then the evidence.

  Findings are grouped by severity with the worst group first, and the grouping
  comes from `SEVERITY_RANK` rather than an order written out a second time, so the
  page cannot disagree with the ranking the server kept findings by. Severity is
  carried by the group heading and the sentence, not by colour alone. A code this
  bundle has no sentence for, or a signal missing the metric its sentence
  interpolates, is **dropped** rather than printed as a bare code or as a sentence
  with a hole in it — a finding that cannot be stated is not a finding.

  The narrative is inserted as HTML, which is worth stating plainly: `util/markdown.ts`
  escapes the model's text *first* and only then emits a fixed list of tags, none of
  which take attributes, so there is no `href`, `src` or `style` for a payload to
  hang an injection on. It has to happen on the server anyway, because the stored
  Markdown says `c7` where a category name belongs and only the server can resolve
  the label. The byline names the model beside the date, so last night's analysis is
  distinguishable from one written three weeks ago by a model since swapped out.

  Both queues are read-only in this version and **say so on screen** rather than
  implying it by the absence of buttons: answering a clarification re-analyses the
  month and applying a proposal writes an audit row, and both belong to
  [#43](https://github.com/nrosier/Balancr/issues/43)–[#45](https://github.com/nrosier/Balancr/issues/45).
  Shipping the queues before the buttons is deliberate — the queue is what tells you
  the analysis is asking about the right categories, and that is worth reading early.
  Clarification cards show the model's guess rather than an open question, with the
  materiality share beside it so the threshold is legible instead of mysterious.

  The ledger is the privacy claim made checkable from a browser instead of from a
  SQLite prompt on the host. Every attempt is a row, `capped` and `blocked`
  included, because those are the answers that are *missing* from the page above; a
  failed run shows the upstream message verbatim, the only text on the screen
  Balancr did not write. The payload is fetched when a row is opened, not with the
  page — twenty redacted bundles would be most of `/api/insights`, downloaded on
  every visit to render a list of dates and costs — and one row is open at a time.
  A payload that will not parse says so as a note, not as an error: the row around
  it is still true, and that is the audit view reporting a finding about itself.

### Changed

- `GET /api/insights` now carries `model` on the narrative object, for the byline.
- `web/src/pages/Placeholder.tsx` is `PageHeader.tsx`, and the placeholder itself is
  gone along with the `page.*.soon` strings: all five pages render their own content
  now, so a component whose job was to say "coming next" has no callers.
- `.badge` moved out of `settings.css` into `theme/components.css`, now that a
  second page labels a status with it.

## [0.5.20] — 2026-09-03

### Added

- **Readiness, a probe that actually runs, and job state on screen**
  ([#37](https://github.com/nrosier/Balancr/issues/37)). Three questions that were
  being asked of one endpoint now have one endpoint each. `/healthz` stays liveness
  and touches nothing — the container health check reads it, and restarting Balancr
  because Ghostfolio is restarting turns one outage into two. `GET /readyz` is the
  new one: should traffic be routed here. `GET /api/status` is the same computation
  with the detail attached, and it needs a session.

  The split is on the disclosure boundary, not on convenience. `/readyz` is
  unauthenticated because a health check cannot hold a cookie, so it carries names
  and verdicts and nothing else: `{name, status}` per check, and no `reason`. The
  detail — `connect ECONNREFUSED 172.19.0.4:5006`, the Ghostfolio path whose shape
  changed, the upstream's own error text — is an internal hostname, an internal
  port and a version fingerprint, and it is behind the session on `/api/status`.
  There is a test that projects both payloads and asserts the exact key set of
  each, so a field added to the status type cannot reach `/readyz` by being
  forgotten.

  **The capability probe now runs on a schedule instead of only at startup.** It
  was a function nothing called after boot, which meant a Ghostfolio upgrade at
  10:00 was discovered by the next aggregation producing wrong numbers. It is a
  job now, with its verdict and per-path report in a new `upstream_probes` table,
  so readiness can report a shape mismatch without calling Ghostfolio on every
  request. The failing report is written *before* the job throws — a probe that
  fails and leaves no trace is the one case the table exists to prevent.

  An unprobed upstream reads "not known", never "ok". Claiming an upstream is
  healthy because no probe has ever contradicted it is the answer worth refusing:
  a fresh deployment that has never run a job looks exactly like a healthy one
  from the inside.

  On screen, a sixth settings panel: the four checks with their reasons, every
  job with last run, last success, next run, duration and schedule, and the
  probe's per-path report. It fetches `/api/status` itself rather than reading the
  settings payload, because readiness decays while the page is open and because it
  has to be able to be the thing that failed while the rest of the page loaded —
  the build block below it stays on the settings payload for the same reason in
  reverse, so the version and revision are still on screen when `/api/status` is
  what is broken.

  Two Ghostfolio failures are drawn differently on purpose. Unreachable is amber:
  transient, and the figures on the page are still the last correct ones.
  A shape mismatch is red, because nothing but a new Balancr fixes it. Verdicts
  with nothing wrong yet — `unknown`, `idle` — get no colour at all; a first boot
  that looked like a fault would send someone hunting for one.

  Upstream text is quoted rather than translated, in a monospace `<q>`, because
  `connect ECONNREFUSED 172.19.0.4:5006` is a string to search for and a
  translated paraphrase of it is not. Everything Balancr says itself is in both
  languages.

## [0.5.19] — 2026-09-03

### Changed

- **One set of instructions for the assistant, not one per language**
  ([#133](https://github.com/nrosier/Balancr/issues/133)). The prompts were seeded
  under every supported locale, which made the locale fallback in `resolvePrompt`
  unreachable and turned an edit into a silent half-change: tightening the rule
  "never state a figure you were not given" in English left the Dutch copy of that
  rule exactly as it was, with nothing on screen saying so. They are now stored
  once, under a `'*'` sentinel that means every language, and the reply language is
  what it always was — a separate directive appended to every run, naming the
  language rather than passing a bare code.

  The sentinel rather than a nullable column, because both unique indexes on
  `prompts` include `locale` and SQLite treats `NULL`s in a unique index as
  distinct — so nullable would have quietly allowed two active shared versions of
  the same prompt. There is a test that the index still refuses the second one.
  It also means the change needs no schema migration at all: `locale` was already
  `text not null`.

  A language can still diverge, and doing so is now a deliberate act with a button
  behind it rather than the default state. Writing a version for one language forks
  the text on screen into it and is what puts that language in the editor's picker;
  going back is `deactivateOverride`, which switches the override off without
  deleting anything, so its versions stay readable and activating one is the way
  back. The editor says which of the three texts is in the box — this language's own
  version, the shared text, or the built-in constant — because someone who opens a
  Dutch prompt, sees English, and saves an edit would otherwise have created a
  Dutch version out of the shared one without being told.

  Migration `0010_shared_prompt_locale.sql` collapses an existing install, and
  deliberately only where it is provably safe: a key whose rows are all one body at
  one version is the untouched seed, so the duplicates are dropped and the survivor
  is renamed to `'*'`. A key whose languages have already diverged is left entirely
  alone — no edit is destroyed and no language is promoted to speak for the rest —
  and `seedPrompts` then writes the shared row it will fall back to, which leaves a
  partly-diverged install in a state that is visible in the editor and fixable
  there. Both behaviours have tests that replay the shipped SQL rather than a
  paraphrase of it.

  One consequence worth stating: the priced test run no longer sends a `locale`
  when the shared prompt is what is being tested. `promptId` already pins the text,
  so the field only chose which language the findings came back in, and the shared
  prompt has no language of its own to ask for. The server answers in the reader's,
  which is what the nightly job would do for them.

### Fixed

- **`node_modules` is no longer tracked as a symlink into one machine's home
  directory.** The v0.5.18 release commit committed it as a link whose target is an
  absolute path on the author's laptop — pointing, as it happens, at itself. Any
  checkout of that commit replaces a real `node_modules` with a self-referential
  link, and everything resolved through it then fails with `ELOOP`: `npm run` cannot
  spawn a script, `node_modules/.bin/tsc` cannot be read, and the whole local gate
  stops working while reporting nothing but exit code 194. Diagnosing it means
  reading `~/.npm/_logs`, because no message names the cause.

  `.gitignore` did not stop it: `node_modules/`, with the trailing slash, matches a
  directory and not a symlink of the same name, so `git add -A` picked it up the
  moment the link existed. The pattern now has no slash and covers both.

  **The v0.5.18 tag and its published release still carry the symlink** — a tag is
  a promise about a commit, and re-cutting one that people may already have fetched
  trades a bounded problem for an unbounded one. A fresh clone at `v0.5.18` needs
  `unlink node_modules && npm ci` before anything else will run; `v0.5.19` and later
  are clean. Removing it from the index does not touch a working copy that has a
  real `node_modules`.

  A new test refuses the whole class rather than this one path: `git ls-tree -r HEAD`
  must contain no mode-`120000` entry, and nothing named `node_modules` at any depth.
  The gate could not have caught this on its own, because the thing that broke was
  the gate.

## [0.5.18] — 2026-09-03

### Added

- **A contrast check in the gate, and it derives its pairs from the stylesheets**
  ([#35](https://github.com/nrosier/Balancr/issues/35)). `npm run contrast:check`
  reads every rule under `web/src`, measures each foreground against its stated
  background, and fails under 4.5:1 for text or 3:1 for a border, a plotted shape
  or the focus ring — in both themes. A hand-kept list of pairs was the obvious
  design and the wrong one: it goes stale the moment a component is styled, and it
  describes pairs the cascade never renders. The first version of this check was
  written against such a list and named a pair that does not exist, which is how
  the design changed.

  A rule that sets only `color` inherits a background no stylesheet can name, so
  the token is measured against all four surfaces the layout paints large areas
  with. That is the strict reading, and it is the one that found the real defect:
  a grey that clears the white card and fails the slightly darker page behind it.

  Every pair is printed with its measured ratio and its remaining margin, on
  success as well as failure. That is not decoration — it is what showed three
  pairs passing by 0.01 after the first round of fixes, which is a floor met and
  no headroom, so the values were recomputed to sit clear of it. The tightest pair
  in the palette now passes by 0.25.

- **The holdings table's scroll box is a named region.** Six columns of figures
  cannot reflow onto a phone, so the box takes `tabIndex={0}` and is the only way
  to reach the right-hand columns without a pointer. That makes it a focus stop,
  and a focus stop with no role and no name announces itself as nothing at all. It
  is now a `region` labelled by the same `<caption>` that names the table — one
  accessible name, stated once, reached two ways.

### Changed

- **`--border-strong` and `--chart-axis` are repainted to clear the floor.** The
  input border sat at 1.54:1 against its own fill and 1.78:1 against the card in
  dark, where 3:1 is the requirement for the edge that tells someone where a text
  box is. Chart axis labels are text and sat at 4.28:1. Both keep their hue and
  saturation and lose only lightness, so the palette reads as it did.

- **`--text-faint` is gone, and the four places that used it for text use
  `--text-muted`.** A validation message, a version string, a diff's line numbers
  and a sign-in separator — all of them informational, all of them under 4.5:1 on
  the page behind them. Darkening the token to clear every surface produced
  `#636b77`, which is indistinguishable from `--text-muted` at `#5a6373`, so there
  was no third tier to keep: a grey light enough to read as faint is a grey under
  the floor. Quieter is now done with size, which is what the settings stylesheet
  already said about disabled controls — change the background, keep the text
  colour, because a viewer has to be able to read the thresholds they cannot
  change.

## [0.5.17] — 2026-09-03

### Fixed

- **The duplicate-account panel now says what it found, and a "no" now sticks**
  ([#131](https://github.com/nrosier/Balancr/issues/131)). It used to offer every
  Ghostfolio account against every non-checking Actual account, so an instance with
  five unrelated accounts — a meal-voucher card, two eco-cheque balances, some cash and
  a savings account — read as a wall of suggestions pairing things that have nothing to
  do with each other, with no way to say so.

  Each pair is now scored on four signals: the same name once punctuation and case are
  normalised, one name containing the other as whole words, balances that agree to
  within €1 or 0.1%, and a matching currency. At least one signal must be something
  other than currency, only the best match per Ghostfolio account is offered, and a
  cash account is never crossed with a portfolio — the account kind derived in
  [#124](https://github.com/nrosier/Balancr/issues/124) is what makes that possible,
  including the direction the old filter structurally excluded: a broker balance mirrored
  into an *on-budget* Actual account.

  Balances are compared signed and only when both sides are non-zero. Zero is the most
  common balance in any dataset, so treating it as evidence would pair every empty
  account with every other one, and a credit card at −800 is not the same money as a
  savings account at +800.

  The reason travels with the suggestion, so the panel reads "Suggested because: both
  are called the same thing and the balances agree" instead of asking you to work out
  what it saw. And **Not the same money** records the answer permanently — against the
  account rather than against the pair, because a pair is identified by two names and
  the next sync that renames either side would resurrect the suggestion. It reuses the
  decided-fields ledger from #132, so a dismissal is an ordinary human decision that
  no derived rule may overturn, and it is audit-logged like any other.

## [0.5.16] — 2026-09-03

### Added

- **The interface's language is decided in one place now, and the document says
  which one it is** ([#34](https://github.com/nrosier/Balancr/issues/34)). The
  resolution order — the signed-in account's own setting, then a `balancr_locale`
  cookie, then a q-weighted `Accept-Language`, then `DEFAULT_LOCALE`, every rung
  filtered against `SUPPORTED_LOCALES` — lives in `src/server/locale.ts` and is
  called by exactly two things: the SPA shell and `/bootstrap`. So `<html lang>`
  and the language the bundle starts in are one answer, not two implementations
  that agree until they don't. The browser's own `navigator.languages` walk is
  gone, which is what makes that true rather than merely intended.

  The account's setting can be the first rung even on a public route because the
  auth `preHandler` populates `request.user` for every request carrying a valid
  session, including the routes declared `auth: false`. A signed-in visitor's
  first paint is therefore in their language, before any JavaScript has run.

- **`<html lang>` is now the language on the page.** One shell document per
  supported locale is built at startup and held in memory, so a request picks a
  string rather than rewriting HTML. The attribute is rewritten, not templated
  from a `{{lang}}` placeholder, so `web/index.html` stays a document the dev
  server can serve — and a bundle with no `<html lang>`, or two of them, is a
  startup error naming the file instead of a page that renders the placeholder.
  The shell carries `Vary: accept-language, cookie` beside its `no-store`, so
  the first visitor's language cannot become everyone's in a cache that ignores
  the one and honours the other.

  This is what a screen reader reads to pick a pronunciation, and it is why
  `hyphens: auto` breaks `Instellingen` where Dutch breaks it.

- **A `balancr_locale` cookie, with the server as its only writer.** It is set on
  local login, on the way through the OIDC callback, and when the profile patch
  changes the column — a cache of the account's `locale`, never an independent
  opinion, which is why it is `httpOnly`. Without it the reload after a language
  change would render `lang="en"` around a page of Dutch strings, and a first
  visit after login would arrive in the browser's language rather than the
  account's.

- **`bootstrap.locales.active`** — the language the server resolved, so the
  client initialises i18next with the answer it was given.

- **`npm run i18n:check` now refuses a translation longer than its box.**
  Thirteen bounds over the nav labels, the buttons that share a row, the
  bullet-chart legend and every group rendered as a badge or a pill, each naming
  the box it has to fit. The check exists because the layout below was sized for
  Dutch by hand, and hand-sizing rots the moment someone adds a key.

### Changed

- **The chrome is sized for the longer language.** Nav labels reserve two lines
  unconditionally so the icons stay on one baseline whichever language is
  showing, and the bullet chart reserves two rows for its legend: Dutch's
  `Toegewezen` / `Uitgegeven` / `12-maandsgemiddelde` is 39 characters against
  English's 26, and ECharts lays the legend over the grid, so an unplanned second
  row lands on the axis labels rather than pushing them down.

- **The application follows the account's language once the session says what it
  is**, tracked by the locale it has already acted on rather than by the language
  currently showing. Comparing against the current language would have meant the
  settings control appeared to do nothing: the session payload is stale the
  instant the control switches the language, so an effect reading it would put
  the interface straight back.

## [0.5.15] — 2026-09-03

### Fixed

- **Net worth no longer counts bank cash twice** on an instance where a tool syncs bank
  accounts into Ghostfolio as well as Actual
  ([#124](https://github.com/nrosier/Balancr/issues/124)). On the reporting instance
  that was roughly a third of the total, entered once from each source, and labelled
  invested — so the emergency-buffer figure and the allocation were both wrong in the
  same direction at the same time.

  Ghostfolio can already tell the two kinds of account apart, so the classification is
  derived rather than asked for. Two independent signals, and either one firing is
  enough: orders recorded against the account, and a value exceeding the balance — both
  taken in the base currency, because comparing a converted value against an
  unconverted balance reads a foreign-currency cash account as a portfolio purely
  because of the exchange rate. On the reporting instance the signals agree unanimously
  across seven accounts, six cash and one portfolio.

  The asymmetry is deliberate. A false "investment" costs a label on a settings page; a
  false "cash" is what gets an account grouped away as a duplicate, and money missing
  from net worth has no symptom. So an account the instance says nothing about stays
  `investment`, and an empty account reads as cash only because nothing is at stake
  until the first trade.

  Each Ghostfolio cash account is then grouped with the Actual account of the same
  name, Actual being the side that counts because that is where the account is
  reconciled against statements. The matcher is unwilling on purpose: one Actual row and
  one Ghostfolio cash row sharing a normalised name, or no pair at all. Two accounts
  called "Spaarrekening" produce nothing, because a total that is too small looks
  exactly like a total that was always that size, while the double count announces
  itself as a number that is too big. Ghostfolio cash with no twin keeps counting —
  excluding it wholesale would be right here and would silently lose the money on a
  deployment where a bank exists in Ghostfolio only.

  Both writes go through the derived path added in 0.5.14, so a person's answer wins
  permanently: ungrouping a pair is a decision, and the next sync leaves it alone rather
  than regrouping what was just taken apart.

- **The allocation chart is a picture of what the money is invested in**, not of the
  account total. Ghostfolio reports the broker's cash balance as a `LIQUIDITY` holding,
  which put "Cash" beside "Equities" as though it were a position someone chose — and on
  an instance holding six mirrored bank balances, that slice was most of the pie.
  `portfolio_metrics` now carries the total split into `invested_value_cents` and
  `cash_value_cents`, the portfolio page names both halves so the slices reconcile
  against the headline figure, and the split crosses to Gemini as well, because the
  reported return is over the whole total while the allocation covers only part of it.
  Rows written before the columns existed read as "not known": the split is not
  recoverable from one number, and filling it in would claim a cash balance was
  invested on exactly the rows that made the fix necessary.

## [0.5.14] — 2026-09-03

### Added

- **Every `account_map` row now records which of its fields a person decided**, so a
  derived classifier can improve a guess without erasing an answer
  ([#132](https://github.com/nrosier/Balancr/issues/132)). `kind` said `savings` and
  nothing distinguished a rule having said so from a person having said so, which made
  the classifier #124 needs unbuildable: `defaultKind` runs only on insert, so it can
  never reach an existing account, and a version that re-derived unconditionally would
  have silently reinstated the six accounts held out of net worth by hand — overstating
  net worth with nothing on the chart saying why.

  Four fields are decidable — `kind`, `includeInNetWorth`, `dedupeGroup` and
  `isSourceOfTruth` — and naming one in a settings write marks it decided, including
  when the value chosen matches what a rule would have produced: confirming a guess has
  to be worth more than never looking. Grouping, choosing a source of truth and
  ungrouping all record themselves too, and choosing a winner marks the whole group,
  because deciding one row is the source is simultaneously deciding the others are not.

  Derived writes go through `applyDerivedFields`, which skips every decided field, does
  *not* claim the fields it does write, and stamps `classified_at` even when it changed
  nothing — "the rule looked and had nothing to add" and "the rule has never run" are
  different states, and only the timestamp separates them.

  The migration infers provenance for existing rows from the only evidence there is: a
  stored value that differs from what the insert-time default would have produced. It is
  deliberately conservative, so it can under-report a decision but never invent one —
  under-reporting costs a re-derivation that agrees with the person anyway, while
  over-reporting would freeze a row against every future improvement. An Actual account
  still reading `checking` or `other` stays undecided on purpose: those are the vague
  ones a better classifier exists to sharpen.


## [0.5.13] — 2026-09-03

### Added

- **Both charts now start where the data starts, not where the install does**
  ([#114](https://github.com/nrosier/Balancr/issues/114)). `net_worth_snapshots` and
  `portfolio_metrics` are written one row per day a job ran, so a fortnight-old
  install had a fortnight of history and a time axis with a dot on it — while Actual
  had been answering `getAccountBalance` for any date all along and Ghostfolio had
  been answering `range=max` with a dated series. A nightly `backfill` job now reads
  both, at month-end granularity, and fills in what was never asked for.

  The two halves fail independently on purpose. The portfolio-value chart is a
  per-date total, so the chart's value *is* the row and that half always runs. Net
  worth is stored per account, so it needs a value per account rather than a
  portfolio total — and the performance endpoint takes `accounts=<id>`, so each
  Ghostfolio account that actually counts is asked for its own series. One request
  per counted account buys a whole dated history, which makes this N calls for the
  job rather than N per date, and N the accounts that count rather than the accounts
  that exist. The unfiltered total is never split across accounts: on an install
  where Ghostfolio counts seven accounts and one of them is mapped, splitting it
  would overstate history by six accounts every month, in the flattering direction.

  Asking per account is also what lets a month-end predate one holding and not
  another. `range=max` begins at an account's first order, so a month-end before it
  is a month that account held nothing rather than a month whose value is unknown —
  an account opened last year no longer shortens the history of one opened five years
  ago, and Actual alone is the whole truth of a date when there was no portfolio at
  all.

  A date that genuinely cannot be completed — a hole inside a series, or an account
  with no dated value anywhere, which is what a cash-only Ghostfolio account looks
  like — is skipped rather than written and flagged. What the reader gets is a series
  that starts where both halves are known instead of one joined to today at a step,
  and a cliff where a backfill meets live data is worse than a shorter chart, because
  the cliff looks like an event. Nothing has to be cleared later either: the next
  pass still sees the date missing.

  Cost is why it is a separate job. It is the only pass that talks to Actual once per
  account per month, so it reads both date sets before opening a connection and never
  asks Actual again once the net-worth half is complete. It is also left out of the
  freshness banner: every figure it writes is for a settled month-end in the past, so
  its failure leaves the charts shorter and leaves nothing on them wrong.

### Changed

- The net-worth history is clamped to the months Actual actually has a budget for.
  `getAccountBalance` answers a date before the budget existed with zero, and a zero
  that means "there was nothing" renders identically to one that means "we did not
  look" — only one of them is true.
- Jobs that need the current month now derive it from the instant the runner recorded
  rather than reading the clock again, so a run starting seconds before midnight
  cannot write one half of its output into one month and the other half into the next.

## [0.5.12] — 2026-09-03

### Added

- **Portfolio page** — the value of everything held, the reported time-weighted
  return, an allocation treemap by asset class, and a holdings table of what is
  actually held, largest first
  ([#31](https://github.com/nrosier/Balancr/issues/31)).
  Annual cost is deliberately not drawn: `ter_annual_cents` has no source yet, and a
  card that always reads "not known yet" teaches a reader that the placeholder means
  nothing.

### Fixed

- **A holding's price is labelled with the currency it is quoted in**, rather than
  with the base currency ([#134](https://github.com/nrosier/Balancr/issues/134)).
  Ghostfolio converts a position's *value* for us and leaves its *quote* in the
  instrument's own currency, so one row carries two currencies — but the row had one
  `currency` column and the table drew the price with a euro sign regardless. A
  dollar-quoted position was shown as a plausible smaller number, which is worse than
  an error. Prices now carry their own `price_currency`, whatever the provider
  reported, with no currency treated as special; the migration backfills existing
  rows from the value currency, which is what they were rendered with all along.
  No column gains a currency label — under a Belgian format locale `Intl` already
  tells `€ 1.234,56` from `US$ 1.234,56`, so an all-euro portfolio reads exactly as
  it did.

## [0.5.11] — 2026-09-03

### Security
- **Ghostfolio could be written to by anyone who added a line, and only the absence
  of that line was stopping it**
  ([#120](https://github.com/nrosier/Balancr/issues/120)). The adapter's one request
  helper took `RequestInit`, so `method` and `body` were caller-supplied: every read
  omitted them and got a GET, which made the read-only promise a property of today's
  code rather than of its types. `POST /api/v1/order` and `POST /api/v1/import` are
  real endpoints on the instance Balancr authenticates against, and this is the file
  somebody reaching for "while I'm in here, let me record that transaction" opens.
  Reads now take a `ReadOptions` offering one flag and nothing else, so a write no
  longer compiles; the anonymous-token call — authentication, not a mutation — is
  written out on its own, taking no arguments and hardcoding both its method and its
  path, which also removed the reentrancy where the helper called the token function,
  which called the helper back. A guard test mirrors Actual's: the type protects this
  adapter's callers, and a source scan catches a future file that reaches for `fetch`
  itself.

## [0.5.10] — 2026-09-03

### Fixed
- **Copying `.env.example` refused to boot, complaining that a variable left
  deliberately blank was too short**
  ([#118](https://github.com/nrosier/Balancr/issues/118)). Nine variables ship empty
  in that file and six of them were declared `z.string().min(1).optional()` —
  optional, so absent was fine, but `.min(1)` rejected the empty string the file
  actually supplies. The message read as a rule about length, which invites putting a
  placeholder into a security-relevant slot to get past it. A blank or whitespace-only
  value now means "not set" for those six, via `optionalText()`/`optionalUrl()`
  helpers; required variables still reject an empty string, because a blank
  `ACTUAL_PASSWORD` is a misconfiguration and not booting is the right answer. A test
  reads the real `.env.example`, fills in only what it asks for, and asserts it boots.
- **`ACTUAL_E2E_PASSWORD` failures blamed the wrong thing, or nothing at all**
  ([#119](https://github.com/nrosier/Balancr/issues/119)). Actual only reads that
  password when the budget carries an `encryptKeyId`, so a blank value on an
  unencrypted budget is a complete configuration and always was. When it *is*
  encrypted, Actual's own error — "File Household is encrypted. Please provide a
  password." — names neither the variable to set nor the file it lives in, and it is a
  different password from `ACTUAL_PASSWORD` two lines above it. `missing-key`,
  `decrypt-failure` and `file-has-new-key` now say `ACTUAL_E2E_PASSWORD` by name and
  keep Actual's wording, which identifies the budget; `old-key-style` points at Actual
  instead, because no configuration change can fix it. Everything else passes through
  untouched — blaming encryption for a wrong sync id would send someone to the wrong
  line of `.env`.
- **Actual's sync engine wrote plain text into an otherwise structured log**
  ([#123](https://github.com/nrosier/Balancr/issues/123)). Its logger gates progress
  and breadcrumbs behind a `verboseMode` that defaults to on, so every hourly sync put
  ten unparseable lines through `console.log` in the middle of pino's JSON — one of
  them naming the budget file path. `init` is now passed `verbose` tied to
  `LOG_LEVEL`: off at `info`, on at `debug` and `trace`. Quiet rather than silenced,
  because when a budget will not load that chatter is the only view into why.

## [0.5.9] — 2026-09-02

### Added
- **The settings page — the one screen in the application that writes**
  ([#33](https://github.com/nrosier/Balancr/issues/33)). Six panels over the eleven
  `/api/settings` routes and the two `/api/ai` ones: language, the thresholds the
  aggregation engine judges by, the prompt editor with its diff and its priced dry run,
  the account mapping that decides which of two tools counts a shared investment
  account, this month's AI spend, and the build in front of you.
- Every settings write answers with the **whole settings payload** rather than the row
  it changed, so the page is a projection of the server's state and never a local copy
  patched to match — a rejected field ends up beside the field that was rejected, and a
  refused write leaves nothing half-applied on screen.
- The thresholds form is **rendered from that payload**. `params` and `paramDefaults`
  are the domain schema itself, so a threshold added to `aggregate/params.ts` appears on
  the page with no client edit, its group and label read from the catalogue — and
  `test/unit/web-contract.test.ts` fails if either is missing rather than letting it
  ship untranslated. Only what actually changed is sent.
- A **grouping mark in a whole-number field is handed back to be retyped**, not guessed
  at. `2.000` in a basis-points field is 20% to anyone typing Belgian grouping and
  0,02% to a decimal parser; neither the panel nor the server can tell which was meant,
  and there is no reading worth saving silently. Which fields are whole numbers is read
  from the stored value, so no list here can fall out of step with the aggregator.
- The prompt editor keeps **saving separate from activating**, because activating an
  earlier version *is* the rollback. Its dry run is a real model call on real figures,
  so the button does not appear until the free estimate has priced it, and the estimate
  refusing to price the run (no facts for the month) is shown as the reason rather than
  as a failure.
- A **viewer sees all of it and may change exactly one thing** — their own language.
  Every other control is disabled with the reason next to it, which is the server's own
  rule made visible instead of re-implemented.
- The AI spend panel is **read-only on purpose**: the monthly cap lives in the
  environment, and a cap editable by whoever reached it is not a cap.

## [0.5.8] — 2026-09-02

### Fixed
- **The portfolio job still failed every pass: Ghostfolio moved every identity field
  into `assetProfile`** ([#113](https://github.com/nrosier/Balancr/issues/113)). The
  diagnostic added in `0.5.7` did exactly what it was written for — it printed the
  keys the holding did have, and `assetProfile` was one of them while `symbol`,
  `isin`, `name`, `currency`, `dataSource` and `assetClass` were all absent. Current
  releases put them one level down; the schema still read them off the holding. They
  are now lifted out of `assetProfile` when the holding does not carry them itself —
  a fallback per field, never an override, the same rule the record key already
  followed.

  `assetClass` is in that list for a sharper reason than the rest. It is what the
  allocation treemap groups by, and reading it from the level Ghostfolio no longer
  uses does not fail — it puts every position in `unknown` and draws one grey block.
  A wrong answer is worse than a refused payload, so it is hoisted with the identity
  rather than left to a default. Verified against a live 2026 instance: two holdings,
  identified by symbol, classed `LIQUIDITY` and `EQUITY`, shares summing to exactly
  10 000 bp.

- **Time-weighted return was permanently null and the value series permanently empty,
  because Ghostfolio moved the performance endpoint to `/api/v2`**
  ([#115](https://github.com/nrosier/Balancr/issues/115)). `/api/v1/portfolio/performance`
  now 404s. Nothing said so: #113 refused the details call first, so the pass never
  reached this one, and the two defects hid behind a single error. v2 is tried first
  and a 404 falls back to v1, so an instance old enough to lack v2 keeps working and
  a current one stops being silently empty. Only a 404 falls back — a 401 is a bad
  token and a 500 is Ghostfolio in trouble, and retrying either against an older path
  would answer a different question than the one asked.

  The v2 response is a superset, so one schema covers both. On the live instance it
  returns **401 daily points back to 2025-07-29** — which is the history
  [#114](https://github.com/nrosier/Balancr/issues/114) is about, and part of why the
  net-worth chart draws a single dot.

## [0.5.7] — 2026-09-02

### Fixed
- **The portfolio job failed every pass on a Ghostfolio release whose holdings do not
  name themselves** ([#107](https://github.com/nrosier/Balancr/issues/107)). The
  symbol is the key of the map the holdings arrive in, not a field inside them — and
  the code that flattened the map to a list dropped the key, then reported `symbol`
  as missing. So a required field was reported absent by the same function that had
  just discarded the only copy of it. The key is now folded in as the symbol, an
  object that names itself keeps its own value, and the requirement moved from
  `symbol` to the weaker thing that actually has to hold: an ISIN *or* a symbol.

  A position with neither refuses the whole payload rather than being skipped.
  `totalValueCents` is the sum of the holdings that were stored, so dropping one row
  would quietly shrink the portfolio total and every allocation share derived from
  it — a wrong number where the adapter promises a loud failure.

  `currency` became optional in the same pass. Every stored amount is already in the
  base currency, which is what the row is labelled with, so the field was required
  and then never read — and on a live instance it failed every pass over a label no
  code would have looked at.
- **The envelope-budget warning fired on envelope budgets**
  ([#108](https://github.com/nrosier/Balancr/issues/108)). Actual renamed its budget
  styles: `rollover` became `envelope`, and `report` became `tracking`. The check
  tested only the old name, so it warned about carryover figures on exactly the
  configuration those figures assume — and would have stayed quiet on `tracking`,
  the case it exists for. Both envelope spellings are accepted, because a deployment
  running an older Actual still reports `rollover`. No figure was ever affected:
  `budgetType` is read nowhere else. A warning that cries wolf on a correct setup
  teaches the reader to skip the one that isn't a false alarm, which is the cost.
- **An OIDC redirect URI mismatch could not be diagnosed**
  ([#110](https://github.com/nrosier/Balancr/issues/110)). The value is derived from
  `PUBLIC_BASE_URL` rather than configured — deliberately, since reading it from a
  `Host` header would let a request choose where the authorization code is sent — and
  the provider compares it byte for byte. It was also the one value nothing printed,
  and the provider refuses the authorization request before the browser ever returns,
  so there was no failed login for Balancr to log and no message for it to improve.
  Startup now logs the issuer, the client id and the exact redirect URI it will send.

  Found while fixing it: `configSummary` — the function whose entire purpose is to be
  loggable, naming every variable and masking every secret — was exported and never
  called, so `PUBLIC_BASE_URL` had never been printed either and the only way to read
  the effective configuration was `docker compose exec … printenv`. It is now logged
  once at startup, right after the version, and gains the two non-secret OIDC inputs
  instead of a single `oidcEnabled` boolean. What makes that safe is a test: every
  secret-shaped field is asserted masked, and no secret value may appear anywhere in
  the object.

### Added
- **The Authentik provider setup is documented**
  ([#109](https://github.com/nrosier/Balancr/issues/109)): which three values come
  off the provider page, the redirect URI to register with a worked example and its
  Strict matching mode, why it is derived rather than configured, what the resulting
  error looks like when it does not match, and the scopes with the reason
  `offline_access` is not among them.

## [0.5.6] — 2026-09-02

### Fixed
- **The logs did not say which build was running**
  ([#104](https://github.com/nrosier/Balancr/issues/104)). A container answering
  `"version":"0.5.0"` had in fact been pulled at `0.5.4`; the image was pulled and
  the container was never recreated. Establishing that took matching the digest
  `docker compose pull` printed against manifest digests read out of workflow logs,
  because no startup line named a version — and until it was established, two
  already-released fixes looked like fixes that had not worked.

  Startup now logs `version`, `revision`, `node` and `env` as its first line, before
  any step that can fail, since a crash during startup is exactly when the build
  matters most.

### Added
- **The commit is stamped into the image** as `BALANCR_REVISION`, a build argument
  set from `github.sha` and logged as `revision`. The version alone cannot identify a
  build: every push to `main` publishes `edge` from the same `package.json` as the
  last tag, so `0.5.4` names the release and every `edge` build after it. A digest
  now maps back to a commit without reading CI logs. `null` outside an image, where
  the working tree is the answer.

  The name has to be spelled identically in three files — `version.ts` reads it, the
  `Dockerfile` declares it, `release.yml` passes it — and renaming any one of them
  would make the field `null` in every log line forever, with nothing failing and
  nothing warning. `test/unit/server-version.test.ts` asserts the agreement.

## [0.5.5] — 2026-09-02

### Added
- **The budget page** (`web/src/pages/Budget.tsx`,
  [#30](https://github.com/nrosier/Balancr/issues/30)) — one month over one request to
  `GET /api/budget`, answered in the order someone actually asks: four totals, then where
  the money went, then whether each envelope held, then whether the month is on pace, then
  a year of shape per envelope. Each answer narrower than the one before it, which is also
  why the charts sit in that order — nobody wants a wall of sparklines before they know
  whether the month balanced.
- **Income to envelopes as a Sankey** (`web/src/charts/SpendSankey.tsx`). Three columns —
  income sources, a pooled hub, envelopes — rather than income drawn straight to
  categories, because that second shape claims to know which euro bought the groceries and
  nothing in Actual knows that. It draws no total it was not handed: the pool's inflow is
  the sum of the income categories rather than `totals.incomeCents`, no negative flow gets
  a ribbon, and a "not spent" node appears only when the pool really has money left.
  Duplicate names are disambiguated, because a link addresses its endpoints by name while
  Actual scopes names to a group, so two envelopes really can share one.
- **Assigned against spent as a bullet chart** (`web/src/charts/BudgetBullet.tsx`) —
  assignment as a wide bar, spend as a narrow bar laid over it, the twelve-month norm as a
  tick. Rows are ordered by the further of the two figures rather than by spend, so an
  envelope holding €400 with nothing spent still appears: that it is untouched is an answer
  to "budget versus actual", not a reason to leave it out.
- **Spending pace against the month's own progress** (`web/src/ui/PaceBar.tsx`), in CSS
  rather than a twelfth chart instance — twelve observers, twelve SVG trees and twelve
  tooltips would cost more than the rest of the page put together for a shape a rectangle
  draws exactly. Every figure it prints — spent, assigned, projected month end, projected
  overrun, how far through the month today is — comes from the server's `burn_rate_over`
  finding. The only arithmetic in the browser is the width of the bar, and a width prints
  no number.
- **A wall of small multiples** (`web/src/charts/CategoryTrend.tsx`), each sparkline
  carrying its own category's EWMA norm dashed through it — which is why the trend window
  is twelve months rather than the twenty-four the history chart uses: the line and the
  average then describe the same period, where two years of line against a one-year mean
  invites reading the gap as a trend.
- **Trailing per-category spend on the wire** (`loadCategoryTrends` in
  `src/domain/aggregate/facts.ts`). Twelve months per category, dense, and every series
  aligned to the same months — dense because a line with holes in it makes a different
  claim from one that touches zero, and shared because a per-category window would hand the
  newest envelope the shortest axis and make its line look the steepest.

### Changed
- **Each sparkline scales to itself**, against the usual shared-axis rule, and the argument
  is written into the file. Rent is thirty times groceries, so one shared maximum draws ten
  flat lines and a single real chart. Magnitude is what the bullet chart one card above is
  for, and every sparkline prints its own figure, so height is never the thing being read.
- **Findings are rendered in the browser from the catalogue the digest already uses**
  (`web/src/ai/signals.ts` over a new dependency-free `src/domain/ai/vars.ts`).
  `/api/budget` carries a finding as a code, a severity and a map of integers — never prose
  — so the same finding reads identically in an email and on screen, and a third language
  costs a catalogue rather than a model call. A code this bundle has no sentence for is
  dropped rather than printed as its own name, and a sentence missing one of its figures is
  dropped rather than interpolated with a hole in it: `€ 0` standing in for "the server did
  not say" is a number someone would act on.
- **The month is a query parameter, not a route.** `?month=` on the endpoint and one piece
  of state in the page, because the resource hook already refetches on a path change and
  that is the whole mechanism. The picker lists the months the database actually holds
  rather than a window derived from the one on screen — a trailing window would drop August
  out of the list the moment July was picked.
- **The browser bundle passes Vite's 500 kB warning**, at 913 kB and 303 kB gzipped: this
  page registers the Sankey, scatter and markLine renderers on top of what the overview
  already pulled in. It is still one file served from Balancr with no external origin and
  nothing inline, which is the property the build actually enforces. Splitting it is worth
  doing once the last screen has added the last chart type, and not before — the set is
  still growing.
- The stale `## [Unreleased]` heading this file carried between 0.5.2 and 0.5.1 is gone. It
  was the section 0.5.2 was rewritten from, left in place by the release that superseded
  it, and it made the overview screen appear twice in a file whose first line promises
  newest first.

### Fixed
- **Every genuine `alert` made `/api/budget` and `/api/insights` answer 500.**
  `signalSchema.severity` said `z.enum(['info', 'warn', 'critical'])` while `codes.ts`,
  `SEVERITY_RANK`, `capSeverity` and both `severity` columns say `alert`. Nothing
  translated between the two vocabularies, so the response schema rejected the value the
  database had just handed it and `parse` threw. Only the two mildest severities were
  reachable: `over_available`, `above_baseline` past its second threshold,
  `emergency_fund_short` and `recompute_mismatch` would each have taken both endpoints
  down. The wire now uses the database's word, and the API fixture carries an `alert` so
  the top severity is exercised from here on — reverting the one-line fix now fails twelve
  tests across both endpoints. Found while building this page's own fixture, which is the
  argument for fixtures that span a vocabulary instead of sampling the middle of it.

### Security
- **Names are escaped on their way into a chart tooltip** (`web/src/charts/tooltip.ts`).
  ECharts renders a tooltip formatter's return value as HTML, and the names going into one
  arrived from a bank feed. The CSP already stops the damage — it permits no external
  origin and carries no `'unsafe-inline'`, so an injected handler never runs — and this is
  the layer that stops the *display* from breaking, which is the failure a good CSP leaves
  behind: a category called `Rent <shared>` should print its own name rather than lose half
  of it to a tag nobody wrote.

## [0.5.4] — 2026-09-02

### Fixed
- **Every AI analysis call was rejected before the model ever saw it**
  ([#96](https://github.com/nrosier/Balancr/issues/96)). Gemini answered
  `400 INVALID_ARGUMENT` to the structured findings pass while the free-text
  narrative in the same run succeeded, so each nightly run recorded
  `analysisStatus: error`, fell back to deterministic findings with nothing ranking
  them, and still billed for the narrative. Two independent causes, both in the
  response schema:

  Zod emits correct draft-7, and correct draft-7 includes four keywords Gemini's
  `responseJsonSchema` does not accept — `$schema`, `default`, `minLength`,
  `maxLength`. The schema is now narrowed to the keywords the provider documents,
  by allowlist rather than by removing those four, since the rejection names no
  keyword and a Zod upgrade emitting a fifth would present as "the AI stopped
  working".

  That alone did not fix it. `maxItems: 48` on the findings array is *also*
  refused — a keyword Gemini accepts, but array bounds are multiplied into an
  undocumented complexity budget, and 48 on a four-field item is over it while 24
  is not. Any cap chosen here would be a guess a single new finding code could
  invalidate, so array bounds are no longer sent at all: the wire schema now
  carries shape and vocabulary, `analysisInstruction` states the limits in words,
  and `parseAnalysisResponse` keeps enforcing them on the way back in. Exceeding
  one now costs a re-rank instead of the whole run.

  Confirmed against the live API, not only against the documented subset: the
  schema as it was is a 400 on both `gemini-3.7-flash` and `gemini-3.1-pro-preview`,
  and the schema as it now stands returns grounded findings on both.

### Changed
- **A rejected structured call now says the schema is the likely cause.** Gemini
  returns a bare 400 with no keyword and no field path, which reads exactly like a
  bad key or a missing model — the reason #96 took an evening rather than an hour.

## [0.5.3] — 2026-09-02

### Fixed
- **Ghostfolio sends `holdings` two ways, and both are now read**
  ([#95](https://github.com/nrosier/Balancr/issues/95)). `/api/v1/portfolio/details`
  returns a symbol-keyed map on the releases the adapter was written against and a plain
  list on current ones; only the map was accepted, so the portfolio job failed on every
  run against a live server and no holdings, allocation or TWR were ever stored. Both
  shapes are normalised to a list at the Zod boundary, which keeps the difference inside
  the one file that exists to absorb a Ghostfolio change. Net worth was never affected —
  it reads `/api/v1/account`.
- **The adapter still names the field that moved.** The container is normalised before
  the items are validated, rather than unioning two validated shapes, so a genuinely
  changed holding reports as `holdings[0].quantity` instead of collapsing into "invalid
  union" — the diagnosis is the whole reason the job fails loudly instead of storing a
  guess. The test that used to assert an array *must* be rejected was the origin of the
  bug and now asserts the opposite.

## [0.5.2] — 2026-09-02

### Added
- **The overview screen** (`web/src/pages/Overview.tsx`) — net worth with its liquid,
  invested and debt parts, the savings rate for the month with the income, spend and
  assigned figures behind it, how many months the emergency buffer covers, the net-worth
  line over time, and the data-quality score with each deduction that is costing it
  points. One request to `GET /api/overview`, and **nothing on the page is computed in the
  browser**: the single piece of arithmetic is turning centimonths of cover back into
  months, because everything else was already decided by the aggregation jobs and a second
  implementation in the client is a second answer.
- **Four states for one endpoint, shared by every page still to come**
  (`web/src/ui/DataState.tsx`, `web/src/api/resource.tsx`). Waiting announces itself in a
  live region rather than flashing a spinner; unreachable says so and quotes the request
  id, which is the only way to find the cause in the log; answered-with-nothing offers a
  refresh instead of a page of zeroes; and a refresh that *fails* keeps the figures it
  already had with a note above them, because throwing away good numbers to show an error
  is a net loss of information.
- **A missing figure says so.** Every field on the overview payload can legitimately be
  null — the net-worth job has run but the budget sync has not, the buffer needs both —
  and each renders "Not known yet" rather than `€ 0`. A zero is a wrong number; a blank is
  a missing one, and only one of the two is honest.
- **A vanished session is reported, not absorbed** (`SessionExpiryProvider`). A cookie can
  be revoked from another device while a dashboard sits open, so a `401` from any endpoint
  is handed up to the session gate in `App.tsx`, which re-asks the server and lands on the
  sign-in screen by exactly the path a first visit takes. Wired once around the whole
  shell, so the four remaining screens inherit it.
- **Freshness told plainly** (`web/src/ui/Freshness.tsx`). A failed job names itself and
  what it said; a deployment with the scheduler switched off explains why the figures are
  not moving; an ordinary instance gets a quiet "Updated 02/09/2026, 07:30"; and a new
  install with nothing to report says nothing at all, because a notice about "not yet" is
  a worry manufactured out of an empty database. A failed **AI** run does not claim the
  numbers are stale — it is not one of the four jobs that produce them.
- `formatDateTime` in `src/i18n/format.ts`, for the one place an hour matters. "Updated
  02/09/2026" for a sync that stopped at midnight reads as this morning's figure.

### Changed
- The overview section is no longer a placeholder, so `common.page.overview.soon` is gone
  from both catalogues and `web/test/pages.test.tsx` checks the "coming next" note on the
  four sections that still have one.

## [0.5.1] — 2026-09-02

### Added
- **The shell the screens go in** (`web/`) — a Vite + React SPA with routing, navigation,
  a light/dark theme, both languages, the sign-in screen and the chart wrapper every view
  will use. The five sections are placeholders that name what is coming; each is filled in
  its own slice. What is finished is everything a screen needs to exist inside.
- **No external origin, enforced by the build.** `src/server/security.ts` sends a CSP that
  names no outside host and permits nothing inline, so a webfont from Google, a chart
  library from a CDN or a bootstrap `<script>` would not merely be a privacy question — it
  would silently not run. Inter ships as two `woff2` files through `@fontsource-variable`,
  the icons are hand-written SVG components, and `scripts/check-web-assets.mjs` fails the
  build if any emitted file references an absolute URL or carries an inline `<style>` or
  `<script>`. A comment in `web/index.html` says why, so the next person to want a CDN
  finds the reason before the failure.
- **Design tokens in one place, generated into CSS** (`web/src/theme/tokens.ts` →
  `tokens.css`). Colours, spacing, radii and type scale are declared once in TypeScript,
  because the ECharts option objects need the same palette the stylesheet uses and two
  hand-kept copies of a colour drift the first time one is adjusted. The CSS is committed
  rather than built, so the dev server, the tests and the bundle all read the same values
  at first paint; `test/unit/web-tokens.test.ts` fails if the two disagree, which turns
  forgetting `npm run tokens:write` into a failing test instead of a wrong colour.
- **A theme with three states, not two.** Light, dark, and *follow the system* — and
  `system` **removes** the `data-theme` attribute rather than writing the currently
  resolved colour into it, which is the difference between a preference and a snapshot: a
  laptop that switches to dark at sunset should follow, and a stored `"dark"` from last
  night would not. The choice is remembered in `localStorage`, every access wrapped
  because storage can be unavailable, and a junk stored value falls back rather than
  throwing.
- **Charts that dispose themselves** (`web/src/charts/Chart.tsx`). ECharts is registered by
  hand from `echarts/core` — only the pieces used, with the SVG renderer — so the bundle
  carries no chart type no view draws. Each instance is disposed on unmount and rebuilt
  only when the theme changes; a data change updates the existing one. Every chart also
  carries `role="img"` and a text summary of what it shows, because a chart is the one
  component whose meaning is entirely visual.
- **A sign-in screen that decides nothing.** Which methods to offer comes from
  `/auth/session`: `local` is a judgement about the TCP peer address that a browser cannot
  make, so the password form appears only when the server says it would be entertained,
  and "no method available from this network" is a state the screen states plainly rather
  than an empty card. A refused login shows the server's single message verbatim — the API
  deliberately answers every failure the same way, since distinguishing "no such account"
  from "wrong password" confirms a guess for whoever is guessing.
- **The session is asked for, never inferred.** After a successful local login the client
  re-asks `/auth/session` instead of trusting the login response, so the signed-in state
  always comes from the cookie the browser actually holds. Asserted by a test on the exact
  request sequence.
- **The SPA fallback, matching the server's** — an unknown path renders "Page not found"
  *inside* the shell, with the navigation still there, because `src/server/spa.ts` hands
  every navigation the same `index.html` and the two have to agree about what happens next.
- **100 browser tests** (`web/test/`, jsdom) alongside the 979 server ones, in a second
  vitest project with its own setup and its own TypeScript program. They cover the
  properties that are invisible when broken: a modified click stays a browser click and
  never a route change, the back button works, a chart disposes, `system` theme leaves no
  attribute behind, and `t('time.monthCount', { count: 2.4 })` is `2,4 months` in English
  and `2,4 maanden` in Dutch — one catalogue, one formatter, two independent settings.
  The catalogues are the server's own JSON files rather than a copy, which is what makes
  `npm run i18n:check` cover what the browser renders.

### Changed
- `npm run typecheck` now checks two programs, the server's and the browser's; `npm test`
  runs both projects; `npm run build` emits the bundle into `dist/web` and the server
  serves it from there, so a deployment still has one port and no CORS.
- `GET /` and an unknown path answer differently depending on whether a bundle is present.
  Server tests pass `web: null` explicitly, so their behaviour does not depend on whether
  `npm run build` happened to have been run.

## [0.5.0] — 2026-09-02

### Added
- **The read-only API the views read from** — `GET /api/overview`, `/api/budget`,
  `/api/portfolio` and `/api/insights` (`src/server/routes/api/`). One rule holds the
  directory together: **a request never calls an upstream.** Everything served comes out
  of Balancr's own SQLite, written by a job on a schedule, which buys three things —
  a page load cannot be slow because Ghostfolio's price provider is slow, cannot fail
  because Actual is mid-restart, and opening the insights page cannot spend money. That
  last one is why the AI budget is a limit rather than a hope. The rule is enforced by a
  test that scans the directory for adapter imports rather than by everyone remembering it.
- **`freshness` on every response, as a field rather than a banner.** The cost of serving
  from a cache is that what is served can be out of date, and a stale figure presented as
  current is worse than no figure. So every payload carries the age of the data and the
  state of the jobs behind it. `stale` is deliberately about *failure*, not age: a second
  instance with `JOBS_ENABLED=false` has old data and nothing wrong with it, while a job
  whose last attempt errored is a different matter. `asOf` is the **oldest** success among
  the data jobs, because a fresh portfolio next to a two-day-old budget is two days old.
  The AI job is excluded from both — a rate-limited Gemini call does not make the budget
  numbers untrustworthy, and marking the whole dashboard stale for it would train the
  reader to ignore the flag.
- **Response schemas whose real job is the money** (`api/schemas.ts`). Validating one's own
  output looks like belt and braces, and for a shape mismatch it would be. What `cents()`
  actually guards is the integer invariant: one division, one average, one `* 0.5` in a
  future aggregate turns `1234` into `1234.5`, which renders as `€ 12.345` and is wrong by
  an order of magnitude in a way no test of that aggregate would notice. The parse sits at
  the last point where the value is still Balancr's problem, and a test walks every field of
  every response asserting `Number.isInteger`.
- **Nulls where a figure has not been computed, never zeros.** A fresh deployment has run no
  jobs, and the honest answer to "what is my net worth" before the first sync is "not known
  yet". Zero is a number someone would act on. Same reasoning behind `mwrBp` being absent
  from `/api/portfolio` rather than reported as `0` until the deferred work lands, and
  behind months-of-cover answering `null` when there is no spend to divide by.
- **Months of liquid cover in hundredths of a month** (`emergencyFundCentimonths`),
  averaged over a twelve-month window rather than read off the latest month — a holiday or
  an annual insurance premium would otherwise halve the figure and read as an emergency.
  Hundredths for the same reason as everything else here: the client formats `450` as
  `4,5`, and no arithmetic anywhere is trusted with a fraction.
- **Findings returned as codes and integers, on both the budget and insights endpoints.**
  The client renders them through the i18n catalogue, which is why these endpoints have no
  opinion about language, why a finding cannot end up half-translated, and why adding a
  language costs a catalogue rather than another model call. The two exceptions are
  deliberate and documented in place: the monthly narrative is free prose by design and is
  cached per locale, and the clarification and proposal cards are rendered from the local
  catalogue — where the real category names live, which is precisely why the model never
  saw them.
- **A malformed `?month=` is a 400, not a fallback** (`resolveMonth`). Answering `2026-13`
  with the latest month's numbers under the label that was asked for would hide a client
  bug behind plausible data. A *valid* month that was never computed is a different case
  and gets the empty state: that is a stale bookmark, not an error worth a red banner.

### Changed
- Every API route is registered without an `auth` opt-out, so the deny-by-default guard
  from `0.4.2` covers them by construction, and they inherit the global rate limit for the
  same reason. Both are asserted through the built app — 401 on each of the four without a
  session — and by a source scan for an `auth: false` or `rateLimit: false` that should
  never appear in that directory.

## [0.4.3] — 2026-09-02

### Added
- **The break-glass local login** (`src/server/auth/local.ts`, `POST /auth/local/login`),
  for when Authentik itself is what broke. Which means it cannot lean on any of
  Authentik's protections, so it carries its own and they are stricter than an ordinary
  password login would be: both factors always — `local_credentials.totp_secret` is not
  nullable, so a password-only local account cannot exist — one identical message for
  every kind of failure, and an argon2id verification against a decoy hash when the
  address is unknown, because argon2 takes long enough that skipping it would answer
  "is there an account here?" through the response time alone.
- **The gate is the TCP peer address, never `X-Forwarded-For`** (`AUTH_LOCAL_ALLOWED_CIDRS`).
  That distinction is the whole value of the setting: a forwarded header is exactly what
  a request arriving through the public tunnel would set. Which also means Traefik's own
  address must not be inside the range — noted in `.env.example` and the README, and the
  reason `config.ts` already refuses a loopback-only `TRUSTED_PROXY_CIDRS` in production.
  Tested by sending `X-Forwarded-For: 127.0.0.1` from outside the range and asserting it
  changes nothing.
- **A used code is a spent code** (`local_credentials.last_totp_step`, migration `0006`).
  A six-digit code is valid for its whole thirty-second step and for the step either side
  of it once clock skew is allowed for, so a code read off a screen is replayable for up
  to ninety seconds. The highest step already accepted is remembered and anything at or
  below it is refused. Worth closing on this path specifically: it is the one used under
  pressure, on whatever screen is to hand.
- **Lockout after five failures, counted across both factors** (`LOCKOUT_THRESHOLD`,
  fifteen minutes). A wrong code is as much a guess as a wrong password, and a second
  factor that can be retried freely is a formality. Attempts made while the lock is in
  force do not extend it — otherwise a script pointed at the endpoint holds the account
  shut indefinitely, which on the break-glass path is the outage it exists to survive.
  The trade is stated in the module header: someone already inside the allowed range can
  be a nuisance, and the CIDR gate is what keeps that on the LAN.
- **A third rate-limit bucket** (`LOGIN_RATE_LIMIT`, ten attempts per quarter hour per
  address). Fixed rather than configurable, because the knob would only ever be turned
  the wrong way. The per-account lockout is the real defence; this stops one client
  spending the server's argon2 budget across many accounts.
- **`npm run auth:local -- --email you@example.com`** (`scripts/local-user.ts`,
  `src/server/auth/provision.ts`): sets or resets the password and prints the TOTP
  enrolment URI once. A command-line tool rather than a settings screen for a reason that
  is not laziness — the credential exists for when nobody can sign in, so it cannot live
  behind a login, and running it on the host keeps the secret out of an HTTP response a
  reverse proxy might log. A reset mints a *new* TOTP secret, deliberately: an operator
  resetting this because they suspect a leak should not be left with half the compromise
  intact. Provisioning lives in its own module so nothing on the request path can write a
  password hash, which `grep` over `src/server/routes` can prove.
- `GET /auth/session` reports `methods.local` for **this connection** — the feature being
  on *and* the peer being inside the range — so the login screen never draws a form that
  is guaranteed to 404.

### Security
- The endpoint answers **404, not 403**, both when the feature is off and when the peer
  is outside the range. The interesting fact about a break-glass endpoint is that it
  exists; an attacker who learns "there is a password login here, just not for you" has
  learned where to go looking for a foothold. The operator's diagnostic is a `warn` line
  naming the refused address, and the response says nothing.
- `POST` means the ordinary CSRF check applies to it, so the login is not a hole in it.
- The attempted address is not logged. It is the one piece of an attempt that is personal
  data, and an operator diagnosing a failure does not need it — the CIDR gate's own line
  already says where the request came from.
- Setting a local password is **not** a promotion: the role rule matches the OIDC path,
  so only the first account in an empty database owns it. A break-glass account must not
  be a way to mint write access.
- An address matching more than one account is refused rather than guessed at, at both
  provisioning and login. `users.email` is deliberately not unique — the OIDC path needs
  an address to be able to move between subjects — so two matches is a situation for a
  person to resolve, not for a login to pick a row out of.

## [0.4.2] — 2026-09-02

### Added
- **Server-side sessions** (`src/server/auth/sessions.ts`, table `sessions`): the cookie
  carries 32 random bytes and nothing else — no claims, no signature. What is stored is
  `sha256(token)`, never the token, because `/data` is backed up nightly and a backup is
  a file that travels; read access to a snapshot of that table should yield no working
  cookie. No salt and no slow KDF, deliberately: the input is 32 uniformly random bytes,
  so there is no dictionary to build. Expiry is renewed only once less than half the
  window remains, which makes an active session effectively permanent and an abandoned
  one expire on schedule, for one write every few days instead of one per request.
- **The OIDC code flow against Authentik** (`src/server/auth/oidc.ts`, `openid-client` 6):
  issuer discovery, PKCE `S256`, `state` and `nonce`, with discovery performed lazily and
  cached only on success — so Authentik booting after Balancr in the same compose stack
  cannot poison logins until a restart. A failed discovery is somebody else's outage and
  answers 503.
- **Logins in flight as a table** (`src/server/auth/login-flow.ts`, table `login_flows`):
  the PKCE verifier, the expected `state` and the expected `nonce` must survive the
  round trip without travelling through the browser, or the protections they provide are
  handed to whoever is being defended against. A row rather than a signed cookie because
  single use is then a `delete` with a checked row count — a captured callback URL fails
  on the second attempt — and because a cookie big enough for all three would be sent on
  every request for the sake of ten seconds of a login.
- **The callback is looked up by cookie, not by the `state` in the URL.** Otherwise an
  attacker starts their own login and hands the victim the resulting link, and the victim
  ends up signed in to the attacker's account, typing their finances into it. The
  victim's browser has no matching flow cookie, so the link is useless on its own.
- **`sub`-keyed user rows** (`src/server/auth/users.ts`): the subject claim is the key,
  not the email address, so an address change keeps the account's history and whoever
  later inherits the old address is not handed it. The first subject through the door
  becomes `owner` and everyone after is `viewer` — a default rather than a flag, because
  the failure it avoids is silent: an Authentik policy widened to a group, and the second
  person holding write access to someone else's money. `locale` and `role`, which Balancr
  owns, survive a login; the display name is refreshed from the provider.
- **A deny-by-default route guard** (`src/server/auth/guard.ts`): the same shape as the
  CSRF hook, for the same reason — a route added in six months is protected because it
  exists, not because someone remembered a list. Opting out is `config: { auth: false }`,
  which is greppable. It runs at `preHandler`, after the rate limiter, so an anonymous
  flood is throttled before it costs a session lookup.
- **Endpoints**: `GET /auth/login`, `GET /auth/callback`, `GET /auth/session` and
  `POST /auth/logout`. The first two exist only when OIDC is configured — a 404 is the
  honest answer for a capability a deployment does not have. Logout is a POST and so
  still carries the CSRF check, and rotates both cookies.
- **A test issuer instead of a mocked library** (`test/helpers/oidc-issuer.ts`): a fake
  Authentik reached through `openid-client`'s `customFetch`, signing real RS256 ID tokens
  with `jose`. Mocking the client would have left the questions worth asking — is PKCE
  actually sent, is `state` actually compared, is a token minted for another application
  refused — answered by construction rather than by the code that ships. All three are
  now tested against the real library, along with replay, a missing flow cookie, a
  disabled account and a failed discovery.

### Security
- **`AUTH_OIDC_ISSUER` must be `https://` in production**, refused at startup rather
  than warned about. Found while writing the signature test: OIDC Core 3.1.3.7 condition
  6 lets a client skip verifying the ID token's signature when the token arrives over a
  direct TLS channel from the token endpoint, and `openid-client` takes that permission.
  So TLS to Authentik *is* what authenticates the claims — over plain `http://` on the
  container network, anything that can answer the token request can name itself as any
  user. There is now a test documenting the library's actual behaviour, so a change in it
  fails loudly instead of quietly making the reasoning wrong.
- **Cookie deletion uses the attributes the cookie was set with** (`clearedCookie`),
  because a mismatch leaves the original in place: a logout would leave the session
  cookie pointing at a deleted row. It works out, since the lookup fails — but "it works
  out" is not what a logout should rest on.
- **A login ends any session already in the browser**, so nothing chosen before
  authentication survives it.
- The production cross-field config rules — the loopback-only `TRUSTED_PROXY_CIDRS`
  check, the `PUBLIC_BASE_URL` HTTPS check and the new issuer check — now have tests
  (`test/unit/config-guards.test.ts`). A guard that silently stops firing is worse than
  no guard, because `.env.example` still promises it.

### Fixed
- An unmatched path answered 401 rather than 404 once the guard was deny-by-default:
  `routeOptions.url` is undefined on the way to the not-found handler and there is
  nothing there to protect. It also made every "this deployment has no such endpoint"
  answer a lie, including the 404 that `/auth/login` relies on when OIDC is unconfigured.
- `csrf.ts` declares its own `FastifyContextConfig` field instead of casting
  `routeOptions.config`, so a typo in a route's exemption is a type error.

## [0.4.1] — 2026-09-02

### Added
- **The HTTP server, as its own module** (`src/server/app.ts`): a factory rather than a
  module-level instance, so a test builds a real app against an in-memory database.
  Registration order is the security order — cookies before the CSRF hook that reads
  them, headers before any route can reply, rate limits before CSRF so a flood of
  tokenless requests is throttled like any other flood. `src/main.ts` keeps the
  lifecycle and hands the HTTP surface off to it.
- **Peer-versus-client address handling** (`src/server/net.ts`): the file that decides
  whether a forwarded header may be believed. `peerAddress` reads the TCP socket,
  which an HTTP client cannot choose; `request.ip` is used for logging and rate
  limiting only. `ipaddr.js` does the matching, so an IPv4 client on a dual-stack
  listener (`::ffff:10.0.0.5`) still matches an IPv4 range instead of silently
  matching nothing. A malformed CIDR is a startup failure naming the entry, never a
  range that quietly matches everything or nothing.
- **Security headers** (`src/server/security.ts`): a content-security policy that
  permits no external origin at all — the same decision as bundling every asset
  locally. `'unsafe-inline'` appears nowhere, `frame-ancestors` and `base-uri` are
  `'none'`, and HSTS is sent only on an HTTPS deployment so a developer's localhost is
  never pinned.
- **Double-submit CSRF** (`src/server/csrf.ts`): sound here because of the `__Host-`
  cookie prefix — a token no sibling host can set is a token an attacker cannot know.
  One token per browser rather than per form, so two tabs and the back button work.
  A route opts out with `config: { csrf: false }`, which is greppable, unlike a route
  someone forgot to add to a list.
- **One error envelope** (`src/server/errors.ts`): `{ error: { code, message, requestId } }`.
  A message reaches the client only when the code chose it; Fastify's default echoes
  the thrown message, and the messages within reach include SQLite constraint text,
  better-sqlite3 paths and internal Actual and Ghostfolio host:port pairs.
- **Two rate-limit buckets** (`src/server/rate-limit.ts`, `RATE_LIMIT_API_PER_MINUTE`
  and `RATE_LIMIT_AI_PER_HOUR`): an ordinary per-minute bucket against noise, and a
  small hourly bucket in front of anything that can reach Gemini. The second is a
  spend limit wearing a request limit's clothes — a correctly authenticated caller is
  exactly the expensive one, so Authentik cannot help. Counters live in the new
  `rate_limits` table rather than in memory, because an hourly money limit that resets
  on deploy is not a limit. `/healthz` is exempt: a 429 there reads as a dead container.

### Changed
- `src/main.ts` is now lifecycle only — migrations, prompt seeding, i18n, the port and
  the shutdown order. The Fastify instance it used to build inline moved to
  `server/app.ts`.

## [0.4.0] — 2026-09-02

### Added
- **The clarification queue** (`src/domain/ai/clarify.ts`): the mechanism that turns
  "what is this budget for?" from a question asked every month into knowledge stored
  once. A card carries the model's **guess** for confirm-or-edit rather than an open
  question, because confirming a guess is one click and answering an interrogation is
  a chore — and an unanswered guess costs nothing, since every downstream computation
  already works without it.
- **Two materiality floors, both required**: 2% of the month's spend *and* €50. A
  relative floor alone interrogates you about every envelope in a quiet month; an
  absolute floor alone asks about a €60 line in a €4,000 month. The queue is then
  capped at five open questions, applied *after* sorting by share, so the five you
  see are the five worth answering.
- **Asked once, permanently.** Three of the five question codes write columns whose
  default is indistinguishable from an answer — `expected_frequency` defaults to
  `monthly`, and answering "monthly" would look exactly like never having been asked.
  So "asked once" lives in the queue's own history: `answered` and `dismissed` rows
  are kept for ever, and a dismissal is as final as an answer.
- **An answer writes straight through** (`answerClarification`), because the value is
  the *user's own* words, and it raises `category_meta.confidence` by 20 in the same
  transaction as the audit entry. A model's words never take that path — they go
  through a proposal.
- **Propose-and-apply** (`src/domain/ai/proposals.ts`): nothing the model suggests
  takes effect until someone approves it. The payload is validated twice — once when
  the proposal is stored, and **again at apply time**, because the gap between the two
  can be a version upgrade, and a partial write from a payload nothing understands any
  more is worse than a visible refusal. Handlers live in a closed map, and v1 ships
  only local-effect ones: nothing here can write to Actual.
- **The diff is recomputed when it is applied.** The card shows what *would* change;
  the audit trail records what *did*. If someone set the value by hand in between, the
  trail says the write changed nothing rather than repeating a prediction made weeks
  earlier.
- **A privacy warning on the one change that leaks a name.** Clearing `sensitive`
  starts sending the category name to the AI, so that field is flagged `privacy` in
  the diff and the review card says so in plain language.
- **The audit trail** (`src/domain/audit.ts`, `audit_log`): the record of every change
  a human approved, over the one table whose contents cannot be regenerated from
  Actual or Ghostfolio. Append-only — the absence of an `updateAudit` is the guarantee
  — with **no foreign keys at all**, because an entry whose run id a cascade can blank
  is not an audit trail but a cache of one. It stores field pairs rather than
  sentences, so a change approved during a Dutch session reads correctly in English.
- Applying a proposal deliberately does **not** raise `confidence`: that number
  measures what the user stated themselves, and the approval is already in the trail.
- **The nightly AI pass** (`src/jobs/ai.ts`), last in the job registry and the only
  job that spends money. It exists so that opening a page never triggers a model
  call: the ranked findings, the month's narrative and the clarification queue are
  all written hours earlier and read from SQLite. Local housekeeping — expiring
  stale proposals — runs *before* any call, so it still happens on a night when
  Gemini is unreachable.
- **A budget of zero turns the AI off** rather than capping it nightly: a user who
  set the budget to nothing does not want a `capped` ledger row every 24 hours
  telling them so.
- **The month that just ended is analysed once more, then left alone.** Its final
  days of spend landed after the previous night's run, so the figures it was judged
  on were never its final ones — but re-analysing a closed month every night for
  ever is paying repeatedly for an answer that cannot change. Three catch-up
  nights, read in the configured timezone, and never reaching back from a month
  that is already in the past.
- **A provider fault fails the job; a month-shaped one does not.** A spent budget
  and a month with no facts are states to report in the ops table. A call that
  could not be made, or an answer that could not be grounded, is a broken
  integration — and "no findings for four days" is only visible if that shows up as
  an error.

## [0.3.3] — 2026-09-02

### Added
- **The analysis runner** (`src/domain/ai/analysis.ts`): the one place the bundle,
  the ranking, the redaction, the prompt, the wire call, the schema, the grounding
  and the ledger are wired together — in the one order that keeps the guarantees.
  Rank *before* redacting, so the model is charged for two dozen findings rather
  than two hundred; check the budget *before* calling; render sentences *after*
  grounding, from the deterministic signal rather than from anything the model
  returned. The model's entire contribution is the order of the list and one
  severity it may lower, which is why a hallucinated finding cannot become a
  sentence: there is no code path from a model response to a rendered figure.
- **A signal the payload cannot explain is not sent.** `redact` gives a signal
  about an unknown category a null label, and null is the household sentinel — so
  a category's numbers would have arrived as a household finding. Those signals are
  filtered out of the payload and kept in the local list, where they are still real
  findings.
- **Every ending is a recorded run, except a month nobody attempted.** Over budget
  writes a `capped` row at zero cost carrying the payload it *would* have sent, so
  the audit view shows what was withheld; a transport failure and an unparseable
  answer write `error` rows, the latter billed for the tokens it spent, because a
  model stuck in a loop must not be free. All three return the deterministic list,
  so the page degrades to real findings in a defensible order rather than to an
  error. A month with no facts records nothing at all — an `error` row for a month
  that has simply not been aggregated yet would be a permanent false failure.
- **Findings are stored as numbers, not sentences** (`ai_findings`): a stored
  sentence would be in one language for good, and re-rendering from the metrics is
  what makes switching language free.
- **The monthly narrative** (`src/domain/ai/narrative.ts`), the one place the model
  writes prose. Cached per `(period, locale)`, so a language toggle cannot quietly
  spend money on the deep model; switching language offers an **explicit translate
  action** that sends a page of text to the fast model instead of a month of facts
  to the expensive one — and gives the reader the same review in their own
  language, not a second opinion about the same month.
- **What is stored is what the model wrote.** Labels stay in `ai_narratives`, and
  the household's own names are substituted on the way to the screen. That is what
  keeps a sensitive category's name out of the row the translate action later sends
  back to Google, and a label whose category has since disappeared renders as "an
  unnamed category" rather than as a bare `c9`.
- **A strict local Markdown renderer** (`src/util/markdown.ts`): no CDN, no
  dependency, and the safety argument is the ordering — every character is escaped
  before any tag is produced, and no branch ever writes an attribute, so
  `ALLOWED_TAGS` is the complete list of what can appear on the page. Link syntax
  collapses to its label, images to their alt text. Substitution happens in the
  Markdown, before rendering, so a category called `<script>` is escaped like any
  other text instead of injected.
- Shared month fixtures (`test/fixtures/month.ts`) built through the real
  persistence functions, so a fixture cannot set up a state the aggregation layer
  could not actually produce.

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
