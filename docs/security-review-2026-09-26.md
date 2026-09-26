# Balancr full-codebase review — 26 September 2026

**Scope:** the whole repository at `HEAD` of `fix-572-573-digest-privacy` (working tree
included), not just recent changes. Static/manual review: every HTTP entrypoint and its
guard, `src/domain/**`, `src/jobs/**`, the AI boundary, the digest feature, `config.ts`,
`egress.ts`, the backup/restore path, every `db.select`/`update`/`delete` against a
tenant-scoped table, the generated migrations, and the `web/` bundle's data handling.
Two cheap empirical checks were run to confirm findings that would otherwise be
speculative (SQLite FK behaviour inside drizzle's migration transaction; Zod/SQLite
behaviour on out-of-range money values). No test suite, no build, no network calls, and
no repository file other than this one was modified.

All examples use synthetic placeholders (`a@example.test`, invented figures) in keeping
with the rest of the repo's tests.

## Summary

The overall posture is unusually strong for a self-hosted application of this size. The
things that most often go wrong here do not: authentication and CSRF are deny-by-default
hooks rather than per-route opt-ins, forwarded-header trust is decided from the socket
address rather than a header, secrets are AES-256-GCM at rest with the key validated at
boot, the AI payload has a single reviewable construction point, the markdown renderer
escapes before it emits, backups are authenticated encryption with a self-describing
authenticated header, and `tenantId` genuinely is threaded through essentially every
query. I found **no authentication bypass, no injection, no XSS, no path traversal, and
no cross-tenant read reachable over HTTP.**

