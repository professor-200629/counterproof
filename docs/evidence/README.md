# Evidence

Machine-written reports from real runs. Each file says where it ran. Nothing here is
hand-edited.

| File pattern | What it is | Where it ran |
|---|---|---|
| `local-e2e-<ts>.json` | `scripts/e2e_local.py`: create → fund → search → commit → replay → attest → relayed settle → withdraw → patch → retest → export, plus a no-violation challenge refunded | **Local anvil chain 31337** (`--network monad`). Not Monad testnet. Public anvil dev keys. |
| `regression-<ts>.json`, `test_regression_<ts>.py` | The exported regression test from that run (JSON and pytest) | Generated from the local run |
| `testnet-e2e-<ts>.json`, `regression-testnet-<ts>.json` | `scripts/e2e_testnet.py --with-refund`, same flow plus ERC-8004 identity and feedback, with Monadscan links | **Monad Testnet 10143** |
| `testnet-llm-<ts>.json` | `scripts/e2e_testnet_llm.py`: funded challenge against the live-model agent, live search, k-of-n replay, settlement, ERC-8004 feedback | **Monad Testnet 10143**; live Groq model |
| `fork-rehearsal-llm-<ts>.json` | `scripts/e2e_testnet_llm.py --recorded` with `COUNTERPROOF_FORK_REHEARSAL=1`: the live-model path including the **signer's own k-of-n verification** (signer_replays, signer_evidence vs worker_evidence), settlement, ERC-8004 feedback on the forked official registries, withdraw | **Local anvil fork of Monad testnet - no transaction reached Monad testnet**; live Groq model |
| `repair-llm-0.2.0-<ts>*.json`, `test_regression_llm_0_2_0_<ts>.py` | `scripts/live_repair_replay.py`: the recorded challenge #3 attack against the repaired `llm-purchasing-agent@0.2.0` (live replays), an ordinary purchase check, the exported regression | Local evaluator on a copy of the testnet data; live Groq model; no chain transaction |
| `independent-llm-<ts>.json` | `scripts/evaluate_independent.py`: the live-model agent under the three strategies, all outcomes including "no violation found" | Off-chain challenge; live Groq model |

How to read a result:

- The target label matters. `intentionally-vulnerable-fixture` results are demonstrations of
  the pipeline with planted defects, not discoveries.
- `verified_violation` for a deterministic target means every replay violated the rule with
  an identical ledger digest. For the live-model target it means at least *k* of *n* fresh
  replays did; it is statistical.
- `no_violation_found` reports the sequences tried, the budget and the termination reason.
  It is not proof of safety.
- Transaction hashes in local reports exist only on the disposable local chain.
