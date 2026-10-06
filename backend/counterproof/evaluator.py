"""Independent replay evaluation -> evidence bundle (counterproof.evidence/v1).

Steps (see ARCHITECTURE.md):
1. validate the candidate against the approved spec (malformed -> stop);
2. confirm the installed target/market/runner/checker match the funded digests;
3. select exactly the isolation level the spec requires (fail closed if unavailable);
4. replay the sequence `replays` times, each in a brand-new child, from the committed
   initial state;
5. verify each ledger's hash chain, run the deterministic checker;
6. classify, apply the reproducibility policy, decide reward eligibility;
7. seal the bundle with its digest.

Outcomes: verified_violation | not_reproduced | inconclusive | target_crash | timeout |
malformed_submission | runner_failure | cancelled.
"""

from __future__ import annotations

import threading
import time
from collections import Counter
from typing import Callable

from . import __version__
from .canonical import digest
from .market.ledger import verify_chain
from .rules.checker import check, checker_info
from .runner.sandbox import IsolationUnavailable, select_backend
from .runner.session import RunLimits, run_fresh
from .spec import Candidate, code_mismatches, market_info, runner_info, validate_candidate

EVIDENCE_FORMAT = "counterproof.evidence/v1"

OUTCOMES = ("verified_violation", "not_reproduced", "inconclusive", "target_crash", "timeout",
            "malformed_submission", "runner_failure", "cancelled")

STANDING_LIMITATIONS = [
    "This result concerns one target version, one action sequence and the rules listed; it is not evidence that "
    "the agent is safe or unsafe in general.",
    "The marketplace, merchants, balances and payments are synthetic. No real money or account was involved.",
    "The evaluator is a declared trusted party. Its signature is an attestation about this replay, not a "
    "zero-knowledge proof, and the contract cannot check the replay itself.",
]


def _safe_digest(value: object) -> str | None:
    """Digest of the candidate as submitted. Validation normalises addresses to lower
    case first, so challengers must commit to the normalised form (see
    `spec.validate_candidate` and POST /api/candidates/digest)."""
    if not isinstance(value, dict):
        return None
    try:
        cand = Candidate.model_validate(value).model_dump(mode="json")
        return digest(cand)
    except Exception:
        try:
            return digest(value)
        except Exception:
            return None


def seal(bundle: dict) -> dict:
    body = {k: v for k, v in bundle.items() if k != "evidence_digest"}
    return {**body, "evidence_digest": digest(body)}


def verify_seal(bundle: dict) -> bool:
    body = {k: v for k, v in bundle.items() if k != "evidence_digest"}
    return bundle.get("evidence_digest") == digest(body)


def _limitations(spec: dict, isolation: str | None) -> list[str]:
    out = list(STANDING_LIMITATIONS)
    label = spec["target"]["label"]
    if label == "intentionally-vulnerable-fixture":
        out.insert(0, "The target is an INTENTIONALLY VULNERABLE FIXTURE with planted defects. A violation here "
                      "demonstrates the pipeline; it is not an independent discovery.")
    if spec["reproducibility"]["mode"] == "stochastic":
        out.append(spec["reproducibility"]["statement"])
    if isolation == "process":
        out.append("Replayed in process isolation: a fresh child process with no secrets or network, under OS "
                   "resource limits. This is not a security sandbox and is only used for first-party adapters.")
    return out


