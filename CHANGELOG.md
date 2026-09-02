# Changelog

All notable changes to Balancr, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the
scheme in [README](README.md#versioning) — a minor lands when its milestone is
complete, patches carry the work in between, and 1.0.0 ships when testing says so
rather than when the feature list ends.

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

## [Unreleased]

### Added
- **The overview screen** (`web/src/pages/Overview.tsx`) — the first page that shows your
  own figures: net worth with its liquid, invested and debt parts, the savings rate for the
  month, how many months the buffer covers, net worth over time as a chart, and the
  data-quality score with what is costing it points. One `GET /api/overview` against
  Balancr's own SQLite, so opening the page triggers no sync and no AI call, and nothing on
  it is computed in the browser — the one arithmetic operation on the page is dividing
  centimonths of cover back into months.
- **A null prints "not known yet", never `€ 0`.** Every figure the endpoint can return is
  nullable, because a job that has not run has produced no balance, and a zero in that
  slot is a wrong number where a blank is a missing one. The card stays, so the reader can
  see *which* figure is missing rather than wondering where it went.
- **Four states per endpoint, not two** (`web/src/api/resource.tsx`,
  `web/src/ui/DataState.tsx`). `useResource` and `DataState` are one hook and one wrapper
  covering waiting, unreachable, answered-with-nothing and answered — with a reload that
  keeps the figures on screen instead of blanking them, a failed refresh that keeps the
  last good ones and notes the failure above them, and an out-of-order answer that cannot
  overwrite a newer one. Built once here because #30–#33 each read one endpoint the same
  way.
- **A session that expires under an open dashboard is handed upward.** A `401` from any
  read reaches `App.tsx` through `SessionExpiryProvider`, which re-asks `/auth/session` and
  lands on the sign-in screen by exactly the path a first visit takes — rather than leaving
  a page to decide, or showing a dashboard of empty charts for an account that no longer
  exists.
- **A freshness note that names what broke** (`web/src/ui/Freshness.tsx`). A failed
  background job is reported as the job and the message it recorded, restricted to the four
  jobs that produce these numbers — a failed AI run does not make a net-worth figure wrong,
  so it does not get offered as the reason one might be. A scheduler switched off gets its
  own note, and a fresh install with nothing to report shows nothing at all.
- **The net-worth chart** (`web/src/charts/NetWorthChart.tsx`), carrying integer cents all
  the way into the series so that every rendered string — axis, tooltip, and the sentence
  behind its `role="img"` — goes through `format.ts`. Daily snapshots get one month label
  where the month changes rather than an axis of unreadable dates.
- `formatDateTime` in `src/i18n/format.ts`, for the freshness note. `formatDate` takes a
  `YYYY-MM-DD` day and throws on a timestamp, and the difference between a sync that ran at
  breakfast and one that stopped at midnight is the whole point of showing the hour.

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
