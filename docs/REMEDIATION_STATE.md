# Remediation state (living file)

Continue from this file and the actual code. Update after every milestone.

- **Branch:** `remediation/judge-review` (from `main` @ `51c0832`, the state published at
  https://counterproof.vercel.app and https://github.com/professor-200629/counterproof).
- **Started:** 2026-10-12 21:39 UTC.
- **Deadline (re-checked 2026-10-12 21:45 UTC):** the public pages (monad.xyz/metropolis,
  hackathon.monad.xyz) now show only "Submission deadline: 13 Oct", with no time or timezone, and
  do not list video lengths; the portal is behind sign-in. The repository's earlier note
  (2026-10-14 03:59 UTC, demo <= 3 min, pitch <= 2 min) came from the portal on 2026-10-06 and
  could not be re-verified. **Owner: confirm the exact cut-off in the portal and submit early.**
- **Working tree at start:** clean (no uncommitted owner work to preserve).

## Milestones

| # | Task | State |
|---|---|---|
| 1 | Establish state, baseline checks | done (see log) |
| 2 | Live-model attestation trust gap (signer independent k-of-n verification) | todo |
| 3 | Expired attestation renewal | todo |
| 4 | Authenticated judge/demo session, server-enforced budgets, operator stop | todo |
| 5 | Repaired live-model adapter (new version), replay of the recorded attack, regression export | todo |
| 6 | External open-source agent + reproduction kit | todo |
| 7 | Judge experience (first screen, comparisons, metrics) | todo |
| 8 | Docs, demo, pitch, submission | todo |
| 9 | Verification, REMEDIATION_REPORT.md | todo |

## Verification log

(command — outcome — environment)

- 2026-10-12 21:40 UTC, baseline on `51c0832`, Windows 11, Python 3.13 (uv), Foundry 1.8.5, Node/pnpm, no network needed:
  - `cd backend && uv run pytest` — **88 passed, 4 skipped** (the 4 skips are the ERC-8004 fork tests; they need `COUNTERPROOF_FORK_TESTS=1` and network).
  - `cd contracts && forge test` — **58 passed**.
  - `cd web && npx vitest run` — **105 passed, 2 failed** (`src/test/snapshot-mode.test.ts`: both assert the old local-anvil snapshot text; `web/public/snapshot` was re-exported from the Monad testnet run on 2026-10-11 without re-running these tests. Pre-existing on `main`, caused by that export.)
  - `cd web && npx tsc --noEmit` — clean.

## Evidence classes

- **Historical, on Monad testnet (2026-10-11):** challenges 1-3, contract
  `0xE37720f40BC214Ce084595111B1Ee4F4d454b5e4`; reports in `docs/evidence/testnet-*.json`. Not modified.
- **Fresh in this remediation:** none yet.

## Decisions so far

- **Digest constraint.** The pinned digests in funded specs cover `evaluator.py`, `runner/*`,
  `market/*`, `rules/*`, `targets/base.py`, `targets/__init__.py`, adapter modules and the package
  `__init__.py`. New logic goes into non-bound modules. Exception (deliberate, documented): adding
  `llm-purchasing-agent@0.2.0` needs one row in `runner/host.py` (`HOSTED_ADAPTERS`), which changes
  the artifact digest of every adapter. Historical source preserved as local git tag
  `testnet-2026-10-11` (= `51c0832`); reproduction of the 2026-10-11 evidence uses that tag.
- **Signer (milestone 2).** The signer calls the unchanged `evaluator.evaluate()` itself on the
  candidate it loads by the on-chain committed digest, with its own model broker (provider key
  added to the signer role; targets still get an empty environment), applies the spec's k-of-n,
  and signs the digest of its own bundle. Asynchronous inside the signer (live replays take
  minutes); worker evidence is a provenance reference only.
- **Renewal (milestone 3).** Same submission only; re-read chain + re-verify stored own evidence;
  expiry capped at the settlement deadline; audit history; per-challenge lock.
- **External agent (milestone 6).** Docker engine does not start on this machine
  (`docker version`: cannot connect to dockerDesktopLinuxEngine), so external code cannot be run
  under the container isolation the project requires for non-first-party code. Integration is
  blocked; candidates + kit being prepared.

## Work in flight (2026-10-12 ~22:30 UTC)

- Workflow stage 1 (worktrees): unit A signer verification + renewal; unit B repaired adapter
  0.2.0 + recording broker + live-model regression export. Each: implement -> 2 adversarial
  reviews -> fix.
- Workflow unit D (worktree): judge-facing web changes.
- Scout workflow: external open-source purchasing agents (pinned commit + license).
- Next: merge A, B, D into `remediation/judge-review`; then unit C (authenticated judge session,
  server budgets, operator stop, verify_tx log-origin fix); then live runs (repaired replay with
  Groq; local anvil live-model e2e with the signer's own verification); docs; report.

## Blockers / owner actions

- none yet

## Next concrete task

Run baseline checks; read signer.py / evaluator.py / api.py / web proxy.