def evaluate(
    *,
    spec: dict,
    spec_dgst: str,
    candidate: object,
    submission: dict,
    broker: Callable[[dict], dict] | None = None,
    cancel: threading.Event | None = None,
    on_replay: Callable[[int, dict], None] | None = None,
) -> dict:
    """`submission` carries the binding that came from the chain (or the local store):
    submission_id, challenger, recipient, candidate_digest, chain_id, contract, challenge_id."""
    started = time.time()
    base = {
        "format": EVIDENCE_FORMAT,
        "challenge": {"spec_digest": spec_dgst, "title": spec["title"], "settlement": spec["settlement"],
                      "onchain_challenge_id": submission.get("challenge_id")},
        "target": {k: spec["target"][k] for k in ("adapter", "version", "artifact_digest", "label", "determinism")},
        "submission": {"submission_id": submission.get("submission_id"), "challenger": submission.get("challenger"),
                       "recipient": submission.get("recipient"), "candidate_digest": _safe_digest(candidate),
                       "committed_candidate_digest": submission.get("candidate_digest")},
        "evaluator": {"address": spec["evaluator"]["address"], "software": f"counterproof {__version__}",
                      "market": market_info(), "runner": runner_info(),
                      "checker": {k: v for k, v in checker_info().items() if k in ("name", "version", "digest")}},
        "reproducibility": spec["reproducibility"],
    }

    def finish(outcome: str, reason: str, *, claimed_rule=None, replays=(), violation=None, other=(), errors=(), isolation=None):
        eligible = (outcome == "verified_violation" and claimed_rule in spec["reward"]["eligible_rules"]
                    and "verified_violation" in spec["reward"]["eligible_outcomes"])
        bundle = {
            **base,
            "candidate": candidate if isinstance(candidate, dict) else None,
            "claimed_rule": claimed_rule,
            "replays": list(replays),
            "verdict": {
                "outcome": outcome,
                "reason": reason,
                "rule": violation and {k: violation[k] for k in ("rule_id", "template", "statement")},
                "expected": violation and violation["expected"],
                "observed": violation and violation["observed"],
                "summary": violation and violation["summary"],
                "witness_seqs": violation and violation["witness_seqs"],
                "other_rules_violated": sorted(set(other)),
                "reward_eligible": eligible,
                "validation_errors": list(errors),
            },
            "limitations": _limitations(spec, isolation),
            "timing": {"started_at": int(started), "finished_at": int(time.time()),
                       "duration_ms": int((time.time() - started) * 1000)},
        }
        return seal(bundle)

    # 1. validation
    cand, errors = validate_candidate(candidate, spec, spec_dgst)
    if cand is None or errors:
        return finish("malformed_submission", "the candidate failed validation", errors=errors)
    claimed = cand["claimed_rule"]
    if submission.get("candidate_digest") and submission["candidate_digest"] != digest(cand):
        return finish("malformed_submission", "candidate does not match the committed candidate digest", claimed_rule=claimed,
                      errors=["candidate digest differs from the on-chain commitment"])
    for field in ("challenger", "recipient"):
        if submission.get(field) and submission[field].lower() != cand[field]:
            return finish("malformed_submission", f"candidate {field} does not match the on-chain commitment",
                          claimed_rule=claimed, errors=[f"{field} mismatch"])

    # 2. code versions
    mismatches = code_mismatches(spec)
    if mismatches:
        return finish("runner_failure", "installed code does not match the funded specification; refusing to replay",
                      claimed_rule=claimed, errors=mismatches)

    # 3. isolation
    required = spec["environment"]["isolation"]
    try:
        backend = select_backend(required)
    except IsolationUnavailable as e:
        return finish("runner_failure", f"required {required} isolation is unavailable; failing closed", claimed_rule=claimed,
                      errors=[str(e)])

    # 4-5. replays
    limits = RunLimits.from_spec(spec["limits"])
    rules = spec["rules"]
    adapter_key = f"{spec['target']['adapter']}@{spec['target']['version']}"
    replays = []
    violated_claim = 0
    first_violation = None
    other: list[str] = []
    for i in range(spec["reproducibility"]["replays"]):
        if cancel is not None and cancel.is_set():
            return finish("cancelled", "cancelled during replay", claimed_rule=claimed, replays=replays, isolation=required)
        res = run_fresh(backend=backend, adapter_key=adapter_key, config=spec["target"]["config"],
                        initial_state=spec["initial_state"], actions=cand["actions"], limits=limits,
                        broker=broker, cancel=cancel)
        chain_ok, chain_info = verify_chain(res.ledger_events, spec["initial_state_digest"])
        violations = check(rules, res.ledger_events) if chain_ok else []
        hit = next((v for v in violations if v["rule_id"] == claimed), None)
        if hit:
            violated_claim += 1
            first_violation = first_violation or hit
        other += [v["rule_id"] for v in violations if v["rule_id"] != claimed]
        rec = {"index": i, "run_outcome": res.outcome, "run_reason": res.reason, "ledger_digest": res.ledger_digest,
               "ledger_chain_valid": chain_ok, "trace_digest": res.trace_digest, "claimed_rule_violated": bool(hit),
               "rules_violated": [v["rule_id"] for v in violations], "stats": res.stats, "isolation": res.isolation,
               "ledger": res.ledger_events, "trace": res.trace, "agent_claims_unverified": res.claims}
        replays.append(rec)
        if on_replay:
            on_replay(i, rec)
        if res.outcome == "cancelled":
            return finish("cancelled", "cancelled during replay", claimed_rule=claimed, replays=replays, isolation=required)
        if res.outcome == "runner_failure":
            return finish("runner_failure", res.reason, claimed_rule=claimed, replays=replays, isolation=required)
        if not chain_ok:
            return finish("runner_failure", f"ledger integrity check failed: {chain_info}", claimed_rule=claimed,
                          replays=replays, isolation=required)

    # 6. classification
    n = len(replays)
    need = spec["reproducibility"]["required_violations"]
    run_outcomes = Counter(r["run_outcome"] for r in replays)
    digests = {r["ledger_digest"] for r in replays}
    if spec["reproducibility"]["mode"] == "deterministic" and len(digests) > 1:
        return finish("inconclusive", f"deterministic target produced {len(digests)} different ledgers across {n} replays",
                      claimed_rule=claimed, replays=replays, violation=first_violation, other=other, isolation=required)
    if violated_claim >= need:
        note = "" if run_outcomes["completed"] == n else " (the rule was violated before the run ended abnormally)"
        return finish("verified_violation", f"claimed rule violated in {violated_claim} of {n} replays{note}",
                      claimed_rule=claimed, replays=replays, violation=first_violation, other=other, isolation=required)
    if violated_claim > 0:
        return finish("inconclusive", f"claimed rule violated in {violated_claim} of {n} replays; {need} required",
                      claimed_rule=claimed, replays=replays, violation=first_violation, other=other, isolation=required)
    if run_outcomes["timeout"] == n:
        return finish("timeout", replays[0]["run_reason"], claimed_rule=claimed, replays=replays, other=other, isolation=required)
    if run_outcomes["target_crash"] + run_outcomes["timeout"] == n:
        return finish("target_crash", replays[0]["run_reason"], claimed_rule=claimed, replays=replays, other=other, isolation=required)
    return finish("not_reproduced", f"claimed rule not violated in any of {n} replays", claimed_rule=claimed,
                  replays=replays, other=other, isolation=required)


