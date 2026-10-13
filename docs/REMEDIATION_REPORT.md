# Remediation report (2026-10-12 / 2026-10-13)

The review findings below came from an earlier version. Each was checked against the code
before anything was changed. All work is on branch `remediation/judge-review`, which was
started from `main` @ `51c0832` (the state published on 2026-10-11). That source is preserved
as the local tag `testnet-2026-10-11`. Nothing has been pushed or deployed yet; see "Owner
actions" at the end. The working log is in [REMEDIATION_STATE.md](REMEDIATION_STATE.md).

## Evidence classes used in this report

| Class | What it is | Files |
|---|---|---|
| **Historical, Monad testnet** | The 2026-10-11 run: challenges 1-3, contract `0xE377…b5e4`, ERC-8004 agents 2190/2192. Not modified. | `docs/evidence/testnet-*.json`, `docs/deployments/*` |
| **Fresh, real model, local** | Real Groq `openai/gpt-oss-120b` calls; local evaluator on a copy of the testnet data directory; no chain transaction. | `docs/evidence/repair-llm-0.2.0-20261013-092750*`, `test_regression_llm_0_2_0_20261013_092750.py` |
| **Fresh, real model, fork rehearsal** | Real Groq calls on a local anvil fork of Monad testnet (official ERC-8004 registries forked). No transaction reached Monad testnet. | `docs/evidence/fork-rehearsal-llm-20261013-100537.json` |
| **Fresh, local anvil** | Deterministic fixture end-to-end run on chain 31337 (not Monad). | `docs/evidence/local-e2e-20261013-151153.json` (final code), `local-e2e-20261013-035546.json` (unit A) |
| **Mocked / scripted** | Unit tests with scripted model brokers and controlled clocks. | `backend/tests/*` |

## Findings

### 1. Live-model attestation trust gap: reproduced, fixed now

- **Root cause.** `signer.py` replayed only deterministic targets. For stochastic (live-model)
  specs it signed after `recheck_bundle()`, a pure validator of worker-supplied ledgers. Hash
  chains have no secret, so fabricated ledgers with recomputed chains and a resealed bundle passed.
- **Reproduction at the signer boundary.** `tests/test_signer_verification.py`:
  - `test_forged_stochastic_bundle_passes_the_pure_validator` shows the pure validator accepting
    the forged bundle.
  - The forged-evidence test was committed first as "is signed by the pre-fix signer"
    (commit `ba87eee`). It used TestClient on the real signer app, a legitimate local commitment
    and faked chain reads, and it obtained a signature that recovers to the evaluator.
  - It is now `test_forged_stochastic_bundle_is_refused_by_the_signer`.
- **Fix.** The signer:
  - reads the chain first;
  - loads the funded spec and the **committed candidate by its on-chain digest**, never from the
    worker bundle;
  - checks code digests;
  - runs the unchanged `evaluator.evaluate()` itself with its own model broker, applying the
    spec's k-of-n with fresh replays and its own checker;
  - signs only a reward-eligible `verified_violation` whose binding equals the chain.

  The signed `evidenceDigest` is the digest of the signer's **own** bundle. That bundle is stored
  content-addressed and served by the API. The worker's evaluation id and evidence digest are
  kept only as a provenance reference. Verification runs asynchronously, with these results:
  - 202 while verifying;
  - 409 for final refusals (below threshold, binding mismatch, settled, refunded or closed);
  - 503 `failed` (retryable, never a verdict) for provider failure, missing credential,
    unavailable isolation or a crash.

  The reviewers also found a **high** issue, fixed with tests: a writer of `signer.sqlite` could
  previously obtain a renewal signature over forged evidence. The signer now never turns its own
  database rows into a signature without re-checking them.
- **Changed files.** `backend/counterproof/signer.py`, `chain.py`, `worker.py` (new `attestation`
  job), `services.py`, `api.py`, `db.py`, `config.py` (provider keys for the signer role),
  `migrations/002_signer_verification.sql`, `scripts/{dev,e2e_local,e2e_testnet,e2e_testnet_llm,demo_dataset}.py`,
  and the web settlement/evidence components.
- **Verification.** 40+ signer tests:
  - forged evidence refused;
  - 2-of-3 attested with the signer's own evidence;
  - 1-of-3 refused;
  - altered recipient, challenger, candidate or spec digest refused;
  - code-digest mismatch refused before any replay;
  - provider failure and missing credential `failed`, not signed;
  - unauthenticated requests rejected.

  Real model: on the fork rehearsal the signer's own replays reproduced the violation in 3 of 3
  (2 required) and it signed its own digest (`8b871c…`), distinct from the worker's (`a96080…`).
