# Architecture

CounterProof turns a promise about an AI purchasing agent into a funded, replayable test.
This document describes the components, the data flow and the trust boundaries.

## Components

```
 browser (Next.js console, wagmi)            Monad Testnet / local anvil
   │  /api (same-origin proxy)                 ▲            ▲
   ▼                                           │ verify     │ fund / settle / withdraw / refund
 API (FastAPI) ───── SQLite (WAL) ─────── Worker            │ (wallet signs; API only reads receipts)
   │  content-addressed artifacts            │  search runs, evaluations, regressions
   │                                          ▼
   │                              Runner (parent, trusted)  ── Market + hash-chained Ledger + Checker
   │                                          │ line-delimited JSON over stdin/stdout
   │                                          ▼
   │                              Target host (child: process or container, untrusted)
   │                                          └─ one adapter from a closed registry
   ▼
 Signer (separate process, the only holder of the evaluator key)
   reads the chain, loads the committed candidate by its on-chain digest, re-runs the
   spec's k-of-n itself (own model broker, own checker), signs EIP-712 over ITS OWN evidence
```

| Component | Code | Responsibility |
|---|---|---|
| Challenge spec | `backend/counterproof/spec.py` | Canonical, versioned terms; digest = what is funded |
| Market + ledger | `backend/counterproof/market/` | Synthetic marketplace; append-only hash-chained ledger of effects |
| Rule templates + checker | `backend/counterproof/rules/` | Five explicit templates; pure function ledger → violations |
| Runner | `backend/counterproof/runner/` | Fresh child per replay; limits; protocol; isolation backends |
| Targets | `backend/counterproof/targets/` | Closed registry, all written by the CounterProof team: `ref-purchasing-agent` 1.0.0 (intentionally vulnerable fixture) and 1.1.0 (repaired fixture); `llm-purchasing-agent` 0.1.1 (live model, no planted defects) and 0.2.0 (capability-enforced repair) |
| Strategies | `backend/counterproof/strategies/` | Sequence explorer, merchant-content, retry/replay, model-assisted generator |
| Evaluator | `backend/counterproof/evaluator.py` | Validate → version check → isolation → replays → classify → sealed evidence |
| Jobs + worker | `jobs.py`, `worker.py` | Durable queue, heartbeats, cancellation, restart recovery |
| API | `api.py`, `services.py`, `chain.py` | HTTP surface, state machines, chain reads, challenger bot commits |
| Signer | `signer.py` | Independent k-of-n verification of the committed candidate, EIP-712 attestation over its own evidence, renewal, audit history |
| Model-proposal record | `providers.py` (`RecordingBroker`) | What the model proposed per replay, observed by the evaluator's broker; stored alongside (not inside) the sealed bundle |
| Regression | `regression.py`, `services.py` | Same-family replays of a verified counterexample; JSON + pytest export that re-executes the agent (recorded model proposals stand in for the model) |
| Auth and limits | `auth.py`, `limits.py` | Operator bearer / judge cookie sessions, CSRF + Origin, budget caps, queue and token ceilings, operator stop |
| Evidence re-check | `scripts/verify_evidence.py` | Offline seals/ledgers/checker re-run; optional read-only chain and ERC-8004 comparison |
| Contract | `contracts/src/CounterProofBounties.sol` | Escrow, commitments, signature-checked settlement, pull payouts, refunds |
| Console | `web/` | Evidence-first UI, wallet flows |
| ERC-8004 link | `erc8004.py`, `scripts/testnet.py` | Agent identity (publisher) and reputation feedback (reporter) on the official ERC-8004 registries |

### ERC-8004 (Trustless Agents)

CounterProof writes its verified results into the official ERC-8004 registries on Monad
testnet (IdentityRegistry `0x8004A818…BD9e`, ReputationRegistry `0x8004B663…8713`, from the
`erc-8004/erc-8004-contracts` README):

1. **Identity.** The publisher registers each reference agent. Its registration file is a
   `data:` URI stored on chain and declares `counterproof.target` and
   `counterproof.artifactDigest`: the owner's own statement of which code that agent is.
