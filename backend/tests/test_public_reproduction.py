"""The supported judge path must work with public files and no owner state."""

import copy
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import httpx
import pytest

from counterproof.canonical import digest
from counterproof.evaluator import seal

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "live_repair_replay.py"


@pytest.fixture
def reproduction():
    spec = importlib.util.spec_from_file_location("public_reproduction", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def legacy_verification():
    spec = importlib.util.spec_from_file_location("verify_evidence", ROOT / "scripts/verify_evidence.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_clean_public_checkout_offline_and_executed_comparison(tmp_path):
    clone = tmp_path / "public-clone"
    shutil.copytree(ROOT / "backend" / "counterproof", clone / "backend" / "counterproof",
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    (clone / "scripts").mkdir()
    shutil.copy2(SCRIPT, clone / "scripts" / SCRIPT.name)
    shutil.copytree(ROOT / "web" / "public" / "snapshot", clone / "web" / "public" / "snapshot")
    # A local .env must never be consulted, even for live mode.
    secret = "test-own-key-never-leak-123456789"
    (clone / ".env").write_text(f"GROQ_API_KEY={secret}\nCOUNTERPROOF_OPERATOR_TOKEN={secret}\n")
    env = {k: v for k, v in os.environ.items() if not k.startswith("COUNTERPROOF_")
           and k not in ("GROQ_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "EVALUATOR_PRIVATE_KEY")}
    env["COUNTERPROOF_OPERATOR_TOKEN"] = secret
    reports = {}
    for mode in ("offline", "scripted"):
        report = tmp_path / f"{mode}.json"
        res = subprocess.run([sys.executable, str(clone / "scripts" / SCRIPT.name), "--mode", mode,
                              "--output", str(report)], cwd=clone, env=env, capture_output=True, text=True, timeout=45)
        assert res.returncode == 0, res.stdout + res.stderr
        assert secret not in res.stdout + res.stderr + report.read_text()
        reports[mode] = json.loads(report.read_text())
        assert not (clone / "data").exists()
    assert "fresh" not in reports["offline"]
    fresh = reports["scripted"]["fresh"]
    assert fresh["comparison_discriminates"] is True
    original = fresh["results"]["llm-purchasing-agent@0.1.1"]
    repaired = fresh["results"]["llm-purchasing-agent@0.2.0"]
    assert original["claimed_rule_violations"] == original["completed_runs"] == 3
    assert repaired["claimed_rule_violations"] == 0 and repaired["completed_runs"] == 3
    assert all(r["requested_purchases_completed"] and r["privileged_calls_reached_market"] == 0 for r in repaired["runs"])
    assert all(r["model_proposals"]["privileged_blocked_by_agent"] == 1 for r in repaired["runs"])
    for result in (original, repaired):
        assert result["spec_digest"] == digest(result["spec"])
        assert result["spec"]["settlement"] is None
        assert result["candidate"]["challenge_spec_digest"] == result["spec_digest"]
        assert result["artifact_digest"] == result["spec"]["target"]["artifact_digest"]
    res = subprocess.run([sys.executable, str(clone / "scripts" / SCRIPT.name), "--mode", "live", "--allow-live"],
                         cwd=clone, env=env, capture_output=True, text=True, timeout=30)
    assert res.returncode == 1 and "GROQ_API_KEY missing from environment" in res.stderr
    assert "Executing live" not in res.stdout and secret not in res.stdout + res.stderr
    assert not (clone / "data").exists()


def test_live_requires_explicit_opt_in(tmp_path):
    res = subprocess.run([sys.executable, str(SCRIPT), "--mode", "live"], cwd=tmp_path,
                         capture_output=True, text=True, timeout=20)
    assert res.returncode == 2 and "requires --allow-live" in res.stderr


def test_public_downloads_never_send_credentials_or_response_cookies(reproduction, monkeypatch, tmp_path):
    monkeypatch.setenv("COUNTERPROOF_OPERATOR_TOKEN", "secret-operator-token-test-123456")
    monkeypatch.setenv("HTTPS_PROXY", "https://user:proxy-secret@example.invalid")
    requests, options = [], []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={"value": 1}, headers={"set-cookie": "public=ignore"})

    client_class = httpx.Client

    def client(**kwargs):
        options.append(kwargs)
        return client_class(**kwargs, transport=httpx.MockTransport(respond))

    monkeypatch.setattr(httpx, "Client", client)
    src = reproduction.PublicSource(tmp_path, tmp_path / "work", "https://public.example")
    try:
        assert src.get("a.json") == src.get("b.json") == {"value": 1}
    finally:
        src.close()
    assert options[0]["trust_env"] is False and options[0]["follow_redirects"] is False
    assert options[0]["auth"] is None
    assert all("authorization" not in r.headers and "cookie" not in r.headers for r in requests)


@pytest.mark.parametrize("url", ["http://public.example", "https://user:pass@public.example",
                                  "https://public.example?token=secret", "https://public.example#token"])
def test_credential_urls_are_refused(reproduction, tmp_path, url):
    with pytest.raises(ValueError):
        reproduction.PublicSource(tmp_path, tmp_path / "work", url)


def test_scripted_children_get_no_secrets_and_use_temporary_scratch(reproduction, monkeypatch, tmp_path):
    from counterproof.runner import sandbox

    monkeypatch.setenv("GROQ_API_KEY", "test-own-provider-secret-123456789")
    monkeypatch.setenv("EVALUATOR_PRIVATE_KEY", "test-own-signing-secret-123456789")
    monkeypatch.setenv("COUNTERPROOF_OPERATOR_TOKEN", "test-own-operator-secret-123456789")
    seen = []
    popen = subprocess.Popen

    def observe(*args, **kwargs):
        seen.append((kwargs["env"], kwargs["cwd"]))
        return popen(*args, **kwargs)

    monkeypatch.setattr(sandbox.subprocess, "Popen", observe)
    with reproduction.isolated_runtime(tmp_path, False):
        src = reproduction.PublicSource(ROOT / "web/public/snapshot", tmp_path)
        records = reproduction.load_records(src)
        result, ok = reproduction.execute(records, "scripted", records["spec"]["target"]["config"], 30)
    assert ok and result["comparison_discriminates"] and len(seen) == 6
    for env, cwd in seen:
        assert not any("KEY" in k or "TOKEN" in k or "PRIVATE" in k for k in env)
        assert Path(cwd).is_relative_to(tmp_path / "scratch")
        assert not Path(cwd).exists()


def test_regression_proposals_must_match_sealed_original_trace(reproduction, tmp_path):
    src = reproduction.PublicSource(ROOT / "web/public/snapshot", tmp_path)
    original_get = src.get

    def tampered(rel):
        value = original_get(rel)
        if rel.endswith("export.json"):
            value["recorded_model_proposals"]["turns"][2]["tool_calls"] = []
        return value

    src.get = tampered
    with pytest.raises(ValueError, match="proposals differ"):
        reproduction.load_records(src)


def test_resealed_inconsistent_checker_flags_are_refused(reproduction, tmp_path):
    src = reproduction.PublicSource(ROOT / "web/public/snapshot", tmp_path)
    spec = src.get(f"api/specs/{reproduction.SPEC_DIGEST}.json")["spec"]
    bundle = copy.deepcopy(src.get(f"api/evidence/{reproduction.EVIDENCE_DIGEST}.json"))
    bundle["replays"][0]["claimed_rule_violated"] = False
    bundle = seal(bundle)
    with pytest.raises(ValueError, match="checker flags"):
        reproduction.check_record(bundle, spec, bundle["evidence_digest"])


def test_an_unrelated_payment_does_not_complete_the_requested_purchase(reproduction, tmp_path):
    src = reproduction.PublicSource(ROOT / "web/public/snapshot", tmp_path)
    bundle = copy.deepcopy(src.get(f"api/evidence/{reproduction.EVIDENCE_DIGEST}.json"))
    assert all(r["requested_purchases_completed"] for r in reproduction.summarize(bundle)["runs"])
    for rep in bundle["replays"]:
        order = next(e for e in rep["ledger"] if e["type"] == "order.created")
        order["data"]["sku"] = "SKU-PAPER-500"
    assert not any(r["requested_purchases_completed"] for r in reproduction.summarize(bundle)["runs"])


def test_live_provider_error_is_reported_and_never_replaced_by_scripted_results(reproduction, monkeypatch, tmp_path):
    from counterproof import providers

    monkeypatch.setenv("GROQ_API_KEY", "caller-provider-key-test-12345678")
    calls = []

    def refuse(url, **kwargs):
        calls.append(url)
        return httpx.Response(401, text="invalid caller credentials", request=httpx.Request("POST", url))

    def no_scripted(*args, **kwargs):
        raise AssertionError("live must not instantiate a scripted broker")

    monkeypatch.setattr(providers.httpx, "post", refuse)
    monkeypatch.setattr(reproduction, "ScriptedBroker", no_scripted)
    with reproduction.isolated_runtime(tmp_path, True):
        src = reproduction.PublicSource(ROOT / "web/public/snapshot", tmp_path)
        records = reproduction.load_records(src)
        result, ok = reproduction.execute(records, "live", records["spec"]["target"]["config"], 30)
    assert not ok and calls == ["https://api.groq.com/openai/v1/chat/completions"]
    original = result["results"][reproduction.ORIGINAL]
    assert original["outcome"] == "runner_failure" and original["completed_runs"] == 0
    assert original["replays"] == 1 and "HTTP 401" in original["runs"][0]["run_reason"]
    assert reproduction.REPAIRED not in result["results"]
    assert not result["comparison_discriminates"]


def test_legacy_public_chain_verifier_uses_no_auth_or_cookies(legacy_verification, monkeypatch):
    requests, options = [], []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={"value": 1}, headers={"set-cookie": "public=ignore"})

    client_class = httpx.Client

    def client(**kwargs):
        options.append(kwargs)
        return client_class(**kwargs, transport=httpx.MockTransport(respond))

    monkeypatch.setattr(httpx, "Client", client)
    source = legacy_verification.Source("https://public.example")
    try:
        assert source.get("manifest.json") == source.get("api/challenges.json") == {"value": 1}
    finally:
        source.http.close()
    assert options[0]["trust_env"] is False and options[0]["follow_redirects"] is False
    assert options[0]["auth"] is None
    assert all("authorization" not in r.headers and "cookie" not in r.headers for r in requests)


@pytest.mark.parametrize("url", ["https://user:pass@public.example", "https://public.example?token=secret",
                                  "https://public.example#token"])
def test_legacy_verifier_refuses_credential_urls(legacy_verification, url):
    with pytest.raises(ValueError, match="must not contain credentials"):
        legacy_verification.Source(url)