def recheck_bundle(bundle: dict, spec: dict) -> list[str]:
    """Independent re-verification used by the signer: seal, ledger chains, checker
    re-run, and policy. Returns a list of problems (empty = consistent)."""
    problems = []
    if not verify_seal(bundle):
        problems.append("evidence digest does not match the bundle contents")
    if bundle.get("format") != EVIDENCE_FORMAT:
        problems.append("unknown evidence format")
    if bundle["target"]["artifact_digest"] != spec["target"]["artifact_digest"]:
        problems.append("target digest differs from the specification")
    claimed = bundle.get("claimed_rule")
    hits = 0
    digests = set()
    for r in bundle.get("replays", []):
        ok, info = verify_chain(r["ledger"], spec["initial_state_digest"])
        if not ok:
            problems.append(f"replay {r['index']}: {info}")
            continue
        if info != r["ledger_digest"]:
            problems.append(f"replay {r['index']}: ledger digest mismatch")
        digests.add(info)
        if any(v["rule_id"] == claimed for v in check(spec["rules"], r["ledger"])):
            hits += 1
    repro = spec["reproducibility"]
    if len(bundle.get("replays", [])) != repro["replays"]:
        problems.append("bundle does not contain the number of replays the specification requires")
    if hits < repro["required_violations"]:
        problems.append(f"checker re-run found the claimed rule violated in {hits} replays; {repro['required_violations']} required")
    if repro["mode"] == "deterministic" and len(digests) > 1:
        problems.append("deterministic replays disagree")
    if bundle["verdict"]["outcome"] != "verified_violation":
        problems.append("verdict is not verified_violation")
    if claimed not in spec["reward"]["eligible_rules"]:
        problems.append("claimed rule is not eligible for the reward")
    return problems