Spot-checks of previously-claimed fixes came back accurate, which is worth stating
because it calibrates the rest: the 2026-09-25 F1 (stored credential sent to a
caller-chosen host) is genuinely closed by `sameHost` on both the PATCH and test paths;
F3 (AI payload retention) is genuinely closed — `clearStaleRunData` now nulls
`payloadJson`; F4 (the README's month-note exception) is genuinely documented. The
issue-#52 H/M/L findings referenced in the task are likewise in place.

What I did find clusters in three places the existing review rounds have not looked at:
**generated migrations**, **the audit log as a retention surface**, and **the digest
feature's two new capabilities (SMTP, PDF blobs)**.

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 1 |
| Medium | 5 |
| Low | 17 |
| Info | 6 |

### Fix these first

1. **D1 (High)** — `PRAGMA foreign_keys=OFF` in the generated migrations is a **no-op**,
   because drizzle runs every pending migration inside one `BEGIN…COMMIT` and SQLite
   silently ignores that pragma inside a transaction. Every table-rebuild migration's
   `DROP TABLE` therefore fires `ON DELETE CASCADE` on its children. Confirmed
   empirically. On upgrade, this has already destroyed every stored monthly narrative
   and AI finding (twice), every net-worth snapshot, and every `local_credentials` row.
   It is also a landmine under every future drizzle-kit-generated rebuild.
2. **C1 (Medium)** — an owner can permanently brick the entire settings screen with one
   accepted `PATCH /api/settings/integrations/ai`, because `budgetEur`/`modelPrices` are
   unbounded on the way in and bounded on the way out. No in-app recovery path.
3. **S3 (Medium)** — the digest mails the household's full financial PDF over
   **opportunistic-only** TLS. A relay that does not advertise STARTTLS receives it in
   cleartext, silently.
4. **P1/P2 (Medium)** — the month note (the one free-text PII field) and the digest
   recipient list are stored verbatim and *forever* in `audit_log`, which no retention
   job touches and every nightly backup carries. This is the same data #503/#539 bounded
   in `ai_runs` and the same data #573 just decided a viewer may not see.
5. **D2 (Medium)** — the process-wide job queue has no timeout and `buildDigestPdf`'s
   promise has no rejection path, so one stuck PDF render stops every job for every
   tenant, permanently, and makes every `POST /api/refresh` answer 409 forever.

---

## 1. Security

### S1 — Medium: a stored AI API key survives a change of custom base URL, unlike Actual/Ghostfolio secrets

`src/server/routes/settings.ts:2095-2101` (PATCH), `src/server/routes/settings.ts:2244-2246` (test)

#534/#535 established the rule that a stored secret must not follow a changed host: the
Actual and Ghostfolio PATCH handlers compute `hostChanged = !sameHost(...)` and write the
`''`/`null` sentinel over the secret (`settings.ts:1993-2009`, `:2046-2055`). The AI
handler does not apply that rule. It preserves `row.aiApiKeyEnc` whenever
`providerChanged` is false — and `provider` staying `openai-compatible` while
`aiBaseUrl` moves from `https://a.internal/v1` to `https://b.internal/v1` is exactly the
case `sameHost` exists for. The test path has the same gap: the stored key is reused when
`storedRow.aiProvider === candidate.provider`, with no comparison against
`storedRow.aiBaseUrl`.

**Failure scenario.** A tenant owner (or a compromised owner session) sends
`{provider:"openai-compatible", baseUrl:"https://<other-approved-host>/v1", modelFast:…}`
with `apiKey` omitted. The key that was typed for the first endpoint is now sent, as a
`Bearer` header, to the second one — and on the next nightly pass, with the tenant's
financial payload attached.

**Bounding that keeps this out of High.** `validatedAiBaseUrl` →
`validateCustomBaseUrl` (`src/adapters/openai-compatible/client.ts:54-89`) refuses any
host not in `EGRESS_EXTRA_HOSTS`, which only the operator sets, and it does so
independently of `EGRESS_MODE`. So the destination must already be operator-approved;
the exposure is "key moves between two approved endpoints", not "key moves anywhere".

**Fix direction.** Extend the `#535` invalidation to `aiBaseUrl`: treat a changed
`aiBaseUrl` origin exactly as `hostChanged` is treated for Actual/Ghostfolio (clear
`aiApiKeyEnc`), and gate the test route's stored-key fallback on
`sameHost(candidate.baseUrl, storedRow.aiBaseUrl)` as well as on provider equality.

### S2 — Medium: the digest email offers only opportunistic TLS

`src/domain/digest/email.ts:25-33`, `src/config.ts:278-285`

The transport is built with `secure: config.SMTP_SECURE` (default `false`) and nothing
else. Nodemailer's default for `secure: false` is plain connect plus STARTTLS *if the
server advertises it*: `requireTLS` defaults to false. There is no `SMTP_REQUIRE_TLS`
variable and no `requireTLS: true` in the options object.

**Failure scenario.** An operator points `SMTP_HOST` at a relay that does not advertise
STARTTLS — a misconfigured container, a relay that dropped the capability after an
upgrade, or an on-path attacker stripping the `250-STARTTLS` line. The monthly digest —
the narrative, the net-worth trend and the budget-vs-actual chart for the whole household
— is transmitted in cleartext SMTP, together with up to five recipient addresses. Nothing
in the log, the job detail or the UI distinguishes this from a successful encrypted send.

**Fix direction.** Set `requireTLS: true` by default (it is compatible with
`secure: false` on port 587 and simply refuses to send if STARTTLS is unavailable), and
expose an explicit `SMTP_REQUIRE_TLS=false` escape hatch for a loopback relay, the same
shape `validateCustomBaseUrl` already uses for `http://` on loopback. `config.ts`'s
`SMTP_HOST` comment already notes this traffic is outside `egress.ts`'s reach, which
makes it the right place to say what does protect it.

### S3 — Low: every digest recipient sees every other recipient's address

`src/domain/digest/email.ts:63`

`to: [...recipients]` puts all up-to-five addresses in a single visible `To:` header.
For a household that is usually fine; for a joint-custody or shared-accountant setup —
which is precisely the situation the recipient *list* exists for — it discloses each
participant's address to all the others. It also sits oddly beside the working-tree #573
change, whose stated reasoning is that a recipient "did not choose to be in it".

**Fix direction.** `bcc` rather than `to` (with `to: config.SMTP_FROM`), or one message
per recipient.

### S4 — Low: the stored digest PDF is served without reference to the current mode, and #572's cleanup is forward-only

`src/server/routes/settings.ts:1451`, `src/server/routes/settings.ts:1473-1481`

The working-tree fix deletes the stored PDF when `before.mode === 'pdf' && after.mode !== 'pdf'`.
Two residuals:

- **No backfill.** An install that switched from `pdf` to `email`/`off` *before* this
  change still has the stranded PDF, and nothing will ever delete it. #572 is a privacy
  fix, so the population it was written for is exactly the population it does not clean.
- **The download route trusts the row's existence, not the preference.** `GET
  /api/settings/digest/pdf` checks only `loadDigestPdf(...) !== null`. Any future path
  that writes a PDF row without going through the mode transition (a manual job run, a
  restored backup taken before the switch, a migration) re-exposes it.

**Fix direction.** Add the preference check to the download route
(`404` unless `mode === 'pdf'`) as defence in depth, and add a one-shot migration or a
first-run sweep that drops `digest_pdfs` rows for tenants not currently in `pdf` mode.

### S5 — Low: a viewer reads integration hostnames, the Actual sync id, model prices and the invite list

`src/server/routes/settings.ts:1055-1097`, `src/server/routes/settings.ts:1126-1192`

`GET /api/settings` is `requireUser`. `loadIntegrations` masks every *secret* to a
`*Configured: boolean`, correctly — but `actual.serverUrl`, `actual.syncId`,
`ghostfolio.url`, `ai.baseUrl`, `ai.googleCloudProject`, the model ids, the per-model
prices and the monthly budget all round-trip in the clear, as does `invites` (labels and
timestamps, via `listInvites`). None of these is a credential, but the internal hostnames
and the Actual sync id are exactly the reconnaissance a viewer with a foothold wants, and
the invite list tells a viewer which doors into the household are currently open.

This is the same argument the working-tree #573 change accepts for `recipientEmails`; it
just was not extended to the neighbouring fields.

**Fix direction.** Decide the rule once and apply it to the whole `integrations` block:
either mask host/id fields for a viewer the way secrets are masked, or state in
`loadIntegrations`' docstring that they are deliberately viewer-visible and why.

### S6 — Low: `apply-batch` echoes raw exception messages to the client

`src/server/routes/proposals.ts:131-137`

`errors.ts`'s stated rule is that a message reaches the client only when the code
deliberately chose it (`HttpError`) — "the messages this application can throw include
SQLite constraint text with column names, `better-sqlite3` file paths, and upstream
failures that name the internal host and port of Actual or Ghostfolio". The batch-apply
handler bypasses that: it catches per id and returns
`reason: error instanceof Error ? error.message : String(error)`. `applyProposal` →
`handler.applyRemote` → `withActual` surfaces `@actual-app/api` worker errors verbatim,
and `ProposalError` carries `z.prettifyError` output naming internal payload fields.

Owner-only, so the blast radius is small — but it is the one place in the codebase that
contradicts its own error-handling rule.

**Fix direction.** Map the per-id failure to a closed set of reason codes (the same shape
`ProposalWhyCode` already uses), or reuse `ProposalError`-only messages and collapse
everything else to a generic string, logging the detail.

### S7 — Low: abuse caps that are meant to be per-tenant are keyed per IP

`src/server/rate-limit.ts:281` (`keyGenerator`), `src/db/schema.ts:1443`

Every bucket keys on `request.ip`. `routes/ai.ts`'s own header already acknowledges this
for `prompt-validate` ("`aiRateLimit()` buckets per IP, which an IP rotation defeats") and
compensates with a ledger-backed daily cap. `INTEGRATIONS_TEST_RATE_LIMIT` (20/hour) has
no such compensation, and it is the bucket in front of the one endpoint that makes the
server open an outbound connection to an owner-chosen destination with a stored secret
attached. `INVITE_REDEEM_RATE_LIMIT` (10 per 15 min, guarding a 64-bit code) is in the
same position.

Relatedly, `rate_limits.tenant_id` is declared with a foreign key and is **never written
or read** — the store only ever writes `key`, `count`, `expiresAt`. A reader of the schema
would reasonably conclude the buckets are tenant-scoped.

**Fix direction.** Either populate and use `tenant_id` so the integration-test and
invite-redeem buckets are `(tenant, ip)` or `(tenant)`-scoped, or drop the column and say
in the table comment that buckets are per-IP by design.

### S8 — Info: `forgetProbe` is unscoped

`src/jobs/probe-state.ts:117-119`

`db.delete(upstreamProbes).where(eq(upstreamProbes.source, source))` deletes every
tenant's row for that source. It has no callers in `src/`, `scripts/` or `test/` today,
so it is currently harmless — but it is the only unscoped mutation left against a
tenant-scoped table, and its own sibling `loadProbes` carries a comment explaining why
that scoping matters (#380).

**Fix direction.** Give it a `tenantId` parameter, or delete it.

### S9 — Info: `EGRESS_MODE=off` removes the *only* check on some paths

`src/egress.ts:357`, `src/adapters/anthropic/client.ts:72`

`installEgressGuard` returns immediately when the mode is `off`, so no wrapper is
installed at all. Most adapters are unaffected in substance (they talk to fixed hosts),
but `callAnthropicWithConfig` and `callOpenAiCompatibleWithConfig` rely on the guard as
their outbound control, and the Ghostfolio/Actual test routes rely on `withScopedHost`,
which becomes a no-op. This is documented behaviour and the default is `enforce`; noting
it only because the docs frame `off` as "leave fetch alone" rather than "the per-call
scoped-host mechanism also stops existing".

### S10 — Info: things checked and found sound

Worth recording so the next pass does not re-derive them: `csrf.ts`'s double-submit rests
correctly on the `__Host-` prefix and uses `timingSafeEqual`; `net.ts` normalises
IPv4-mapped IPv6 before matching, and `localLoginAvailable` reads the socket not
`request.ip`; `auth/local.ts` pays for a decoy argon2 hash on a miss and consumes the TOTP
step with a single conditional `UPDATE`; sessions store `sha256(token)` only;
`spa.ts` passes the wildcard parameter to `sendFile` raw so `@fastify/send`'s traversal
guard actually fires; `getOrSpawnWorker` validates the derived `dataDir` with
`relative()`; `util/markdown.ts` escapes before it emits and its amount sentinels are
private-use codepoints that escaped input cannot forge; `backup/crypto.ts` bounds
`logN` before deriving a key and feeds the header to GCM as AAD; `backup/restore.ts`
verifies fully before it moves anything and never deletes.

---

## 2. Data loss

### D1 — High: generated migrations cascade-delete child rows, because `PRAGMA foreign_keys=OFF` is a no-op inside the migration transaction

`src/db/apply-migrations.ts:8`; `src/db/migrations/0025_unknown_brother_voodoo.sql:1,20,72,432`;
`src/db/migrations/0029_overrated_slyde.sql:1,40`;
`src/db/migrations/0044_nice_korath.sql:1,38,40`;
cascades declared at `src/db/schema.ts:84,124,770,1183,1214`

`src/db/index.ts:21` sets `foreign_keys = ON` on the connection. `drizzle-orm`'s
better-sqlite3 migrator runs **every pending migration inside one `BEGIN…COMMIT`**
(`node_modules/drizzle-orm/sqlite-core/dialect.cjs:676-694`). SQLite documents
`PRAGMA foreign_keys` as *"a no-op within a transaction"*. Every drizzle-kit table-rebuild
migration opens with `PRAGMA foreign_keys=OFF` and then `DROP TABLE <parent>` — and SQLite
documents `DROP TABLE` as performing an implicit `DELETE` that "may cause foreign key
actions".

I confirmed this end to end with a throwaway in-memory database reproducing the exact
statement sequence: inside the transaction the pragma read back as `1`, and dropping the
parent deleted every child row.

Concretely, in this repo:

| Migration | Parent dropped | Collateral, via the declared action |
|---|---|---|
| `0025:20` | `account_map` | **every `net_worth_snapshots` row** (`cascade`, `schema.ts:770`) — and the `net_worth_snapshots` rebuild at `0025:230` then copies an already-empty table |
| `0025:72`, `0044:38` | `ai_runs` | **every `ai_findings` row and every `ai_narratives` row** (`cascade`, `schema.ts:1183`, `:1214`); `proposals.run_id` nulled (`set null`, `:1238`) |
| `0025:432` | `users` | **every `local_credentials` row** and every `sessions` row (`cascade`, `schema.ts:84`, `:124`) |
| `0029:40` | `prompts` | `ai_runs.prompt_id` nulled (`set null`, `schema.ts:1029`) |

**Why this is the worst finding in the report.** `ai_narratives` is the single most
expensive artefact Balancr produces: the deep model, once per month, paid for from a
pre-paid key, and `runNarrative` will not regenerate it for free. `local_credentials` is
the break-glass login that exists for the day Authentik is what broke — losing it silently
on an upgrade is an outage waiting for a bad day. And `jobs/backup.ts`'s own header names
"the accumulated knowledge about the budget … plus the prompt versions and the AI ledger"
as the one thing that cannot be recomputed, which is exactly what this destroys.

The loss is **silent** (the migration succeeds), **irreversible** (the transaction
commits), and affects **upgrades only** — a fresh install drops empty tables, which is why
the test suite never sees it. `test/helpers/pre-migration-db.ts` exists, so the harness for
a regression test is already there.

**Fix direction.** Do not rely on the pragma inside the transaction. Either run the
migration statements with FK enforcement genuinely off (`sqlite.pragma('foreign_keys = OFF')`
on the connection *before* `applyMigrations`, restored after — SQLite honours it outside a
transaction), or replace `migrate()` with a runner that executes each migration file in its
own transaction with the pragma set outside it. Then add a test that seeds a child row,
applies a rebuild migration, and asserts the child survived — otherwise the next
drizzle-kit-generated rebuild reintroduces this. Separately, the damage already done needs
an operator note: anyone who upgraded across `0025` or `0044` has lost those rows and
should restore narratives from a pre-upgrade snapshot if they want them.

### D2 — Medium: the job queue has no timeout, and `buildDigestPdf` can never reject

`src/jobs/runner.ts:31`, `src/jobs/runner.ts:224-326`; `src/domain/digest/pdf.ts:134-140`, `:165-166`

`createSerialiser` (`src/util/serialise.ts:13-26`) is a single promise chain, and
`runner.ts:31` creates **one** of them for every job in the process, across every tenant —
deliberately, because Actual's sync engine has no concurrency guarantees. `runJob` has no
timeout of its own. Every other blocking step in the codebase is bounded (Actual worker
IPC 60s/120s, Ghostfolio `AbortSignal.timeout(20_000)`, AI calls 120s).

`buildDigestPdf` is the exception. Its completion promise resolves only on the document's
`'end'` event; there is no `'error'` listener and no `reject` path:

```ts
const finished = new Promise<Buffer>((resolve) => {
  doc.on('end', () => resolve(Buffer.concat(chunks)))
})
```

**Failure scenario.** `pdfkit` or `svg-to-pdfkit` emits `'error'` on the document stream
asynchronously (a font-metrics failure, a malformed SVG path from an ECharts option shape
the SSR renderer produces for an unusual dataset). With no listener, Node raises an
uncaught exception rather than a promise rejection — and if the failure instead leaves the
document simply never emitting `'end'`, the awaited promise never settles. In that second
case: the digest job hangs, the shared queue never advances, and **every job for every
tenant stops permanently** — no sync, no portfolio, no backup — while `inFlight` keeps the
`digest` claim, so `POST /api/refresh` answers 409 for that tenant forever. The dashboard
goes stale with the freshness block reporting the last successful run, which is the exact
failure `runner.ts`'s own header says the design exists to prevent ("nothing would notice
until someone opened a page and read a three-week-old figure").

**Fix direction.** Give the promise a rejection path (`doc.on('error', reject)`) and put a
wall-clock ceiling on `runJob` — an `AbortSignal.timeout`-shaped race that records the run
as `error` and releases the queue. The timeout is the more important half: it bounds every
future job as well as this one.

### D3 — Low: `saveMonthNote` is an unguarded read-modify-write of one JSON blob

`src/domain/ai/month-note.ts:82-99`, `src/server/routes/month-note.ts:48-51`

All of a tenant's month notes live in one `settings.value_json` map.
`saveMonthNote` does `loadAll(...)` → mutate in memory → `insert … onConflictDoUpdate`,
with no transaction around the read and the write. `PATCH /api/budget/note` compounds it
by reading `before` separately first.

**Failure scenario.** Two owners (or two tabs) save notes for different months
concurrently. Both read the same map; the second write replaces the first's key with the
stale copy. The note is silently lost — and it is one of only two free-text fields a
person types by hand, so nothing can reconstruct it.

The codebase already knows this shape is wrong: `db/schema.ts:1485`'s comment on `loans`
says a blob "would make 'edit this loan' a read-modify-write of every other loan, which is
the shape that loses a concurrent edit". The same reasoning applies here, and
`saveProfile` (`src/domain/advice/profile.ts:268-297`) has the same structure for the same
reason (though its merge semantics make the outcome less surprising).

**Fix direction.** Wrap the load-and-store in `db.transaction`, which is enough for
SQLite's single-writer model. A per-month row would be better still, but the transaction is
the cheap correct fix.

### D4 — Low: the sync job persists in four independent transactions

`src/jobs/sync.ts:319-365`; `src/domain/aggregate/facts.ts:~60-135`, `src/domain/aggregate/month-store.ts:103-113`

Inside one `step('compute', …)`, `syncCategoryMeta`, `persistFacts`,
`persistMonthTotals` and `persistMismatches` each open their own `db.transaction`. A
failure between the second and the third leaves `monthly_category_facts` updated while
`monthly_totals` — including `factsHash`/`factsChangedAt`, the fingerprint `signals.ts`
uses to decide whether a month's figures actually moved — still describes the previous
pass.

Self-healing on the next successful sync, which is why this is Low rather than Medium; but
until then the month reads as "unchanged" to the signals job while its per-category facts
have in fact changed, and the insights page shows findings judged against numbers that are
no longer there.

**Fix direction.** One transaction around the four, or make `factsHash` the last thing
written inside the same transaction as the facts it fingerprints.

### D5 — Info: one unrecognised file in `BACKUP_DIR` stops pruning forever

`src/backup/snapshot.ts:156-179`

`prune` iterates the sorted names and `break`s on the first one `snapshotTime` cannot
parse. A stray `balancr-old.db.enc` (matching `isSnapshot`'s prefix/suffix but not the
timestamp shape) sorts before every real snapshot and stops the loop on every run, so the
directory grows without bound. Documented as the deliberately safe direction ("neither is
something to delete on a guess"), and growth is bounded by disk rather than correctness —
recording it only so the unbounded-growth consequence is written down somewhere.

### D6 — Info: no confirmation on `POST /api/refresh/reset`, by design

`src/server/routes/refresh.ts:220-250`, `src/domain/aggregate/reset.ts:67-74`

Reviewed and found correct: the nine tables it wipes are all derivable, the delete is one
transaction, it is owner-only, `jobsInFlight` is checked *before* the delete so a running
job cannot have its output removed mid-write, and `category_meta`/`settings`/`prompts`/the
AI ledger are explicitly excluded. No finding.

---

## 3. Data protection and leakage

### P1 — Medium: the month note is retained verbatim and forever in `audit_log`

`src/server/routes/month-note.ts:59-67`; `src/domain/audit.ts:274-295`; `src/config.ts:214-222`

`AI_RUNS_TEXT_RETENTION_DAYS` (default 90) and `jobs/ai-runs-retention.ts` exist
specifically because, as `config.ts` puts it, "the payload is where the one unredacted
field (the month note, see `redact.ts`) lives". That bound applies to `ai_runs` and
nothing else.

`PATCH /api/budget/note` writes `before: { text: <previous note> }, after: { text: <new note> }`
into `audit_log` on every save. `audit.ts` is append-only by design — "Nothing in this
module updates or deletes a row. The absence of an `updateAudit` is the guarantee" — and
no job prunes the table. So **every version of every month note ever typed** persists
indefinitely in `audit_log.before_json`/`after_json`, and `writeSnapshot` copies all of it
into every nightly encrypted backup.

**Failure scenario.** A household types "Mum's care home deposit, €X, and the solicitor's
fee for the custody hearing" into a month note, then deletes it a week later. The current
note is gone from `settings`; both versions remain readable in `audit_log` forever, and in
fourteen backup files.

**Fix direction.** Either exclude the note *text* from the audit entry (record a length
and a hash — the audit question here is "was there a note when that nudge ran", which a
hash answers), or extend the retention sweep to null `before_json`/`after_json` for
`budget.monthNote` entries past the same window. The first is cleaner and matches how
`prompt.create` already audits "chars" rather than the body
(`src/server/routes/settings.ts:2854-2860`).

### P2 — Medium: digest recipient addresses are audited in plaintext, forever

`src/server/routes/settings.ts:1453-1461`

The working-tree #573 change decided that a recipient list is PII a viewer must not see,
because it is "a role that cannot act on it and did not choose to be in it". The audit
entry written three lines below that change stores `before` and `after` as the whole
`DigestPreference` object — `recipientEmails` included, in the clear, in a table with no
retention, carried into every backup.

The same applies to `settings.household` (`settings.ts:1409-1419`), whose `before`/`after`
carry member labels and birth years — the household roster, which is PII of people who are
not users of the application at all.

Note the contrast with `settings.integrations`, where `AUDIT_ACTIONS`' own comment
(`src/domain/audit.ts:173-181`) explicitly says the entry carries "only the same
`*Configured` shape the settings screen itself sees — so this trail can … without becoming
a second place a password could leak from". That reasoning was applied to credentials and
not to PII.

**Fix direction.** Audit the *shape* of the change, not the values, for the two
PII-bearing settings: `{ mode, recipientCount }` for the digest, `{ memberCount, country }`
for the household. Both answer the question the trail exists for.

### P3 — Low: the audit trail is write-only — nothing in the application reads it

`src/domain/audit.ts:311-326`

`loadAuditTrail` and `auditValues` have **no callers** outside
`test/unit/audit.test.ts`. There is no route and no UI that reads `audit_log`. Yet the
module's header states its purpose as "the only way to undo a bad answer later", 26 of the
29 `AUDIT_ACTIONS` entries are justified by a question somebody would open the trail to
answer ("was it always 3 000?", "who pointed this instance at a different Actual server"),
and `AUDIT_ACTIONS`' own comment says "the audit view groups by this" — describing a view
that does not exist.

So the codebase pays the full privacy cost of the trail (P1, P2) and realises none of its
benefit without direct SQLite access. That is the wrong side of the trade for a table that
accumulates PII indefinitely.

**Fix direction.** Either build the read surface (an owner-only `GET /api/audit` with
`entity`/`entityRef` filters — `loadAuditTrail` already has the signature), or scale the
retention and the field selection down to what direct SQLite access actually needs. Doing
neither is the one option that keeps the cost without the benefit.

### P4 — Low: a viewer can read the full assembled prompt, month note included

`src/server/routes/api/index.ts:116-123`, `src/server/routes/api/insights.ts:302-323`

`GET /api/insights/runs/:id/payload` is `requireUser` and returns `requestText` — which
`assembleRequestText` (`src/adapters/ai/prompt.ts:41-46`) builds as the system
instruction plus the fenced payload, and the payload carries `note` verbatim
(`src/domain/ai/redact.ts:431-455`). The route's own docstring justifies viewer access on
the grounds that "the payload is the redacted bundle and nothing else: aggregates,
category names, and an opaque label where a sensitive category would be" — which is
accurate about every field *except* the note, the one field `redact.ts` says crosses
unmodified.

This is internally consistent today (`GET /api/budget/note` is also `requireUser`), so it
is not a new exposure. It is flagged because #573 just adopted the opposite principle for
a neighbouring field, and because the route's own justification no longer covers what it
returns.

**Fix direction.** Either update the docstring to name the note exception (matching what
the README now does, per the 2026-09-25 F4 fix), or strip `note` from the payload view for
a viewer. A decision either way, written down, is the fix.

### P5 — Low: the digest PDF is an unencrypted blob in a table with no retention

`src/domain/digest/storage.ts:19-27`, `src/db/schema.ts:1648`

`digest_pdfs.pdf_bytes` holds a rendered document containing the household's narrative and
two charts, unencrypted, while `field-crypto.ts` exists and is used for credentials in the
adjacent `tenant_integrations` table. Consistent with `balancr.db` being plaintext overall
(`snapshot.ts:99` makes that argument explicitly), so this is mostly Info — but it is one
row of concentrated, human-readable financial summary rather than the integer columns the
rest of the database holds, and `loadDigestPdf` is called on **every** settings read
(`settings.ts:1121`) purely to test existence, so those bytes are pulled into memory on
every page load of the settings screen.

**Fix direction.** At minimum, replace the existence check with a `SELECT 1`/`count(*)`
so the blob is only read when it is actually being downloaded. Encryption is a judgement
call the plaintext-database argument already answers.

### P6 — Info: log redaction is a denylist of key names

`src/logger.ts:15-32`

The redact paths cover `password`, `apiKey`, `accessToken`, `securityToken`,
`clientSecret`, `authorization`, `cookie` and a one-level wildcard. A secret nested two
levels deep under a name not on the list (for instance an error object carrying a request
body) is not redacted. This is stated as a deliberate design ("A denylist at the sink is
the only version of this that stays true as the code grows") and I found no path that
actually logs one. Recording it as the residual it is.

---

## 4. Data corruption

### C1 — Medium: an owner can permanently brick the settings screen with one accepted request

`src/server/routes/settings.ts:709-726` (in), `src/server/routes/api/schemas.ts:86,1918-1924` (out),
`src/adapters/ai/pricing.ts:220`, `src/server/routes/settings.ts:1083-1094`

The request schema bounds `budgetEur` and the `modelPrices` entries only from below:

```ts
modelPrices: z.record(z.string().min(1), z.strictObject({
  inputEur: z.number().nonnegative(), … })).default({}),
budgetEur: z.coerce.number().nonnegative(),
```

`eurToMicroEur` then multiplies by 10⁶ and `Math.round`s. The response schema, meanwhile,
is `microEur() = z.int().nonnegative()` — which in Zod 4 requires a **safe** integer.

I verified the arithmetic: `budgetEur: 1e15` passes the request schema;
`eurToMicroEur(1e15) === 1e21`, which is not a safe integer; SQLite's INTEGER affinity
cannot represent it so it is stored as `REAL 1e21`; and `z.int().nonnegative()` rejects
`1e21`.

**Failure scenario.** An owner (or a fat-fingered form, or a client that sends a
string) submits `PATCH /api/settings/integrations/ai` with `budgetEur: 1e15`. The write
succeeds. From then on:

- `loadIntegrations` throws inside `integrationsSettingSchema.parse` →
- `GET /api/settings` is a 500, permanently;
- **every** settings write is a 500, because each one ends `return buildSettings(db, request)`;
- `PATCH /api/settings/integrations/ai` — the one route that could put the value back — is
  a 500 too, because its first act is `const before = loadIntegrations(db, tenantId)`
  (`settings.ts:2086`).

There is no in-app recovery. The owner needs `sqlite3` against the data volume. The same
applies to `modelPrices.inputEur` and friends, which also feed `tenantModelPrices` →
`eurToMicroEur`.

(For completeness: `Infinity` is *not* reachable — Zod 4's `z.number()` rejects
non-finite values, so `1e999` from JSON is refused. It is the large-but-finite range that
gets through.)

**Fix direction.** Bound the request schema to what the response schema can represent —
a `.max()` on `budgetEur` and each `*Eur` such that `value * 1e6 <= Number.MAX_SAFE_INTEGER`,
or better, validate the *derived* micro-euro integer with the same `microEur()` helper the
wire schema uses, so the two cannot disagree. A regression test asserting that any body the
PATCH accepts produces a settings payload that parses would close the whole class.

### C2 — Low: several aggregation parameters have a floor but no ceiling

`src/domain/aggregate/params.ts:48-61`

`baselineWarnBp`, `baselineAlertBp`, `materialityFloorCents` and `availableFloorCents` are
`z.number().int().min(0)` with no `max`, unlike their neighbours in `baseline`,
`burnRate`, `household` and `dayCurve`, all of which are bounded on both sides.
`1e20` is an integer as far as `Number.isInteger` is concerned, so it is storable — which
turns off every threshold signal silently rather than refusing the request.

Lower impact than C1 because these columns are not re-validated on the read path, so
nothing breaks; the numbers just stop meaning anything.

**Fix direction.** Add a `max` in the same spirit as the neighbouring groups (a basis-point
field cannot sensibly exceed, say, 1 000 000 bp).

### C3 — Low: `paramsPatchRequest` accepts non-finite-shaped records at the wire

`src/server/routes/settings.ts:257-265`

`paramGroupPatch = z.record(z.string(), z.number())` accepts any key and any finite
number; the real check is `unknownParamFields(patch)` plus `saveParams`' own schema. That
division is deliberate and documented. Recording it only because the wire schema's
permissiveness is what made C1 possible in the neighbouring route, and the two routes look
alike.

### C4 — Info: money and date handling reviewed and found sound

Every monetary column is integer cents or micro-euros; `costMicroEur` uses `Math.ceil`
so the ledger is never under the bill; `util/month.ts` is string-based with UTC parsing for
calendar arithmetic and `Intl`-based wall-clock parts for anything that depends on "now in
Brussels", with `monthIn(instant, tz)` explicitly provided so a job cannot straddle
midnight on the 1st; `aiSpendMonthly` groups by tenant so one tenant's spend cannot
throttle another's; `assertDenseMonths` refuses a sparse series rather than averaging across
a hole. `snapshotName` is UTC-stamped specifically so text sorting survives a DST change.
No findings.

---

## 5. Code quality

- **Q1 — Low. A comment that says the opposite of what the code does.**
  `src/domain/ai/clarify.ts:399-406`: *"How many questions are waiting. For a badge,
  without loading the cards."* — the implementation is
  `db.select({ id: … }).…all().length`, i.e. it loads every open row and counts them in
  JavaScript. `SELECT count(*)` is what the comment describes, and `countRunsSince`
  (`src/domain/ai/runs.ts:182-196`) already does it that way in the same codebase.

- **Q2 — Low. A stale reference to a file that does not exist.**
  `src/domain/digest/preference.ts:10` points at `digest/render.ts` for locale resolution.
  There is no `render.ts` in `src/domain/digest/`; the logic is `resolveDigestLocale` in
  that same file, consumed by `pdf.ts`.

- **Q3 — Low. `src/db/apply-migrations.ts:4` uses `new URL(...).pathname`** where the rest
  of the codebase correctly uses `fileURLToPath` (`src/server/spa.ts:90`,
  `src/adapters/actual/client.ts:64`). On Windows this yields `/C:/…` and the migrator
  cannot find the folder — which matches the "Windows migration-path adjustment" the
  2026-09-25 review had to make by hand to get a clean run.

- **Q4 — Low. `src/adapters/ai/prompt.ts` has no module docstring.** It is the file that
  owns `DATA_OPEN`/`DATA_CLOSE` and `FENCE_CONTRACT` — the prompt-injection boundary the
  whole AI layer rests on, and the thing `promptBodyRequest` refuses to let an owner
  smuggle. Every comparably load-bearing file in this repo opens with an argument for its
  own design; this one opens with an import.

- **Q5 — Low. `buildDigestPdf` has no `'error'` handling.** See D2 for the consequence.
  Listed here too because it is also a plain omission relative to how every other async
  boundary in the codebase is written.

- **Q6 — Low. `test/unit/tenant-isolation.test.ts` does not cover the newest tables.**
  It covers `account_map`, month totals, signals/hygiene, net worth, portfolio metrics,
  household/reference, properties, loans, debts, risk profile, the clarification queue,
  proposals and `ai_runs`. Absent: **`digest_pdfs`** (the newest feature, and the one
  holding a whole-household document), `ai_findings`, `ai_narratives`, `prompts`, `goals`,
  `tenant_invites`, `category_meta`/`category_translations`, and the `settings`-backed
  month notes. The `digest_pdfs` gap is the one worth closing first — `loadDigestPdf` and
  `deleteDigestPdf` are both correctly scoped, but nothing pins that.

- **Q7 — Low. Five near-identical category PATCH routes.**
  `src/server/routes/settings.ts:2358`, `:2451`, `:2497`, `:2535` (and `:2399` for
  translations) each repeat: `loadMapping(db, tenantId, null).find(row => row.categoryId === id)`
  → 404, then `try { save…() } catch (MappingError) { 404 }`, then a `recordAudit` differing
  only in the action name and one field. The duplication has not drifted yet, which is
  exactly when it is cheap to factor.

- **Q8 — Low. Per-tenant busy check in front of a process-wide queue.**
  `src/jobs/refresh.ts:223` reads `jobsInFlight(tenantId)`, scoped per tenant since #372.
  The queue it protects is process-wide (`runner.ts:31`). So the module header's third
  rule — *"a request that returns `202` and then sits behind four jobs has told the caller
  something untrue"* — no longer holds in a multi-tenant deployment: tenant B's refresh is
  accepted with a `202` and then waits behind tenant A's 90-minute sync. Either the
  guarantee or the comment needs updating.

- **Q9 — Info. `src/server/routes/ai.ts:1-7` maintains a count of endpoints in prose**
  ("The eight endpoints that can spend money … This count was already stale at 'six'
  before it was corrected to seven"). The file documents its own history of getting this
  wrong. A derived assertion (a test that counts the registered `/api/ai/*` routes) would
  retire the problem.

- **Q10 — Info. Missing test for a risky path: `sendDigestEmail` itself.**
  `test/unit/jobs-digest.test.ts` covers the job with `setMailTransport` stubbed, which is
  the right seam — but nothing asserts the transport *options* (`secure`, auth presence,
  and the `requireTLS` that S2 asks for), and nothing asserts the recipient header shape
  (S3). Both are the kind of thing that regresses invisibly.

- **Q11 — Info. `rate_limits.tenant_id` is a dead column.** See S7.

---

## 6. Code efficiency

- **E1 — Low. N+1 on `/api/insights`.** `renderProposal`
  (`src/domain/ai/proposals.ts:790-811`) calls `handler.targetName(db, …)` per row, and
  those resolve through `loadMeta` (`:195-205`) or `loadBudgetedCents` (`:372-390`) — one
  query each. `buildInsights` maps over `pendingProposals(db, tenantId)`, capped at 50, so
  a full queue is ~50 extra round trips per page load. Batch the category/fact lookup the
  way `openQuestions` already batches `loadCategoryNames`.

- **E2 — Low. Whole-table reads then filter/limit in JavaScript.**
  `openQuestions` (`clarify.ts:360-364`) selects every open row before sorting and
  `.slice(0, limit)`; `openQuestionCount` (`:400-406`) loads rows to count them (Q1);
  `pendingBudgetProposals` (`proposals.ts:587-601`) selects every pending
  `budget_amount.set` row with no `LIMIT` and filters by month in JS because the month is
  encoded inside `targetRef`; `findReusableRun` (`runs.ts:229-247`) `.all()`s the candidate
  set to do a prefix match on `model`. All are small today; all grow with the ledger, which
  `runs.ts` itself notes "only grows".

- **E3 — Low. Every settings write returns the full settings payload.** This is a
  documented decision (`settings.ts:20-25`) and the right one for correctness, but the
  payload is expensive: `benchmarkSetting` reads and parses a YAML file **from disk per
  request** (`settings.ts:966-974`), `prompts` resolves and lists versions for every
  `PROMPT_KEYS × (SUPPORTED_LOCALES + 1)` combination (`:1169-1174`), `dedupeCandidates`
  recomputes over the whole account map, and `loadDigestPdf` pulls a PDF blob into memory
  to test a boolean (`:1121`, see P5). A single-category PATCH pays all of it twice —
  once for `before`, once for the response.

- **E4 — Low. `loadMapping(db, tenantId, null)` to find one row.** Four routes
  (`settings.ts:2363`, `:2456`, `:2502`, `:2540`) read the entire category mapping to
  locate a single `categoryId` for the audit `before`. A targeted read of the one row
  would do.

- **E5 — Low. `VACUUM INTO` blocks the event loop.** `src/backup/snapshot.ts:119` runs it
  through synchronous better-sqlite3, so the whole HTTP surface stalls for the duration of
  the nightly snapshot. The file's own header correctly argues `VACUUM INTO` is the right
  *mechanism*; the synchronous execution is the separate cost. `crypto.ts:182-192`
  deliberately avoids `scryptSync` for exactly this reason, so the codebase already holds
  the principle.

- **E6 — Low. `loadNetWorthHistory` is unbounded.**
  `src/domain/aggregate/networth-store.ts:111-125` returns every stored date, and
  `src/domain/digest/charts.ts:37` feeds all of it into an SVG line series for the PDF —
  where the chart is 500×220 px and cannot show more than a few hundred points usefully.
  `showSymbol: history.length <= 24` suggests the author expected a small series. Cap or
  downsample for the digest.

- **E7 — Info. `egress.ts` re-queries `tenantIntegrations` on every `fetch`.**
  `installEgressGuard`'s docstring justifies this explicitly ("one row from a
  single-digit-row table, which is nothing next to the network call it is guarding") and
  the justification holds. Reviewed, no change wanted; noted so a future reader does not
  flag it again.

---

## Method and limits

Read in full: `config.ts`, `egress.ts`, `logger.ts`, `main.ts` (startup ordering),
`db/{index,schema,field-crypto,tenant,tenant-integrations,apply-migrations,migrate}.ts`,
all of `server/` (app, guard, sessions, local, oidc callback flow, login-flow, onboarding,
users, provisioning, invites, csrf, cookies, net, trust, rate-limit, errors, security,
spa, shell, locale, validate) and every route module, all of `domain/digest/`,
`domain/audit.ts`, `domain/ai/{runs,proposals,month-note,prompt}`, `domain/aggregate/{reset,params,month-store,networth-store}`,
`adapters/{actual/client,ghostfolio/client,ai/{client,prompt,pricing},anthropic/client,openai-compatible/client}`,
`backup/{crypto,snapshot,restore}`, `jobs/{runner,scheduler,refresh,sync,backup,digest,ai-runs-retention,index,probe-state}`,
`util/{markdown,month,serialise}`, and the `web/` data path
(`api/client.ts`, `privacy/`, `auth/session.ts`, the two `dangerouslySetInnerHTML` sites).
Skimmed with targeted greps: the remaining `domain/aggregate/**` and `domain/ai/**`
computation modules, `redact.ts`'s field-by-field construction, the 46 migration files,
and `test/unit/**` for coverage gaps.

Every tenant-scoped table was enumerated from the schema and every
`from()`/`update()`/`delete()` against it was checked for a `tenantId` predicate. Two
candidates came back: `analysis.ts:379` (safe — `sourceRunId` comes from the
tenant-scoped `findReusableRun`) and `probe-state.ts:118` (S8).

Two verification scripts were run from the repo root and deleted immediately
(`.fkcheck-tmp.mjs`, `.zcheck-tmp.mjs`); they created only in-memory SQLite databases. No
other repository file was modified. The test suite was not run and nothing was built.

**This review cannot establish that every vulnerability has been found.** In particular it
did no dynamic testing, no dependency-advisory scan, no container-image scan, no history
scan for committed secrets, and nothing against a live Actual, Ghostfolio, AI provider or
SMTP relay.
