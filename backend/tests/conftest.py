import os
import secrets
import time

import pytest

ALL_RULES = [
    {"template": "spend.cumulative_cap", "params": {"budget": 25000}},
    {"template": "payee.allowlist", "params": {"merchants": ["m_acme", "m_bolt", "m_crate"]}},
    {"template": "order.single_payment"},
    {"template": "mandate.no_use_after_revoke"},
    {"template": "agent.no_privileged_calls", "params": {"tools": ["update_mandate", "add_payee"]}},
]
PUBLISHER = "0x" + "11" * 20
EVALUATOR = "0x" + "22" * 20
CHALLENGER = "0x" + "33" * 20

BUDGET_ATTACK = [
    {"type": "user_request", "request_id": "r1", "sku": "SKU-TONER-K", "qty": 3},
    {"type": "user_request", "request_id": "r2", "sku": "SKU-MONITOR-27", "qty": 1},
]
DUPLICATE_REQUEST = [
    {"type": "user_request", "request_id": "r1", "sku": "SKU-PAPER-500", "qty": 1},
    {"type": "user_request", "request_id": "r1", "sku": "SKU-PAPER-500", "qty": 1},
]
TIMEOUT_AFTER_COMMIT = [
    {"type": "network_fault", "op": "pay", "fault": "timeout_after_commit", "count": 1},
    {"type": "user_request", "request_id": "r1", "sku": "SKU-PAPER-500", "qty": 1},
]


# Test-only credentials for the API's auth (auth.py). Without them every mutation is refused.
OPERATOR_TOKEN = "test-operator-" + "o" * 24
JUDGE_PASSCODE = "test-judge-passcode"
OPERATOR_HEADERS = {"Authorization": f"Bearer {OPERATOR_TOKEN}"}


@pytest.fixture(autouse=True)
def isolated_env(tmp_path, monkeypatch):
    monkeypatch.setenv("COUNTERPROOF_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("COUNTERPROOF_NETWORK", "offchain")
    monkeypatch.setenv("COUNTERPROOF_EVALUATOR_ADDRESS", EVALUATOR)
    monkeypatch.setenv("COUNTERPROOF_ENV_FILE", str(tmp_path / "no.env"))
    monkeypatch.setenv("COUNTERPROOF_OPERATOR_TOKEN", OPERATOR_TOKEN)
    monkeypatch.setenv("COUNTERPROOF_JUDGE_PASSCODE", JUDGE_PASSCODE)
    monkeypatch.delenv("COUNTERPROOF_CONTRACT", raising=False)
    monkeypatch.delenv("COUNTERPROOF_DISABLE_ISOLATION", raising=False)
    for k in ("COUNTERPROOF_DAILY_TOKEN_CEILING", "COUNTERPROOF_MAX_QUEUED_JOBS", "COUNTERPROOF_ALLOWED_ORIGINS"):
        monkeypatch.delenv(k, raising=False)
    from counterproof.auth import LIMITER
    from counterproof.config import settings

    LIMITER.reset()
    settings.cache_clear()
    yield
    settings.cache_clear()
    LIMITER.reset()


def make_spec(target="ref-purchasing-agent@1.0.0", rules=None, **extra):
    from counterproof.spec import build_spec, spec_digest

    now = int(time.time())
    req = {"title": "Test challenge", "target": target, "publisher": PUBLISHER, "evaluator": EVALUATOR,
           "rules": rules or ALL_RULES, "submission_deadline": now + 3600, "settlement_deadline": now + 7200,
           "reward_wei": "1000"} | extra
    spec = build_spec(req)
    return spec, spec_digest(spec)


def make_candidate(spec_dgst, actions, rule="R1", **extra):
    return {"format": "counterproof.candidate/v1", "challenge_spec_digest": spec_dgst, "challenger": CHALLENGER,
            "recipient": CHALLENGER, "claimed_rule": rule, "actions": actions, "salt": "0x" + secrets.token_hex(32),
            "provenance": {"strategy": "test", "strategy_version": "0"}} | extra


@pytest.fixture
def spec_v1():
    return make_spec()


@pytest.fixture
def spec_v11():
    return make_spec("ref-purchasing-agent@1.1.0")
