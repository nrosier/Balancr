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
  <a href="https://github.com/nrosier/Balancr/releases"><img alt="Release" src="https://img.shields.io/badge/release-v0.11.3-blue"></a>
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
- **Overspending, five ways** — over what you assigned, over what is *available*
  after carryover, over your own 12-month norm, over what a comparable Belgian
  household spends, and over what is left once the direct debits still to fall this
  month are counted. They are reported separately, because they mean different
  things — the Belgian one is context rather than a verdict, which is why it can
  never read as an alert, and the last one fires while there is still time to move
  money rather than after the payment has gone.
- **Burn rate that knows the rent is scheduled** — projected month-end totals from
  spend so far, so a warning arrives mid-month instead of as a post-mortem, with
  Actual's schedules read so that one direct debit on the 3rd is not extrapolated
  into ten and an envelope with a €900 payment still due never looks comfortable.
- **What a shared cost actually costs you** — flag the categories you split with a
  co-parent and the budget page prints your share of them beside what left your
  account. Actual's figure is never adjusted; the second figure is an addition.
- **Portfolio** — allocation, returns and holdings from Ghostfolio, deduplicated
  against Actual so an investment account is never counted twice.
- **What to do about it** — a risk profile written in numbers, every asset class
  measured against its band, and one trade per class that left it: the reason, the
  instrument from a list you vetted, and what the Belgian tax on it would be.
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
- **Who lives here stays here.** The household roster behind
  [the benchmark](#comparing-with-belgian-households) and
  [the shared-cost split](#costs-shared-with-a-co-parent) — a year of birth, a share of the
  time, an optional name, the share of a shared cost you state — is never part of a payload.
  What the model may see about that comparison is a survey line, a share and a euro figure;
  about a split, the total you paid on shared costs, the share applied to it and the euros
  that leaves with the other household.

### Where it goes, and when

Four hosts, and three of them are yours: Actual, Ghostfolio and the OIDC issuer all sit
on your own network. Google is the only third party, and only if the AI layer is
configured at all — leave the Gemini credential empty and nothing leaves the machine
except the calls that fetch your own data from your own servers. The
[egress allowlist](#egress) is derived from those four, so a fifth host is refused
rather than reviewed.

- **Which Google.** `GEMINI_PROVIDER=vertex`, the recommended setting, sends to Vertex
  AI in `GOOGLE_CLOUD_LOCATION` (`europe-west1` by default), which keeps the request in
  that region and leaves an IAM and audit trail on your own project. `aistudio` is a
  plain API key with none of that, and a **free-tier** key is the one configuration to
  avoid outright: its terms allow Google to use prompts to improve its products, and
  these prompts are your budget.
- **Once a night, and never on a page load.** The nightly pass runs at
  `JOBS_NIGHTLY_HOUR` (03:00 local) and is the only thing that spends money on its own.
  Opening Insights makes no call — the findings, the narrative and the queues were
  written hours earlier and are read from SQLite. Every other call is one you asked
  for, by pressing a button that first says what it will cost.
- **What is in the call.** Category names with the month's budgeted, spent and
  available figures, the signals derived from them, and for the household comparison a
  survey line, a share and a euro figure. No payee, no memo, no individual transaction,
  no account number, and nobody's name or year of birth.
- **What "sensitive" actually withholds.** The name and the description you wrote — the
  two fields that say what the envelope is. It keeps the amounts, and it keeps the
  classification: the COICOP code, `fixed`/`variable`/`discretionary`, and how often it
  is expected. That is deliberate rather than an oversight — an envelope with no amounts
  and no class is one the model can say nothing useful about — but it does mean a broad
  category (`06`, health) is inferable from a flagged envelope. There is no per-envelope
  opt-out beyond the flag today: if even the class is too much, the honest answers are
  `AI_ENABLED=false`, or keeping that spending out of the budget Balancr reads.
- **How to check it without reading the source.** Insights → Ledger lists every call
  ever made — when, which model, tokens in and out, what it cost, how it ended — and
  "Show the exact payload" prints what was sent, from `ai_runs.payload_json`. Nothing
  prunes that table: a call made in the first week is still auditable a year later. If
  a claim above is ever false, that is where it shows.

### Privacy mode

A separate, on-screen concern from the list above: the eye icon in the header
(or Ctrl/Cmd+Shift+E) blurs every money figure and holdings quantity with a
CSS filter, so a screen over your shoulder — a video call, someone walking
past — sees shapes instead of numbers. Hovering or focusing one figure clears
just that one; the choice persists across reloads via `localStorage`.

It is a shoulder-check, not a security boundary:

- **The underlying text never changes.** It is still selectable, still what a
  screen reader announces, and still exactly what a look at DevTools or the
  page's own API responses would show. Blurring is a `filter`, not redaction.
- **Chart axes blur along with everything else.** Charts render with ECharts'
  SVG renderer, not canvas, so axis text is real DOM the same filter already
  reaches — net worth, budget-versus-actual and the category trend all blur
  wholesale rather than leaving a labelled line or bar on screen. The other
  two charts have no money-labelled axis to begin with, only a tooltip
  (already blurred).
- **One category of figure is deliberately exempt**, because it is not
  personal spending: the price of an AI call on the settings page (the
  prompt editor's test run, the spend panel) and configuration numbers you
  set yourself (thresholds, trading minimums). The same figures on the
  insights page — what a review cost, what a month has spent against its
  cap — blur like everything else there. An enforcement test scans `web/src`
  for any money call that bypasses `<Money>`/`<Private>` outside this named
  allowlist, so a new figure added anywhere else fails to blur, not just
  this one.

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
| **Investing** | `FUND_UNIVERSE_PATH`, `FUND_UNIVERSE_MAX_AGE_DAYS`, `TAX_RULES_PATH` |
| **Benchmark** | `BENCHMARK_PATH` |
| **Egress** | `EGRESS_MODE` (`enforce`\|`warn`\|`off`), `EGRESS_EXTRA_HOSTS` |
| **Locale** | `DEFAULT_LOCALE` (`en`), `SUPPORTED_LOCALES`, `FORMAT_LOCALE` (`nl-BE`), `TZ`, `BASE_CURRENCY` |
| **Jobs** | `JOBS_ENABLED`, `JOBS_SYNC_INTERVAL_MINUTES`, `JOBS_NIGHTLY_HOUR`, `JOBS_HISTORY_MONTHS` |

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

`JOBS_HISTORY_MONTHS` is a horizon, not just a lookback: an edit in Actual to a
month older than it covers is never picked up, however recently it was made.
Settings → Data window shows how many months that is and which ones the sync
pass has actually reached so far.

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

## The fund universe

Portfolio advice may only propose an instrument that is on a list you wrote. There is no
default list: `FUND_UNIVERSE_PATH` points at `./config/fund-universe.yaml`, nothing
creates that file, and until it exists advice proposes nothing and says why in the startup
log. What ships in the image is a template beside it.

```sh
cp config/fund-universe.example.yaml data/fund-universe.yaml
$EDITOR data/fund-universe.yaml
```

In a container, keep it on the data volume — `FUND_UNIVERSE_PATH=/data/fund-universe.yaml`
— so an upgrade replaces the template and not your list. The file is re-read on every use,
so an edit takes effect without a restart.

One entry, which is all the format is:

```yaml
version: 1
funds:
  - isin: IE00B4L5Y983
    name: iShares Core MSCI World UCITS ETF USD (Acc)
    ticker: IWDA                 # never used as an identifier; for finding it
    asset_class: equity          # equity | bond | cash | property | commodity
    region: developed
    currency: USD
    ter_percent: 0.20            # percent per year: 0.20 is twenty basis points
    domicile: IE
    distribution: accumulating
    ucits: true
    source: https://www.ishares.com/uk/individual/en/products/251882/
    last_verified: 2026-09-03
```

Four things are checked when it loads, and a file that fails any of them is refused with
the line and the fund named:

- **The ISIN's check digit.** A transposed pair of characters is otherwise a valid-looking
  reference to a different fund, and nothing downstream would notice.
- **Accumulating only.** A distributing share class pays out dividends that Belgian
  roerende voorheffing taxes at 30% every year, whether or not the money was wanted. The
  accumulating class of the same index reinvests inside the fund. They are not
  interchangeable, so only one of them belongs on a list of things to propose.
- **EEA-domiciled UCITS.** That is the passport that means a KID exists and a Belgian
  broker can sell it to you — which is why `IWDA` is a legitimate entry and `VTI` is not,
  however good its TER looks.
- **`last_verified` within `FUND_UNIVERSE_MAX_AGE_DAYS`** (365). Past it, the entry is not
  flagged, it is unproposable, and it is left out of what the model is shown at all. A
  list everybody agrees should be reviewed some day never is, unless it stops working.

What none of that checks is whether the name beside an ISIN is the right fund, whether the
TER is this year's, or whether the share class is the accumulating one. That is what
`source` and `last_verified` are for: the first makes the claim checkable in one click, the
second records when somebody did. **Copying the template is not vetting it** — the app
cannot tell the difference, and a universe of three funds you understand is worth more than
eleven you copied.

## Belgian tax

A trade costs more than its price. Balancr puts the Belgian taxes on a concrete
transaction, in euros, before it is made — the beurstaks on the way in and out, roerende
voorheffing on a dividend, the Reynders levy on a bond fund's interest component, and the
capital-gains tax that arrived in 2026.

Every rate lives in a dated file, `config/belgian-tax.yaml`, and none of it lives in code.
That is the whole design:

```yaml
rulesets:
  - effective_from: 2026-01-01
    beurstaks:
      tiers:
        - id: fund_accumulating_registered
          when: { kind: fund, distribution: accumulating, fsma_registered: true }
          rate_percent: 1.32
          cap_eur: 4000
          citation: 'WDRT art. 1262, 3° — Belgian-registered accumulating funds'
          last_verified: 2026-09-03
          status: transcribed
```

Rulesets carry the date they take effect and are selected by the transaction's own date, so
a sale in December 2025 is taxed under 2025's rules and one in January 2026 under 2026's —
including the capital-gains tax that did not exist before it. The file ships with both, and
a transaction before the oldest ruleset is refused rather than estimated.

Every rate also carries the article it came from, the day somebody last checked it, and a
`status`. **Everything shipped is `transcribed`, not `confirmed`** — transcribed from
published guidance, not verified against the law by anyone. That is not a disclaimer in a
comment: it is a field, it drives a sentence on screen naming the taxes in play, and it is
what a `confirmed` status is for once you have checked one against its article yourself.

Staleness here is shown and never enforced, which is the opposite of the fund universe. A
rate that changed last month, displayed with the date it was last checked, is still worth
more than no estimate; a fund entry nobody has re-read means possibly buying the wrong
instrument. So every line carries its citation and date, the startup log names the oldest
check, and nothing stops working.

**The 1.32% question.** Which beurstaks rate an accumulating fund pays turns on whether it
is registered for public distribution in Belgium — 1.32% if it is, 0.12% if it is not.
Nothing in the ISIN, the domicile or the exchange says which, so the fund universe has an
optional `fsma_registered` field and the estimate does not guess. Left unset, the answer
comes back as a **range** — "between € 1,20 and € 13,20" — and never as either end of it.
Defaulting to the low rate would understate the cost elevenfold in the direction that makes
a trade look cheap, which is the one direction that matters. The same applies to a bond
fund's interest component, which only the fund publishes: unknown reads as unknown, with a
line saying what to go and find out.

A file that could produce "no rate found" is refused at startup instead: an instrument kind
with no unconditional fallback tier, or a tier that shadows every tier below it, both fail
to load with the tier named and the fix stated.

None of this is tax advice, and it is not a filing. It is the arithmetic done in the open,
with the source of every number one click away.

## The risk profile

"Some risk, but not super high risk" is an adjective, and an adjective cannot motivate a
trade. **Settings → Risk profile** is where it becomes twelve numbers: a floor, a target and
a ceiling for each of equities, bonds, property and commodities. Three presets arrive with
their own figures visible before anything is committed to — Defensive, Balanced (the
default: 65% equities, 30% bonds, 5% property) and Growth — and editing any band makes the
profile `custom`, which the panel says the moment a box changes rather than after a round
trip. The profile in force is the numbers; the name is a label on them.

Targets must add up to 100%, every floor must sit under its target and every ceiling above
it. The panel adds up the targets as you type, and the refusal still lives on the server,
because a rule enforced in a form is a rule enforced nowhere.

Two thresholds decide when a drift is worth acting on at all:

| Setting | Default | What it does |
|---|---|---|
| Ignore drift under | `100` bp (1%) | How far past a band edge a share may sit before a trade is proposed. Zero would propose one every morning. |
| Smallest trade worth making | `€ 500` | A correction under this is reported and never suggested — a €300 rebalance pays beurstaks twice to move an allocation by three basis points. |

The portfolio page then draws one row per band class, worst drift first — **including the
classes worth nothing**, because zero bonds against a 30% target is the most actionable row
on the page and a table built from what is held would leave it out. Shares are of the
*invested* value, which the caption says out loud: cash at a broker is not an asset class,
and on an instance whose Ghostfolio holds a synced bank balance, measuring against the total
would drag every class below its floor at once. A class Ghostfolio has and your profile has
no band for is reported separately with its share, never folded into a neighbour — that is a
band to go and add, not a rounding error to absorb.

Underneath it, one trade per class that left its band, each carrying the drift figure that
motivates it. That is the requirement the code is shaped around: a suggestion holds the
drift line it came from and cannot be built without it, so the sentence on the card and the
row in the table are one function over one number rather than two texts that can disagree.
Each card also states:

- **What the amount means.** Buying from cash grows the base the share is a share of, so
  closing an apparent 15% gap at a 65% target takes nearly three times the gap. When the
  same report also wants a sale, the two fund each other and the gap *is* the trade. The
  card says which of the two it is; one figure quoted for both would be wrong by a factor of
  three in whichever case it was not written for.
- **Which instrument, or why none.** A purchase can only name a fund from
  [the fund universe](#the-fund-universe). When nothing in it covers the class, or when the
  class is over its ceiling and no position is labelled with it, the card says which — "no
  suggestion" and "no fund in your list" need different actions from you.
- **What acting costs**, from the [Belgian tax](#belgian-tax) module, and **what the cost
  leaves out**: the realised gain on a sale depends on a cost base Balancr never sees, so
  every sale says so rather than presenting a total that reads as complete.

A class outside its band that was left alone is reported too, with the threshold that
suppressed it and the size of the trade it suppressed — a red row with nothing under it is
a bug report waiting to be filed, and those are the numbers needed to judge the threshold.

Every figure here is computed in TypeScript. The model is not asked what to sell, how much,
or what it costs — see [the rule that makes it trustworthy](#the-rule-that-makes-it-trustworthy).
And nothing is executed: Balancr never places a trade, and both upstream tools stay
read-only.


### How long it has been like that

The rows above are about today. The fact worth reading is that the same row was there in
August and in July, because that is what separates a market that moved from a rebalance
nobody did — and it is the one thing on this page a language model is better at than a
threshold. Balancr therefore counts back over the month-end metrics it has been storing all
along: **Settings → Thresholds → Portfolio drift** sets how many consecutive month ends a
class must sit outside the same edge before it is worth a line, three by default, and never
one — a fortnight of markets can move a share on its own, and a single month outside a band
would repeat, less precisely, what the portfolio page already shows.

Four things the count deliberately does *not* do:

- **It does not measure against the bands you had at the time.** The profile is not
  versioned, so there is no honest way to say what it said in June. The claim is "given the
  profile you have now, this class has been outside it for three months" — which means
  widening a band this morning resets the run, and that is correct: you have just said that
  share is acceptable.
- **It does not count through a month nobody looked at.** A month with no metrics row, or one
  from before the invested/cash split was recorded, is not a month in which nothing drifted.
  Both end the count, because measuring shares against a missing denominator puts every class
  at 0% and below its floor — and counting through the hole would turn a run of one into a run
  of four on an instance whose history was backfilled.
- **It does not count an overshoot as persistence.** Below its floor in July and above its
  ceiling in September is not three months of one problem; the run has to be on the same side.
- **It does not imply a trend the history cannot carry.** How many month ends could be read at
  all is reported beside the count, and the narrative is instructed to say so where they are
  few.

What crosses to the model is the profile's name, one line per class with its share, its band
and its count, and the trades as *how many there were* — no ISIN, no fund name, no position.
The suggestions name an instrument to buy and Ghostfolio's unmapped entries are its own
strings for something it could not classify, so both are reduced to integers before anything
leaves the machine; the [golden denylist test](#privacy) covers the new fields. The narrative
may explain a drift of that length and may not do arithmetic on it: not the distance restated,
not the share turned into an amount, not a guess at what a rebalance would cost. A run
returning a figure that disagrees with the computed one changes nothing on any screen.


## Comparing with Belgian households

Your own twelve-month norm answers "is this month unusual for me". It cannot answer "is
€650 a month on food a lot", and that second question is what the budget page's last card is
for.

The reference is Statbel's **Household Budget Survey**: the share of its total an average
Belgian household spends on each of ten lines. It lives in
[`config/statbel-benchmark.yaml`](config/statbel-benchmark.yaml) — a dated file carrying the
survey, the year, a citation, the day somebody last checked it and a `status` per block,
the same arrangement as [Belgian tax](#belgian-tax) — and `BENCHMARK_PATH` points at it.
Point that at a path that does not exist and the card disappears while every other figure
stays exactly as it was: not everybody wants their spending held up against an average, and
that is a supported choice rather than a broken install.

Nothing in the app edits those shares. A screen that let anybody type over them would be a
screen that manufactures a reference, which is the one failure that would make this feature
worse than not having it. Two things are yours to supply:

- **Which line each envelope belongs to** — Settings → Benchmark mapping, as one of the
  twelve COICOP divisions, the international classification the survey itself is published
  against. The picker offers the twelve divisions rather than the ten survey lines because
  three divisions share the survey's "other expenditure" line, so "other" would store a code
  nothing could later resolve; the line each division feeds is shown beside the choice
  instead. There is a thirteenth entry, `00`, for what is not household consumption at all:
  savings, investments, taxes, transfers, debt repayment. Those are set aside rather than
  counted at zero — a budget holds plenty of them, and counting them would make every real
  share look small — and the card says how much was set aside.
- **Who lives here** — Settings → Household, as a year of birth and a share of the time per
  person. A year rather than a "child" checkbox, because a checkbox is right on the day it is
  ticked and quietly wrong from the next birthday, with nothing on screen to say so. Only the
  year is stored: a full date of birth would be more personal data than the scale can use.

The household is what makes the two comparable at all — a single parent spends less than the
average household and is not being frugal. The scale is the **modified OECD** one, also from
the file: 1,0 for the first person, 0,5 for each additional adult, 0,3 for a child under
fourteen. One part of that calculation is Balancr's and not the source's, and is labelled as
Balancr's wherever it shows: somebody who is here half the time counts at half their weight.
The published scale has no notion of part-time membership, so a prorated household prints the
assumption next to the figure it produced. Ages are taken as of the year being compared, so a
member who turned fourteen in March is a child in last January's comparison and an adult in
this one.

Two thresholds decide whether anything is said:

| Threshold | Value | What it prevents |
|---|---|---|
| Share of the month mapped | `70%` | Under it, no comparison is drawn and the card says what to map instead. 100% would mean the feature never switches on, because nobody maps every envelope; 50% would mean a chart about the mapping rather than about the spending. |
| Difference worth a finding | `20%`, and the same materiality floor in euros as every other signal | Rounding, a category that straddles two divisions and a month with five weekends each move a group by a few percent, and none of them is news. A line 40% over by €12 stays quiet too. |

**A difference is `info` and cannot become anything else.** The severity is capped in the
payload rather than by convention, and the stylesheet has no red cell to render one in,
because a household above the transport line has done nothing wrong and neither has one
below the restaurants line. There is deliberately no "below benchmark" finding: spending
less than average on transport is what not owning a car looks like, and flagging it would be
telling somebody their frugality is a problem.

The survey's euro total per household has not been transcribed, so the comparison today is
of **shares** — how your month divides against how theirs does — and the card says outright
that nothing in it claims you spend more than they do. Filling in the file's optional
`reference_household` block switches the same card to euro-for-euro, scaled to your
household's size on the scale. Either way the card cites the survey, the year and the date
the file was last checked, and lists the blocks nobody has yet confirmed against the source —
including, at the moment, the shares themselves.


## Costs shared with a co-parent

Paying the whole school bill in September is a 200% overrun against your own norm, and
roughly half of it was never economically yours. Actual is right either way — what left the
account is what left the account — but "did I overspend" is a different question from "what
did that cost me", and one number cannot answer both.

So the budget page prints a second figure beside the first, and never instead of it. Two
things switch it on:

- **Which categories are shared** — Settings → Categories, the *Shared* column. Opt-in per
  category, because the assumption behind the split is that the whole invoice left your
  account. A cost the co-parent invoices you for is already your share in Actual, and
  flagging it would halve a figure that was never doubled. The box is closed for income and
  hidden envelopes, which the split skips. Answering the assistant's `custody_shared_unknown`
  card sets the same flag — a checkbox exists so the feature is reachable without a Gemini
  key at all.
- **What share of them is yours** — Settings → Household. Leave it empty and Balancr derives
  it from the roster: the average share of the time the part-time members are here. Type a
  number and that is used instead.

The derived share and a stated one are **different claims, and the card says which**. Who
pays for the winter coat is negotiated separately from who has the children on Wednesday,
and plenty of agreements split costs down the middle on an unequal week — so a derived share
is Balancr guessing at an arrangement it has never seen, and a screen that printed the two
identically would be presenting a guess as a fact. Full-time members are left out of the
average: a partner who lives here does not halve the school fees, and averaging them in would
pull the share towards 100% and quietly make the whole feature do nothing.

What the card shows is a row per flagged category with spending that month, largest first:
what you paid, and your share of it. The paid column is Actual's own figure on every row and
in the total, so the card can never disagree with the envelope table above it. Under the
table sit the three sentences that qualify the figure — where the share came from, what the
shared categories are of the month's whole spend, and the assumption the second column rests
on. Nothing in the browser computes any of it; the offset is a subtraction the server did.

The monthly findings gain one line for it, `custody_offset`, and it is worth being clear
about its shape:

| Decision | Why |
|---|---|
| One finding for the household, not one per envelope | Five flagged categories paid in one month would say the same thing five times, and the useful figure is the total — it is what that month's overruns should be read against. |
| Capped at `info`, like the benchmark | Nobody has done anything wrong by paying a bill that gets split. A `warn` would put a joint-custody household at the top of the insights page every month for the shape of its family. |
| Counted as good news, though it is about spending | It takes weight off an overrun rather than adding any. The insights page styles it apart from a problem for that reason. |
| Silent under the shared materiality floor | A €20 offset on a shared subscription is true and not worth a line. |

**No budget figure is adjusted anywhere.** Not the envelope table, not the totals, not the
baseline a category is measured against, not the benchmark comparison. The split is
disclosure printed beside Actual's numbers, which is the same principle
[the benchmark card](#comparing-with-belgian-households) follows and the reason your share is
an extra column rather than a correction.


## What the month has already committed

A budget knows what has been spent. Between the 1st and the 28th it does not know what is
*coming*, and the two together are what "can I still spend this" actually asks. An envelope
with € 80 assigned, € 0 spent and a € 84,50 direct debit due on the 28th reads as untouched on
every screen and is already over. Actual holds the answer — the schedules are right there —
and nothing was reading them.

So the budget page prints a second figure per envelope, **Still to come**, beside what was
spent. Nothing switches it on: if there are schedules in Actual they are read on the next sync
pass, and if there are none every figure is zero and nothing appears.

### What it counts

| Decision | Why |
|---|---|
| A separate figure, never folded into spend | "Every category total agrees with Actual" is the property the rest of this application rests on. A projection that quietly included next week's rent would break it in a way nobody could see. |
| Only the current month | A closed month's committed figure is zero by definition: whatever was scheduled either happened, and is spend, or did not, and never will be. A past or future month returns nothing rather than a guess in either direction. |
| Costs only | A scheduled salary is not a commitment. Netting one against a bill would answer "what is still to come" with two things at once, and would take the weight off an overspend warning with money that has not arrived. |
| An occurrence due today still counts | On the one day a month a bill falls due it may or may not have posted. Counting it briefly puts a posted schedule in both columns and overstates the day by one bill; not counting it would understate every manual schedule for a whole day. Both are wrong on that day, and only one is wrong in the safe direction. |
| A range counts at its upper bound | Actual shows an approximate schedule at its average. The panel note says the assumption out loud rather than leaving a figure looking exact, because the direction that cannot produce an unpleasant surprise is the useful one here. |
| Money no rule attributes is not guessed into an envelope | Actual assigns a schedule a category through the rule it owns, and a schedule whose rule sets none is real money on a real date belonging to nothing. It counts in the month total, which says how many there are — putting it in a row would print a figure Actual will never agree with. |

The month total is therefore **not always the sum of the rows above it**, and it is stored as
its own figure rather than added up on the way to the screen. A total that disagrees with its
rows has to be the stored one, or the next person to read the code will "fix" it.

### Actual's recurrence rules, reimplemented

Actual's own expansion lives in `@actual-app/core`, which publishes raw TypeScript with
internal `#server/…` imports and takes its recurrence engine from a transitive `@rschedule`
dependency — none of it can be imported at runtime. So the rules are reimplemented, and
`test/unit/committed.test.ts` is a claim about what Actual would say for every frequency,
interval, day-of-month and nth-weekday pattern, ending mode and weekend solve direction it
offers. Two of those are worth knowing about, because each would be a plausible bug the other
way round:

- **A monthly schedule on the 31st has no occurrence in a 30-day month.** It is not clamped
  to the 30th. Actual skips the month, and so does this.
- **29 February in a common year is skipped without consuming a counted occurrence.** A
  schedule set to run four times from a leap day still runs four times.

A schedule whose weekend solve moves it backwards off a Sunday the 1st is paid in the
*previous* month, and the expansion scans a few days either side of the window so it lands in
the right one.

### What it changes

**The burn rate.** The projection was `spent ÷ elapsed fraction`, which gets a scheduled month
wrong twice: on the 3rd it turns one rent into ten, and on the 20th it reports an envelope as
comfortable that has a payment still due. It is now what has been spent, plus what is still
committed, plus only the *unscheduled* part of the spending extrapolated over the days left.
With no schedules anywhere both committed figures are zero and the arithmetic reduces exactly
to the old one — asserted across five positions in the month, rather than left to the algebra.

**A fifth overspend signal**, `committed_over_available`: more still scheduled to leave than
the envelope has left. It is capped at `warn` rather than `alert`, and the distinction is the
whole point — nothing has gone wrong yet, the money is still there, and this is the one
finding that can be acted on before it becomes an `over_available` on the 29th. It is reported
beside the other four and never folded into them, and it holds the same materiality floor:
a € 4,50 shortfall is true and not worth a line.

### What crosses the boundary

A schedule carries a payee, an account and the rule conditions that matched it — a bank's
`NETFLIX INTERNATIONAL B.V.` among them. Balancr's shape declares eight fields and none of
them is any of those, so the strip in `src/adapters/actual/queries.ts` removes them, along
with any field a future Actual version adds. What reaches the aggregation layer is an id, an
amount, a category id, a date or a recurrence, and three flags —
[the same rule](#privacy) every other read from Actual follows.


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

Two files matter to whatever takes over: the database at `DATABASE_PATH`
(`/data/balancr.db`) and `.env`, which holds the only copy of every credential. Stop the
app before copying the database — a running instance keeps its `-wal` and `-shm`
sidecars beside the file, and a plain `cp` of the `.db` alone can catch a checkpoint
half-written:

```sh
docker compose stop balancr
cp /data/balancr.db /somewhere/else/
docker compose start balancr

# or, without stopping it — the same mechanism the nightly job uses:
sqlite3 /data/balancr.db "VACUUM INTO '/somewhere/else/balancr.db'"
```

To restore one of those plain copies: stop the app, put the file back, delete any
`-wal`/`-shm` left beside it, run `npm run db:migrate` if the copy predates this build,
start the app. `/data/actual` is not worth copying either way — it is a cache of a
budget the Actual server still holds.

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

Work merged on the way there releases as a **patch of the current minor**. `0.8.0`
was claimed the day the last issue of the advice milestone closed, so the slices of
`0.9.0` now release as `0.8.1`, `0.8.2`, … — each one a real version for a real
merge, none of them claiming a milestone that is not finished yet. The minor is the
promise kept; the patches are the progress toward it.

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
| `0.8.0` | Portfolio advice, curated fund universe, Belgian tax module | ✅ |
| `0.9.0` | Statbel benchmark, shared costs, scheduled spend, insights month picker | ✅ |
| `0.10.0` | Budget depth: re-judging changed months, reusing an analysis | ✅ |
| `0.11.0` | Forecasting and on-demand insight | ✅ |
| `1.0.0-rc.N` | Feature complete, in testing | ⬜ |
| `1.0.0` | Blessed by the person whose money it is | ⬜ |

✅ complete · 🔄 in progress, shipping under the patch series shown · ⬜ not started

**Where it is now** — `0.11.3` is the current release, a fix on top of the
`Forecasting and on-demand insight` milestone above, which is already closed.
`1.0.0-rc.N` is next and has not started: a documentation pass, a
security-verification checklist, and a reconciliation acceptance test.

Progress is tracked as [issues](https://github.com/nrosier/Balancr/issues), grouped
by milestone. [`CHANGELOG.md`](CHANGELOG.md) records what each version changed and
why, one entry per release — this section used to repeat that history in prose and no
longer does.

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