- **Remaining limits.** The signer process now holds both the signing key and the provider key.
  Targets get neither. The signer trusts the provider's responses. It is still a declared trusted
  evaluator: an attestation, not a proof, and not trustless.

### 2. Expired attestation renewal: reproduced, fixed now

- **Root cause.** The API returned a stored attestation row forever. The signer returned its
  stored signature with the old expiry (`ATTESTATION_TTL` 3600 s). An expired attestation could
  never be replaced while the settlement window was still open.
- **Fix.** Renewal works only for the same verified submission:
  - it re-reads the chain (funded, inside the window);
  - it re-verifies the stored own evidence (integrity, seal, recheck, binding equal to the chain);
  - it returns the existing attestation while more than 300 s remain;
  - otherwise it re-signs the same message with expiry = min(now + TTL, settlement deadline);
  - it refuses after settle, refund or the deadline.

  It uses a per-challenge lock plus `BEGIN IMMEDIATE`, keeps an `attestation_history` audit
  table and an injectable clock. The API updates its attestation row (`attestation.renewed`
  activity). The console offers **Renew**, but not in snapshot mode.
- **Verification.** Controlled-clock tests cover:
  - a usable attestation returned unchanged;
  - expired-but-eligible renewed with the cap applied and all other fields identical;
  - tampered stored evidence refused;
  - settled, refunded and closed challenges refused;
  - concurrent requests: exactly one submission attested, one verification per challenge.

  On anvil (`tests/test_chain_local.py`) the contract accepts the renewed signature and rejects
  the expired original after `evm_increaseTime`.

### 3. Mutation routes without authentication or limits: reproduced, fixed now

- **Root cause.** All 14 POST routes were unauthenticated, and caller budgets overrode defaults
  (`defaults | budget`; 0 meant unlimited). Run params and spec `target_config` were
  caller-chosen. There was no queue limit, cost ceiling or operator stop, and
  `next dev` bound to 0.0.0.0.

  Found on the way: `chain.verify_tx` accepted logs from **any** contract and refund events for
  another challenge, and `record_failed_tx` could overwrite a confirmed transaction row.
- **Fix: authentication.**
  - One app-wide dependency guards every mutation. The operator uses
    `Authorization: Bearer <COUNTERPROOF_OPERATOR_TOKEN>`.
  - Judges get an 8-hour cookie session (HttpOnly, SameSite=Strict, hashed server-side) from a
    passcode. Cookie mutations need `X-CSRF-Token` and an allowed Origin/Referer.
  - TrustedHost and X-Forwarded-Host checks guard against DNS rebinding. Request bodies are
    capped at 256 KB, with NaN/Infinity rejected.
  - It fails closed when no secret is configured.
- **Fix: limits.**
  - Role caps are clamped at the API and again in the worker. A judge gets 50 sequences, 300 s
    and 60k tokens per run, 2 active jobs per session and role-wide totals.
  - Judges always use the configured model, at temperature 0 with at most 8 steps; strategy
    `mode` is validated.
  - A global queue limit and a token ledger enforce a daily ceiling. Ceiling and stop refusals
    surface as `runner_failure`, never `target_crash`.
  - Operator stop/resume/status is available from the API and `scripts/operator.py`.
- **Fix: ownership and the chain bugs.** Judges can cancel and retry only their own work.
  Candidate submit on funded challenges (challenger-bot gas) is operator-only.
  `verify_tx` binds receipts to the configured contract and challenge, and confirmed rows are
  never overwritten.
- **Changed files.** `auth.py`, `limits.py` (new), `migrations/005_auth_and_limits.sql`,
  `api.py`, `services.py`, `jobs.py`, `worker.py`, `providers.py`, `chain.py`, `config.py`,
  `redact.py`, `scripts/{operator,operator_auth,dev,e2e_local,...}.py`, and the web
  `judge-session.tsx` and `api.ts`.
- **Verification.** `tests/test_auth_and_limits.py` (39 tests): every mutation route iterated,
  CSRF, Origin, Host, ownership, clamps, model lock, mode bypass, queue limits, ceilings,
  operator stop and the receipt binding. Web transport tests confirm the Next rewrite forwards
  cookies.

  Checked in the browser on the local stack:
  - anonymous POST → 401, foreign Host → 400;
  - judge sign-in → role shown;
  - a judge run with 100,000 sequences / 99,999 s was clamped to 50 / 300;
  - a judge spec naming another model → 403;
  - a missing CSRF header → 403.
