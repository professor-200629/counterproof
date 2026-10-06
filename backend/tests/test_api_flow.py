"""End-to-end through the HTTP API, the job queue and the worker (off-chain mode)."""

import time

import pytest
from conftest import ALL_RULES, BUDGET_ATTACK, PUBLISHER, make_candidate
from fastapi.testclient import TestClient

FAKE_SECRETS = {"GROQ_API_KEY": "gsk_" + "s3cr3t" * 8, "EVALUATOR_PRIVATE_KEY": "0x" + "ab" * 32,
                "COUNTERPROOF_SIGNER_TOKEN": "signer-token-" + "z" * 20}


@pytest.fixture
def client(monkeypatch):
    for k, v in FAKE_SECRETS.items():
        monkeypatch.setenv(k, v)
    from counterproof import api

    api._local.conn = None
    with TestClient(api.app) as c:
        yield c
    api._local.conn = None


def drain(max_jobs=20):
    """Run queued jobs to completion in-process."""
    from counterproof import jobs
    from counterproof.worker import Worker

    w = Worker(name="test-worker")
    for _ in range(max_jobs):
        j = jobs.claim(w.conn, w.name)
        if j is None:
            return
        w.execute(j)


def assert_no_secrets(text: str):
    for v in FAKE_SECRETS.values():
        assert v not in text


def new_challenge(client, target="ref-purchasing-agent@1.0.0"):
    now = int(time.time())
    body = {"title": "API flow challenge", "target": target, "rules": ALL_RULES, "publisher": PUBLISHER,
            "submission_deadline": now + 3600, "settlement_deadline": now + 7200, "offchain": True}
    prev = client.post("/api/specs/preview", json=body)
    assert prev.status_code == 200, prev.text
    spec = client.post("/api/specs", json=body).json()
    assert spec["digest"] == prev.json()["digest"]
    ch = client.post("/api/challenges", json={"spec_digest": spec["digest"]}).json()
    assert ch["status"] == "offchain"
    return ch, spec


def test_create_challenge_search_replay_regress_export(client):
    ch, spec = new_challenge(client)
    cid = ch["id"]
    for strategy in ("sequence-explorer", "retry-replay", "merchant-content"):
        r = client.post(f"/api/challenges/{cid}/runs", json={"strategy": strategy, "budget": {"max_sequences": 150}})
        assert r.status_code == 200, r.text
    drain()
    view = client.get(f"/api/challenges/{cid}").json()
    statuses = {r["strategy"]: r["status"] for r in view["runs"]}
    assert statuses == {"sequence-explorer": "candidate_found", "retry-replay": "candidate_found",
                        "merchant-content": "no_violation_found"}
    mc = next(r for r in view["runs"] if r["strategy"] == "merchant-content")
    assert mc["record"]["sequences_tried"] > 0 and mc["record"]["termination"]
    rules = sorted(c["claimed_rule"] for c in view["candidates"])
    assert rules == ["R1", "R3"]

    budget_cand = next(c for c in view["candidates"] if c["claimed_rule"] == "R1")
    ev = client.post(f"/api/candidates/{budget_cand['id']}/submit").json()
    again = client.post(f"/api/candidates/{budget_cand['id']}/submit").json()
    assert again["id"] == ev["id"] and again["duplicate"] is True  # no second payable finding
    drain()
    ev = client.get(f"/api/evaluations/{ev['id']}").json()
    assert ev["outcome"] == "verified_violation"
    bundle = client.get(f"/api/evidence/{ev['evidence_digest']}?download=true")
    assert bundle.status_code == 200 and "attachment" in bundle.headers["content-disposition"]
    assert bundle.json()["verdict"]["rule"]["rule_id"] == "R1"
    from counterproof.evaluator import verify_seal

    # one evidence digest everywhere: evaluation record == digest inside the bundle == recomputed seal
    assert bundle.json()["evidence_digest"] == ev["evidence_digest"]
    assert verify_seal(bundle.json())
    assert client.get(f"/api/candidates/{budget_cand['id']}").json()["status"] == "verified_violation"

    reg = client.post("/api/regressions", json={"candidate_id": budget_cand["id"], "target": "ref-purchasing-agent@1.1.0"}).json()
    drain()
    reg = client.get(f"/api/regressions/{reg['id']}").json()
    assert reg["outcome"] == "not_reproduced"
    new_spec = client.get(f"/api/specs/{reg['spec_digest']}").json()["spec"]
    assert new_spec["supersedes"] == ch["spec_digest"] and new_spec["revision"] == 2
    exp = client.get(f"/api/regressions/{reg['id']}/export").json()
    assert exp["format"] == "counterproof.regression/v1" and exp["actions"]
    py = client.get(f"/api/regressions/{reg['id']}/export?format=pytest").text
    assert "replay_regression" in py

    from counterproof.regression import replay_regression

    assert "R1" in replay_regression(exp, "ref-purchasing-agent@1.0.0")["rules_violated"]
    assert "R1" not in replay_regression(exp, "ref-purchasing-agent@1.1.0")["rules_violated"]

    for path in ("/api/config", f"/api/challenges/{cid}", "/api/overview", f"/api/evidence/{ev['evidence_digest']}"):
        assert_no_secrets(client.get(path).text)


