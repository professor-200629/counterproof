"""Secrets stay in the process that needs them and never reach logs or responses."""

import os

import pytest

from counterproof.redact import redact

SECRET_ENV = {
    "EVALUATOR_PRIVATE_KEY": "0x" + "e1" * 32,
    "COUNTERPROOF_CHALLENGER_PRIVATE_KEY": "0x" + "c1" * 32,
    "COUNTERPROOF_SIGNER_TOKEN": "tok" + "t" * 30,
    "GROQ_API_KEY": "gsk_" + "g" * 40,
}


@pytest.fixture
def envfile(tmp_path, monkeypatch):
    p = tmp_path / "test.env"
    p.write_text("\n".join(f"{k}={v}" for k, v in SECRET_ENV.items()) + "\nCOUNTERPROOF_API_PORT=8099\n", encoding="utf-8")
    monkeypatch.setenv("COUNTERPROOF_ENV_FILE", str(p))
    for k in SECRET_ENV:
        monkeypatch.delenv(k, raising=False)
    monkeypatch.delenv("COUNTERPROOF_API_PORT", raising=False)
    return p


@pytest.mark.parametrize("role,expected", [
    ("api", {"COUNTERPROOF_CHALLENGER_PRIVATE_KEY", "COUNTERPROOF_SIGNER_TOKEN", "GROQ_API_KEY"}),
    ("worker", {"COUNTERPROOF_SIGNER_TOKEN", "GROQ_API_KEY"}),
    ("signer", {"EVALUATOR_PRIVATE_KEY", "COUNTERPROOF_SIGNER_TOKEN"}),
])
def test_each_role_loads_only_its_secrets(envfile, monkeypatch, role, expected):
    from counterproof.config import settings

    monkeypatch.setenv("COUNTERPROOF_ROLE", role)
    settings.cache_clear()
    s = settings()
    assert s.api_port == 8099  # non-secret values always load
    loaded = {k for k in SECRET_ENV if os.environ.get(k) == SECRET_ENV[k]}
    assert loaded == expected
    for k in SECRET_ENV:
        monkeypatch.delenv(k, raising=False)


def test_unknown_role_defaults_to_least_privilege(envfile, monkeypatch):
    from counterproof.config import settings

    monkeypatch.setenv("COUNTERPROOF_ROLE", "something-else")
    settings.cache_clear()
    settings()
    assert os.environ.get("EVALUATOR_PRIVATE_KEY") is None
    for k in SECRET_ENV:
        monkeypatch.delenv(k, raising=False)


def test_redaction(monkeypatch):
    monkeypatch.setenv("SOME_API_KEY", "abcdefghijklmnopqrstuvwxyz")
    text = "error with abcdefghijklmnopqrstuvwxyz and gsk_" + "Q" * 30 + " and Bearer sk-or-v1-" + "a" * 30
    out = redact(text)
    assert "abcdefghijklmnopqrstuvwxyz" not in out and "gsk_" not in out and "sk-or-v1" not in out
