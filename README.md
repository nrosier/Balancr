<h1 align="center">Balancr</h1>

<p align="center">
  <em>A self-hosted AI advisor for your budget and portfolio — reading
  <a href="https://actualbudget.org">Actual Budget</a> and
  <a href="https://ghostfol.io">Ghostfolio</a>, and keeping your data yours.</em>
</p>

<!--
  The release and licence badges are static on purpose. This repository is
  private, and shields.io reads the public GitHub API — its `github/v/release`
  and `github/license` endpoints render "repo not found" here, which looks like a
  broken project rather than a closed one. `npm run badges:check` fails if either
  badge drifts from package.json, or if a dynamic one comes back.
-->
<p align="center">
  <a href="https://github.com/nrosier/Balancr/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/nrosier/Balancr/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/nrosier/Balancr/releases"><img alt="Release" src="https://img.shields.io/badge/release-v0.5.13-blue"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

---

Actual and Ghostfolio each hold half the picture, and neither can reason across
the two. Net worth, savings rate and "can I afford to invest more this month"
all need both — which today means a spreadsheet, every month.

Balancr joins them, computes the numbers itself, and asks Gemini only to explain
and prioritise what it already knows.

## What it does

- **Where the money goes** — every category, every month, reconciled against
  Actual's own figures rather than recomputed and hoped for.
- **Overspending, four ways** — over what you assigned, over what is *available*
  after carryover, over your own 12-month norm, and (later) over Belgian
  reference spending for a comparable household. They are reported separately,
  because they mean different things.
- **Burn rate** — projected month-end totals from spend so far, so a warning
  arrives mid-month instead of as a post-mortem.
- **Portfolio** — allocation, returns and holdings from Ghostfolio, deduplicated
  against Actual so an investment account is never counted twice.
- **It asks about unclear budgets** — and remembers the answers. That accumulated
  knowledge is the part of this app worth backing up.
- **English and Dutch** — with Belgian number and date formatting in both.

## The rule that makes it trustworthy

**The model never computes a number.** Every figure is aggregated in TypeScript
and SQL from your own data; Gemini receives pre-computed facts and returns
*codes*, not prose:

```json
{ "code": "above_baseline", "category_id": 42, "value": 0.18, "severity": "warn" }
```

The sentence you read — *"Groceries is 18% above your 12-month norm"* /
*"Boodschappen ligt 18% boven je 12-maandsgemiddelde"* — is rendered locally from
the translation catalogue. So the output cannot invent a figure, cannot end up
half-English, and costs a fraction of what shipping raw transactions would.

## Privacy

- **No payees, no memos, no transactions ever leave the machine.** Only
  aggregates and category names, and categories you mark sensitive are sent as an
  opaque label plus their class.
- **Every call is logged verbatim.** `ai_runs.payload_json` holds exactly what was
  sent, so you can check the claim above by hand rather than trusting it.
- **A golden test enforces it** — the redaction test fails if any payee string
  from the fixture appears in a payload. It is load-bearing, not decorative.
- **Nothing the AI suggests takes effect on its own.** Proposals are reviewed and
  applied by you.
- **Neither source is ever written to.** Not Actual, not Ghostfolio, and not as a
  matter of intent: the Actual client re-exports no method that mutates a budget, the
  Ghostfolio client's read type cannot express an HTTP method or a body, and a test
  per adapter scans the source so a future edit that goes around either one fails
  before it ships.
- **No CDN, no external assets.** All JavaScript, CSS and fonts are bundled and
  served from the container, so the UI works on a locked-down network and leaks
  nothing to a third party by loading a page.

## Quick start

