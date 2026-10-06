# Status

_Last updated: 2026-10-06 (day 1). Hackathon submissions close 2026-10-14 03:59 UTC
(13 Oct 23:59 US Eastern), per hackathon.monad.xyz. 13 Oct is reserved for verification,
recording and submission._

## Current stage

Stage 1 (local loop) and Stage 2 (local settlement) are working end to end on a local anvil
chain. The web console is being built. Monad testnet deployment is waiting for testnet MON.

## What works (verified by running it)

| Capability | Evidence |
|---|---|
| Canonical challenge spec v1, SHA-256 digests, immutable versions | `tests/test_api_flow.py`, preview digest = funded digest |
| Synthetic market, hash-chained ledger, 5 rule templates, deterministic checker | `tests/test_market_and_rules.py` |
| Vulnerable fixture 1.0.0 breaks R1 (38,400 vs 25,000 SYN) and R3 (double payment) | tests + local e2e |
| Repaired 1.1.0 resists both sequences and every reference attack | tests + local e2e |
| Isolated replay: fresh child, no secrets, socket guard, Job Object limits | `tests/test_sandbox.py` |
| Fail closed on unavailable isolation and on code-digest mismatch | `tests/test_evaluator.py` |
| Three deterministic strategies with shrinking, budgets and cancellation | `tests/test_api_flow.py` |
| Evidence bundles sealed; tampering detected; signer re-verification | `tests/test_evaluator.py` |
| Durable jobs, cancellation, restart recovery | `tests/test_api_flow.py` |
| Contract: 56 Foundry tests (fuzz + invariant) | `forge test` (contract workflow report) |
| Python EIP-712 signer == contract hash; wrong signer / altered recipient / cross-chain / cross-contract / double settle / early refund rejected | `tests/test_chain_local.py` on anvil |
| Full multi-process local run: create → fund → search → commit → replay → attest → settle (relayed) → withdraw → patch → retest → export, plus a no-violation challenge refunded | `scripts/e2e_local.py`, report `docs/evidence/local-e2e-20261006-174302.json` |
| Monad gas-limit billing reproduced locally (withdraw fee = gas limit × price) | same report |

Test counts on 2026-10-06: backend 61 passed; contracts 56 passed (to be re-run after the
review fixes).

## In progress

- Web console (Next.js 16, wagmi 3): foundation and pages being built.
- Contract review fixes: OpenZeppelin submodule pinned to v5.6.1 (the first commit picked
  up gitlinks that pointed at `master`).

## Not yet verified

- **Monad testnet**: keys generated (`scripts/keygen.py`); deployer
  `0x3893A16a140969702F88C1DCa98CA5a1Cc27554B` needs testnet MON from the faucet. No testnet
  transaction has been made yet. Nothing in this repository should be read as a testnet
  transaction until `docs/deployments/monad-testnet.json` and a `testnet-e2e` report exist.
- **Container isolation**: implemented (`docker/target.Dockerfile`, `DockerBackend`) but the
  Docker engine does not start on this machine; untested.
- **Live-model agent and model-assisted generator**: code paths exist; not yet run against
  Groq.
- **Second-implementation evaluation**: pending (Stage 4).
- **Web console**: not yet verified in a browser.

## Next tasks

1. Finish and verify the web console against `scripts/dev.py local`.
2. When testnet MON arrives: `testnet.py fund-roles`, `deploy`, `verify`, `e2e_testnet.py`.
3. Run the live-model agent (Groq) under the three strategies; record honest results.
4. Demo script, pitch, submission text; record the demo.