2. **Reputation.** After `ChallengeSettled`, a dedicated reporter key (not the evaluator, not
   the publisher) calls `giveFeedback(agentId, 1, 0, "counterproof.verifiedViolation", <rule>,
   <console URL>, <feedback file data: URI>, keccak256(file))`. Before sending, it re-checks on
   chain that the challenge is settled with the funded spec digest, takes the evidence digest
   from the `ChallengeSettled` event, re-verifies the sealed evidence bundle, and refuses
   unless the agent's declared artifact digest equals the spec's target digest.
3. **Reading it.** Anyone can call `readFeedback(agentId, reporter, index)` or
   `getSummary(agentId, [reporter], "counterproof.verifiedViolation", "")`; the feedback
   file names the bounties contract, challenge, spec, submission, evidence and settle
   transaction so every statement can be checked against the chain.

Feedback is a statement by a declared reviewer, which is how ERC-8004 reputation works:
readers choose which client addresses they trust. CounterProof does not use the ERC-8004
Validation Registry, which has no official deployment on Monad.

## Data flow

1. **Create.** The publisher picks a target adapter and rule templates and approves exact
   parameters. `spec.build_spec` fills every default *before* hashing, binding the target
   artifact digest, the market/runner/checker digests, the full initial state, the scope,
   limits, reproducibility policy, evaluator, deadlines, reward and settlement contract.
   Preview and create share one code path, so the reviewed digest is the funded digest.
2. **Fund.** The wallet calls `createChallenge(specDigest, evaluator, deadlines)` with the
   reward. The API reads the receipt and the `ChallengeCreated` event and checks every
   value against the stored spec before marking the challenge funded.
3. **Challenge.** Strategies propose action sequences. The harness runs them against the
   target in the challenger's own sandbox, checks the rules locally and shrinks hits to a
   minimal sequence. A hit is a *candidate*, never a finding.
4. **Commit.** The candidate is normalised and hashed (with a random salt). The challenger
   commits `candidateDigest` and a payout recipient on chain before the submission
   deadline. `submissionId = keccak256(chainid, contract, challengeId, challenger, digest)`.
5. **Replay.** The evaluator validates the candidate against the spec, refuses if installed
   code digests differ from the funded ones, selects exactly the required isolation level
   (fails closed otherwise), and replays the sequence `replays` times, each in a brand-new
   child from the committed initial state. It verifies each ledger's hash chain and runs
   the checker over the ledger only.
6. **Classify.** Deterministic targets must violate the claimed rule on every replay with an
   identical ledger digest; stochastic (live-model) targets need *k* of *n*. Outcomes:
   `verified_violation`, `not_reproduced`, `inconclusive`, `target_crash`, `timeout`,
   `malformed_submission`, `runner_failure`, `cancelled`. Only `verified_violation` of an
   eligible rule is reward-eligible. The evidence bundle is sealed with its own digest.
7. **Attest.** The evaluation job queues an `attestation` job, which asks the signer and
   polls it. The signer trusts nothing the API or worker produced (their evaluation id and
   evidence digest are recorded as provenance only). It reads the challenge and submission
   from the chain first, loads the funded spec and the *committed* candidate by their
   on-chain digests, and runs its own `evaluate()` - the spec's k-of-n policy, fresh
   isolated children, the deterministic checker, and (for live-model targets) a model broker
   inside the signer process. It signs only if its own bundle is a reward-eligible
   verified violation bound to the on-chain submission, and the signed `evidenceDigest` is
   the digest of that bundle, which it stores for the API to serve. A live-model
   verification takes minutes, so it runs in the background (`202 verifying`); provider
   failures are `failed` (retryable, never a verdict). It refuses a second attestation for
   the challenge, and signs `Attestation(challengeId, specDigest, submissionId,
   candidateDigest, evidenceDigest, challenger, recipient, verdict, expiry)` under the
   EIP-712 domain `CounterProof / 1 / chainId / contract`. An attestation lives at most an
   hour and never past the settlement deadline; while the window is open it can be
   **renewed**: the signer re-reads the chain, re-checks its stored evidence and signs the
   same message with only a later expiry (no new replay). Every signature is kept in the
   signer's audit history.