def test_external_submission_and_malformed(client):
    ch, spec = new_challenge(client)
    cand = make_candidate(spec["digest"], BUDGET_ATTACK, "R1")
    d = client.post("/api/candidates/digest", json={"spec_digest": spec["digest"], "candidate": cand}).json()
    ev = client.post(f"/api/challenges/{ch['id']}/submissions", json={"candidate": cand}).json()
    drain()
    ev = client.get(f"/api/evaluations/{ev['id']}").json()
    assert ev["outcome"] == "verified_violation" and ev["candidate_digest"] == d["digest"]
    bad = client.post(f"/api/challenges/{ch['id']}/submissions", json={"candidate": {"format": "nope"}})
    assert bad.status_code == 400


def test_live_model_target_requires_explicit_configuration(client, monkeypatch):
    monkeypatch.delenv("COUNTERPROOF_LLM_PROVIDER", raising=False)
    from counterproof.config import settings

    settings.cache_clear()
    ch, _ = new_challenge(client, "llm-purchasing-agent@0.1.1")
    r = client.post(f"/api/challenges/{ch['id']}/runs", json={"strategy": "sequence-explorer"})
    assert r.status_code == 409 and "COUNTERPROOF_LLM_PROVIDER" in r.json()["detail"]


def test_model_assisted_without_key_fails_explicitly(client, monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    ch, _ = new_challenge(client)
    r = client.post(f"/api/challenges/{ch['id']}/runs", json={"strategy": "model-assisted", "mode": "model-assisted"})
    assert r.status_code == 409 and "GROQ_API_KEY is not set" in r.json()["detail"]
    assert_no_secrets(r.text)


def test_cancel_queued_and_running_runs(client):
    from counterproof import jobs
    from counterproof.worker import Worker

    ch, _ = new_challenge(client)
    run = client.post(f"/api/challenges/{ch['id']}/runs", json={"strategy": "sequence-explorer"}).json()
    assert client.post(f"/api/runs/{run['id']}/cancel").json()["status"] == "cancelled"

    run = client.post(f"/api/challenges/{ch['id']}/runs",
                      json={"strategy": "sequence-explorer", "params": {"max_length": 8},
                            "budget": {"max_sequences": 100000, "max_wall_seconds": 60}}).json()
    w = Worker(name="cancel-worker")
    j = jobs.claim(w.conn, w.name)
    import threading

    threading.Timer(0.4, lambda: client.post(f"/api/runs/{run['id']}/cancel")).start()
    t = time.monotonic()
    w.execute(j)
    assert time.monotonic() - t < 15
    r = client.get(f"/api/runs/{run['id']}").json()
    assert r["status"] == "cancelled" and r["job"]["status"] == "cancelled"
    assert r["record"]["termination"] == "cancelled"


def test_interrupted_jobs_are_recovered_after_restart(client):
    from counterproof import jobs
    from counterproof.db import connect
    from counterproof.worker import Worker

    ch, _ = new_challenge(client)
    run = client.post(f"/api/challenges/{ch['id']}/runs", json={"strategy": "retry-replay"}).json()
    conn = connect()
    j = jobs.claim(conn, "dead-worker")
    conn.execute("UPDATE runs SET status='running' WHERE id=?", (run["id"],))
    conn.execute("UPDATE jobs SET heartbeat_at=? WHERE id=?", (int(time.time()) - 600, j["id"]))
    w = Worker(name="new-worker")
    changed = w.recover()
    assert changed == [{"id": j["id"], "kind": "search", "to": "queued"}]
    assert client.get(f"/api/runs/{run['id']}").json()["status"] == "queued"

    j = jobs.claim(conn, "dead-again")
    conn.execute("UPDATE jobs SET heartbeat_at=? WHERE id=?", (int(time.time()) - 600, j["id"]))
    changed = w.recover()
    assert changed[0]["to"] == "failed"
    r = client.get(f"/api/runs/{run['id']}").json()
    assert r["status"] == "failed" and "interrupted" in r["error"]
