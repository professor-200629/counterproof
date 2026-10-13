# Threat model

Scope: the hackathon MVP running one evaluator, a closed set of first-party target
adapters, a synthetic marketplace, and a reward contract on Monad Testnet (or local anvil).

## Assets

| Asset | Why it matters |
|---|---|
| Escrowed rewards | Real (testnet) value held by the contract |
| Evaluator signing key | Can authorise payouts for any committed submission of its challenges |
| Integrity of verdicts | A false "verified violation" pays the wrong party; a false "not reproduced" withholds a deserved reward |
| Challenge terms | Publishers and challengers rely on immutable, inspectable terms |
| Host machine | Targets and strategies execute code on it |
| Provider API keys | Billable live-model access |

## Actors

Publisher (wants no payout, might under-fund or change terms), challenger (wants a payout,
may submit hostile data), target developer (may ship a target that hides violations),
relayer/front-runner (sees attestations in the mempool), compromised API or worker
process, curious users of the web UI.

## Attacks and mitigations

| # | Attack | Mitigation | Test |
|---|---|---|---|
| 1 | Change terms after funding | Spec digest funded on chain; specs immutable and content-addressed; any change is a new spec with `supersedes`; contract has no setters | `test_api_flow` (regression spec), forge tests |
| 2 | Replay old evidence against new code | Spec binds target/market/runner/checker digests; evaluator and signer refuse on mismatch | `test_mismatched_target_version_is_refused`, `..._checker_...` |
| 3 | Challenger writes the ledger or checker state | Actions are closed-schema data (`extra=forbid`); only the parent market appends ledger events; merchant text is stored as data | `test_merchant_text_shaped_like_ledger_events_stays_data`, malformed tests |
| 4 | Target claims success it did not achieve, or fakes ledger entries | Checker reads only the parent's ledger; agent claims stored as unverified; unknown tools refused | `test_checker_ignores_agent_claims_and_reads_only_the_ledger` |
| 5 | Tampered evidence bundle | Bundle sealed with its digest; ledgers hash-chained to the initial-state digest; signer re-runs checks and replays | `test_tampered_evidence_is_rejected`, `test_ledger_tampering_is_detected` |
| 6 | Hostile target exhausts the host | Per-replay memory, CPU, wall-clock, tool-call and output limits; one process; kill on close | `test_sandbox.py` |
| 7 | Target exfiltrates secrets | Child gets an empty environment; provider keys stay in the broker; socket guard (process) / no network (container) | `test_target_environment_has_no_secrets`, `test_target_has_no_network` |
| 8 | Isolation silently degraded | Spec names the level; unavailable level → `runner_failure`, no fallback | `test_isolation_failure_blocks_execution` |
| 9 | Same finding paid twice | One evaluation per (challenge, candidate digest); signer refuses a second attestation per challenge; contract settles once | `test_create_challenge_search_replay_regress_export`, chain tests |
| 10 | Front-running redirects the reward | Recipient bound at commit and inside the signature; anyone may relay but cannot change it | `test_valid_attestation_settles_to_the_bound_recipient_even_when_relayed` |
| 11 | Signature replay across chains/contracts/challenges | EIP-712 domain has chain id and contract; message has challenge, spec, submission, candidate | `test_cross_chain_and_cross_contract_signatures_are_rejected`, forge tests |
| 12 | Copying a committed digest | `submissionId` includes the committer; the evaluator binds challenger and recipient from the chain; salted candidate | forge tests (copied digest) |
| 13 | Publisher reclaims funds while a payout is valid | Refund only after the settlement deadline; settlement only until it | `test_refund_only_after_the_settlement_window`, forge tests |
| 14 | Recipient contract blocks payment | Pull payments; settlement never transfers | forge tests (reverting recipient) |
| 15 | Reentrancy | `ReentrancyGuardTransient` on settle/refund/withdraw; checks-effects-interactions | forge tests (reentrant recipient) |
| 16 | API process compromise obtains signatures | Evaluator key only in the signer (role-based `.env` loading); signer re-verifies, replays, reads the chain | `test_each_role_loads_only_its_secrets` |
| 16a | Compromised API/worker forges self-consistent evidence (fabricated ledgers, recomputed hash chains, resealed) - passes `recheck_bundle` | The signer never signs worker evidence: for every target, deterministic or live-model, it replays the committed candidate (loaded by the on-chain digest) itself with the spec's k-of-n policy and its own model broker, and signs the digest of its own bundle | `test_forged_stochastic_bundle_passes_the_pure_validator`, `test_forged_stochastic_bundle_is_refused_by_the_signer` (reproduced as signed before the fix) |
| 16b | Expired attestation strands a valid finding / renewal re-signs something else | Renewal re-reads the chain (funded, inside the window), re-checks the signer's stored evidence and its binding, and re-signs the same message with only the expiry changed; refused after settlement, refund or the deadline | `test_expired_attestation_is_renewed_up_to_the_settlement_deadline`, `test_renewal_refused_*`, `test_signer_renewal_settles_after_the_original_expired` (anvil) |
| 16c | Two submissions race for one challenge | Per-challenge lock and `BEGIN IMMEDIATE`; one verification per challenge at a time; one signed row per challenge | `test_two_submissions_racing_for_one_challenge_attest_exactly_one` |
| 16d | Compromised API/worker writes the signer's database (`signer.sqlite` is in the shared `COUNTERPROOF_DATA_DIR`, same OS user in the shipped launchers) to plant a 'verified' row and an expired 'signed' row over forged evidence, so a renewal re-signs it without any replay | A stored attestation is used only if its signature recovers to the evaluator key over exactly the stored message (else 409); a renewal also needs the 'verified' row's HMAC under a key derived from the evaluator key, written only after the signer's own replay. A row without it is treated as legacy (returned while usable, re-verified independently once expired), so a planted row next to a genuine pre-fix signature cannot be renewed either. Residual: whoever can write the file can delete or alter rows (denial of service; `attestation_history` is not tamper-evident) but cannot obtain a signature | `test_planted_signer_rows_cannot_renew_forged_evidence` (renewed with a genuine signature before the fix), `test_planted_verified_row_cannot_renew_a_legacy_signature_blindly`, `test_verified_row_without_the_signers_mac_is_reverified_not_renewed` |
| 17 | Secrets leak into logs or responses | Redaction of known secret values/patterns; API never returns env; e2e scripts strip secrets from child envs | `test_redaction`, API secret checks |
| 18 | LLM decides a payout | Model output only proposes sequences or drives the target's tool calls; outcomes come from the checker | design; model-assisted provenance records digests |
| 19 | Browser lies about a transaction | API accepts only a hash and reads the receipt/events from the chain | `chain.verify_funding`, `verify_tx` |
| 20 | Interrupted jobs shown as live | Heartbeats; stale jobs requeued or failed with "interrupted" | `test_interrupted_jobs_are_recovered_after_restart` |
| 21 | A publisher pins a violation on someone else's ERC-8004 agent | Feedback only for an agent whose own registration file declares the funded target's artifact digest | `test_reporter_refuses_an_agent_that_declares_different_code` (fork) |
| 22 | Reputation feedback without a real settlement, or with swapped evidence | Reporter reads the challenge status, spec digest and the `ChallengeSettled` evidence digest from chain and re-verifies the bundle | `test_reporter_refuses_self_feedback_and_unsettled_or_tampered_results` (fork) |
| 23 | Self-review | ERC-8004 forbids feedback from the agent's owner/operator; the reporter is a separate key and checks `isAuthorizedOrOwner` first | same |
| 24 | A rehearsal mistaken for Monad testnet | Fork rehearsals write only under `data/fork-rehearsal/`, never `.env` or `docs/deployments`; the API labels the network "FORK REHEARSAL"; the snapshot exporter refuses it | `scripts/testnet.py`, `scripts/export_snapshot.py` |

