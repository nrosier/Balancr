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
  <a href="https://github.com/nrosier/Balancr/releases"><img alt="Release" src="https://img.shields.io/badge/release-v0.7.0-blue"></a>
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
| `npm run backup:verify` | Decrypt a snapshot in a temp directory and prove it restores — the newest one, or `-- --all` |
| `npm run backup:restore` | Put a snapshot back, after verifying it in full |
| `npm test` | Unit tests — server under Node, UI under jsdom |
| `npm run typecheck` | TypeScript, no emit — two programs, server and browser |
| `npm run i18n:check` | Key, interpolation and plural parity between `en` and `nl` |
| `npm run contrast:check` | Every colour pair the stylesheets render, measured against the WCAG floor in both themes |
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
| **Gemini** | `AI_ENABLED`, `GEMINI_PROVIDER` (`vertex`\|`aistudio`), `GEMINI_API_KEY`, `GEMINI_MODEL_FAST`, `GEMINI_MODEL_DEEP`, `GEMINI_MONTHLY_BUDGET_EUR`, `GEMINI_CACHE_MIN_TOKENS` |
| **Auth** | `AUTH_OIDC_ISSUER`, `AUTH_OIDC_CLIENT_ID`, `AUTH_OIDC_CLIENT_SECRET`, `AUTH_LOCAL_ENABLED`, `AUTH_LOCAL_ALLOWED_CIDRS`, `TRUSTED_PROXY_CIDRS`, `SESSION_SECRET` |
| **Backups** | `BACKUP_PASSPHRASE`, `BACKUP_DIR`, `BACKUP_KEEP` |
| **Egress** | `EGRESS_MODE` (`enforce`\|`warn`\|`off`), `EGRESS_EXTRA_HOSTS` |
| **Locale** | `DEFAULT_LOCALE` (`en`), `SUPPORTED_LOCALES`, `FORMAT_LOCALE` (`nl-BE`), `TZ`, `BASE_CURRENCY` |

Two settings people expect to be one: `DEFAULT_LOCALE` switches the language,
`FORMAT_LOCALE` decides how money and dates are written. They are separate
because `Intl` with `en-BE` produces `€1,234.56` — so an English UI would
otherwise render amounts that no longer match your bank statements.

The whole Gemini block is optional. Leave the credential empty and Balancr starts
anyway: the aggregation, the overspend signals, the burn rate and the net-worth history
are computed locally and never involved a model, and the pages that would have needed one
name the variable to set. `AI_ENABLED=false` switches it off with the key left in place;
`GEMINI_MONTHLY_BUDGET_EUR=0` does the same. What is refused is a contradiction —
`GEMINI_PROVIDER=vertex` with only `GEMINI_API_KEY` set, or the reverse — because that
is a typo rather than a decision.

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

## Backups

One passphrase switches them on. There is no separate flag:

```ini
BACKUP_PASSPHRASE=write-this-down-somewhere-else
BACKUP_DIR=./data/backups
BACKUP_KEEP=14
```

Every night, after the other jobs, the database is copied with `VACUUM INTO` — a
consistent copy taken through SQLite rather than a file grabbed from underneath a
running WAL — and encrypted to `data/backups/balancr-20260903T030012Z.db.enc` with
AES-256-GCM under a scrypt-derived key. Sixteen characters is the minimum for the
passphrase because these files sit on disk, where a short one is attacked offline at
whatever rate the attacker's hardware allows.

**Nothing can recover a snapshot without that passphrase.** Not Balancr, not the
database, not Google. Write it down somewhere that is not `.env`.

Leaving it empty is a legitimate configuration — the job logs one line saying backups
are off and reports success — and it is the right one if the volume is already covered
by a host snapshot or a restic job.

What is worth protecting is smaller than it looks. Almost everything in the database is
recomputed from Actual and Ghostfolio on the next nightly run, so losing it costs a
night. What does not come back is the part you typed: every category description, COICOP
code and sensitivity flag built up by answering questions about your own budget, plus
the prompt versions and the AI cost ledger. `/data/actual` is deliberately not in the
snapshot — it is a cache of a budget the Actual server still holds, and re-downloading
it is one call.