Requires an existing Actual Budget server, a Ghostfolio instance and a Gemini
API key (a paid one — the free tier may use prompts to improve Google's models).

```bash
git clone https://github.com/nrosier/Balancr.git
cd Balancr
cp .env.example .env && chmod 600 .env   # then fill it in
docker compose up -d
```

Behind Traefik and Cloudflare with Authentik in front, `compose.yaml` is the
starting point — adjust the hostname and the DockFlare labels for your stack.
Actual and Ghostfolio stay on the internal network; only Balancr is published.

### Running from source

```bash
npm ci
npm run db:migrate     # create/upgrade the SQLite schema
npm run probe          # validate both upstreams before trusting a number
npm run dev            # the server, on :3000
npm run dev:web        # the UI, on :5173, proxying the server's routes to it
```

Two processes in development, one in production: `npm run build` emits the bundle
into `dist/web` and the server serves it, so a deployment has no second port and
no CORS. The dev server exists for its hot reload, and proxies rather than mocking
so the browser talks to the real API.

| Script | What it does |
|---|---|
| `npm run dev` | Server in watch mode with `.env` loaded |
| `npm run dev:web` | Vite dev server for the UI, proxying to the above |
| `npm run probe` | Read-only check of Actual and Ghostfolio, and a category-by-category reconciliation against Actual's own totals |
| `npm test` | Unit tests — server under Node, UI under jsdom |
| `npm run typecheck` | TypeScript, no emit — two programs, server and browser |
| `npm run i18n:check` | Key, interpolation and plural parity between `en` and `nl` |
| `npm run tokens:write` | Regenerate `tokens.css` after changing a design token |
| `npm run db:generate` | Generate a migration from a schema change |
| `npm run build` | Compile the server and bundle the UI into `dist/` |

`npm run probe` is the one to run after upgrading Actual or Ghostfolio. Three of
the four Ghostfolio endpoints Balancr reads are its frontend's internal,
unversioned API; the probe tells you which one changed instead of letting a wrong
number reach a chart.

## Configuration

All of it via `.env` — see [.env.example](.env.example) for the full list.

| | |
|---|---|
| **Actual** | `ACTUAL_SERVER_URL`, `ACTUAL_PASSWORD`, `ACTUAL_SYNC_ID`, `ACTUAL_E2E_PASSWORD` (encrypted budgets only) |
| **Ghostfolio** | `GHOSTFOLIO_URL`, `GHOSTFOLIO_SECURITY_TOKEN` |
| **Gemini** | `GEMINI_PROVIDER` (`vertex`\|`aistudio`), `GEMINI_API_KEY`, `GEMINI_MODEL_FAST`, `GEMINI_MODEL_DEEP`, `GEMINI_MONTHLY_BUDGET_EUR` |
| **Auth** | `AUTH_OIDC_ISSUER`, `AUTH_OIDC_CLIENT_ID`, `AUTH_OIDC_CLIENT_SECRET`, `AUTH_LOCAL_ENABLED`, `AUTH_LOCAL_ALLOWED_CIDRS`, `TRUSTED_PROXY_CIDRS`, `SESSION_SECRET` |
| **Locale** | `DEFAULT_LOCALE` (`en`), `SUPPORTED_LOCALES`, `FORMAT_LOCALE` (`nl-BE`), `TZ`, `BASE_CURRENCY` |

Two settings people expect to be one: `DEFAULT_LOCALE` switches the language,
`FORMAT_LOCALE` decides how money and dates are written. They are separate
because `Intl` with `en-BE` produces `€1,234.56` — so an English UI would
otherwise render amounts that no longer match your bank statements.

`TRUSTED_PROXY_CIDRS` is the one to get right. Authentik's identity headers are
honoured only from peers inside that range; without it, anyone who reaches the
container directly authenticates as you by setting a header.

`AUTH_OIDC_ISSUER` must be `https://` in production, and the app refuses to start
otherwise. OpenID Connect lets a client skip verifying the ID token's signature
when the token arrives straight from the token endpoint over TLS, and the library
takes that permission — so over plain `http://` on the container network, anything
that can answer the token request can name itself as any user.

### Setting up the Authentik provider

Create an **OAuth2/OpenID Provider**, bind it to an application, and take three
values from it:

| In Authentik | Into `.env` |
|---|---|
| Client ID | `AUTH_OIDC_CLIENT_ID` |
| Client Secret | `AUTH_OIDC_CLIENT_SECRET` |
| OpenID Configuration Issuer | `AUTH_OIDC_ISSUER` |

Client type **Confidential** — Balancr is a server holding a secret, not a browser
app. The issuer is the one on the provider's own page, trailing slash included:
`https://authentik.example.com/application/o/<app-slug>/`.

Then the redirect URI, which is the field that most often refuses a login. Balancr
does not read it from configuration — it derives it from `PUBLIC_BASE_URL`, so
register exactly that:

```
PUBLIC_BASE_URL=https://balancr.example.com
→ https://balancr.example.com/auth/callback     (matching mode: Strict)
```

Derived rather than configured because the alternative is trusting the request's
`Host` header, which would let a request decide where the authorization code is
delivered. The cost is that a wrong `PUBLIC_BASE_URL` shows up as Authentik's

> The request fails due to a missing, invalid, or mismatching redirection URI

rather than as a complaint about the variable that actually caused it. The
comparison is exact — scheme, host, any non-default port, and no trailing slash —
so a `PUBLIC_BASE_URL` of `http://` or with a port that Cloudflare terminates will
not match an `https://` registration. Balancr logs the string it will send at
startup, so the check is a diff rather than a guess:

```
INFO  OIDC login enabled; the provider must have this exact redirect URI registered
      redirectUri: "https://balancr.example.com/auth/callback"
```

Balancr must be served at the root of that origin. A sub-path in
`PUBLIC_BASE_URL` is discarded when the callback path is appended, because every
route and asset the SPA loads is rooted.

Scopes are `openid profile email` — a display name and an address are what the UI
shows. Not `offline_access`: Balancr never calls Authentik on your behalf after
login, so a refresh token would be a long-lived credential stored for no purpose.
PKCE (`S256`) is always sent, `state` and `nonce` are always checked, and a
response without an ID token is refused rather than treated as a login.

No `prompt` and no `max_age` are requested, so an existing Authentik session signs
you straight in — that is the point of putting SSO in front — and how long that
session lasts stays Authentik's decision rather than being hardcoded here.

The break-glass login is set from the command line, not from a screen:

```sh
npm run auth:local -- --email you@example.com
```

It asks for a password, prints the TOTP enrolment URI once, and that is the only
time the secret is readable. There is deliberately no web UI for it — the
credential exists for when nobody can sign in, so it cannot live behind a login.
Both factors are mandatory, five failures shut the account for fifteen minutes,
and `AUTH_LOCAL_ALLOWED_CIDRS` is matched against the TCP peer address rather than
`X-Forwarded-For`: a header is exactly what a request through the tunnel would
set. Which also means Traefik's own address must not be in that range.

## Architecture

```
Fastify ──┬── /api/*     read-only, against Balancr's own SQLite
          ├── /auth/*    OIDC (Authentik) + CIDR-gated local login
          └── static     Vite/React SPA, everything bundled locally
          │
cron ─────┴── sync → aggregate → snapshot → nightly AI run
          │
adapters ─┼── actual/      @actual-app/api, sole owner of the sync dataDir
          ├── ghostfolio/  REST, capability-probed
          └── gemini/      behind the redaction boundary
```

One container, modular inside. The one hard constraint is that a single process
owns Actual's `dataDir` — its API is a local sync engine over SQLite, not a REST
client, and it makes no concurrency guarantees. Operations are serialised for the
same reason.

## Versioning

`0.x` versions track progress toward 1.0, one **minor per completed milestone**:
`0.4.0` was the version where every issue in the AI-layer milestone was closed,
not the version where the first piece of it landed.

Work merged on the way there releases as a **patch of the current minor**. The
`0.6.0` milestone is in progress now, so its slices release as `0.5.1`, `0.5.2`, …
— each one a real version for a real merge, none of them claiming a milestone that
is not finished yet. The minor is the promise kept; the patches are the progress
toward it.

When every requested feature is in, releases become `1.0.0-rc.N` for real-world
testing; **1.0.0 ships when the testing says it is ready**, not when the checklist
ends.

| Version | Milestone | Status |
|---|---|---|
| `0.1.0` | Config, schema, i18n, formatting, logging | ✅ |
| `0.2.0` | Actual and Ghostfolio adapters, capability probe | ✅ |
| `0.3.0` | Aggregation, portfolio snapshots, job scheduler | ✅ |
| `0.4.0` | AI: redaction boundary, findings, narrative, cost guard | ✅ |
| `0.5.0` | HTTP API, OIDC + local auth, sessions, rate limits | ✅ |
| `0.6.0` | Web UI: overview, budget, portfolio, insights, settings | 🔄 `0.5.x` |
| `0.7.0` | Backups, monthly digest, operational hardening | ⬜ |
| `0.8.0` | Portfolio advice, curated fund universe, Belgian tax module | ⬜ |
| `0.9.0` | Statbel benchmark, clarification flow, proposal handlers | ⬜ |
| `1.0.0-rc.N` | Feature complete, in testing | ⬜ |
| `1.0.0` | Blessed by the person whose money it is | ⬜ |

✅ complete · 🔄 in progress, shipping under the patch series shown · ⬜ not started

**Where it is now** — `0.6.0`, slice 4 of 8: the web UI. The settings page is in
([#33](https://github.com/nrosier/Balancr/issues/33)) — the one screen in the
application that writes, and the eleven routes behind it: language, the seventeen
thresholds the aggregation engine judges by, the prompt editor with its diff and its
priced dry run, the account mapping that decides which of two tools counts a shared
investment account, and what the assistant has cost this month. So is the portfolio
page ([#31](https://github.com/nrosier/Balancr/issues/31)), and the history both
charts had been drawing without
([#114](https://github.com/nrosier/Balancr/issues/114)) — a nightly backfill over
Actual's dated balances and Ghostfolio's value series, so a fresh install shows two
years rather than one night. Insights is being built now.

**Three decisions are what make it safe to hand someone.** Every write answers with
the whole settings payload rather than the row it changed, so the page is a projection
of the server's state and never a local copy patched to match. The thresholds form is
rendered from that payload — `params` and `paramDefaults` are the domain schema itself,
so a threshold added to the aggregator appears on the page with no client edit, and a
test fails if its label is missing rather than letting it appear untranslated. And a
grouping mark in a whole-number field is handed back to be retyped instead of guessed
at: `2.000` in a basis-points field is 20% to anyone typing Belgian grouping and 0,02%
to a decimal parser, and there is no reading of it worth saving silently.

The prompt editor separates saving from activating, because activating an older version
*is* the rollback — and its dry run is a real model call on real figures, so the button
does not appear until the free estimate has priced it. The AI spend panel is read-only
on purpose: the monthly cap lives in the environment, and a cap editable by whoever
reached it is not a cap.

Before it, the budget page
([#30](https://github.com/nrosier/Balancr/issues/30)) — a month in the order someone
asks about it. Where the money went as an income-to-envelope Sankey, whether each
envelope held as a budget-versus-actual bullet chart, whether this month is on pace
against how far through it the server thought it was, and twelve months of shape per
envelope as a wall of sparklines with each category's own norm drawn through it. The
month is a query parameter, so the picker offers every month a job has written and a
month that was never computed answers with a sentence and a way out rather than a 404.

**Nothing on that page is computed.** Totals, norms, deltas, the trend series, the
burn-rate projection and the month's own progress all arrive from `GET /api/budget` as
integers; the single piece of arithmetic in the browser is the width of a rectangle,
which prints no number. Findings render from the same catalogue the emailed digest
uses, so a finding reads identically in both and adding a language costs a catalogue
rather than a model call — and a finding whose sentence is missing a figure is dropped
rather than printed with a hole in it.

Before it, the overview screen ([#29](https://github.com/nrosier/Balancr/issues/29))
established two things every remaining screen inherits. **A page has four states, not
one**: waiting, unreachable, answered-with-nothing and answered — and a figure the jobs
have not produced yet says "not known yet" rather than `€ 0`, because a zero is a wrong
number and a blank is a missing one. And **a session can vanish while a dashboard sits
open**, so a `401` from any endpoint is handed back up to the session gate, which
re-asks and lands on the sign-in screen by exactly the path a first visit takes.

**Running it against the real Actual and Ghostfolio found three defects**, all
filed. Ghostfolio has shipped `/api/v1/portfolio/details` with `holdings` as a
symbol-keyed map and as a plain list; only the map was read, so the portfolio job failed
every run and no holdings, allocation or TWR were stored
([#95](https://github.com/nrosier/Balancr/issues/95)) — fixed in `0.5.3` by accepting
both shapes at the boundary. Net worth was never affected; it reads a different
endpoint. And every AI analysis call was refused by Gemini before the model saw it
([#96](https://github.com/nrosier/Balancr/issues/96)), so the findings on the page were
the deterministic ones with nothing ranking them — which is exactly what the degraded
path was built for, and still a bug. Two causes: four draft-7 keywords the provider does
not accept, and `maxItems: 48`, which it does accept but refuses at that size. Both fixed
in `0.5.4`, and verified against the live API rather than against the documentation —
the second cause only showed up when the first fix was tried for real.

The third was found while diagnosing the first two, and it is the one that cost the
most time: **nothing in the logs said which build was running**
([#104](https://github.com/nrosier/Balancr/issues/104)). A container reporting
`0.5.0` had been pulled at `0.5.4` — pulled, but never recreated — and establishing
that took matching the digest `docker compose pull` printed against manifest digests
read out of CI logs. Until it was established, both fixes above looked like fixes that
had not worked. Startup now names the version first, before any step that can fail,
and the commit is stamped into the image as `revision`: every push to `main` publishes
`edge` from the same `package.json` as the last tag, so a version identifies a release
while only the commit identifies a build.

**Then `0.5.6`'s own startup log found four more**, which is the argument for that
version in one line. Ghostfolio has a release whose holdings carry no `symbol`
inside the object — it is the key of the map they arrive in — and the code that
flattened the map discarded the key and then reported the field as missing, failing
every portfolio pass ([#107](https://github.com/nrosier/Balancr/issues/107)). A
position now needs an ISIN *or* a symbol, from the object or from its key, and one
that has neither refuses the whole payload rather than being skipped: the portfolio
total is the sum of the rows that were stored, so dropping one would quietly shrink
every allocation share computed from it. `currency` became optional in the same
pass, having been required and never read.

Actual renamed its budget styles — `rollover` to `envelope`, `report` to
`tracking` — and the health check still tested the old name, so it warned that an
envelope budget was not an envelope budget on exactly the configuration it exists
to endorse, while staying silent on the one it is for
([#108](https://github.com/nrosier/Balancr/issues/108)). And an OIDC login was
refused by Authentik for a mismatched `redirect_uri` that Balancr never printed
([#110](https://github.com/nrosier/Balancr/issues/110)): the value is derived from
`PUBLIC_BASE_URL`, the provider compares it byte for byte, and the refusal happens
before the browser returns — so there was no request to log and no error to
improve. Startup now names the exact string it will send, and the Authentik section
above says what to register and why it is derived rather than configured
([#109](https://github.com/nrosier/Balancr/issues/109)). Found while fixing that one:
the function whose whole purpose is to print the effective configuration with every
secret masked was never called, so `PUBLIC_BASE_URL` had never been logged either. It
is logged now, one line after the version, and a test is what keeps it safe to log.

**And that log, in turn, found two more.** With `PUBLIC_BASE_URL` corrected and the
UI up, the portfolio job was still failing every pass — and the diagnostic `0.5.7`
had just added is what named the cause. It printed the keys the holding did have,
and `assetProfile` was among them while `symbol`, `isin`, `name`, `currency` and
`assetClass` were all absent: current Ghostfolio moved every identity field one
level down ([#113](https://github.com/nrosier/Balancr/issues/113)). They are lifted
out of `assetProfile` now when the holding does not carry them itself. `assetClass`
matters most there and fails most quietly — it is what the allocation chart groups
by, and reading it from the wrong level would not error, it would put every
position in `unknown` and draw one grey block.

Probing the same instance to confirm that fix turned up the second one:
`/api/v1/portfolio/performance` returns `404`, because Ghostfolio moved the series
to `/api/v2` ([#115](https://github.com/nrosier/Balancr/issues/115)). Return was
permanently null and the value chart permanently empty, and nothing said so —
the details call refused first, so the pass never reached this one and two defects
hid behind one error. v2 is tried first with a fallback to v1 on a `404` only, so
both generations of server work and neither fails silently. That endpoint turns out
to hold **401 daily value points**, which is most of the answer to why the net-worth
chart draws a single dot ([#114](https://github.com/nrosier/Balancr/issues/114)):
both series are written one row per nightly run, so they begin the day Balancr is
installed rather than the day the data does. A nightly backfill now reads those
points, and Actual's dated balances beside them, so both charts start where the data
starts.

**The first clean production run then found the rest by being readable.** With both
Ghostfolio defects fixed, every job finished `ok` and the log became legible enough to
read for what it was still getting wrong. Three things in it were about starting up
rather than about the numbers. Copying `.env.example` and filling in only what you use
refused to boot, because six optional variables were declared as optional *and* as
needing at least one character — so a variable left deliberately blank was reported as
too short, which reads as a rule about length and invites typing a placeholder into a
password field ([#118](https://github.com/nrosier/Balancr/issues/118)). A blank now
means "not set" for exactly those six, and a test copies the real `.env.example` to
prove it. `ACTUAL_E2E_PASSWORD` was the variable that happened to, and it turns out
Actual only reads that password when the budget is genuinely encrypted — so leaving it
empty was always correct, and when it is *not* correct the error now names the variable
instead of relaying Actual's own wording, which was written for someone standing in
front of Actual ([#119](https://github.com/nrosier/Balancr/issues/119)). And Actual's
sync engine had been writing ten lines of plain text through `console.log` into the
middle of pino's JSON on every hourly pass, because its verbose mode defaults to on;
it is now tied to `LOG_LEVEL`, quiet at `info` and back at `debug`
([#123](https://github.com/nrosier/Balancr/issues/123)).

The same log also named two things that are about the numbers, both filed rather than
fixed here. Net worth counts bank cash twice for anyone syncing accounts into
Ghostfolio as well as Actual — roughly a third of the reported total, entered once from
each source — and Ghostfolio can already tell the two kinds of account apart, so the
fix is to derive the classification and let it be overridden rather than ask for it
([#124](https://github.com/nrosier/Balancr/issues/124)). Gemini's context caching has
never once engaged, because the system prompt is about half the 1024-token minimum: it
degrades exactly as designed, which is why nothing noticed
([#121](https://github.com/nrosier/Balancr/issues/121)).

The portfolio page is up ([#31](https://github.com/nrosier/Balancr/issues/31)), and
building it turned up a figure that was wrong rather than missing: Ghostfolio converts
a position's value to euro but leaves its quoted price in the instrument's own
currency, and we were drawing both with a euro sign
([#134](https://github.com/nrosier/Balancr/issues/134)).

Next are insights
([#32](https://github.com/nrosier/Balancr/issues/32)), language switching end to end
([#34](https://github.com/nrosier/Balancr/issues/34)) and the accessibility and
responsive pass ([#35](https://github.com/nrosier/Balancr/issues/35)), together with
the double-counted cash ([#124](https://github.com/nrosier/Balancr/issues/124)) —
shipping as `0.5.13`, `0.5.14`, … until every issue in that milestone is closed and
`0.6.0` lands.

Progress is tracked as [issues](https://github.com/nrosier/Balancr/issues),
grouped by milestone. `CHANGELOG.md` records what each version changed.

A push to `main` publishes `edge`; a `v*` tag publishes that version, and
`latest` follows the newest non-RC tag. Releasing means bumping `package.json` —
the patch for a slice, the minor when its milestone closes — renaming
`## [Unreleased]` in `CHANGELOG.md` to it, and letting
`npm run badges:check` confirm the release badge above moved with it — that bump
is also what triggers the image build, since `package.json` is one of
[`image.yml`](.github/workflows/image.yml)'s trigger paths.

## Development notes

- **Dependencies** are updated by [Renovate](renovate.json), except
  `@actual-app/api` — it is versioned `YY.M` to match the Actual server release,
  so bumping it ahead of your server produces `out-of-sync-migrations`. That one
  is approved by hand, when the server is upgraded.
- **Secrets** are scanned on every push and pull request with gitleaks; the same
  command runs locally:
  ```bash
  docker run --rm -v "$PWD:/repo" -w /repo zricethezav/gitleaks:latest git --redact /repo
  ```
- **CI** typechecks, verifies `en`/`nl` catalogue parity, runs the tests and
  builds the image on every change.

## License

[MIT](LICENSE) © 2026 NiQck
