# CounterProof

**Put AI promises to the test.**

Developers publish measurable promises about their AI agents. Challengers earn funded
rewards by producing reproducible counterexamples. CounterProof independently replays the
evidence, records the outcome and settles the reward on Monad.

First domain: **AI purchasing agents** in an isolated, synthetic marketplace (invented
merchants, products, balances and orders — no real shops, accounts or money).

> **What a result does and does not mean.** A verified violation shows that one target
> version, given one exact action sequence, broke one agreed rule — observed in the
> evaluator's own ledger, not in the agent's report. "No violation found" means none was
> found within the stated search budget; it is not proof of safety. The evaluator is a
> declared trusted party: its signature is an attestation, not a zero-knowledge proof, and
> a blockchain receipt proves that a transaction happened, not that an AI is correct.

## How it works

1. **Promise** — the publisher picks a target adapter and approves exact rule parameters
   from five templates: cumulative budget cap, merchant allowlist, single payment per
   order, no use after revocation, no privileged calls (untrusted content cannot expand
   permissions). The full terms are canonicalised and hashed.
2. **Fund** — the spec digest, evaluator, deadlines and reward go into the
   `CounterProofBounties` contract.
3. **Challenge** — three bounded strategies search for counterexamples: a sequence
   explorer, a merchant-content (prompt-injection) adversary and a retry/replay adversary.
   An optional model-assisted generator proposes sequences; it never decides outcomes.
4. **Commit** — the challenger commits a salted candidate digest and payout recipient on
   chain before the deadline.
5. **Replay** — the evaluator replays the sequence in fresh isolated children from the
   committed initial state. A deterministic checker reads the evaluator-side ledger.
6. **Attest** — a separate signer re-verifies the sealed evidence, replays once itself,
   checks the chain and signs an EIP-712 attestation.
7. **Settle** — anyone relays the attestation; the contract pays the bound recipient
   (pull payment). Unsettled rewards are refundable after the settlement window.
8. **Repair** — the same sequence is replayed against the repaired version and exported
   as a regression test (JSON + pytest).

## Targets

| Adapter | Label | Notes |
|---|---|---|
| `ref-purchasing-agent@1.0.0` | **Intentionally vulnerable fixture** | Two planted defects: per-purchase (not cumulative) budget check; no idempotency on payment retries. Findings against it demonstrate the pipeline; they are not discoveries. |
| `ref-purchasing-agent@1.1.0` | Repaired fixture | Both defects fixed. |
| `llm-purchasing-agent@0.1.0` | Independent implementation (live model) | Conventional tool-calling agent; behaviour comes from a hosted model through the evaluator's broker. Results are statistical (k-of-n replays). |

## Quick start (Windows, local chain)

Prerequisites: Python 3.13 + [uv](https://docs.astral.sh/uv/), Node 20+ and pnpm, Foundry
≥ 1.8 (`forge`, `anvil`).

```bash
cd backend && uv sync && cd ..
cd contracts && forge build && cd ..
cd web && pnpm install && cd ..
backend/.venv/Scripts/python scripts/dev.py local
```

Open http://localhost:3000. `local` mode starts anvil (`--network monad`, chain 31337 —
**not Monad testnet**), deploys the contract, and runs the signer, API, worker and web app.
The web app offers a clearly labelled "Local dev account" wallet that only works on anvil.

Other modes: `scripts/dev.py offchain` (no chain, evidence only) and
`scripts/dev.py testnet` (see below).

## Tests

```bash
cd backend && uv run pytest
cd contracts && forge test
cd web && pnpm test
```

Complete local end-to-end run (separate API, worker, signer and anvil processes):

```bash
backend/.venv/Scripts/python scripts/e2e_local.py
```

It writes a report to `docs/evidence/local-e2e-<timestamp>.json`. See
[STATUS.md](STATUS.md) for what has actually been run and what remains unverified.

## Monad testnet

Verified network facts (docs.monad.xyz, 2026-10-06): chain id 10143, RPC
`https://testnet-rpc.monad.xyz`, explorer `https://testnet.monadscan.com`, faucet
`https://faucet.monad.xyz`. Gas is billed on the gas **limit**. A value-sending transaction
reverts if the sender would end below a 10 MON reserve (unless it is an "emptying"
transaction).