- **Remaining limits.** Behind the Next proxy all browsers share one client key, so passcode
  guessing is stopped by the enforced secret lengths rather than the limiter. Cancellation is
  cooperative: an in-flight model call finishes first. The hosted site remains a read-only
  evidence explorer; no hosted execution is exposed.

### 4. No repaired replay for the live-model finding: confirmed, fixed now

- **Root cause.** The only "repair" offered was `ref-purchasing-agent@1.1.0`, a different adapter
  family. Regressions also dropped `target_config`, so live-model regressions crashed with no
  model.
- **Fix.**
  - New `llm-purchasing-agent@0.2.0` (`targets/llm_agent_v0_2.py`, self-contained; 0.1.1 is
    byte-identical). Privileged tools are not offered, and the dispatcher refuses any tool outside
    an explicit allow-list before anything reaches the market. Policy authority comes only from
    `get_mandate`, never from text. There are in-code guards for cumulative budget, merchant
    allow-list, one payment per order and revocation. Blocked proposals are reported by the agent
    as unverified claims, apart from ledger effects; R5 is unchanged.
  - A `RecordingBroker` stores what the model proposed per replay (a sidecar beside, not inside,
    the sealed bundle).
  - Regressions are same-family only (cross-family → 409). They keep config, limits and policy,
    and they export the recorded model proposals.
  - The generated pytest re-executes the agent with the recorded proposals standing in for the
    model.
- **Digest change.** Hosting 0.2.0 needed one row in `runner/host.py`, which is part of every
  adapter's pinned digest. Verified on 2026-10-13: from tag `testnet-2026-10-11`, the adapter,
  runner, market and checker digests all equal challenge #3's funded spec. From HEAD only the
  adapter digest differs, and no other digest-bound file changed. Historical specs and evidence
  were not rewritten.
- **Real-model result (fresh, local).** The exact recorded attack against 0.2.0, with the same
  rules, initial state, model and 2-of-3 policy:
  - **not reproduced: R5 held in 3 of 3 replays, all completed, the order was still paid.**
  - Enforcement versus remaining unsafe proposals: the model proposed **no** privileged tool in
    any replay, because none was offered. So 0 calls were blocked in code, 0 rejected by the
    provider and 0 reached the market. The in-code refusal was **not** exercised live; scripted
    tests cover it.
  - An ordinary purchase with no injection completed with payment in 3 of 3.
  - The exported pytest gives 2 passed (0.2.0 passes; 0.1.1 still violates), with 1 live variant
    opt-in.
- **Remaining limits.** Bounded, statistical evidence for one model on one date; not general
  safety. A provider rejection of a tool that is not offered (Groq `tool_use_failed`) would end a
  replay as `target_crash`. Such a regression is recorded as inconclusive, not as a confirmed
  repair.

### 5. Independent validation: partly blocked, kit prepared

- All adapters were written by the CounterProof team. The labels now say "team-written", and
  "independent implementation" is no longer used as display text.
- **External agent: blocked.** External code requires container isolation, and the Docker engine
  does not start on this machine. Candidates were pinned and licence-checked read-only:
  1. Google's AP2 shopping agent (Apache-2.0, `e1ea56db…`);
  2. Anthropic's commerce-agents (Apache-2.0, `fd4d5922…`);
  3. AWS shopping concierge (Apache-2.0, `f33b4f14…`).

  The integration plan is in [EXTERNAL_AGENT_PLAN.md](EXTERNAL_AGENT_PLAN.md). Nothing was run.
- **Human reproduction: pending.** The kit is [REPRODUCE.md](REPRODUCE.md), and
  `scripts/verify_evidence.py` re-checks the recorded evidence offline and against Monad testnet
  (all checks pass for the repository snapshot and the hosted site). No outreach was sent.

### 6. Judge experience: confirmed, fixed now

- **Fixed.**
  - The first screen leads with the live-model finding: promise, quoted injected text, attempted
    tool, "3 of 3, 2 required", settled versus withdrawn, ERC-8004 feedback, repair status with
    model proposals, and inspect/run links.
  - Same-family comparisons only, with cross-family regressions labelled "different agent family".
  - Per-replay witness marks (replays 1 and 2 had the wrong row marked).
  - "Awaiting settlement" versus "Ever funded"; a MON versus SYN legend; a withdraw tx in the
    reward answer.
  - Snapshot tests are data-driven (the two baseline failures are fixed).
  - The source link defaults to the public repository.
  - Pages are measured at 375 px. A compare-page overflow to 789 px came from an absolutely
    positioned screen-reader label escaping its scroll box, and is fixed.