## Residual risks (accepted for the MVP, stated plainly)

- **The evaluator is trusted.** A compromised or dishonest evaluator key can authorise a
  payout to any submission committed to its challenges. Mitigations are operational
  (separate signer process, independent re-verification); there is no on-chain dispute.
- **Process isolation is not a sandbox.** It is acceptable only because targets are
  first-party adapters and challenger input is data. Container isolation is implemented but
  unverified on the development machine. Neither is a guarantee against arbitrary hostile
  code; there is no public code-upload path.
- **Concurrent discoveries are not perfectly fair.** The first eligible settlement wins;
  the evaluator processes submissions in order but ordering is evaluator-mediated.
- **Live-model results are statistical.** They depend on the provider, the model and the
  date, and can change without notice.
- **Search coverage is bounded.** "No violation found" reports the budget explored; it does
  not mean the agent is safe.
- **Single machine.** SQLite and local processes; no high availability.
- **Testnet only.** No mainnet assets; dedicated testnet keys in a git-ignored `.env`.
- **ERC-8004 feedback is reviewer-attested.** It is as trustworthy as the reporter key and
  the evaluator behind it; a reader who does not trust the reporter address should ignore it.
  The agent-to-code binding is the agent owner's own declaration.
- **Signer token** is a shared secret on localhost; anyone with local access to the
  machine and the `.env` can request attestations (which the signer still re-verifies).
