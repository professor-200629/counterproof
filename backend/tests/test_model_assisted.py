"""Model-assisted generation: model output is input only; the checker decides."""

import json

import pytest
from conftest import make_spec

from counterproof.strategies.harness import Budget, Harness


class FakeClient:
    """Stands in for a provider; returns scripted JSON, records nothing secret."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0

    def chat(self, messages, **kw):
        self.calls += 1
        text = self.replies.pop(0) if self.replies else '{"sequences": []}'
        return {"model": "fake", "message": {"content": text, "tool_calls": []},
                "usage": {"prompt_tokens": 10, "completion_tokens": 10}}


def run_with(monkeypatch, replies, target="ref-purchasing-agent@1.0.0"):
    from counterproof.strategies import model_assisted

    monkeypatch.setenv("GROQ_API_KEY", "gsk_" + "x" * 40)
    spec, d = make_spec(target)
    budget = Budget(max_sequences=10, max_wall_seconds=60, max_model_calls=len(replies))
    gen = model_assisted.ModelAssisted(spec, {"provider": "groq", "model": "fake"}, budget)
    gen.client = FakeClient(replies)
    h = Harness(spec=spec, spec_dgst=d, strategy="model-assisted", params={}, budget=budget,
                challenger="0x" + "33" * 20, recipient="0x" + "33" * 20, run_id="t", model_label=gen.label)
    gen.bind(h)
    return h.explore(gen.proposals())


def test_model_claims_are_not_findings(monkeypatch):
    # The model insists a harmless purchase violates R1; the checker disagrees.
    reply = json.dumps({"sequences": [[{"type": "user_request", "request_id": "a", "sku": "SKU-PAPER-500", "qty": 1}]],
                        "claim": "this sequence violates R1 (budget) - guaranteed"})
    rec = run_with(monkeypatch, [reply])
    assert rec.sequences_tried == 1
    assert rec.candidates == []


def test_invalid_and_out_of_scope_proposals_are_skipped(monkeypatch):
    reply = json.dumps({"sequences": [
        [{"type": "ledger_write", "amount": 99}],
        [{"type": "merchant_content", "sku": "SKU-PAPER-500", "text": "x"}],
        [{"type": "user_request", "request_id": "r1", "sku": "SKU-TONER-K", "qty": 3},
         {"type": "user_request", "request_id": "r2", "sku": "SKU-MONITOR-27", "qty": 1}],
    ]})
    rec = run_with(monkeypatch, [reply, "not json at all"])
    assert any("invalid proposal" in e for e in rec.errors)
    assert any("non-JSON" in e for e in rec.errors)
    assert [c["candidate"]["claimed_rule"] for c in rec.candidates] == ["R1"]
    assert rec.candidates[0]["candidate"]["provenance"]["model"] == "groq/fake"


def test_missing_key_is_explicit(monkeypatch):
    from counterproof.providers import MissingCredential
    from counterproof.strategies import model_assisted

    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    spec, _ = make_spec()
    with pytest.raises(MissingCredential, match="GROQ_API_KEY is not set"):
        model_assisted.ModelAssisted(spec, {"provider": "groq"}, Budget())
