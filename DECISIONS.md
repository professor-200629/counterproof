# Decisions

Short records of choices that shape the system. Newest last.

### D1. Separate repository at `C:\dev\counterproof` (2026-10-06)
The working directory was another project (Elisa). CounterProof is unrelated, so it lives in
its own git repository; nothing in the other project was touched.

### D2. Python backend, Next.js frontend, Foundry contracts
Matches the requested stack and the machine (Python 3.13 via uv, Node 24 + pnpm, Foundry
1.8.5 installed from the official GitHub release after checking its SHA-256).

### D3. The ledger lives in the evaluator, never in the target
Targets run in a child process and can only ask for tool calls. This one choice makes
"challenger cannot corrupt the ledger" and "do not trust the agent's own report" structural
rather than a matter of careful coding.

### D4. Challenger submissions are data, not code
A candidate is a list of closed-schema environment actions. This removes the need to run
challenger code at all and keeps the attack surface to schema validation.

### D5. Process isolation by default, container isolation implemented, fail closed
Docker Desktop's engine does not start on this machine (a first-run dialog needs the
owner). Rather than block, the spec names the isolation level and the evaluator refuses
if that level is unavailable. `process` isolation is documented as *not a sandbox* and is
limited to first-party adapters.

### D6. Windows Job Object and the base interpreter
The venv's `python.exe` on Windows is a launcher that spawns a second process, which the
one-process job limit forbids. The child runs the base interpreter; it needs only the
standard library and this package's target modules.

### D7. SHA-256 canonical JSON digests, stored as bytes32
Strict JCS subset (sorted ASCII keys, no floats, integers within 2^53). Anyone can
recompute a digest with standard tools; the same 32 bytes go on chain.

### D8. Deterministic reproducibility = identical ledger digests on every replay
For live models, a declared *k-of-n* policy instead; seeds are not treated as determinism.

### D9. One reward per challenge, first eligible settlement wins, pull payments
Simplest reviewable lifecycle. Settlement never sends value, so a recipient cannot block it.

### D10. EIP-712 attestation binds chain, contract, challenge, spec, submission, candidate, evidence, challenger, recipient, verdict, expiry
Covers cross-chain, cross-contract and recipient-substitution attacks with one signature.

### D11. A separate signer process that re-verifies and replays
The API/worker never hold the evaluator key (role-based `.env` loading). The signer
re-checks the sealed bundle, replays deterministic candidates itself and reads the chain.

### D12. Native testnet MON, no tokens
Avoids token dependencies, approvals and extra contracts.

### D13. Live models through an evaluator-side broker; Groq only provider with working access
Inspection on 2026-10-06: Groq's free tier answers; the OpenAI key returns 429 and
OpenRouter has no credit (free models only). Claude Max is a development subscription and
is not used at runtime. Live-model mode is optional; deterministic mode needs no model.

### D14. Reference agent with exactly two planted defects; a separate LLM agent as the independent implementation
The fixture is labelled everywhere. The second implementation is a conventional
tool-calling agent whose behaviour comes from a hosted model, written without planted
defects; its results are reported as observed.

### D15. Foundry `network = "monad"`, `anvil --network monad`, solc 0.8.31, EVM osaka
Per the Monad docs (Foundry ≥ 1.8 has native Monad support). Local runs therefore bill gas
on the gas limit like Monad, which the local end-to-end run confirmed (fee = limit × price).

### D16. OpenZeppelin v5.6.1 (audited `latest`), not 5.7.0 (`dev`, unaudited)
Uses `EIP712`, `ECDSA` (rejects malleable signatures) and `ReentrancyGuardTransient`.

### D17. ERC-8004 through the official registries, posted by a separate reporter (2026-10-11)
Track 04 of Metropolis names ERC-8004 agent identity and reputation. CounterProof uses the
official IdentityRegistry and ReputationRegistry on Monad testnet rather than deploying its
own copies, so its results sit where other ERC-8004 readers look. Considered and rejected:
calling `giveFeedback` from `settle()` (adds an external call and a new failure mode to the
payment path, and the contract was already tested and ready to deploy) and posting from the
evaluator key (the signer is kept free of transaction sending). A reporter key that only
relays facts it re-checked on chain keeps both boundaries. Feedback is posted only for
verified violations of the agent that declares the tested artifact; "no violation found"
is not posted as a positive score.

### D18. Fork rehearsal before spending testnet MON (2026-10-11)
`anvil --fork-url https://testnet-rpc.monad.xyz` gives the real ERC-8004 registries and
chain id 10143 with no real transactions. `COUNTERPROOF_FORK_REHEARSAL=1` runs the testnet
scripts against it, isolated from `.env` and `docs/deployments`. Found this way: the public
anvil dev addresses carry EIP-7702 delegations on Monad testnet, so an ERC-721 safe mint to
them reverts; the fork tests clear that code.
