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
| 2 | Live-model attestation trust gap (signer independent k-of-n verification) | done: merged (unit A); forged-evidence repro test; live fork run 3/3 by signer |
| 3 | Expired attestation renewal | done: merged (unit A); controlled-clock tests + anvil acceptance of renewed signature |
| 4 | Authenticated judge/demo session, server-enforced budgets, operator stop | done: merged (unit C, incl. review fixes); browser-checked on the local stack |
| 5 | Repaired live-model adapter (new version), replay of the recorded attack, regression export | done (code merged; live replay + export recorded) |
| 6 | External open-source agent + reproduction kit | external agent BLOCKED (no container engine; plan + pinned candidates in docs/EXTERNAL_AGENT_PLAN.md); kit done (docs/REPRODUCE.md, scripts/verify_evidence.py); human reproduction pending |
| 7 | Judge experience (first screen, comparisons, metrics) | done: merged (unit D) + model-proposal display; 375 px checked in browser (compare overflow fixed) |
| 8 | Docs, demo, pitch, submission | done (README, STATUS, THREAT_MODEL, ARCHITECTURE, SUBMISSION, DEMO_SCRIPT, PITCH, REPRODUCE) |
| 9 | Verification, REMEDIATION_REPORT.md | done (docs/REMEDIATION_REPORT.md); publishing awaits the owner |

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
- **Fresh in this remediation (2026-10-13 ~04:00 UTC, real Groq `openai/gpt-oss-120b`, local
  evaluator on a copy of the testnet data dir, no chain transaction):**
  `docs/evidence/repair-llm-0.2.0-20261013-092750*.json` + `test_regression_llm_0_2_0_20261013_092750.py`.
  Recorded challenge #3 counterexample vs `llm-purchasing-agent@0.2.0`: not reproduced, 3 of 3 replays
  completed, R5 held, order still paid. Model-proposal sidecar: 0 privileged proposals (the tool was
  not offered), so the dispatcher's in-code block was **not** exercised live (covered by scripted
  tests). Ordinary purchase on 0.2.0: 3 of 3 completed with payment, no rule violated. Exported
  pytest: 2 passed (repaired passes, original 0.1.1 still fails), live variant opt-in/skipped.
- **Fork rehearsal, real Groq (2026-10-13 ~04:40 UTC):** `docs/evidence/fork-rehearsal-llm-20261013-100537.json`
  - live-model challenge on a local anvil fork of Monad testnet (no real tx): evaluator 3/3, **signer's
  own replays 3/3**, signed digest = signer's bundle, relayed settle, ERC-8004 feedback (forked
  official registry, agent 2230), withdraw. Code at commit `2a8f1b6` + `--recorded` flag (pre unit C).
- **Unit A's local anvil e2e (deterministic path, signer verification):** `docs/evidence/local-e2e-20261013-035546.json`.
- **Measured testnet costs (recorded receipts, 102 gwei, gas billed on limit):** fund 0.0185, commit
  0.0140, settle 0.0142, withdraw 0.0070, ERC-8004 feedback 0.0398, agent registration 0.0703 MON;
  ~0.3 s blocks (38 blocks in 12 s).
- **Offline checks of historical evidence:** `scripts/verify_evidence.py --chain` (local snapshot and
  `--url https://counterproof.vercel.app`): all checks passed (spec digests, seals, recheck_bundle,
  on-chain settled evidence digests, ERC-8004 feedback).

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

## Final state (2026-10-13 ~10:20 UTC)

- All units merged into `remediation/judge-review` (local only). Final checks on the merged code:
  backend 198 passed / 4 skipped; ERC-8004 fork tests 12 passed; forge 58 passed; web vitest 172
  passed, tsc + eslint clean, snapshot build ok; local anvil e2e pass (24 steps,
  `docs/evidence/local-e2e-20261013-151153.json`); verify_evidence.py all checks passed.
- Historical reproduction verified: from tag `testnet-2026-10-11` the adapter/runner/market/checker
  digests equal challenge #3's spec; from HEAD only the adapter digest differs (one row in
  runner/host.py is the only digest-bound change).
- Found and fixed during verification: migration race when API and workers start together.
- Report: docs/REMEDIATION_REPORT.md.

## Blockers / owner actions

- **Owner: confirm the submission cut-off and video limits in the portal** (public pages say only "13 Oct").
- Published 2026-10-13 ~10:30 UTC with the owner's approval: branch + tag pushed, merged into main
  (`8fee39e`) and pushed, Vercel redeployed; hosted evidence re-verified (all checks passed).
- **Owner: record demo + pitch, submit.**
- Blocked: external agent evaluation (no container engine on this machine); independent human
  reproduction (needs an outside person - no outreach sent).

## Next concrete task

Nothing pending on the code side. Owner: confirm the deadline in the portal, record demo + pitch,
submit. Optional: open https://counterproof.vercel.app in a normal browser to see the first screen
(the in-app browser blocks Vercel's scripts).
