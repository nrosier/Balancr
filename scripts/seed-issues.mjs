/**
 * Seeds the GitHub issue tracker from the roadmap.
 *
 * Idempotent, and safe to re-run: labels, milestones and issues are matched by
 * name/title and only created when missing. Nothing is ever edited or deleted, so
 * a re-run after hand-editing an issue leaves the edit alone.
 *
 *   node scripts/seed-issues.mjs [--dry-run]
 *
 * Kept in the repo rather than run once by hand because the roadmap changes, and
 * a tracker rebuilt from a file beats one rebuilt from memory.
 */
import { execFileSync } from 'node:child_process'

const dryRun = process.argv.includes('--dry-run')

const LABELS = [
  ['area:actual', '1d76db', 'Actual Budget integration'],
  ['area:ghostfolio', '1d76db', 'Ghostfolio integration'],
  ['area:aggregation', '0e8a16', 'Deterministic number crunching'],
  ['area:ai', '5319e7', 'Gemini, prompts, findings'],
  ['area:auth', 'b60205', 'Login, sessions, proxy trust'],
  ['area:api', 'c5def5', 'HTTP surface'],
  ['area:web', 'fbca04', 'Frontend'],
  ['area:i18n', 'bfd4f2', 'English/Dutch'],
  ['area:infra', '444444', 'CI, Docker, deployment'],
  ['area:privacy', 'd93f0b', 'What leaves the machine'],
  ['area:docs', '0075ca', 'Documentation'],
  ['type:feature', 'a2eeef', 'New capability'],
  ['type:chore', 'ededed', 'Maintenance'],
  ['type:test', '006b75', 'Verification'],
  ['priority:high', 'e11d21', 'Blocks other work'],
]

const MILESTONES = [
  ['v0.1.0 Foundation', 'Config, schema, i18n, formatting, logging.'],
  ['v0.2.0 Adapters', 'Actual and Ghostfolio integration with a capability probe.'],
  ['v0.3.0 Aggregation', 'Every number Balancr shows, computed deterministically.'],
  ['v0.4.0 AI layer', 'Redaction boundary, structured findings, narrative, cost guard.'],
  ['v0.5.0 API and auth', 'HTTP surface, OIDC and local login, sessions, rate limits.'],
  ['v0.6.0 Web UI', 'Overview, budget, portfolio, insights, settings.'],
  ['v0.7.0 Jobs and deployment', 'Scheduler, health, backups, hardening.'],
  ['v0.8.0 Investment advice', 'Curated fund universe, risk-bounded advice, Belgian tax module.'],
  ['v0.9.0 Benchmarks and proposals', 'Statbel comparison, clarification flow, Actual write-back.'],
  ['v1.0.0 Release readiness', 'Reconciliation, security verification, docs. Blessed after testing.'],
  ['Backlog', 'Wanted, not scheduled.'],
]