`BACKUP_DIR` defaults to `./data/backups`, which is inside the one volume. That is a
real limit, stated plainly: a backup living in the volume it backs up survives a bad
migration, a mistaken bulk edit and a corrupted page, and does **not** survive losing
the volume. Point it at another mount, or copy the files off, if you want the second
case covered too.

A file is deleted only when it is both older than `BACKUP_KEEP` days **and** surplus to
`BACKUP_KEEP` files. Both clauses, because either one alone gets a case wrong: taking a
backup by hand before something risky would otherwise evict a scheduled one, and an
instance switched off for a month would come back, run one backup, and delete its own
history for being old.

### Checking that they work

```sh
npm run backup:verify            # the newest snapshot
npm run backup:verify -- --all   # every one, at a key derivation apiece
```

This is the question a nightly job cannot answer about itself: that the passphrase in
`.env` today is the one those files were written with, that they decrypt, and that what
comes out is this deployment's data rather than an empty schema. It decrypts to a
private temp directory, runs `PRAGMA integrity_check`, counts the rows in eight tables
and deletes the copy. It never touches the snapshot, the live database or an upstream,
so it is safe to run against production — and worth running after changing the
passphrase, after an upgrade, and occasionally for no reason at all.

### Restoring

Stop the server first: SQLite tolerates a great deal, but not having its file replaced
while it holds a connection to it.

```sh
docker compose stop balancr
npm run backup:restore -- --latest              # or a named snapshot
npm run db:migrate                              # if the snapshot predates this build
docker compose start balancr
```

The snapshot is decrypted and integrity-checked **in full before anything moves**, so a
wrong passphrase, a truncated file or a database that opens but fails its integrity
check all stop while the current database is still in place. Nothing is deleted either:
the database being replaced is renamed to `balancr.db.pre-restore-<stamp>`, with its
`-wal` and `-shm` sidecars moved alongside it, so restoring the wrong snapshot is undone
with one `mv`. Deleting those copies is left to you.

Then check Settings → Status. The upstream figures re-sync on the next nightly run, or
immediately from the refresh control on any page.

This procedure is not assumed to work. `test/unit/backup-restore.test.ts` runs it on
every test run — restoring over a corrupted database, over a database with stale WAL
sidecars, and refusing a wrong passphrase and a damaged snapshot while asserting the
target is left byte-for-byte unchanged. It has also been performed by hand end to end:
a migrated database with a hand-typed category description, backed up, overwritten with
garbage, restored, and the description read back.

## Hardening

The container runs as `node`, on a read-only root filesystem, with every Linux
capability dropped and `no-new-privileges` set. Everything writable is the one volume —
SQLite and Actual's sync cache — plus a 64 MB `tmpfs` for `/tmp`.

None of that is taken on trust, because all of it is configuration until something
checks it. `scripts/verify-image.sh` starts the built image with exactly the flags
`compose.yaml` uses and then asks the running container: which uid is this, does `/app`
really refuse a write, does `/data` really accept one, is `CapEff` all zeroes, do both
native modules load, and does the image's own `HEALTHCHECK` command actually work — a
broken one makes Docker restart a perfectly healthy container every interval, forever.
CI runs it on every image build and records the image size and the time to first
response in the job summary, so a change that doubles either is something a reviewer
walks past rather than has to go looking for. By hand:

```sh
docker build -t balancr:test . && scripts/verify-image.sh balancr:test
```

### Egress

Balancr refuses to connect to a host nobody configured. The allowlist is derived from
`.env` — Actual, Ghostfolio, the OIDC issuer and Google's Gemini endpoint — so there is
no second list to keep in step: moving Ghostfolio to a new hostname needs no edit here.

| | |
|---|---|
| `EGRESS_MODE=enforce` | the default: refuse the connection and log the host |
| `EGRESS_MODE=warn` | allow it and log the host — how to see what a new dependency wants before deciding whether it should have it |
| `EGRESS_MODE=off` | leave `fetch` alone |
| `EGRESS_EXTRA_HOSTS` | hostnames to allow beyond the four, for an outbound proxy |

