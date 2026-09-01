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
  <a href="https://github.com/nrosier/Balancr/releases"><img alt="Release" src="https://img.shields.io/badge/release-v0.3.1-blue"></a>
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
npm run dev
```

| Script | What it does |
|---|---|
| `npm run dev` | Watch mode with `.env` loaded |
| `npm run probe` | Read-only check of Actual and Ghostfolio, and a category-by-category reconciliation against Actual's own totals |
| `npm test` | Unit tests |
| `npm run typecheck` | TypeScript, no emit |
| `npm run i18n:check` | Key, interpolation and plural parity between `en` and `nl` |
| `npm run db:generate` | Generate a migration from a schema change |
| `npm run build` | Compile to `dist/` |

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
`0.4.0` is the version where every issue in the AI-layer milestone is closed, not
the version where the first piece of it landed.

Work merged on the way there releases as a **patch of the current minor**. While
the `0.4.0` slice is in progress the releases are `0.3.1`, `0.3.2`, … — each one a
real version for a real merge, none of them claiming a milestone that is not
finished yet. The minor is the promise kept; the patches are the progress toward
it.

When every requested feature is in, releases become `1.0.0-rc.N` for real-world
testing; **1.0.0 ships when the testing says it is ready**, not when the checklist
ends.

| Version | Milestone | Status |
|---|---|---|
| `0.1.0` | Config, schema, i18n, formatting, logging | ✅ |
| `0.2.0` | Actual and Ghostfolio adapters, capability probe | ✅ |
| `0.3.0` | Aggregation, portfolio snapshots, job scheduler | ✅ |
| `0.4.0` | AI: redaction boundary, findings, narrative, cost guard | 🔄 `0.3.x` |
| `0.5.0` | HTTP API, OIDC + local auth, sessions, rate limits | ⬜ |
| `0.6.0` | Web UI: overview, budget, portfolio, insights, settings | ⬜ |
| `0.7.0` | Backups, monthly digest, operational hardening | ⬜ |
| `0.8.0` | Portfolio advice, curated fund universe, Belgian tax module | ⬜ |
| `0.9.0` | Statbel benchmark, clarification flow, proposal handlers | ⬜ |
| `1.0.0-rc.N` | Feature complete, in testing | ⬜ |
| `1.0.0` | Blessed by the person whose money it is | ⬜ |

✅ complete · 🔄 in progress, shipping under the patch series shown · ⬜ not started

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