/** [title, milestone, labels, body, closed?] */
const ISSUES = [
  // ---------------------------------------------------------------- 0.1.0
  ['Environment config, SQLite schema and logging', 'v0.1.0 Foundation',
    'area:infra,type:feature', `Validate the whole environment at import time and fail to boot rather than run half-configured. Schema covers identity, source mapping, category knowledge, computed facts, the AI audit trail and ops.

Done when:
- [x] Zod-validated config with cross-field rules reported all at once
- [x] Drizzle schema + migrations, money as integer cents throughout
- [x] pino logging with a redaction denylist at the sink`, true],

  ['English and Dutch catalogues with Belgian formatting', 'v0.1.0 Foundation',
    'area:i18n,type:feature', `Language and number formatting are separate settings: \`Intl\` with \`en-BE\` yields \`€1,234.56\`, so deriving money format from the UI language would render amounts that no longer match Belgian bank statements.

Done when:
- [x] Six namespaces per language, generated from one tree so parity is structural
- [x] \`format.ts\` as the single entry point, bundleable for the browser
- [x] Glossary of Belgian financial terms, surfaced in the English UI too
- [x] \`npm run i18n:check\` fails on missing keys, dropped interpolations or incomplete plurals`, true],

  // ---------------------------------------------------------------- 0.2.0
  ['Actual Budget adapter: read-only, serialised, version-checked', 'v0.2.0 Adapters',
    'area:actual,type:feature', `Actual's API is a local sync engine over SQLite, not a REST client, and makes no concurrency guarantees — so one process owns the dataDir and one operation runs at a time.

Done when:
- [x] init/download/sync/shutdown lifecycle with a serialising queue that survives a rejection
- [x] Only reads are exported, enforced by a test that scans for mutating calls
- [x] Version misalignment with the server warns instead of refusing to boot
- [x] ActualQL queries schema-validated, since \`aqlQuery\` returns \`unknown\``, true],

  ['Ghostfolio adapter and capability probe', 'v0.2.0 Adapters',
    'area:ghostfolio,type:feature', `Three of the four endpoints Balancr reads are Ghostfolio's frontend API: unversioned and free to change on any upgrade.

Done when:
- [x] Anonymous-token auth, JWT cached, exactly one re-auth on a 401
- [x] Request timeout so a hung upstream cannot hang the nightly job
- [x] All HTTP in one file, so a breaking upgrade is a single-file fix
- [x] Probe distinguishes *unreachable* (retry) from *shape-mismatch* (stop writing snapshots)
- [x] Public-share endpoint rejected on privacy grounds`, true],

  ['Repo infrastructure: CI, secret scanning, Renovate, image', 'v0.2.0 Adapters',
    'area:infra,type:chore', `Done when:
- [x] CI typechecks, verifies catalogue parity, runs tests, builds the image
- [x] gitleaks on every push and PR, with a narrow allowlist
- [x] Renovate configured; \`@actual-app/api\` excluded from automatic bumps because it must match the server release
- [x] Multi-stage amd64 Dockerfile, non-root, read-only rootfs, \`/data\` volume
- [x] README with CI, release and licence badges`, true],

  // ---------------------------------------------------------------- 0.3.0
  ['Spend aggregation with hygiene rules', 'v0.3.0 Aggregation',
    'area:aggregation,type:feature,priority:high', `The rules that decide whether any figure is believable. Getting them wrong makes totals visibly disagree with Actual's own UI, which destroys trust in everything else.

Done when:
- [ ] Transfers excluded via \`transfer_id\` (which is also what stops credit-card payments counting as spend)
- [ ] Splits expanded to children, parents excluded
- [ ] Refunds netted against spend
- [ ] Off-budget accounts excluded from budget figures but available to net worth
- [ ] Starting balances excluded
- [ ] Actual's own \`spent\`/\`budgeted\`/\`balance\` stored as the source of truth, with our recomputation kept beside it for comparison`],

  ['EWMA baselines with winsorisation and amortisation', 'v0.3.0 Aggregation',
    'area:aggregation,type:feature', `"Am I overspending" needs a norm. A plain 12-month mean lets one boiler repair define normal, and a single-month comparison flags every annual insurance premium.

Done when:
- [ ] EWMA over 12 months, 3-month half-life, values winsorised at p5/p95
- [ ] Quarterly and annual categories compared as rolling rates rather than single months
- [ ] No baseline emitted below a minimum history, instead of a confident one from two months
- [ ] Every parameter in \`settings\`, tunable from the UI
- [ ] Golden test against a hand-computed value`],

  ['Overspend signals, reported separately', 'v0.3.0 Aggregation',
    'area:aggregation,type:feature', `Four different things get called "overspending" and they mean different things — merging them into one number is why budget alerts get ignored.

Done when:
- [ ] Over what was assigned this month
- [ ] Over what is *available* after Actual's carryover (often "over budget" yet fine)
- [ ] Over your own EWMA baseline, with a materiality floor so a €7 envelope cannot trigger it
- [ ] Benchmark signal present but returning null until the Statbel model lands
- [ ] Each signal carries its own severity and never collapses into the others`],

  ['Burn-rate projection', 'v0.3.0 Aggregation',
    'area:aggregation,type:feature', `Spend-to-date projected to month end, so a warning arrives mid-month instead of as a post-mortem.

Done when:
- [ ] Projection uses local wall-clock month progress (at 01:00 CEST on the 1st, UTC is still last month)
- [ ] No projection below a minimum elapsed fraction — day-two extrapolation is noise
- [ ] Tolerance band configurable`],

  ['Net worth with source-of-truth dedupe', 'v0.3.0 Aggregation',
    'area:aggregation,type:feature', `An investment account usually exists in both Actual and Ghostfolio. Summing both double-counts the same money.

Done when:
- [ ] \`account_map\` groups duplicates; exactly one row per group is source of truth
- [ ] Balances from Actual's own \`getAccountBalance\` (transfers and starting balances included, unlike spend)
- [ ] Daily snapshots, rebuildable idempotently
- [ ] Reconciles against Ghostfolio's dashboard and Actual's account list`],

  ['Portfolio snapshots and metrics', 'v0.3.0 Aggregation',
    'area:ghostfolio,area:aggregation,type:feature', `Done when:
- [ ] Holdings snapshotted per day with ISIN where available (the identifier Belgian brokers use)
- [ ] TWR and MWR stored as basis points, allocation and drift as JSON
- [ ] Annual fund cost shown in euros, not just TER percent
- [ ] Snapshots refused while the probe reports a shape mismatch`],

  ['Data hygiene score', 'v0.3.0 Aggregation',
    'area:aggregation,type:feature', `The AI will confidently analyse garbage, so the state of the data has to be visible.

Done when:
- [ ] Uncategorised transaction count and amount
- [ ] Accounts not reconciled in N days
- [ ] Stale portfolio prices
- [ ] Disagreement between Actual's \`spent\` and our recomputation, surfaced as a finding rather than left to be spotted by eye
- [ ] A single score, prominent in the UI`],

  ['Idempotent fact persistence', 'v0.3.0 Aggregation',
    'area:aggregation,type:chore', `Computed facts must be rebuildable from the sources at any time, with no accumulated drift.

Done when:
- [ ] Upserts keyed by (month, category) and (date, account) — a re-run changes nothing
- [ ] A rebuild of an arbitrary month range is one call
- [ ] Recomputation never touches durable state (category knowledge, prompts, proposals)`],

  ['Aggregation golden tests against a fixture budget', 'v0.3.0 Aggregation',
    'area:aggregation,type:test,priority:high', `Done when:
- [ ] A small committed fixture budget covering transfers, splits, refunds, credit-card payments, off-budget accounts and an annual premium
- [ ] Each hygiene rule asserted independently, so a failure names the rule
- [ ] EWMA asserted against a hand-computed value`],

  // ---------------------------------------------------------------- 0.4.0
  ['Redaction boundary with a golden denylist test', 'v0.4.0 AI layer',
    'area:ai,area:privacy,type:feature,priority:high', `One pure function is the only path to Gemini. This is the privacy guarantee, so it is a single reviewable place rather than a rule spread across call sites.

Done when:
- [ ] \`AggregateBundle -> RedactedBundle\`, emitting aggregates and category names only
- [ ] Never payees, memos, transaction ids or account numbers
- [ ] Categories marked sensitive emitted as an opaque label plus class and nature
- [ ] Golden test asserts no payee string from the fixture appears in the payload
- [ ] Every payload stored verbatim in \`ai_runs.payload_json\` so the claim can be checked by hand`],

  ['Deterministic finding assembly', 'v0.4.0 AI layer',
    'area:ai,type:feature', `The candidate findings are computed, not generated: the model prioritises and explains, it never decides that a number is high.

Done when:
- [ ] Candidates built from aggregates for all finding codes
- [ ] Severity from configured thresholds, not from the model
- [ ] Findings rendered locally from the catalogues, in both languages`],

  ['Gemini client with a closed output vocabulary', 'v0.4.0 AI layer',
    'area:ai,type:feature', `Done when:
- [ ] \`@google/genai\` supporting both AI Studio keys and Vertex (\`europe-west1\` for residency)
- [ ] Structured output restricted to the known finding codes, so an unbacked claim cannot render
- [ ] A parse failure is an error, never a rendered guess
- [ ] Context caching for the stable system prompt
- [ ] Financial data inside a delimited untrusted block, with the system prompt stating it is never instructions`],

  ['Monthly narrative, cached per locale', 'v0.4.0 AI layer',
    'area:ai,area:i18n,type:feature', `The only free text in the app.

Done when:
- [ ] Generated in the active locale, cached per (period, locale)
- [ ] Switching language offers an explicit translate action instead of silently triggering an expensive re-analysis
- [ ] Markdown rendered safely`],

  ['AI cost guard', 'v0.4.0 AI layer',
    'area:ai,type:feature', `Authentik cannot protect against cost-DoS, and a surprise bill is the fastest way to switch this off for good.

Done when:
- [ ] Month-to-date cost read from a view over \`ai_runs\` — no second ledger to drift
- [ ] Over \`GEMINI_MONTHLY_BUDGET_EUR\`, serve the cached result with a banner; never fail hard, never silently overspend
- [ ] Nightly precompute, so opening a page never triggers a call`],

  ['Prompt versioning with diff, dry-run and cost estimate', 'v0.4.0 AI layer',
    'area:ai,type:feature', `Done when:
- [ ] Prompts versioned per (key, locale); rollback flips \`active\`, no edit destroys the previous text
- [ ] At most one active version per key and locale, enforced by the database
- [ ] Editor shows a diff against active, dry-runs against last month's real data, and shows the cost before running
- [ ] Authored in English with an explicit output-language directive`],

  ['Clarification queue with a materiality threshold', 'v0.4.0 AI layer',
    'area:ai,type:feature', `"What is this budget for?" — asked once, remembered for ever. Being interrogated about a €4 envelope is how a tool like this gets abandoned.

Done when:
- [ ] Only categories above a materiality threshold are enqueued, ordered by share of spend
- [ ] Cards present the model's guess to confirm or edit, not an open question
- [ ] Answers stored in \`category_meta\` and fed back into later runs
- [ ] At most one open question per (category, question)`],

  ['Propose-and-apply with local-effect handlers', 'v0.4.0 AI layer',
    'area:ai,type:feature', `Done when:
- [ ] Proposals reviewed with a rendered before/after diff
- [ ] Handlers registered in a map; v1 ships only category-metadata handlers
- [ ] Every apply audit-logged with actor and originating run
- [ ] Nothing mutates without explicit approval`],

  // ---------------------------------------------------------------- 0.5.0
  ['Fastify app with proxy trust and security headers', 'v0.5.0 API and auth',
    'area:api,area:auth,type:feature,priority:high', `Done when:
- [ ] \`trustProxy\` limited to \`TRUSTED_PROXY_CIDRS\`; \`X-authentik-*\` and \`X-Forwarded-*\` honoured only from those peers — without this, anyone reaching the container directly authenticates as you by setting a header
- [ ] helmet, a CSP that permits no external origin, HSTS
- [ ] CSRF double-submit on every mutation
- [ ] Errors never leak internals to the client`],

  ['OIDC login via Authentik', 'v0.5.0 API and auth',
    'area:auth,type:feature', `Preferred over trusting forward-auth headers: real server-side sessions, group claims, and it survives an infra change.

Done when:
- [ ] Code flow with PKCE and state, issuer discovery
- [ ] Sessions server-side in SQLite; the cookie carries an opaque id and nothing else
- [ ] \`__Host-\` prefix, httpOnly, Secure, SameSite=Lax
- [ ] Existing Authentik SSO session means no second prompt`],

  ['Local break-glass login', 'v0.5.0 API and auth',
    'area:auth,type:feature', `For when Authentik itself is what broke.

Done when:
- [ ] Disabled by default, and restricted to \`AUTH_LOCAL_ALLOWED_CIDRS\` even when enabled — LAN/VPN only, never through the tunnel
- [ ] argon2id, mandatory TOTP, lockout after repeated failures
- [ ] Refused from the tunnel and accepted from LAN, verified by hand`],

  ['Read-only API for the views', 'v0.5.0 API and auth',
    'area:api,type:feature', `Done when:
- [ ] Overview, budget, portfolio and insights endpoints served from Balancr's own SQLite, never by calling upstreams during a request
- [ ] Findings returned as codes and values so the client renders the language
- [ ] Zod-validated responses, no float money
- [ ] A stale-data indicator when the last sync failed`],

  ['Rate limiting, with a stricter AI bucket', 'v0.5.0 API and auth',
    'area:api,type:chore', `Done when:
- [ ] Global limit on the API
- [ ] Tighter bucket on \`/api/ai/*\`, where a request costs real money
- [ ] Limits survive a restart well enough to matter, and are logged when tripped`],

  // ---------------------------------------------------------------- 0.6.0
  ['SPA shell: layout, theme tokens, no external assets', 'v0.6.0 Web UI',
    'area:web,type:feature,priority:high', `Modern and responsive, and everything served from the container: no CDN, no Google Fonts, no analytics. A page load must leak nothing to a third party and must work on a locked-down network.

Done when:
- [ ] Vite + React + TypeScript, all JS/CSS/fonts bundled locally and self-hosted
- [ ] One shared token module (colour, spacing, type) driving light and dark
- [ ] Responsive from phone to desktop; charts reflow rather than scroll off
- [ ] A single ECharts palette so every chart reads as one system`],

  ['Overview page', 'v0.6.0 Web UI', 'area:web,type:feature',
    `Net worth over time (Actual + Ghostfolio, deduped), savings rate, emergency-fund months, hygiene score. The page that answers "how am I doing" in five seconds.`],

  ['Budget page', 'v0.6.0 Web UI', 'area:web,type:feature',
    `Income-to-category Sankey, budget-vs-actual bullet chart, burn rate against month progress, category trend small multiples. Axis and tooltip formatters must go through \`format.ts\` — the spot where locale handling is usually forgotten.`],

  ['Portfolio page', 'v0.6.0 Web UI', 'area:web,type:feature',
    `Allocation treemap, TWR line, holdings table with ISIN, currency and annual cost in euros.`],

  ['Insights page', 'v0.6.0 Web UI', 'area:web,area:ai,type:feature',
    `Findings grouped by severity, the monthly narrative, the clarification queue and proposal review in one place — with the payload that was sent inspectable from the UI.`],

  ['Settings page', 'v0.6.0 Web UI', 'area:web,type:feature',
    `Language, prompt editor with diff and dry-run, thresholds, account mapping and source-of-truth selection, AI spend to date. Prompts and thresholds live in the database precisely so a web app can edit them; secrets stay in \`.env\`.`],

  ['Language switching end to end', 'v0.6.0 Web UI', 'area:i18n,area:web,type:feature',
    `Done when:
- [ ] react-i18next wired to the same catalogues the server uses
- [ ] Resolution order: user setting, cookie, \`Accept-Language\`, \`DEFAULT_LOCALE\`
- [ ] \`<html lang>\` set per request
- [ ] Dutch strings run 10–30% longer than English; legends and buttons sized for the Dutch string`],

  ['Accessibility and responsive pass', 'v0.6.0 Web UI', 'area:web,type:test',
    `Done when:
- [ ] Keyboard reachable throughout, visible focus
- [ ] Contrast holds in both themes
- [ ] Charts have text equivalents — a treemap alone is not an answer
- [ ] Usable at 375px wide`],

  // ---------------------------------------------------------------- 0.7.0
  ['In-process scheduler', 'v0.7.0 Jobs and deployment', 'area:infra,type:feature',
    `Done when:
- [ ] sync → aggregate → snapshot → nightly AI run, each recorded in \`jobs\`
- [ ] Overlapping runs impossible (one process owns Actual's dataDir)
- [ ] A failed step leaves the previous good facts in place
- [ ] Manual trigger from the UI`],

  ['Health, readiness and job status', 'v0.7.0 Jobs and deployment', 'area:api,type:feature',
    `Done when:
- [ ] \`/healthz\` is liveness only — it must not fail because Ghostfolio is restarting
- [ ] Readiness reports upstream and probe state, including a shape mismatch
- [ ] Last run, last success and last error visible in the UI`],

  ['Backups and restore', 'v0.7.0 Jobs and deployment', 'area:infra,type:feature',
    `Losing the accumulated category knowledge would genuinely hurt — it is the one thing here that cannot be recomputed.

Done when:
- [ ] Nightly encrypted backup of \`/data\`
- [ ] A restore actually performed and documented, not assumed`],

  ['Deployment hardening', 'v0.7.0 Jobs and deployment', 'area:infra,type:chore',
    `Done when:
- [ ] Non-root, read-only rootfs, dropped capabilities, verified at runtime
- [ ] Egress restricted to Actual, Ghostfolio and the Gemini endpoint
- [ ] Image size and startup time recorded, so a regression is noticeable
- [ ] \`.env\` at 0600, documented`],

  // ---------------------------------------------------------------- 0.8.0
  ['Curated fund universe', 'v0.8.0 Investment advice', 'area:ai,type:feature',
    `Advice restricted to a pre-approved list, so the model cannot recommend an instrument nobody vetted.

Done when:
- [ ] YAML universe with ISIN validation and a \`last_verified\` date
- [ ] Belgian-accessible accumulating ETFs and funds, with TER and domicile
- [ ] Anything outside the universe cannot be proposed`],

  ['Risk-bounded portfolio advice', 'v0.8.0 Investment advice', 'area:ai,type:feature',
    `"Some risk but not super high risk", made explicit: a stated risk profile with allocation bands, drift thresholds and a reason attached to every suggestion. No suggestion without the drift figure that motivates it.`],

  ['Belgian tax module', 'v0.8.0 Investment advice', 'area:aggregation,type:feature',
    `Done when:
- [ ] TOB/beurstaks tiers, roerende voorheffing, Reynders levy and the capital-gains rules as dated configuration with \`last_verified\` — never hardcoded in logic
- [ ] Tax shown as euros on a concrete transaction, not as a percentage in prose
- [ ] The glossary explains each one; rates live only in the dated config`],

  // ---------------------------------------------------------------- 0.9.0
  ['Statbel benchmark with an equivalence scale', 'v0.9.0 Benchmarks and proposals',
    'area:aggregation,type:feature', `The original ask: how does my spending compare to a Belgian single parent with joint custody of a teenager? Household composition is the hard part — a naive per-capita comparison is worse than none.

Done when:
- [ ] Statbel household budget data mapped to categories via COICOP
- [ ] An explicit equivalence scale for one adult plus a part-time teenager, with the assumption stated in the UI
- [ ] Benchmark deltas shown as \`info\`, never as an alert — this is context, not a verdict
- [ ] Source and year cited next to every comparison`],

  ['Custody-aware child cost split', 'v0.9.0 Benchmarks and proposals',
    'area:aggregation,type:feature', `Categories flagged \`custody_shared\` reported both as paid and as economically borne, so joint-custody costs stop looking like overspending.`],

  ['Actual-writing proposal handlers', 'v0.9.0 Benchmarks and proposals',
    'area:actual,area:ai,type:feature', `Only after the read path has been trusted for a while.

Done when:
- [ ] Category assignment and budget-amount handlers behind explicit approval
- [ ] The read-only boundary test updated deliberately, in the same commit, with the reason
- [ ] Every write reversible or clearly logged`],

  // ---------------------------------------------------------------- 1.0.0
  ['Reconciliation acceptance test', 'v1.0.0 Release readiness',
    'area:aggregation,type:test,priority:high', `The test that decides whether this ships.

Done when:
- [ ] Three months reconciled category by category against Actual's own UI
- [ ] Net worth reconciled against Ghostfolio's dashboard
- [ ] Any mismatch treated as a hygiene bug, not a rounding issue`],

  ['Security verification checklist', 'v1.0.0 Release readiness',
    'area:auth,area:privacy,type:test', `Done when:
- [ ] A spoofed \`X-authentik-username\` from a non-proxy peer is ignored
- [ ] Local login refused through the tunnel, accepted from LAN
- [ ] Rate limit trips; cost cap degrades to cached output with a banner
- [ ] \`ai_runs.payload_json\` inspected by hand — no payee ever left the box`],

  ['Documentation pass', 'v1.0.0 Release readiness', 'area:docs,type:chore',
    `Setup guide from an empty machine, screenshots, an explicit privacy statement, backup/restore, upgrade notes for Actual and Ghostfolio, and what to do when the probe reports a shape mismatch.`],

  // ---------------------------------------------------------------- Backlog
  ['12-month cashflow forecast', 'Backlog', 'area:aggregation,type:feature',
    `Project balances forward from recurring income, fixed costs and known annual bills. Wanted; not scheduled.`],

  ['Subscription creep detection', 'Backlog', 'area:aggregation,type:feature',
    `Recurring charges that grew, or that nobody uses any more. Needs payee-level data, which currently never leaves the machine — so it has to be computed locally.`],

  ['Scenario simulator', 'Backlog', 'area:web,type:feature',
    `"What if I put €200 more into investments each month" — answered against real baselines rather than a round number.`],

  ['Monthly digest as PDF or email', 'Backlog', 'area:ai,type:feature',
    `The narrative and key charts, rendered server-side in the configured language. This is why \`DEFAULT_LOCALE\` exists: a cron job has no request context.`],

  ['Ghostfolio MCP endpoint as a fallback', 'Backlog', 'area:ghostfolio,type:feature',
    `Ghostfolio ships an experimental \`POST /mcp\`. Not depended on — v1 needs deterministic figures, not an AI protocol — but worth revisiting if the internal API keeps moving.`],
]

