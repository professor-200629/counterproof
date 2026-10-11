# Status

_Last updated: 2026-10-11. Hackathon submissions close 2026-10-14 03:59 UTC (13 Oct 23:59 US
Eastern), per hackathon.monad.xyz. 13 Oct is reserved for verification, recording and
submission._

## Current stage

Everything runs end to end on a local anvil chain and, since 2026-10-11, on a **local fork of
Monad testnet** (real ERC-8004 registries, chain id 10143, no real transactions). The real
Monad testnet run is waiting only for testnet MON on the deployer
(`0x3893A16a140969702F88C1DCa98CA5a1Cc27554B`, about 1.5 MON). Source is public at
https://github.com/professor-200629/counterproof; the read-only console is at
https://counterproof.vercel.app (recorded local-anvil snapshot until the testnet run).

## Added 2026-10-11: ERC-8004 agent identity and reputation

| Capability | Evidence |
|---|---|
| Registration and feedback files, data: URIs, keccak feedback hash; malformed or foreign agent URIs fail closed | `tests/test_erc8004.py` (offline) |
| Against the **official** registries on a fork of Monad testnet: register an agent, settle a real verified violation, post feedback, read it back | `COUNTERPROOF_FORK_TESTS=1 pytest tests/test_erc8004.py` (12 passed) |
| Reporter refuses: agent declaring other code, self-feedback, unsettled challenge, tampered evidence | same |
| Full `e2e_testnet.py` as a fork rehearsal: identity -> fund -> 3 strategies -> commit -> replay (verified, 2 of 2) -> attest -> settle (relayed) -> ERC-8004 feedback -> withdraw -> repaired 1.1.0 not reproduced | `data/fork-rehearsal/` (not committed: it is not Monad testnet evidence) |
| Settlement page ERC-8004 panel | `web/src/test/erc8004.test.ts`; viewed in the browser against the rehearsal data |

Measured on the fork (Monad testnet gas prices at the forked block): contract deploy ~0.12 MON;
publisher (register + fund 0.01 + gas) ~0.065 MON; reporter feedback ~0.013 MON.

Found while doing it: the public anvil dev addresses (e.g. `0xf39F…2266`) carry EIP-7702
delegations on Monad testnet, so the registry's ERC-721 safe mint to them reverts. CounterProof's
own keys are plain EOAs and register fine (checked with `eth_call` on the live testnet).

## What works (verified by running it)

| Capability | Evidence |
|---|---|
| Canonical challenge spec v1, SHA-256 digests, immutable versions; preview digest = funded digest | `tests/test_api_flow.py` |
| Synthetic market, hash-chained ledger, 5 rule templates, deterministic checker | `tests/test_market_and_rules.py` |
| Vulnerable fixture 1.0.0 breaks R1 (38,400 vs 25,000 SYN) and R3 (double payment); repaired 1.1.0 resists | tests + local e2e |
| Isolated replay: fresh child, no secrets, socket guard, Job Object limits | `tests/test_sandbox.py` |
| Fail closed on unavailable isolation and on code-digest mismatch | `tests/test_evaluator.py` |
| Strategies with shrinking, budgets, cancellation; model-assisted generator (live on Groq) | `tests/test_api_flow.py`, `tests/test_model_assisted.py` |
| Evidence sealed; tampering detected; signer re-verification + own replay | `tests/test_evaluator.py`, local e2e |
| Live-model classification: provider outage → runner_failure (never "not reproduced"); k-of-n; invalid tool calls → target failure; provider waits excluded from target time | `tests/test_live_model_classification.py`, `tests/test_providers.py` |
| Durable jobs, cancellation, restart recovery, retry of runner failures | `tests/test_api_flow.py`, `tests/test_live_model_classification.py` |
| Contract: 58 Foundry tests (fuzz, invariants, dependency pins); 7 planted bugs all caught | `forge test`, contract workflow report |
| Python EIP-712 signer == contract; wrong signer / altered recipient / cross-chain / cross-contract / double settle / early refund rejected | `tests/test_chain_local.py` (anvil) |
| Full multi-process local run incl. relayed settle, withdraw, patch, retest, export, refund | `docs/evidence/local-e2e-20261006-174302.json` (runner 1.0.0; deterministic path unchanged since) |
| Monad gas-limit billing reproduced locally | same report |

Tests on 2026-10-11 (latest run): backend **88 passed, 4 skipped** (the 4 fork tests; they
pass with `COUNTERPROOF_FORK_TESTS=1`); contracts **58 passed** (2026-10-06, contract unchanged
since); web unit tests **107 passed**.

## Hosted read-only console

