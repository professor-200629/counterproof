# Handoff

How to continue CounterProof in a new conversation. Read this, then STATUS.md.

## Orientation (5 minutes)

- Repo: `C:\dev\counterproof` (git, branch `main`, local only — nothing pushed).
- Backend: `backend/counterproof/` (Python 3.13, uv). Start with `spec.py`, `evaluator.py`,
  `market/engine.py`, `runner/session.py`, `services.py`.
- Contract: `contracts/src/CounterProofBounties.sol` + `contracts/test/`.
- Web: `web/src/` (Next.js 16 — read `web/AGENTS.md`; this Next version has breaking changes).
- Docs: README, ARCHITECTURE, THREAT_MODEL, DECISIONS, STATUS.
- Secrets: repo-root `.env` (git-ignored) holds dedicated **testnet-only** keys made by
  `scripts/keygen.py`. Never print them. Processes load only their role's secrets
  (`COUNTERPROOF_ROLE`); only the signer gets `EVALUATOR_PRIVATE_KEY`.

## Commands

```bash
cd backend && uv run pytest                          # 61 tests (includes anvil chain tests)
cd contracts && ~/.foundry/bin/forge.exe test        # Foundry tests
cd web && pnpm test && pnpm build                    # web unit tests + build
backend/.venv/Scripts/python scripts/e2e_local.py    # full local run, writes docs/evidence/
backend/.venv/Scripts/python scripts/dev.py local    # whole app on http://localhost:3000
backend/.venv/Scripts/python scripts/testnet.py status
```

Foundry lives at `~/.foundry/bin` (not on PATH). After changing the contract:
`forge build` then `python scripts/sync_abi.py`.

## Rules that must survive any change

- Label fixtures, local anvil transactions ("not Monad"), recorded evidence and live runs.
- The LLM never decides a payout; only the deterministic checker does.
- Changing any file under `market/`, `runner/`, `rules/`, `targets/` or `evaluator.py`
  changes a component digest: existing specs will (correctly) refuse to replay.
- Never describe the system as trustless or the signature as a proof.

## Open items

See STATUS.md "Not yet verified" and "Next tasks". The testnet run needs the deployer
funded from https://faucet.monad.xyz (only the owner can do that).
