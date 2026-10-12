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
| 1 | Establish state, baseline checks | in progress |
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

## Blockers / owner actions

- none yet

## Next concrete task

Run baseline checks; read signer.py / evaluator.py / api.py / web proxy.
