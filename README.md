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
  <a href="https://github.com/nrosier/Balancr/releases"><img alt="Release" src="https://img.shields.io/badge/release-v0.5.5-blue"></a>
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
  applied by you; v1 never writes to Actual at all, and a test scans the adapter
  to keep it that way.
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

**Where it is now** — `0.6.0`, slice 3 of 8: the budget page
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

Next are portfolio, insights and settings
([#31](https://github.com/nrosier/Balancr/issues/31)–[#33](https://github.com/nrosier/Balancr/issues/33)),
language switching end to end ([#34](https://github.com/nrosier/Balancr/issues/34))
and the accessibility and responsive pass
([#35](https://github.com/nrosier/Balancr/issues/35)) — shipping as `0.5.6`,
`0.5.7`, … until every issue in that milestone is closed and `0.6.0` lands.

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