A denial logs the host and never the path or query, because on an exfiltration attempt
the query string *is* the data being exfiltrated.

What this defends against is a dependency rather than a network. This process holds the
Actual password, the Ghostfolio token, the Gemini key and a database of your finances,
and the realistic attack on that is a compromised transitive package posting the lot
somewhere. It wraps global `fetch`, so it covers the Ghostfolio adapter, the Gemini SDK,
`openid-client` and anything else using the standard API; it does **not** cover a
library that reaches for `node:http` directly, a native module, or a child process, and
it is not a sandbox — code running in this process can put the original `fetch` back.
So: a real barrier against accidental and casual exfiltration, an audit trail for
anything unexpected, and no claim to stop an attacker who already runs code here. That
last one is what the network layer is for, and it is worth having as well: Docker
networks cannot express "these four hosts", so that version of the rule lives on the
host firewall or in whatever egress gateway the network already has.

### The `.env` file

It holds the Actual password, the Ghostfolio token, the Gemini key, the session secret
and the backup passphrase — the whole set, in plain text. `chmod 600 .env`, which the
quick start does, and which Balancr checks at every start: a group- or world-readable
file gets one warning naming the mode and the command that fixes it. A warning, not a
refusal — the mode of a file is not a reason to leave someone without their budget page.

Inside a container there is normally no such file at all: compose reads `.env` on the
host and passes the values as environment variables, so the check is silent there and
speaks up for installs running from source.

## Architecture