8. **Settle.** Anyone relays `settle(attestation, signature)`. The contract checks the
   evaluator signature, the commitment, the spec digest, the deadline and the expiry, then
   credits the *bound* recipient. The recipient withdraws (pull payment). After the
   settlement window an unsettled challenge is refundable to the publisher.
9. **Patch → retest → export.** The same action sequence is rebound to a new spec version
   for the repaired adapter (`supersedes` = old digest, `revision` + 1) and replayed. The
   sequence is exported as `counterproof.regression/v1` JSON and as a pytest file.

## Determinism and what a result means

- **Deterministic adapters** (reference agents): the target, market and checker are
  deterministic, the child runs with `PYTHONHASHSEED=0`, and the evaluator requires
  identical ledger digests across replays. A verified violation means: *this target
  version, given this exact sequence from this initial state, produced ledger effects that
  violate this rule, every time.*
- **Live-model adapters**: a hosted model is not deterministic, and a seed does not make it
  so. The spec states a *k-of-n* policy (default 2 of 3). A verified violation means: *the
  violation occurred in at least k of n fresh replays against this provider/model on this
  date.* It is statistical evidence, labelled as such.
- **No violation found** always carries the tested version, the rules, the number of
  sequences tried, the search budget, the termination reason and the limitations. It is
  not proof of safety.

## Trust boundaries

| Boundary | Trusted side | Untrusted side | Mechanism |
|---|---|---|---|
| Target ↔ evaluator | runner, market, ledger, checker (parent) | target adapter (child) | separate process/container; tool calls only; ledger never in the child |
| Challenger ↔ evaluator | evaluator | candidate (data) | closed action schema (`extra=forbid`), scope checks, digest binding |
| Model ↔ evaluator | model broker (parent) | model output | broker fixes model/budget; output only drives the target's tool calls |
| Evaluator ↔ chain | contract | everyone | signature over chain id + contract + all bindings; pull payments |
| API/worker ↔ signer | signer | API/worker (incl. their artifacts and the shared data dir) | separate process; the signer re-executes the committed candidate itself and never signs worker evidence; it never turns its own database rows into a signature without re-checking them; key never leaves the signer |
| Browser ↔ API | API | browser | mutations need an operator bearer or a judge session (cookie + CSRF + Origin); server-side budget caps; API accepts only tx hashes and reads values from receipts of the configured contract |

The evaluator itself is a **declared trusted party**. The contract cannot check a replay;
it checks that the declared evaluator signed these exact bindings. This is an
attestation, not a zero-knowledge proof, and the system is not trustless.

## Digest pins and historical reproduction

A funded spec pins the digests of the target adapter (its module plus the shared host/protocol
files), the market, the runner (including `evaluator.py`) and the checker. A replay refuses to
run when the installed code differs (`spec.code_mismatches`). Adding `llm-purchasing-agent@0.2.0`
required one new row in `runner/host.py` (the closed table of hosted adapters), which is part of
every adapter's digest. Specs funded before that change (the Monad testnet challenges of
2026-10-11) therefore re-run only from git tag `testnet-2026-10-11` (`51c0832`). Their recorded
evidence can still be re-checked from any commit, because seals, ledgers and the checker do not
depend on the adapter files.

## Isolation

- `process` (default here): fresh child Python process; empty environment (no secrets);
  socket guard; Windows Job Object (memory, CPU time, one process, kill-on-close) or POSIX
  rlimits; scratch directory removed afterwards. **Not a security sandbox** — offered only
  for first-party adapters from the closed registry, whose inputs are validated data.
- `container`: `docker run --network none --read-only --tmpfs /tmp --user 10001
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 32 --memory --cpus`,
  removed after use and swept on worker start. Implemented but **not verified on this
  machine** (the Docker engine does not start here).
- A spec names one level. If it is unavailable the evaluator returns `runner_failure`
  ("failing closed") and never downgrades silently. There is no upload path for arbitrary
  target code.

## Storage

- SQLite (`data/<mode>/counterproof.db`, WAL) with numbered migrations in
  `backend/counterproof/migrations/`.
- Content-addressed artifacts (`data/<mode>/artifacts/<sha256>.json`): specs, candidates,
  evidence bundles. Every read re-checks the digest.
- On chain: only digests, deadlines, the evaluator address, commitments and settlement.
