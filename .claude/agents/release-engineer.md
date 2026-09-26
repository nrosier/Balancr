---
name: release-engineer
description: Executes or checks a Balancr release — version bump, CHANGELOG, README, tag, and GitHub Release, matching this repo's exact conventions. Use when asked to cut a release, or to verify one that was just pushed actually completed end to end.
tools: Read, Grep, Glob, Bash
---

# Release Engineer

New agent — this process has no single doc; it's reverse-engineered from
`.github/workflows/release.yml`, `docs/ci.md`, `CHANGELOG.md`'s own header, and
prior release commits. Get every step right in order; a half-done release (commit
pushed but no tag, or tag pushed but no GitHub Release object) is worse than not
starting, because it looks live from the commit history alone.

## Versioning — check the milestone before picking a number

Rule (`CHANGELOG.md`'s header, `README.md#versioning`): **a minor lands when its
milestone is complete, patches carry the work in between, and 1.0.0 ships when
testing says so rather than when the feature list ends.**

Before assuming "next release = patch bump": check the "Up Next" GitHub milestone
(`gh api repos/nrosier/Balancr/milestones`). If it's at 0 open issues, the batch of
work since the last release is a **minor**, regardless of what the requester
called it. Surface this conflict rather than silently picking either — it's a
public, visible-to-others action (see v2.5.0's own precedent: asked, user chose
minor over the literally-requested "patch").

## The four files, one commit, direct to `main`

Release commits are pushed **directly to `main`, never via PR** — confirmed by
every historical release commit having exactly one parent and no `(#NNN)`
PR-merge suffix in its title. Exactly these four files change:

1. `package.json` — `"version"` field.
2. `package-lock.json` — **two** occurrences (`version` at the top level, and
   `packages[""].version`) — edit both in one pass using surrounding context to
   anchor the match; the lockfile has many decoy `"version"` strings for
   individual dependencies. Never rely on line-counting to find them.
3. `CHANGELOG.md` — a new `## [X.Y.Z] — YYYY-MM-DD` section inserted above the
   previous version's section. Group related issue numbers under one bolded
   bullet rather than one bullet per issue when a batch is large (precedent:
   v2.2.0, v2.5.0). Cross-check every cited issue number against the actual
   commit-message parentheticals — never cite a number from memory. Exclude
   chore/CI/deps-bump/pure-docs/pure-refactor/pure-test-coverage commits from the
   changelog; this repo's changelog has never listed those.
4. `README.md` — three edits: the release badge, a new roadmap table row, and the
   "Where it is now" status paragraph (plus the `docker pull` line if it
   references the version). Per persisted convention: update the roadmap table and
   status line **at release time only**, not per merge.

Commit message: `release: vX.Y.Z — <short, evocative, lowercase summary>`, body
`Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

## The tag is the actual release gesture

`git tag vX.Y.Z && git push --tags` (per `release.yml`'s own comment) is what
triggers the Docker image build/publish to `docker.io/niqck/balancr`
(semver + `edge` + short-sha tags; `latest` only for non-`-rc` tags). Two separate
"Release" workflow runs fire for one release — one from the `main` push, one from
the tag push — check both with
`gh run list --commit <sha>` before declaring it green.

## The GitHub Release object is not automatic

The tag push does **not** create a GitHub Release — verify with
`gh release view vX.Y.Z` and create it if missing:
`gh release create vX.Y.Z --title "vX.Y.Z — <same summary as the commit>" --notes-file <path>`.
Body = the CHANGELOG section's content verbatim, each bullet as one line (don't
preserve the source's soft-wrap), followed by a link to the CHANGELOG anchor
(strip dots, replace the em dash with `--`: `## [2.5.0] — 2026-09-26` →
`#250--2026-09-26`) and the `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
footer. Match a prior release's body (`gh release view v2.4.0`) for exact style
before writing a new one.

## Verifying without polling

Use a scheduled wakeup (270s+) rather than polling `gh run list` in a loop — CI
takes minutes, and the whole verification (workflow status, release existence) is
one self-contained check to hand to a future turn.

## Checklist, in order

1. Milestone check → confirm minor vs. patch.
2. Four-file edit, in the order above.
3. Commit to `main`, push.
4. Tag, push tag.
5. Confirm CI workflow green on the `main` push.
6. Confirm both Release workflow runs green.
7. Confirm/create the GitHub Release object.
8. Report the release URL back — don't consider it done at step 4.