```
Fastify ──┬── /api/*     read-only, against Balancr's own SQLite
          ├── /auth/*    OIDC (Authentik) + CIDR-gated local login
          └── static     Vite/React SPA, everything bundled locally
          │
cron ─────┴── sync → aggregate → snapshot → nightly AI run → encrypted backup
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
`0.8.0` milestone is in progress now, so its slices release as `0.7.1`, `0.7.2`, …
— each one a real version for a real merge, none of them claiming a milestone that
is not finished yet. The minor is the promise kept; the patches are the progress
toward it.

Two milestones can be in flight at once, and then they share that one patch series,
which is what happened on the way here: `0.6.0` was claimed the day its last issue
closed, and the operational work that had already landed simply continued as
`0.6.1`, `0.6.2`, … until its own milestone closed as `0.7.0`. A patch number never
means a milestone; only a minor does.

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
| `0.6.0` | Web UI: overview, budget, portfolio, insights, settings | ✅ |
| `0.7.0` | Backups, monthly digest, operational hardening | ✅ |
| `0.8.0` | Portfolio advice, curated fund universe, Belgian tax module | ⬜ |
| `0.9.0` | Statbel benchmark, clarification flow, proposal handlers | ⬜ |
| `0.10.0` | Budget depth: month picker, scheduled spend, analysis reuse | ⬜ |
| `1.0.0-rc.N` | Feature complete, in testing | ⬜ |
| `1.0.0` | Blessed by the person whose money it is | ⬜ |

✅ complete · 🔄 in progress, shipping under the patch series shown · ⬜ not started

**Where it is now** — `0.7.0` is released: the data refreshes on a schedule and on
demand, the database is backed up and the restore is proven, the digest arrives monthly,
and the container's hardening is checked rather than declared. Next is `0.8.0`,
investment advice, shipping as `0.7.1`, `0.7.2`, … on the way.

The deployment is hardened, and — the part that took the work — checked
([#39](https://github.com/nrosier/Balancr/issues/39)). Non-root, a read-only root
filesystem and `cap_drop: ALL` were already in the Dockerfile and `compose.yaml`, which
made them claims: `read_only: true` protects nothing if the app turns out to need a
writable path outside `/data`, and the wrong moment to find that out is a deployment.
So CI now starts the built image with exactly those flags and interrogates it from the
inside — uid, an unwritable `/app`, a writable `/data`, `CapEff` all zeroes, both native
modules loading, and the image's own healthcheck command answering — then records the
size and the time to first response where a reviewer sees them. Asking the question
found something immediately: the runtime prune understood one of the two prebuild
layouts npm packages use, so every image up to here shipped all eight of
`better-sqlite3`'s platform binaries, seven of them unloadable on any Linux host. It
also carried 10 MB of vendored SQLite C source per copy. Seventy megabytes, gone, and
the pruner now takes the target architecture as an argument instead of assuming amd64 —
the same mistake in reverse would have deleted the only binary an arm64 build can load.
Egress is restricted in the process itself, because a Docker network cannot express
"these four hosts" and the only place that knows what they are is the one reading
`.env`. And the file holding every secret is checked for its mode at each start, since a
`0644` copy of it behaves exactly like a `0600` one from the inside.

Gemini is now optional ([#165](https://github.com/nrosier/Balancr/issues/165)). It was
not: `vertex` is the default provider and needs a Google Cloud project, so a copied
`.env.example` with the AI block untouched would not boot — a paid dependency demanded
of someone who only wanted to see where their money went. Missing credentials switch the
model off instead, and the pages say which line of `.env` would switch it on. Only a
contradiction is still refused, where the provider names one credential and the other is
the one that is set, because that is a typo rather than a choice. `AI_ENABLED=false` is
the other half: pause the spending without editing a key out of the file and back in.
Everything that computes a number is unaffected either way — the aggregation, the four
overspend signals, the burn rate, the net-worth history never involved a model — so the
insights page still draws them and drops only the three sections a model would have
filled. A narrative written while the key was in place stays readable.

The one thing the release before last got wrong about itself is fixed
([#121](https://github.com/nrosier/Balancr/issues/121)): every process start was asking
Google to cache a system prompt Google will not cache — the floor is 1024 tokens and
Balancr's prompts are 453 and 589 — so two models each spent a doomed round trip
rediscovering that and logged it as though something were wrong. The size is now
checked locally before the call, the estimate deliberately errs on the side of asking
anyway, and the mechanism stays for when the fund universe makes the prompt big enough
to be worth caching.

The figures can be made current by hand
([#122](https://github.com/nrosier/Balancr/issues/122)) — before this, the only ways
were to wait for the schedule or to restart the container. Every page already said how
old its numbers were; the control now sits next to that sentence, and starts only the
jobs whose figures that page shows, so re-reading a category total does not wait
through a Ghostfolio download. Asking for one job runs what depends on it — a budget
re-read that left net worth computed from the previous one would make the two halves of
the overview disagree — and the page names what ran that nobody asked for rather than
leaving it to be noticed. Progress is read from the job rows, not timed: "Refreshed" is
said only once every job has run *since* the request, with a row still marked `running`
and a job with no row yet both counting as unfinished, and after a minute it stops
waiting and says the job is still going instead of spinning. The analysis is the one
job not on that button. It spends money, so it has its own control on the panel that
already shows what the month has cost — priced from a free estimate first, then
confirmed with the amount in the button's own label.

Before that, insights ([#32](https://github.com/nrosier/Balancr/issues/32)) — the
view that had to show its own workings. It renders what a model
concluded about a month, so it renders every call that was made and exactly what went
out in each one — `capped` and `blocked` attempts included, because those are the
answers that are *missing* from the page above, and a failed run quotes the upstream
verbatim. That table is the privacy claim made checkable from a browser instead of
from a SQLite prompt on the host; each payload is fetched when its row is opened, one
at a time. Above it, findings are grouped worst-first from the same ranking the
server kept them by, and a finding whose sentence this bundle does not have, or whose
sentence is missing a number, is dropped rather than printed as a bare code or with a
hole in it. One paragraph on the page is prose a model wrote, and it says which model
and when. Both queues — the questions the analysis wants answered, the changes it
proposes — are read-only in this version and say so on screen: answering and applying
are [#43](https://github.com/nrosier/Balancr/issues/43)–[#45](https://github.com/nrosier/Balancr/issues/45),
and the queue is worth reading before the buttons exist, because it is what tells you
the analysis is asking about the right categories.

Balancr can now be asked whether it is working, and by whom
([#37](https://github.com/nrosier/Balancr/issues/37)). Three questions had one
endpoint between them; they have one each. `/healthz` stays liveness and touches
nothing, because a container that restarts when Ghostfolio restarts turns one outage
into two. `GET /readyz` answers whether traffic should be routed here, and carries
names and verdicts only — it is unauthenticated, and an internal hostname, an internal
port and an upstream's version fingerprint are not things to hand an unauthenticated
caller. The detail lives behind the session on `GET /api/status`, and a test projects
both payloads and pins the exact key set of each, so a field added later cannot reach
the open endpoint by being forgotten. The capability probe runs on a schedule now
rather than only at boot — it was a function nothing called after startup, which meant
a Ghostfolio upgrade at 10:00 was discovered by the next aggregation quietly producing
wrong numbers. An upstream nothing has probed reads "not known", never "ok". On screen
it is a sixth settings panel: four checks with their reasons, every job with its last
run, last success, next run, duration and schedule, and the probe's per-path report,
with Ghostfolio unreachable drawn amber and a changed response shape drawn red,
because only one of those is fixed by waiting.

The settings page is in
([#33](https://github.com/nrosier/Balancr/issues/33)) — the one screen in the
application that writes, and the eleven routes behind it: language, the seventeen
thresholds the aggregation engine judges by, the prompt editor with its diff and its
priced dry run, the account mapping that decides which of two tools counts a shared
investment account, and what the assistant has cost this month. So is the portfolio
page ([#31](https://github.com/nrosier/Balancr/issues/31)), and the history both
charts had been drawing without
([#114](https://github.com/nrosier/Balancr/issues/114)) — a nightly backfill over
Actual's dated balances and Ghostfolio's value series, so a fresh install shows two
years rather than one night. And the figure both pages lead with is now honest on a
deployment that syncs bank accounts into Ghostfolio as well as Actual: the shared
balances are counted once, on the Actual side that reconciles them, and the cash sitting
at the broker is named rather than drawn as an asset class
([#124](https://github.com/nrosier/Balancr/issues/124)). The pairs it cannot decide by
itself are put to you with the evidence attached, and a refusal is remembered
([#131](https://github.com/nrosier/Balancr/issues/131)). The language is settled by the
server now ([#34](https://github.com/nrosier/Balancr/issues/34)): one resolution
order behind both `<html lang>` and the strings underneath it, where the attribute used
to say `en` to everyone. And the palette has been measured rather than assumed
([#35](https://github.com/nrosier/Balancr/issues/35)): the gate now fails on a colour
pair under the contrast floor, in either theme, and one token that could not clear it is
gone. And the assistant's instructions are one text rather than one per language
([#133](https://github.com/nrosier/Balancr/issues/133)): editing them used to change
what English runs and leave Dutch on the old wording, silently. And insights
([#32](https://github.com/nrosier/Balancr/issues/32)) closed the milestone: what a
model concluded about a month, printed next to every call that produced it.

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

The same log also named two things that are about the numbers. Gemini's context
caching has never once engaged, because the system prompt is about half the
1024-token minimum: it degrades exactly as designed, which is why nothing noticed
([#121](https://github.com/nrosier/Balancr/issues/121)) — still filed rather than
fixed. The other is now fixed, below.

The portfolio page is up ([#31](https://github.com/nrosier/Balancr/issues/31)), and
building it turned up a figure that was wrong rather than missing: Ghostfolio converts
a position's value to euro but leaves its quoted price in the instrument's own
currency, and we were drawing both with a euro sign
([#134](https://github.com/nrosier/Balancr/issues/134)).

Account settings now record *who* decided each field
([#132](https://github.com/nrosier/Balancr/issues/132)). That sounds like
bookkeeping and was really a precondition: `kind` said `savings` and nothing
distinguished a rule from a person, so the classifier could not be written without
also reinstating the accounts held out of net worth by hand.

That classifier has now landed
([#124](https://github.com/nrosier/Balancr/issues/124)). Net worth counted bank cash
twice for anyone syncing accounts into Ghostfolio as well as Actual — roughly a third
of the reported total, entered once from each source, and called invested. Ghostfolio
could already tell the two kinds of account apart, so the label is derived from its own
evidence, each mirrored balance is grouped with its Actual twin, and cash held at the
broker is kept out of the allocation while staying in the total. Every derived answer
yields to a human one, permanently — including "these two are not the same account".

The interface's language is decided on the server now
([#34](https://github.com/nrosier/Balancr/issues/34)). The order this README has
promised since `0.1.0` — account setting, cookie, `Accept-Language`,
`DEFAULT_LOCALE` — existed only as a browser-side walk over `navigator.languages`,
so `<html lang>` said `en` to every visitor and an account's own setting was never
read at all. One order behind both answers is also what lets the chrome be sized for
Dutch and kept that way: thirteen length bounds in `npm run i18n:check` refuse a
translation longer than the box it has to fit.

The pairs the classifier will not group by itself are now put to you properly
([#131](https://github.com/nrosier/Balancr/issues/131)). The panel used to offer every
Ghostfolio account against every non-checking Actual account, which on an instance
holding a meal-voucher card, two eco-cheque balances, some cash and a savings account
is a wall of suggestions about accounts that have nothing to do with each other. Each
pair is now scored on the name, whole-word containment, a signed balance within €1 or
0.1%, and the currency — never on currency alone, never zero against zero, and never a
cash account against a portfolio — and the reason is shown in words, because a
suggestion you have to reverse-engineer is one you cannot check. **Not the same money**
is recorded against the account rather than the pair: a pair is identified by two names,
and the next sync that renames either side would bring the suggestion back.

The palette is measured rather than asserted
([#35](https://github.com/nrosier/Balancr/issues/35)). `npm run contrast:check` reads
the stylesheets, works out which colour pairs the cascade actually renders, and fails
the build under 4.5:1 for text or 3:1 for a border, a plotted shape or the focus ring —
in both themes, with every ratio and its remaining margin printed either way. Deriving
the pairs from the CSS rather than from a list is the whole point: a list describes
pairs nobody renders and misses the one that matters, which here was a grey that clears
the white card and fails the slightly darker page behind it. Five real failures came out
of it, one of them a text-box border at 1.54:1, and one token — a third, fainter grey —
turned out to have no value that both reads as faint and clears the floor, so it is gone
and small print is quieter by size instead.

The assistant's instructions are one text, not one per language
([#133](https://github.com/nrosier/Balancr/issues/133)). They were seeded under every
supported locale, so editing them changed what English runs and left the Dutch copy of
the same rule as it was, with nothing saying so — and the fallback that was supposed to
prevent that could never fire, because every language had a version of its own. They are
stored once now, and the reply language is what it always was: a separate directive
appended to every run. A language can still diverge, but it takes a button, and pressing
it is what puts that language in the editor's picker — so divergence is visible instead
of being the default. Going back switches the override off rather than deleting it, so
its versions stay readable and activating one is the way back.

The database is now backed up, and the restore is proven rather than assumed
([#38](https://github.com/nrosier/Balancr/issues/38)). One passphrase in `.env` switches
it on; a nightly `VACUUM INTO` copy is encrypted with AES-256-GCM under a scrypt-derived
key, and retention deletes a file only when it is both older than `BACKUP_KEEP` days and
surplus to `BACKUP_KEEP` files — so a backup taken by hand before something risky never
evicts a scheduled one. `npm run backup:verify` answers the question the job cannot ask
about itself, and `npm run backup:restore` verifies a snapshot in full before anything
moves and renames the database it replaces instead of deleting it. Most of what is in
there would be recomputed by morning anyway; what would not is the part you typed, which
is the reason any of this exists. See [Backups](#backups).

That closes the operational milestone. What comes next is `0.8.0`: advice about the
portfolio rather than only a picture of it — a curated fund universe, tax-aware
proposals, and the Belgian rules that decide what a move actually costs.

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
