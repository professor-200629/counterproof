"""Evaluator outcomes, evidence integrity and fail-closed behaviour."""

import copy

import pytest
from conftest import BUDGET_ATTACK, DUPLICATE_REQUEST, make_candidate, make_spec

from counterproof.canonical import digest
from counterproof.evaluator import recheck_bundle, seal, verify_seal
from counterproof.evaluator import evaluate as _evaluate


def evaluate(spec, d, cand, **sub):
    return _evaluate(spec=spec, spec_dgst=d, candidate=cand, submission=sub)


def test_valid_candidate_reproduces_the_reference_failure(spec_v1):
    spec, d = spec_v1
    b = evaluate(spec, d, make_candidate(d, BUDGET_ATTACK, "R1"))
    assert b["verdict"]["outcome"] == "verified_violation"
    assert b["verdict"]["reward_eligible"] is True
    assert len(b["replays"]) == 2
    assert b["replays"][0]["ledger_digest"] == b["replays"][1]["ledger_digest"]
    assert b["verdict"]["observed"]["total_settled"] == 38400
    assert any("INTENTIONALLY VULNERABLE" in x for x in b["limitations"])
    assert verify_seal(b)
    assert recheck_bundle(b, spec) == []


def test_repaired_adapter_resists_the_same_sequence(spec_v11):
    spec, d = spec_v11
    b = evaluate(spec, d, make_candidate(d, BUDGET_ATTACK, "R1"))
    assert b["verdict"]["outcome"] == "not_reproduced"
    assert b["verdict"]["reward_eligible"] is False


def test_wrong_claim_is_not_reproduced_even_if_another_rule_breaks(spec_v1):
    spec, d = spec_v1
    b = evaluate(spec, d, make_candidate(d, DUPLICATE_REQUEST, "R1"))
    assert b["verdict"]["outcome"] == "not_reproduced"
    assert "R3" in b["verdict"]["other_rules_violated"]
    assert b["verdict"]["reward_eligible"] is False


@pytest.mark.parametrize("mutate,needle", [
    (lambda c: c.update(extra_field=1), "Extra inputs"),
    (lambda c: c.update(challenge_spec_digest="sha256:" + "0" * 64), "different challenge"),
    (lambda c: c.update(claimed_rule="R9"), "not part of this challenge"),
    (lambda c: c.update(actions=[{"type": "ledger_write", "amount": 1}]), "actions"),
    (lambda c: c.update(actions=[{"type": "merchant_content", "sku": "SKU-PAPER-500", "text": "x"},
                                 {"type": "user_request", "request_id": "a", "sku": "SKU-PAPER-500", "qty": 1}]), "may not set content"),
    (lambda c: c.update(actions=[{"type": "user_request", "request_id": f"r{i}", "sku": "SKU-PAPER-500", "qty": 1} for i in range(9)]), "exceed"),
    (lambda c: c.update(actions=[{"type": "user_request", "request_id": "a", "sku": "SKU-NOPE", "qty": 1}]), "unknown SKU"),
    (lambda c: c.update(actions=[{"type": "user_request", "request_id": "a", "sku": "SKU-PAPER-500", "qty": 1, "ledger": []}]), "Extra inputs"),
    (lambda c: c.update(challenger="not-an-address"), "challenger"),
])
def test_malformed_submissions_never_replay(spec_v1, mutate, needle):
    spec, d = spec_v1
    c = make_candidate(d, BUDGET_ATTACK, "R1")
    mutate(c)
    b = evaluate(spec, d, c)
    assert b["verdict"]["outcome"] == "malformed_submission"
    assert b["replays"] == []
    assert b["verdict"]["reward_eligible"] is False
    assert any(needle in e for e in b["verdict"]["validation_errors"]), b["verdict"]["validation_errors"]


