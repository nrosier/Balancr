# Balancr security assessment

**Date:** 25 September 2026  
**Repository:** `https://github.com/nrosier/Balancr`  
**Reviewed commit:** `4dae8ae7efc6fcb27f767e6bc4001d1f0d8b3d81` (2.3.9)  
**Assessment type:** Local source review, dependency audit, focused tests, and a synthetic proof of concept. No live service or third-party system was attacked.

## Executive summary

The most urgent issue is in integration settings. An authenticated tenant **owner** can submit a new Ghostfolio or Actual URL while omitting the secret. Both connection tests and saved configuration changes retain or reuse that tenant's stored secret with the new URL. For the Ghostfolio test, I reproduced a request containing the saved token to a synthetic attacker-controlled host even with `EGRESS_MODE=enforce`. The same flow permits requests to internal hosts. A viewer or unauthenticated visitor cannot invoke these endpoints.

The second material issue is a race in applying AI proposals that write to Actual. A remote write may succeed while another request rejects or supersedes the proposal. The local transaction then refuses to record the apply, leaving Actual changed with a rejected or expired proposal and no corresponding apply audit entry. An existing test demonstrates this ordering.

The remaining findings concern privacy retention, broad privacy wording, and deployment assumptions. These matter for financial data, but they are not evidence of an unauthenticated compromise. **No audit can establish that every vulnerability has been found.**

| ID | Severity | Finding |
| --- | --- | --- |
| F1 | High | Saved integration credentials can be used with a caller-chosen host through connection tests or saved URL changes; the test also provides server-side requests to internal addresses |
| F2 | Medium | An Actual write can succeed after a proposal is rejected, without an apply audit record |
| F3 | Medium | AI payloads, including free-text month notes, remain in SQLite indefinitely despite request/response text retention |
| F4 | Low | The unconditional privacy promise omits the verbatim month-note exception |
| F5 | Low | README's read-only-source guarantee contradicts current approved Actual writes |

## Findings

### F1 — Saved credentials to an arbitrary connection-test destination (High)

