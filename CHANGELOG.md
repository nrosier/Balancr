# Changelog

All notable changes to Balancr, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the
scheme in [README](README.md#versioning) — `0.x` marks progress toward 1.0, and
1.0.0 ships when testing says so rather than when the feature list ends.

## [Unreleased]

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
- Golden tests for both: hand-computed EWMA and interpolated quantiles, the
  annual-premium case the frequency window exists to handle, and the Brussels
  midnight case where UTC still says the previous month.

### Changed
- `BaselineResult` reports `winsorEffectBp` — how far winsorisation moved the
  norm — instead of a `clamped` boolean. Because the quantiles are interpolated,
  the p5/p95 clamp nudges the extremes of every series that is not perfectly
  flat, so the boolean was true for nearly every category and told a reader
  nothing.

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
