# Remediation state (living file)

Continue from this file and the actual code. Update after every milestone.

- **Current checkout:** `C:\dev\counterproof`, branch **`submission/final-fixes`** (from `main`
  @ `7ea1a96`). The Codex session's uncommitted submission fixes were preserved in commit
  `5adbbe6`; the fresh live re-run and re-verification docs follow on the same branch.
- **Published:** GitHub main was `7ea1a96` before this session; the preserved historical tag is
  published. https://counterproof.vercel.app serves the 2026-10-13 read-only Monad Testnet
  evidence snapshot. **Submission fixes published 2026-10-13 ~17:15 UTC** with the owner's approval: branch
  `submission/final-fixes` pushed, `main` fast-forwarded to `114c2a3` and pushed, Vercel production
  redeployed (new first screen; recorded evidence unchanged).
- **Started:** 2026-10-12 21:39 UTC.
- **Deadline (signed-in portal re-checked 2026-10-13):** dashboard and project overview show
  **14 October 2026, 09:29 GMT+5:30 (IST)**. The rules modal, version 3.0 updated 3 September,
  says 13 October 2026, 11:59 PM ET. These agree. Technical demo <= 3 minutes is verified in
  current rules. Pitch <= 2 minutes remains the previously recorded limit, because the
  submission tab is unavailable until the owner creates a project. Project name <= 120 and
  one-line description <= 200 characters are verified. No portal fields or legal terms changed.
- **Working tree at start:** clean (no uncommitted owner work to preserve).

## Submission fixes (2026-10-13, current session)

| Task | Current state |
|---|---|
| Clean-clone public reproduction | Complete locally: offline and scripted modes passed from a real public clone with its own locked dependencies and no data directory. Explicit live mode, missing-key exit and provider-error behavior checked; 16 new tests pass. |
| Documentation and first screen | Updated and verified locally, including production build, desktop and narrow mobile review. Recorded evidence and funded specs remain unchanged. |
| Submission package and recordings | Paste-ready package, updated timed scripts and existing-brand PNG prepared; videos still pending. |
| Current portal requirements | Signed-in rules and setup limits verified; submission fields and logo constraints inaccessible before project creation. Working-product requirement needs actual operation demo plus runnable code and Monad deployment. Snapshot alone is not claimed to satisfy it. |
| Open-source license | Owner explicitly approved MIT and affirmed authority on 2026-10-13; root LICENSE added locally. Dependency licenses retained. |
| Fresh live re-run | Done 16:37 UTC: original R5 3/3, repaired 0/3 (3/3 completed), purchases 3/3 each; `docs/evidence/public-reproduction-live-20261013-163751.json`. Off-chain only. |
| Independent re-verification (Claude Code) | Done: real clean clone + locked deps, all three modes, clean-clone web build, backend 214/4 skipped, contracts 58, web 173, browser desktop + 375 px, hosted chain check. |
| Publication | Done 2026-10-13 ~17:15 UTC: branch + main (`114c2a3`) pushed, Vercel redeployed. Re-verified: hosted chain check all passed, hosted `--url` offline pass, 9 pages/downloads + 17 page assets 200, GitHub detects MIT, fresh GitHub clone offline + scripted pass. No new testnet transaction. |
| External agent / independent human reproduction | Still pending; no external evaluation or outreach performed. |

## Earlier remediation milestones (dated 2026-10-12/13)

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
| 9 | Verification, REMEDIATION_REPORT.md | done; published 2026-10-13 ~10:30 UTC with owner approval |

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

## Historical pre-publication state (2026-10-13 ~10:20 UTC)

- All units merged into `remediation/judge-review` (local only). Final checks on the merged code:
  backend 198 passed / 4 skipped; ERC-8004 fork tests 12 passed; forge 58 passed; web vitest 172
  passed, tsc + eslint clean, snapshot build ok; local anvil e2e pass (24 steps,
  `docs/evidence/local-e2e-20261013-151153.json`); verify_evidence.py all checks passed.
- Historical reproduction verified: from tag `testnet-2026-10-11` the adapter/runner/market/checker
  digests equal challenge #3's spec; from HEAD only the adapter digest differs (one row in
  runner/host.py is the only digest-bound change).
- Found and fixed during verification: migration race when API and workers start together.
- Report: docs/REMEDIATION_REPORT.md.

## Current verification (submission-fix session, Windows 11)

- Existing backend suite: **198 passed, 4 skipped** (ERC-8004 fork opt-in), 113.97 seconds.
- Contracts: **58 passed**, including invariants, no contract changes.
- Existing exported regression: **2 passed, 1 skipped** (fresh live provider opt-in).
- New public reproduction tests: **16 passed**, including tampered proposals/resealed checker flags,
  credential URLs, no public-request authorization/cookies/proxy trust, ignored `.env`, clean copy,
  target-child secrets/scratch, unrelated paid products and real-broker HTTP 401 without fallback.
- Fresh public Git clone with its own `uv sync --locked` virtual environment, no `data/`: offline
  pass (0.1 s); scripted pass (1.5 s) with original R5 **3/3**, repaired
  **0/3**, both **3/3 completed**, repaired payment **3/3**. Fresh reports bind current artifacts.
- Live mode with provider keys removed: exits **1**, explicit missing GROQ_API_KEY, no fallback.
- Public download reproduction: offline pass against https://counterproof.vercel.app, no credentials.
- `verify_evidence.py --url https://counterproof.vercel.app --chain`: **all checks passed**, including
  historical settlements, attested evidence digests and ERC-8004 feedback for agents 2190/2192.
- Web: **173 passed**, TypeScript and ESLint clean; production snapshot build passed.
  Desktop and **375 x 812** browser screenshots reviewed: legible comparison, no overlap or
  horizontal overflow. Existing date, read-only and testnet labels retained.
- All **52 hosted snapshot files**: HTTP 200 and exact byte matches to the checkout; **5 hosted
  evidence pages**: HTTP 200. Production preview also served all 52 downloads correctly.
- Final diff audit: no historical snapshot/evidence/deployment artifacts, funded specs, backend
  digest-bound source or contracts modified; whitespace check clean. No fresh provider run in the
  Codex session (live credential/failure paths tested); a real one followed at 16:37 UTC (see table above). Linux/macOS remain untested.

## Blockers / owner actions

- **Owner:** create the portal project, inspect remaining submission fields and logo limits, record
  and upload both videos, review and submit before **14 October 09:29 IST**. Do not ask the agent
  to accept terms or submit the form on your behalf.
- Published 2026-10-13 ~10:30 UTC with the owner's approval: branch + tag pushed, merged into main
  (`8fee39e`) and pushed, Vercel redeployed; hosted evidence re-verified (all checks passed).
- **Owner: record demo + pitch, submit.**
- Blocked: external agent evaluation (no container engine on this machine); independent human
  reproduction (needs an outside person - no outreach sent).

## Next concrete task

Nothing pending on the code side. Owner only:

1. Create the portal project, check the remaining fields (pitch limit, logo upload limits),
   record and check both videos (docs/DEMO_SCRIPT.md, docs/PITCH.md), paste real links into
   docs/SUBMISSION_FINAL.md and submit before **14 October 09:29 IST** (03:59 UTC). The agent
   must not accept terms or submit the form.
2. A local snapshot preview for recording runs at http://127.0.0.1:3101 (read-only, no jobs); the
   same first screen is live at https://counterproof.vercel.app.
3. Do not mark videos, external-agent evaluation or outside reproduction complete until the
   actual artifacts or independent work exist.