**Evidence.** The Ghostfolio test accepts any nonempty URL and an optional token in [`settings.ts`](Balancr/src/server/routes/settings.ts#L683). Its handler requires an owner, but if `securityToken` is omitted it decrypts the stored token, permits the candidate host with `withTestHost`, and posts `{"accessToken": ...}` to that host ([`settings.ts`](Balancr/src/server/routes/settings.ts#L1953-L1980)). The Actual test similarly falls back to the stored password and optional encryption password, then passes them with the candidate `serverUrl` to a new Actual client ([`settings.ts`](Balancr/src/server/routes/settings.ts#L2124-L2142), [`test-worker.ts`](Balancr/src/adapters/actual/test-worker.ts#L61-L79)). A current unit test explicitly expects the saved Actual password to be passed with a **different** candidate URL ([`settings-integrations.test.ts`](Balancr/test/unit/settings-integrations.test.ts#L681-L692)). The settings PATCH handlers also replace either URL without replacing or clearing an omitted secret ([`settings.ts`](Balancr/src/server/routes/settings.ts#L1814-L1832), [`settings.ts`](Balancr/src/server/routes/settings.ts#L1857-L1872)); integration resolution then pairs the new URL with the old secret ([`tenant-integrations.ts`](Balancr/src/db/tenant-integrations.ts#L103-L115)). The regular Ghostfolio client posts the resolved token to the resolved URL when it authenticates ([`client.ts`](Balancr/src/adapters/ghostfolio/client.ts#L188-L199)); the Actual client opens with the resolved URL and password ([`client.ts`](Balancr/src/adapters/actual/client.ts#L196-L209)). The egress exception accepts the candidate hostname for the duration of a test ([`egress.ts`](Balancr/src/egress.ts#L198-L229)), while stored Actual/Ghostfolio URLs enter the process-wide allowlist ([`egress.ts`](Balancr/src/egress.ts#L170-L185)).

**Reproduction.** In a temporary local test, I created an owner session using the test fixture's saved Ghostfolio token, stubbed network `fetch`, enabled the egress guard in `enforce` mode, and posted `{"url":"http://collector.invalid:4444"}` to `/api/settings/integrations/ghostfolio/test`. The stub received a POST to `http://collector.invalid:4444/api/v1/auth/anonymous` with `{"accessToken":"test-token"}`. The test passed. No packet was sent to that host. The temporary test was removed after verification.

**Impact and conditions.** A tenant owner whose browser or session is compromised, or a malicious owner in a multi-tenant deployment, can disclose a saved integration credential without seeing it in the settings response. The connection test can also make the server contact a chosen internal address on the fixed Ghostfolio paths or through the Actual client's connection flow. This is owner-only and depends on the server's network reachability; the observed request is not an unauthenticated or general-purpose HTTP proxy. The changed-URL PATCH path was confirmed by source tracing, not a separate live network proof of concept.

**Fix.** For both tests and saved settings updates, bind reuse of a stored secret to the same normalized origin as the saved integration URL, or require the secret again whenever the origin changes. Reject user-supplied URL credentials, unexpected schemes, and internal destinations when testing externally hosted services. Restrict Actual/Ghostfolio hosts through an operator-controlled allowlist in multi-tenant deployments. Replace the process-wide temporary host exception with a request-scoped transport policy, then add regression tests for changed origin, private addresses, redirects, and concurrent tenants.

### F2 — Remote Actual write can outlive a rejected proposal (Medium)

**Evidence.** `applyProposal` checks that the proposal is pending, computes a diff, awaits `handler.applyRemote`, and only then starts a local transaction that checks status again and writes the audit row ([`proposals.ts`](Balancr/src/domain/ai/proposals.ts#L893-L955)). The remote handlers call Actual mutation functions for transaction categories and budget amounts ([`proposals.ts`](Balancr/src/domain/ai/proposals.ts#L357-L368), [`proposals.ts`](Balancr/src/domain/ai/proposals.ts#L439-L445), [`queries.ts`](Balancr/src/adapters/actual/queries.ts#L679-L702)). An existing test rejects a proposal during the awaited remote call. It then asserts that the apply throws, the proposal is `rejected`, and the only audit entry is `proposal.reject` ([`ai-proposals.test.ts`](Balancr/test/unit/ai-proposals.test.ts#L643-L660)).

**Impact and conditions.** If the remote write succeeds in that window, Actual changes even though Balancr reports the apply as failed and has no apply audit entry. The same window can arise with an overlapping decision or process failure between remote success and local commit. The test mocks Actual, so the actual remote effect is inferred from the production call order, not demonstrated against a live Actual server.

**Fix.** Atomically claim a proposal for application before remote I/O, prevent reject/adjust/supersede while it is in progress, and record a durable `applying`/`failed`/`applied` state. Reconcile uncertain outcomes with Actual before allowing another decision. Audit the remote result separately from the local finalization. Keep retry idempotent.

### F3 — AI payload retention has no expiry (Medium)

**Evidence.** The redaction payload can include a month note verbatim ([`redact.ts`](Balancr/src/domain/ai/redact.ts#L430-L439), [`redact.ts`](Balancr/src/domain/ai/redact.ts#L803-L805)); the budget-nudge payload also carries the note ([`redact.ts`](Balancr/src/domain/ai/redact.ts#L1158-L1160)). Every AI run stores the payload in `ai_runs.payload_json` ([`runs.ts`](Balancr/src/domain/ai/runs.ts#L96-L112)). The retention job nulls only `requestText` and `responseText`, leaving `payloadJson` intact ([`runs.ts`](Balancr/src/domain/ai/runs.ts#L337-L366)). The default text retention is 90 days ([`config.ts`](Balancr/src/config.ts#L221)); the schema says the ledger grows indefinitely ([`schema.ts`](Balancr/src/db/schema.ts#L1097-L1101)).

**Impact.** A month note may contain names, account details, health facts, or other sensitive prose. Those details can persist in the application database and its backups long after the nominal AI text retention period. This is a local data minimization issue, not evidence that the application sends stored payee records to an AI provider.

**Fix.** Define a separate retention period for payloads, or keep only a payload hash and the minimum accounting fields after the review period. Show the note disclosure and retention plainly before AI use. Cover database and backup deletion in the policy.

### F4 — Privacy guarantee does not describe the note exception (Low)

The README states that no payees, memos, or transactions ever leave the machine and describes only aggregates and category names as AI input ([`README.md`](Balancr/README.md#L73-L81)). The month note is deliberately sent verbatim ([`redact.ts`](Balancr/src/domain/ai/redact.ts#L430-L439)). A person can type a payee, transaction detail, or other personal fact into that note. The code's behavior appears intentional; the weakness is that the unconditional user-facing promise can lead someone to enter sensitive details under a false assumption. State the exception beside the privacy claim and in the note UI. Clarify that source payee/memo records are excluded, while user-entered note text is sent as written.

### F5 — Read-only-source documentation is stale (Low)

The README says neither Actual nor Ghostfolio is ever written to and that the Actual adapter exports no mutating method ([`README.md`](Balancr/README.md#L82-L88)). Current code exports Actual writes for approved proposals ([`queries.ts`](Balancr/src/adapters/actual/queries.ts#L679-L702)). This mismatch can mislead an operator about the effect of approving a proposal. Update the guarantee to say Ghostfolio is read-only and Actual is written only after an explicit proposal approval; document the two write types and their audit/recovery behavior.

## Other hardening observations

- The fetch egress allowlist is a process-level guard, not a network firewall. It explicitly does not cover `node:http`, native modules, or child processes ([`egress.ts`](Balancr/src/egress.ts#L19-L32)). The README correctly describes that limit and calls for a host firewall or egress gateway ([`README.md`](Balancr/README.md#L989-L1001)). Confirm that such a network control is present in each deployment. The supplied Compose file joins existing networks but does not configure an outbound firewall ([`compose.yaml`](Balancr/compose.yaml#L37-L39), [`compose.yaml`](Balancr/compose.yaml#L62-L66)).
- The supplied Compose file defaults to the mutable image tag `niqck/balancr:latest` ([`compose.yaml`](Balancr/compose.yaml#L8)). Pin a reviewed digest or version for reproducible security updates.
- Several controls are present in the reviewed code: integration test endpoints require the tenant owner, settings writes use CSRF protection, session cookies use secure attributes as configured, secrets are encrypted at rest, and the egress guard defaults to enforcement. These reduce reachability and impact but do not remove F1 or F2.

## Validation and limits

- `npm audit --json` and `npm audit --omit=dev --json`: **0** known dependency advisories at assessment time. This does not assess unpublished vulnerabilities or application logic.
- `npm run typecheck`: passed.
- Focused tests for integration settings, AI proposals, auth, and tenant isolation: **176 passed** after a temporary Windows migration-path adjustment. The synthetic F1 proof of concept also passed. Both temporary audit changes were removed; the repository is clean.
- A broader server run after that temporary adjustment reported **3,334 passed and 20 failed**; the remaining failures included Windows POSIX-permission expectations and CRLF-sensitive fixtures. The unmodified checkout's migration-path handling prevents a clean Windows run. Those are test portability limits, not confirmed security findings.
- No live Actual, Ghostfolio, AI provider, or deployed container was tested. No production network, cloud IAM, historical commit secret scan, container image scan, or penetration test of a running deployment was performed. Findings are tied to the reviewed commit; later changes may alter them.

## Fix order

1. Stop stored credentials from being reused with a different origin in tests **and saved settings**; constrain integration destinations (F1).
2. Make proposal application durable across remote I/O and concurrent decisions (F2).
3. Define and enforce AI payload retention, then correct the privacy and write-behavior documentation (F3–F5).
4. Pin the deployment image and verify network-level egress restrictions.