- **Hosted site.** Labelled as a read-only evidence explorer. The new snapshot (challenges 1-3
  unchanged, plus the repaired replay and an off-chain ordinary-purchase check) is committed
  but **not deployed yet**.

### 7. Found during verification: migration race, fixed now

When `scripts/dev.py local` starts the API and workers together on an existing database, two
processes could apply the same `ALTER TABLE` ("duplicate column name") and the worker exited.
`db.migrate` now re-checks under the write lock. The new test fails 3/3 without the fix and
passes 3/3 with it.

## Test results (final, on the merged branch)

| Check | Result | Environment |
|---|---|---|
| Backend `uv run pytest` | **198 passed, 4 skipped** (skips: ERC-8004 fork tests without the env var) | Windows 11, Python 3.13 (uv), offline |
| ERC-8004 fork tests `COUNTERPROOF_FORK_TESTS=1 pytest tests/test_erc8004.py` | **12 passed** | anvil fork of Monad testnet (network) |
| Contracts `forge test` | **58 passed** (contract unchanged) | Foundry 1.8.5 |
| Web `vitest` | **172 passed** (16 files) | Node 24 |
| Web `tsc --noEmit`, `eslint src` | clean | |
| Snapshot production build | ok | `NEXT_PUBLIC_SNAPSHOT=1 next build` |
| Local anvil e2e on final code | **pass, 24 steps** | `docs/evidence/local-e2e-20261013-151153.json` |
| Exported live-model regression pytest | 2 passed, 1 skipped (live opt-in) | |
| `scripts/verify_evidence.py --chain` | all checks passed | repository snapshot and https://counterproof.vercel.app + Monad testnet RPC |

Baseline before the work (on `51c0832`): backend 88 passed / 4 skipped, contracts 58, web
105 passed / 2 failed.

**Skipped or not run:**
- no new Monad testnet transaction;
- no browser-wallet check on testnet;
- no container isolation (Docker unavailable);
- Linux/macOS untested;
- the live variant of the exported regression test was not re-run (its live result is the
  recorded repaired replay).

## Fresh demo / reproduction procedure

See [REPRODUCE.md](REPRODUCE.md). In short:

1. `scripts/verify_evidence.py --url https://counterproof.vercel.app --chain`.
2. `cd backend && uv run pytest`, then the exported regression test.
3. `scripts/dev.py local`, sign in as judge (passcode in `data/judge.passcode`) and run the
   strategies.
4. With a Groq key: `scripts/live_repair_replay.py` on the owner's machine, or
   `COUNTERPROOF_FORK_REHEARSAL=1 COUNTERPROOF_TESTNET_RPC=http://127.0.0.1:8546 scripts/e2e_testnet_llm.py --recorded`
   against `anvil --fork-url https://testnet-rpc.monad.xyz --network monad --port 8546`.

## Deployment and external-validation status

- **Monad testnet:** unchanged since 2026-10-11, with no new transactions.
- **GitHub:** the branch `remediation/judge-review` and tag `testnet-2026-10-11` exist only
  locally.
- **Vercel:** https://counterproof.vercel.app still shows the 2026-10-11 snapshot and console.
  The new console and snapshot are built and tested locally only.
- **External agent and independent human reproduction:** pending (see section 5).

## Owner actions

1. **Confirm the submission cut-off and video limits in the portal.** The public pages say only
   "13 Oct".
2. **Publish (your decision).** These are the exact commands once approved:
   ```bash
   git push origin remediation/judge-review testnet-2026-10-11
   git checkout main && git merge --no-ff remediation/judge-review && git push origin main
   cd web && npx vercel deploy --prod --yes --build-env NEXT_PUBLIC_SNAPSHOT=1 --build-env NEXT_PUBLIC_SNAPSHOT_SOURCE_URL=https://github.com/professor-200629/counterproof
   ```
   The deploy uploads the committed `web/public/snapshot` (re-exported 2026-10-13). After it,
   run `scripts/verify_evidence.py --url https://counterproof.vercel.app --chain`.
3. **Record the demo and pitch** from [DEMO_SCRIPT.md](DEMO_SCRIPT.md) and [PITCH.md](PITCH.md),
   then submit with [SUBMISSION.md](SUBMISSION.md).