function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    if (allowFail) return ''
    process.stderr.write(String(error.stderr ?? error.message))
    throw error
  }
}

const repo = JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner
process.stdout.write(`repo: ${repo}${dryRun ? ' (dry run)' : ''}\n`)

// --- labels ---------------------------------------------------------------
const existingLabels = new Set(
  JSON.parse(gh(['label', 'list', '--limit', '200', '--json', 'name'])).map((l) => l.name),
)
for (const [name, color, description] of LABELS) {
  if (existingLabels.has(name)) continue
  process.stdout.write(`label + ${name}\n`)
  if (!dryRun) gh(['label', 'create', name, '--color', color, '--description', description])
}

// --- milestones -----------------------------------------------------------
// No `gh milestone` command exists; the REST API is the only route.
const existingMilestones = new Map(
  JSON.parse(
    gh(['api', `repos/${repo}/milestones?state=all&per_page=100`]),
  ).map((m) => [m.title, m.number]),
)
for (const [title, description] of MILESTONES) {
  if (existingMilestones.has(title)) continue
  process.stdout.write(`milestone + ${title}\n`)
  if (dryRun) continue
  const created = JSON.parse(
    gh(['api', `repos/${repo}/milestones`, '-f', `title=${title}`, '-f', `description=${description}`]),
  )
  existingMilestones.set(title, created.number)
}

// --- issues ---------------------------------------------------------------
const existingIssues = new Map(
  JSON.parse(
    gh(['issue', 'list', '--state', 'all', '--limit', '300', '--json', 'number,title,state']),
  ).map((i) => [i.title, i]),
)

let missing = 0
let created = 0
for (const [title, milestone, labels, body, closed = false] of ISSUES) {
  if (existingIssues.has(title)) continue
  missing += 1
  process.stdout.write(`issue  + ${title}\n`)
  if (dryRun) continue

  const out = gh([
    'issue', 'create',
    '--title', title,
    '--body', body,
    '--milestone', milestone,
    '--label', labels,
  ])
  created += 1

  if (closed) {
    const number = out.trim().split('/').pop()
    gh([
      'issue', 'close', number,
      '--reason', 'completed',
      '--comment', 'Shipped — see CHANGELOG.md for the release this landed in.',
    ])
  }
}

process.stdout.write(
  dryRun
    ? `\n${missing} of ${ISSUES.length} issues would be created.\n`
    : `\n${created} issues created, ${ISSUES.length - created} already present.\n`,
)
