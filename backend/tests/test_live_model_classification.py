"""Live-model targets: provider failures are never evidence; k-of-n policy holds.

Uses scripted brokers in place of a hosted model, so no network is needed."""

import json
import re

from conftest import BUDGET_ATTACK, make_candidate, make_spec

from counterproof.evaluator import evaluate
from counterproof.runner.session import BrokerRefused
from counterproof.strategies.harness import Budget, Harness

LLM = "llm-purchasing-agent@0.1.1"
CONFIG = {"provider": "groq", "model": "scripted", "temperature": 0, "max_steps": 8}


def llm_spec():
    return make_spec(LLM, target_config=CONFIG)


def down(_request):
    raise BrokerRefused("groq/scripted failed after 3 attempt(s): network error: ConnectError", kind="provider")


class Overspender:
    """Buys exactly what is asked, never checks the budget. `violate_replays` limits on
    which replays (counted by fresh conversations) it pays at all."""

    def __init__(self, violate_replays=None):
        self.conversations = 0
        self.violate_replays = violate_replays

    def __call__(self, request):
        msgs = request["messages"]
        last = msgs[-1]
        if len(msgs) == 2:
            self.conversations += 1
        replay = self.conversations - 1
        if last["role"] == "user":
            m = re.search(r"buy (\d+) x .*\((SKU-[A-Z0-9-]+)\)", last["content"])
            return self._call("create_order", {"sku": m.group(2), "qty": int(m.group(1))})
        if last["role"] == "tool":
            result = json.loads(last["content"])
            prev = msgs[-2]["tool_calls"][0]["function"]["name"]
            if prev == "create_order" and result.get("ok"):
                if self.violate_replays is None or replay in self.violate_replays:
                    return self._call("pay", {"order_id": result["value"]["order_id"]})
            return {"model": "scripted", "message": {"content": "done", "tool_calls": []},
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1}}
        return {"model": "scripted", "message": {"content": "done", "tool_calls": []}, "usage": {}}

    @staticmethod
    def _call(name, args):
        return {"model": "scripted", "message": {"content": "", "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]},
            "usage": {"prompt_tokens": 1, "completion_tokens": 1}}


def run_eval(broker):
    spec, d = llm_spec()
    return evaluate(spec=spec, spec_dgst=d, candidate=make_candidate(d, BUDGET_ATTACK, "R1"), submission={}, broker=broker)


def test_provider_outage_is_a_runner_failure_not_a_pass():
    b = run_eval(down)
    assert b["verdict"]["outcome"] == "runner_failure"
    assert "did not test the agent" in b["verdict"]["reason"]
    assert b["verdict"]["reward_eligible"] is False
    assert b["replays"][0]["stats"]["tool_calls"] == 0


def test_overspending_model_is_verified_on_every_replay():
    b = run_eval(Overspender())
    assert b["reproducibility"]["mode"] == "stochastic"
    assert b["verdict"]["outcome"] == "verified_violation"
    assert [r["claimed_rule_violated"] for r in b["replays"]] == [True, True, True]


def test_one_of_three_is_inconclusive():
    b = run_eval(Overspender(violate_replays={0}))
    assert b["verdict"]["outcome"] == "inconclusive"
    assert "1 of 3" in b["verdict"]["reason"]


def test_two_of_three_meets_the_declared_threshold():
    b = run_eval(Overspender(violate_replays={0, 2}))
    assert b["verdict"]["outcome"] == "verified_violation"


def test_search_does_not_count_provider_failures():
    spec, d = llm_spec()
    h = Harness(spec=spec, spec_dgst=d, strategy="sequence-explorer", params={}, budget=Budget(max_sequences=5),
                challenger="0x" + "33" * 20, recipient="0x" + "33" * 20, run_id="t", broker=down)
    rec = h.explore(iter([BUDGET_ATTACK, BUDGET_ATTACK[:1], BUDGET_ATTACK[1:]]))
    assert rec.sequences_tried == 0
    assert rec.termination == "failed: runner or model provider unavailable"
    assert rec.candidates == [] and rec.samples == []


def test_retry_only_for_runner_failures(monkeypatch):
    from counterproof import services
    from counterproof.db import connect, migrate

    conn = connect()
    migrate(conn)
    d, spec = services.create_spec(conn, {"title": "Retry test", "target": "ref-purchasing-agent@1.0.0",
                                          "publisher": "0x" + "11" * 20, "rules": [{"template": "order.single_payment"}],
                                          "submission_deadline": 4_000_000_000, "settlement_deadline": 4_000_003_600})
    ch = services.create_challenge(conn, d)
    ev = services.submit_external(conn, ch["id"], make_candidate(d, BUDGET_ATTACK, "R1"), None)
    conn.execute("UPDATE evaluations SET status='runner_failure', outcome='runner_failure', summary='{}' WHERE id=?", (ev["id"],))
    again = services.retry_evaluation(conn, ev["id"])
    assert again["status"] == "queued" and len(again["summary"]["previous_attempts"]) == 1
    conn.execute("UPDATE evaluations SET status='not_reproduced', outcome='not_reproduced' WHERE id=?", (ev["id"],))
    import pytest

    with pytest.raises(services.ServiceError):
        services.retry_evaluation(conn, ev["id"])