def test_candidate_must_match_its_onchain_commitment(spec_v1):
    spec, d = spec_v1
    from counterproof.spec import validate_candidate

    c = make_candidate(d, BUDGET_ATTACK, "R1")
    norm, errors = validate_candidate(c, spec, d)
    assert not errors
    committed = digest(norm)  # challengers commit to the normalised candidate
    assert committed != digest(c)  # (defaults are filled in by normalisation)
    b = evaluate(spec, d, c, candidate_digest="sha256:" + "ab" * 32)
    assert b["verdict"]["outcome"] == "malformed_submission"
    b = evaluate(spec, d, c, candidate_digest=committed, recipient="0x" + "44" * 20)
    assert b["verdict"]["outcome"] == "malformed_submission"
    ok = evaluate(spec, d, c, candidate_digest=committed, recipient=c["recipient"])
    assert ok["verdict"]["outcome"] == "verified_violation"
    assert ok["submission"]["candidate_digest"] == committed


def test_mismatched_target_version_is_refused(spec_v1):
    spec, _ = spec_v1
    forged = copy.deepcopy(spec)
    forged["target"]["artifact_digest"] = "sha256:" + "00" * 32
    d = digest(forged)
    b = evaluate(forged, d, make_candidate(d, BUDGET_ATTACK, "R1"))
    assert b["verdict"]["outcome"] == "runner_failure"
    assert any("artifact digest" in e for e in b["verdict"]["validation_errors"])
    assert b["replays"] == []


def test_mismatched_checker_version_is_refused(spec_v1):
    spec, _ = spec_v1
    forged = copy.deepcopy(spec)
    forged["checker"]["digest"] = "sha256:" + "00" * 32
    d = digest(forged)
    assert evaluate(forged, d, make_candidate(d, BUDGET_ATTACK, "R1"))["verdict"]["outcome"] == "runner_failure"


def test_isolation_failure_blocks_execution(monkeypatch):
    spec, d = make_spec(isolation="container")
    monkeypatch.setenv("COUNTERPROOF_DISABLE_ISOLATION", "container")
    b = evaluate(spec, d, make_candidate(d, BUDGET_ATTACK, "R1"))
    assert b["verdict"]["outcome"] == "runner_failure"
    assert "failing closed" in b["verdict"]["reason"]
    assert b["replays"] == []


def test_process_isolation_can_be_disabled_and_then_fails_closed(spec_v1, monkeypatch):
    spec, d = spec_v1
    monkeypatch.setenv("COUNTERPROOF_DISABLE_ISOLATION", "process")
    b = evaluate(spec, d, make_candidate(d, BUDGET_ATTACK, "R1"))
    assert b["verdict"]["outcome"] == "runner_failure" and b["replays"] == []


def tamper(b, fn):
    b = copy.deepcopy(b)
    fn(b)
    return b


def test_tampered_evidence_is_rejected(spec_v1):
    spec, d = spec_v1
    good = evaluate(spec, d, make_candidate(d, DUPLICATE_REQUEST, "R3"))
    assert recheck_bundle(good, spec) == []

    def edit_amount(b):
        ev = next(e for e in b["replays"][0]["ledger"] if e["type"] == "payment.settled")
        ev["data"]["amount"] = 1

    cases = [
        tamper(good, lambda b: b["verdict"].update(outcome="verified_violation", summary="edited")),  # seal broken
        seal(tamper(good, edit_amount)),  # resealed, but the ledger chain breaks
        seal(tamper(good, lambda b: b.update(claimed_rule="R1"))),  # checker re-run disagrees
        seal(tamper(good, lambda b: b["replays"].pop())),  # wrong replay count
        seal(tamper(good, lambda b: b["target"].update(artifact_digest="sha256:" + "0" * 64))),
    ]
    for bad in cases:
        assert recheck_bundle(bad, spec), "tampering was not detected"


def test_not_reproduced_bundle_cannot_be_promoted(spec_v11):
    spec, d = spec_v11
    b = evaluate(spec, d, make_candidate(d, BUDGET_ATTACK, "R1"))
    promoted = seal(tamper(b, lambda x: x["verdict"].update(outcome="verified_violation", reward_eligible=True)))
    problems = recheck_bundle(promoted, spec)
    assert any("checker re-run" in p for p in problems)