https://counterproof.vercel.app (Vercel project `counterproof`, deployed 2026-10-07 with the owner's
approval). It shows a recorded snapshot (challenges 6, 8, 9 of 9; local anvil, labelled "not Monad")
and runs nothing live. Verified: all routes and assets return 200 from Vercel; the identical build
rendered fully at localhost with no backend running. The in-app browser blocks Vercel's script
assets, so the hosted page itself was not watched rendering - open it in a normal browser to confirm.
Redeploy: `scripts/export_snapshot.py --challenges ...` then
`cd web && npx vercel deploy --prod --yes --build-env NEXT_PUBLIC_SNAPSHOT=1 --build-env NEXT_PUBLIC_SNAPSHOT_SOURCE_URL=https://github.com/professor-200629/counterproof`.
Source: https://github.com/professor-200629/counterproof (public since 2026-10-11).

## Web console — verified in the browser (2026-10-06, local anvil)

Walked through with the labelled local dev wallet: create (5 steps; browser-recomputed spec
digest matches the backend) → fund (`createChallenge`, backend verified the receipt) → run
three strategies (real progress counts) → submit a candidate (committed on chain) →
evidence page (verified 2 of 2, witness ledger events, five questions answered) → request
attestation (browser recovers the signer from the signature) → relay `settle()` from a third
account (reward credited to the bound recipient, verified from `ChallengeSettled`) →
before/after against 1.1.0 (not reproduced; 19,500 within budget) → exports. All main routes
fit 375 px (measured). Web unit tests: 80 passed.

Found and fixed during the walkthrough: two different "evidence digests" (store key vs seal)
— now one; dev wallet not reconnecting after reload / reconnecting on the wrong chain; a
failed search run worded as "no violation found" in the activity log; wide hashes
overflowing small screens.

Not a bug but worth knowing: in a hidden browser window, streamed pages stay on their loading
placeholder until the window is visible (React's reveal waits for an animation frame).

## Incidents (recorded, fixed)

1. **Misclassified live-model replays (runner 1.0.0).** A network outage during the first
   live-model evaluation made every model call fail; replays "completed" with zero tool calls
   and were classified `not_reproduced`. Fixed in runner 1.0.1 (provider failure →
   `runner_failure`). The report is kept in `docs/evidence/superseded/` with an explanation.
2. **Rate limits read as outages (runner 1.0.1 → 1.0.3).** The rerun correctly reported
   `runner_failure`, but the causes were Groq's 8,000 tokens/minute limit (429) and invalid
   tool calls generated by the model (400). Runner 1.0.2 paces requests, honours
   retry-after, excludes provider waits from target time and classifies invalid model output
   as a target failure; runner 1.0.3 shares the token budget across worker processes and makes
   provider waits cancellable. The 1.0.1 report (in `docs/evidence/superseded/`) shows only
   runner failures and contains no findings.
3. **OpenZeppelin submodule pinned to master in the first commit.** Fixed; pins verified by
   `contracts/script/check-release.sh` and `DependencyPins.t.sol`.

## Independent live-model evaluation (gpt-oss-120b, 2026-10-06)

Recorded in [docs/evidence/INDEPENDENT_EVALUATION.md](docs/evidence/INDEPENDENT_EVALUATION.md):
sequence explorer 5/5 and retry/replay 5/5 found no violation within budget; the
merchant-content adversary produced an R5 candidate the evaluator **verified in 3 of 3**
replays (after injected merchant text the agent called `update_mandate(budget=1000000)`; the
market refused it). The three earlier one-off observations on gpt-oss-20b (over-budget
purchase, double payment, privileged call) are still unconfirmed by the evaluator; that
model's daily quota ran out before they could be replayed.

## Not yet verified

- **Monad testnet**: no testnet transaction exists yet. Deployer
  `0x3893A16a140969702F88C1DCa98CA5a1Cc27554B` needs ~1.5 testnet MON. Everything up to that
  point has run on a fork of Monad testnet.
- **10 MON reserve rule**: neither anvil nor the fork enforces it; only testnet can confirm
  (scripts space value-sending transactions so they qualify as "emptying").
- **Container isolation**: implemented, untested (Docker engine does not start here).
- **Web console on Monad testnet** with a real browser wallet (verified on local anvil with the dev wallet).

## Next tasks

1. Testnet (needs MON): `testnet.py fund-roles`, `deploy`, `verify`, `e2e_testnet.py`
   (includes ERC-8004 identity + feedback), then `dev.py testnet --data <run dir>` and
   `export_snapshot.py`, redeploy the console with the testnet snapshot.
2. Final local e2e on the final code.
3. Demo video (<= 3 min), pitch video (<= 2 min), submission text (docs/SUBMISSION.md).