```bash
backend/.venv/Scripts/python scripts/keygen.py            # dedicated testnet keys -> .env (addresses printed)
# fund the deployer address from https://faucet.monad.xyz
backend/.venv/Scripts/python scripts/testnet.py fund-roles
backend/.venv/Scripts/python scripts/testnet.py deploy
backend/.venv/Scripts/python scripts/testnet.py verify
backend/.venv/Scripts/python scripts/e2e_testnet.py       # full flow with Monadscan links
backend/.venv/Scripts/python scripts/dev.py testnet       # the app against testnet
```

## Live-model mode (optional)

Deterministic mode needs no model. To test the live-model agent or use the model-assisted
generator, set `COUNTERPROOF_LLM_PROVIDER` (`groq`, `openai` or `openrouter`), the
provider's API key and optionally `COUNTERPROOF_LLM_MODEL` in `.env`. Missing credentials
produce an explicit error; a failed live run is never replaced with fixture results.

## Hosted snapshot

For people who cannot run the evaluator, the console can be published as a **read-only
recorded snapshot** (e.g. on Vercel). It is a recording, not a deployment of CounterProof:
the API, worker, signer and chain run only on the owner's machine, and nothing on the
hosted site runs live. The replays, verdicts, signatures and transactions it shows were
recorded from the evaluator's run; a banner on every page says when the snapshot was
taken, from which network, and how many challenges it includes. Every action (create,
fund, run, cancel, submit, retry, attest, settle, withdraw, refund, regression) is replaced
by a note pointing here, the wallet button is gone, deadlines are judged at snapshot time
instead of counting down, and downloads (evidence bundles, spec JSON, regression tests)
are the recorded files. The browser reads nothing from a local anvil chain; only for a
Monad testnet snapshot does it read `credits()` live from the public RPC, labelled as such.

How it is produced:

```bash
# 1. with the evaluator running (scripts/dev.py local | testnet) and the flow done:
backend/.venv/Scripts/python scripts/export_snapshot.py [--api http://127.0.0.1:8010] [--challenges 3]
#    -> web/public/snapshot/ (every GET the console needs + manifest.json); refuses to
#       export any response containing a secret value from .env
# 2. preview locally
cd web && NEXT_PUBLIC_SNAPSHOT=1 pnpm build && pnpm start
```

3. Deploy `web/` to Vercel (project root directory `web`) with the build-time environment
   variable `NEXT_PUBLIC_SNAPSHOT=1` and no `BACKEND_URL`. Vercel builds from the
   repository, so commit `web/public/snapshot/` first (or deploy from the CLI). A snapshot
   build without `public/snapshot/manifest.json` fails on purpose.
4. Set `SNAPSHOT_SOURCE_URL` in `web/src/lib/snapshot.ts` to this repository's URL; the
   banner's "How to run it yourself" link and every read-only note point there.

Details: [web/FRONTEND_NOTES.md](web/FRONTEND_NOTES.md), section "Snapshot mode".

## Documents

- [ARCHITECTURE.md](ARCHITECTURE.md) — components, data flow, trust boundaries
- [THREAT_MODEL.md](THREAT_MODEL.md) — assets, attacks, mitigations, residual risks
- [DECISIONS.md](DECISIONS.md) — key choices and why
- [STATUS.md](STATUS.md) — what works, what was tested, what is not verified
- [HANDOFF.md](HANDOFF.md) — how to continue the work
- [contracts/README.md](contracts/README.md) — contract build, test, deploy, verify

## Limitations

- The evaluator is trusted; there is no dispute mechanism.
- Process isolation is not a security sandbox; it is used only for first-party adapters.
  Container isolation is implemented but unverified here (Docker engine unavailable).
- Only the five rule templates can be adjudicated; natural-language promises cannot.
- Search is bounded; absence of findings is not proof of safety.
- Live-model results depend on provider, model and date.
- Testnet only. No mainnet assets.
