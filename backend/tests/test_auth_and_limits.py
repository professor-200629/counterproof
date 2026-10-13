"""Authentication, authorization, server-side limits and the operator stop (auth.py, limits.py),
plus the chain receipt checks for settle/refund/withdraw and failed-transaction reports."""

import json
import re
import secrets
import time

import httpx
import pytest
from conftest import (ALL_RULES, BUDGET_ATTACK, JUDGE_PASSCODE, OPERATOR_HEADERS, OPERATOR_TOKEN, PUBLISHER,
                      make_candidate, make_spec)
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from counterproof import jobs, limits, providers

ORIGIN = "http://localhost:3000"
LLM = "llm-purchasing-agent@0.1.1"


@pytest.fixture
def api_app():
    from counterproof import api

    api._local.conn = None
    yield api
    api._local.conn = None


@pytest.fixture
def anon(api_app):
    with TestClient(api_app.app) as c:
        yield c


@pytest.fixture
def operator(api_app):
    with TestClient(api_app.app, headers=OPERATOR_HEADERS) as c:
        yield c


class Judge:
    """A browser with a judge cookie session: every mutation sends the CSRF token and Origin."""

    def __init__(self, client: TestClient, passcode: str = JUDGE_PASSCODE):
        self.c = client
        r = client.post("/api/session", json={"passcode": passcode}, headers={"Origin": ORIGIN})
        assert r.status_code == 200, r.text
        self.session = r.json()
        self.csrf = self.session["csrf_token"]

    def post(self, path, json=None, **headers):
        h = {"X-CSRF-Token": self.csrf, "Origin": ORIGIN} | headers
        return self.c.post(path, json=json if json is not None else {}, headers={k: v for k, v in h.items() if v is not None})

    def get(self, path):
        return self.c.get(path)


@pytest.fixture
def judge(api_app):
    with TestClient(api_app.app) as c:
        yield Judge(c)


@pytest.fixture
def judge_b(api_app):
    with TestClient(api_app.app) as c:
        yield Judge(c)


def spec_body(target="ref-purchasing-agent@1.0.0", **extra):
    t = int(time.time())
    return {"title": "Auth test challenge", "target": target, "rules": ALL_RULES, "publisher": PUBLISHER,
            "submission_deadline": t + 3600, "settlement_deadline": t + 7200, "offchain": True} | extra


def new_challenge(post, target="ref-purchasing-agent@1.0.0", **extra) -> dict:
    spec = post("/api/specs", spec_body(target, **extra))
    assert spec.status_code == 200, spec.text
    ch = post("/api/challenges", {"spec_digest": spec.json()["digest"]})
    assert ch.status_code == 200, ch.text
    return ch.json()


def op_post(client):
    return lambda path, body=None: client.post(path, json=body if body is not None else {})


def drain(max_jobs=20):
    from counterproof.worker import Worker

    w = Worker(name="test-worker")
    for _ in range(max_jobs):
        j = jobs.claim(w.conn, w.name)
        if j is None:
            return
        w.execute(j)


# ----------------------------------------------------------------------------- every mutation route
def _mutation_routes(app):
    out = []
    for r in app.routes:
        if isinstance(r, APIRoute):
            for m in sorted(r.methods & {"POST", "PUT", "PATCH", "DELETE"}):
                out.append((m, r.path))
    return out


def _fill(path: str) -> str:
    return re.sub(r"\{(\w+)\}", lambda m: "1" if m.group(1) == "cid" else "x1", path)


def test_every_mutation_route_refuses_anonymous_callers(api_app, anon):
    routes = _mutation_routes(api_app.app)
    assert len(routes) >= 17 and ("POST", "/api/candidates/{cand_id}/submit") in routes  # the table is really iterated
    checked = 0
    for method, path in routes:
        if (method, path) in api_app.PUBLIC_MUTATIONS:
            continue
        r = anon.request(method, _fill(path), json={})
        assert r.status_code == 401, (method, path, r.status_code, r.text)
        checked += 1
    assert checked == len(routes) - len(api_app.PUBLIC_MUTATIONS)
    # reads stay public
    assert anon.get("/api/challenges").status_code == 200 and anon.get("/api/config").status_code == 200


def test_without_secrets_every_mutation_is_refused(anon, monkeypatch):
    monkeypatch.delenv("COUNTERPROOF_OPERATOR_TOKEN")
    monkeypatch.delenv("COUNTERPROOF_JUDGE_PASSCODE")
    r = anon.post("/api/specs/preview", json=spec_body(), headers={"Authorization": "Bearer anything"})
    assert r.status_code == 401 and "COUNTERPROOF_OPERATOR_TOKEN" in r.json()["detail"]
    r = anon.post("/api/session", json={"passcode": ""})
    assert r.status_code == 401 and "COUNTERPROOF_JUDGE_PASSCODE" in r.json()["detail"]


# ----------------------------------------------------------------------------- sessions, CSRF, origin
def test_judge_cookie_needs_csrf_token_and_allowed_origin(judge):
    body = spec_body()
    assert judge.post("/api/specs/preview", body, **{"X-CSRF-Token": None}).status_code == 403
    assert judge.post("/api/specs/preview", body, **{"X-CSRF-Token": "wrong"}).status_code == 403
    r = judge.post("/api/specs/preview", body, Origin="http://evil.example")
    assert r.status_code == 403 and "origin" in r.json()["detail"]
    assert judge.post("/api/specs/preview", body, Origin=None).status_code == 403  # no Origin and no Referer
    assert judge.post("/api/specs/preview", body, Origin=None, Referer="http://127.0.0.1:3000/challenges/new").status_code == 200
    assert judge.post("/api/specs/preview", body).status_code == 200


def test_operator_bearer_needs_no_csrf_and_a_wrong_token_is_refused(operator, anon):
    assert operator.post("/api/specs/preview", json=spec_body()).status_code == 200  # no Origin, no CSRF
    bad = anon.post("/api/specs/preview", json=spec_body(), headers={"Authorization": "Bearer nope"})
    assert bad.status_code == 401


def test_session_cookie_flags_lifecycle_and_no_secret_in_responses(anon, api_app, monkeypatch):
    assert anon.get("/api/session").json()["authenticated"] is False
    r = anon.post("/api/session", json={"passcode": JUDGE_PASSCODE}, headers={"Origin": ORIGIN})
    cookie = r.headers["set-cookie"]
    assert "cp_session=" in cookie and "HttpOnly" in cookie and "samesite=strict" in cookie.lower() and "Path=/api" in cookie
    assert "Secure" not in cookie
    s = anon.get("/api/session").json()
    assert s["role"] == "judge" and s["csrf_token"] == r.json()["csrf_token"] and s["expires_at"] > time.time() + 7 * 3600
    assert s["limits"]["max_sequences"] == 50 and s["limits"]["max_active_jobs"] == 2
    assert s["usage"]["active_jobs"] == 0 and s["usage"]["tokens_remaining"] == s["limits"]["daily_tokens"]
    for text in (r.text, anon.get("/api/session").text, anon.get("/api/config").text):
        assert JUDGE_PASSCODE not in text and OPERATOR_TOKEN not in text
    # the database keeps only the hash of the cookie value
    from counterproof.db import connect

    sid = anon.cookies.get("cp_session")
    assert not connect().execute("SELECT 1 FROM sessions WHERE id_hash=?", (sid,)).fetchone()
    # sign out: the cookie no longer authorizes anything
    out = anon.request("DELETE", "/api/session", headers={"X-CSRF-Token": s["csrf_token"], "Origin": ORIGIN})
    assert out.status_code == 200 and out.json()["signed_out"] is True
    anon.cookies.clear()
    again = anon.post("/api/specs/preview", json=spec_body(),
                      headers={"X-CSRF-Token": s["csrf_token"], "Origin": ORIGIN, "Cookie": f"cp_session={sid}"})
    assert again.status_code == 401 and "signed out" in again.json()["detail"]
    # Secure cookies when the API is served over https
    monkeypatch.setenv("COUNTERPROOF_COOKIE_SECURE", "1")
    assert "Secure" in anon.post("/api/session", json={"passcode": JUDGE_PASSCODE}).headers["set-cookie"]


def test_expired_session_is_refused(judge):
    from counterproof.db import connect

    connect().execute("UPDATE sessions SET expires_at=?", (int(time.time()) - 1,))
    r = judge.post("/api/specs/preview", spec_body())
    assert r.status_code == 401 and "expired" in r.json()["detail"]


def test_operator_token_as_passcode_opens_an_operator_session(anon):
    r = anon.post("/api/session", json={"passcode": OPERATOR_TOKEN}, headers={"Origin": ORIGIN})
    assert r.status_code == 200 and r.json()["role"] == "operator"
    assert anon.get("/api/session").json()["role"] == "operator"


def test_failed_passcodes_are_limited_but_never_lock_out_the_right_one(anon):
    """Behind the Next.js /api rewrite every browser reaches the API from 127.0.0.1 and Next adds
    no X-Forwarded-For (only X-Forwarded-Host), so the API cannot tell judges apart. Before, a
    client-sent X-Forwarded-For chose the bucket (a fresh one per forged value), and five wrong
    guesses from anyone refused even the right passcode to everyone. Now failures past the limit
    get 429, a forged header is no new client, and the right passcode is still accepted."""
    for _ in range(5):
        assert anon.post("/api/session", json={"passcode": "guess"}).status_code == 401
    r = anon.post("/api/session", json={"passcode": "guess"})
    assert r.status_code == 429 and int(r.headers["retry-after"]) > 0
    forged = anon.post("/api/session", json={"passcode": "guess"}, headers={"X-Forwarded-For": "10.0.0.7"})
    assert forged.status_code == 429  # no fresh bucket of guesses for a made-up address
    ok = anon.post("/api/session", json={"passcode": JUDGE_PASSCODE}, headers={"Origin": ORIGIN})
    assert ok.status_code == 200 and ok.json()["role"] == "judge"


def test_behind_a_trusted_proxy_each_client_has_its_own_limit(anon, monkeypatch):
    """COUNTERPROOF_TRUSTED_PROXY=1: a proxy in front appends the real client address, so the
    rightmost X-Forwarded-For entry identifies the client (anything left of it is forgeable).
    Such a client is refused for its window, even with the right passcode; others are not, and
    the overall limit never refuses the right passcode."""
    monkeypatch.setenv("COUNTERPROOF_TRUSTED_PROXY", "1")
    a = {"X-Forwarded-For": "6.6.6.6, 10.0.0.1"}
    for _ in range(5):
        assert anon.post("/api/session", json={"passcode": "guess"}, headers=a).status_code == 401
    assert anon.post("/api/session", json={"passcode": JUDGE_PASSCODE}, headers=a).status_code == 429
    same_client = {"X-Forwarded-For": "1.2.3.4, 10.0.0.1"}  # a different forged prefix, the same proxy hop
    assert anon.post("/api/session", json={"passcode": JUDGE_PASSCODE}, headers=same_client).status_code == 429
    assert anon.post("/api/session", json={"passcode": JUDGE_PASSCODE}, headers={"X-Forwarded-For": "10.0.0.2"}).status_code == 200
    for i in range(30):  # fill the overall bucket from many clients
        anon.post("/api/session", json={"passcode": "guess"}, headers={"X-Forwarded-For": f"10.1.0.{i}"})
    assert anon.post("/api/session", json={"passcode": "guess"}, headers={"X-Forwarded-For": "10.2.0.1"}).status_code == 429
    assert anon.post("/api/session", json={"passcode": JUDGE_PASSCODE}, headers={"X-Forwarded-For": "10.2.0.2"}).status_code == 200


def test_secrets_shorter_than_the_minimum_are_ignored(anon, monkeypatch):
    """Guessing is stopped by the secrets' length, so a short one is refused as if unset (and
    scripts/dev.py will not start with one)."""
    monkeypatch.setenv("COUNTERPROOF_JUDGE_PASSCODE", "elevenchars")
    r = anon.post("/api/session", json={"passcode": "elevenchars"})
    assert r.status_code == 401 and "shorter than 12 characters" in r.json()["detail"] and "elevenchars" not in r.text
    assert anon.post("/api/session", json={"passcode": OPERATOR_TOKEN}).json()["role"] == "operator"  # the operator still can
    monkeypatch.setenv("COUNTERPROOF_OPERATOR_TOKEN", "op-" + "t" * 20)
    r = anon.post("/api/specs/preview", json=spec_body(), headers={"Authorization": "Bearer op-" + "t" * 20})
    assert r.status_code == 401 and "shorter than 24 characters" in r.json()["detail"] and "op-ttt" not in r.text
    assert "shorter than 12 characters" in r.json()["detail"]  # neither secret counts: everything is refused


def test_sign_in_from_a_foreign_origin_is_refused(anon):
    r = anon.post("/api/session", json={"passcode": JUDGE_PASSCODE}, headers={"Origin": "http://evil.example"})
    assert r.status_code == 403


# ----------------------------------------------------------------------------- ownership
def test_a_judge_cannot_cancel_another_judges_run_but_the_operator_can(judge, judge_b, operator):
    ch = new_challenge(judge.post)
    run = judge.post(f"/api/challenges/{ch['id']}/runs", {"strategy": "sequence-explorer"}).json()
    assert run["owner"].startswith("judge:sess_") and run["job"]["owner"] == run["owner"]
    r = judge_b.post(f"/api/runs/{run['id']}/cancel")
    assert r.status_code == 403 and "another session" in r.json()["detail"]
    assert operator.post(f"/api/runs/{run['id']}/cancel").json()["status"] == "cancelled"
    mine = judge.post(f"/api/challenges/{ch['id']}/runs", {"strategy": "retry-replay"}).json()
    assert judge.post(f"/api/runs/{mine['id']}/cancel").json()["status"] == "cancelled"


def test_a_judge_can_retry_only_its_own_evaluations(judge, judge_b, operator):
    from counterproof.db import connect

    ch = new_challenge(judge.post)
    cand = make_candidate(ch["spec_digest"], BUDGET_ATTACK, "R1")
    ev = judge.post(f"/api/challenges/{ch['id']}/submissions", {"candidate": cand}).json()
    assert ev["owner"] == judge.session["owner"]
    connect().execute("UPDATE evaluations SET status='runner_failure', outcome='runner_failure' WHERE id=?", (ev["id"],))
    connect().execute("UPDATE jobs SET status='failed' WHERE id=?", (ev["job_id"],))
    assert judge_b.post(f"/api/evaluations/{ev['id']}/retry").status_code == 403
    assert judge.post(f"/api/evaluations/{ev['id']}/retry").json()["status"] == "queued"


# ----------------------------------------------------------------------------- budgets and model choice
def test_judge_budget_is_clamped_to_the_cap_and_recorded_in_the_job(judge, operator):
    ch = new_challenge(judge.post)
    r = judge.post(f"/api/challenges/{ch['id']}/runs", {"strategy": "sequence-explorer", "params": {"max_length": 30},
                                                         "budget": {"max_sequences": 100000, "max_wall_seconds": 86400,
                                                                    "max_model_calls": 0, "max_cost_usd_micros": 9}})
    assert r.status_code == 200, r.text
    run = r.json()
    assert run["budget"] == {"max_sequences": 50, "max_wall_seconds": 300, "max_model_calls": 60, "max_model_tokens": 60000}
    assert run["job"]["params"]["budget"] == run["budget"]
    assert run["budget_clamped"]["max_sequences"] == {"requested": 100000, "effective": 50}
    assert run["params"]["max_length"] == 8
    # operator: higher caps, still finite
    big = operator.post(f"/api/challenges/{ch['id']}/runs", json={"strategy": "retry-replay",
                                                                  "budget": {"max_sequences": 100000, "max_wall_seconds": 10**9}}).json()
    assert big["budget"]["max_sequences"] == 100000 and big["budget"]["max_wall_seconds"] == 3600
    assert big["budget"]["max_model_calls"] > 0 and big["budget"]["max_model_tokens"] > 0  # 0 is never "unlimited"
    # bad values are refused, not guessed
    assert judge.post(f"/api/challenges/{ch['id']}/runs", {"strategy": "retry-replay",
                                                            "budget": {"max_sequences": "lots"}}).status_code == 400


def test_worker_reclamps_a_stored_budget(judge):
    from counterproof import services
    from counterproof.db import connect, dumps
    from counterproof.worker import _effective_budget

    ch = new_challenge(judge.post)
    run = judge.post(f"/api/challenges/{ch['id']}/runs", {"strategy": "retry-replay"}).json()
    conn = connect()
    conn.execute("UPDATE runs SET budget=? WHERE id=?", (dumps({"max_sequences": 10**6, "max_model_tokens": 0}), run["id"]))
    stored = services.get_run(conn, run["id"])
    spec = services.get_spec(conn, ch["spec_digest"])
    b = _effective_budget(stored, spec)
    assert b["max_sequences"] == 50 and b["max_model_tokens"] == 60000
    stored["owner"] = None  # rows from before authentication: operator caps, still finite
    assert _effective_budget(stored, spec)["max_sequences"] == 100000


@pytest.fixture
def live_model_env(monkeypatch):
    from counterproof.config import settings

    monkeypatch.setenv("COUNTERPROOF_LLM_PROVIDER", "groq")
    monkeypatch.setenv("COUNTERPROOF_LLM_MODEL", "openai/gpt-oss-120b")
    monkeypatch.setenv("GROQ_API_KEY", "gsk_" + "k" * 40)
    settings.cache_clear()
    yield
    settings.cache_clear()


def test_judge_specs_use_the_configured_model_only(judge, operator, live_model_env):
    other = {"provider": "groq", "model": "some-expensive-model", "temperature": 0, "max_steps": 8}
    r = judge.post("/api/specs", spec_body(LLM, target_config=other))
    assert r.status_code == 403 and "openai/gpt-oss-120b" in r.json()["detail"]
    assert judge.post("/api/specs", spec_body(LLM, target_config={"provider": "openai"})).status_code == 403
    assert judge.post("/api/specs", spec_body(LLM, target_config={"temperature": 0.7})).status_code == 403
    assert judge.post("/api/specs", spec_body(LLM, target_config={"max_steps": 40})).status_code == 403
    assert judge.post("/api/specs", spec_body(target_config={"anything": 1})).status_code == 403  # deterministic target
    spec = judge.post("/api/specs", spec_body(LLM, scope={"max_actions": 32})).json()["spec"]
    assert spec["target"]["config"] == {"provider": "groq", "model": "openai/gpt-oss-120b", "temperature": 0, "max_steps": 8}
    assert spec["scope"]["max_actions"] == 8
    # the operator may choose
    assert operator.post("/api/specs", json=spec_body(LLM, target_config=other)).json()["spec"]["target"]["config"] == other
    # model-assisted runs: the configured provider/model only
    ch = new_challenge(judge.post)
    r = judge.post(f"/api/challenges/{ch['id']}/runs", {"strategy": "model-assisted", "mode": "model-assisted",
                                                         "params": {"provider": "openai", "sequences_per_call": 50}})
    assert r.status_code == 403
    ok = judge.post(f"/api/challenges/{ch['id']}/runs", {"strategy": "model-assisted", "mode": "model-assisted",
                                                          "params": {"provider": "groq", "sequences_per_call": 50}}).json()
    assert ok["params"]["model"] == "openai/gpt-oss-120b" and ok["params"]["sequences_per_call"] == 5


EXPENSIVE = {"provider": "openrouter", "model": "some/expensive-model"}


def test_run_mode_must_agree_with_the_strategy(judge, operator, live_model_env):
    """The worker picks the generator from the strategy. Before, strategy "model-assisted" with
    any other mode (e.g. "x") skipped the judge model lock and the token-ceiling check: the run
    was stored with the caller's provider/model and the worker called that model."""
    from counterproof import services
    from counterproof.db import connect

    ch = new_challenge(judge.post)
    runs = f"/api/challenges/{ch['id']}/runs"
    assert judge.post(runs, {"strategy": "model-assisted", "mode": "x", "params": EXPENSIVE}).status_code == 422
    r = judge.post(runs, {"strategy": "model-assisted", "mode": "deterministic", "params": EXPENSIVE})
    assert r.status_code == 400 and "model-assisted mode" in r.json()["detail"]
    assert judge.post(runs, {"strategy": "sequence-explorer", "mode": "model-assisted"}).status_code == 400
    with pytest.raises(services.ServiceError) as e:  # in-process callers are held to the same rule
        services.start_run(connect(), ch["id"], "model-assisted", dict(EXPENSIVE), mode="x")
    assert e.value.status == 400
    assert judge.get(f"/api/challenges/{ch['id']}").json()["runs"] == []
    # the one valid spelling is locked to the configured model for a judge
    ok = judge.post(runs, {"strategy": "model-assisted", "mode": "model-assisted", "params": {"provider": "groq"}}).json()
    assert (ok["params"]["provider"], ok["params"]["model"]) == ("groq", "openai/gpt-oss-120b")


def test_worker_runs_a_judges_generator_on_the_configured_model(judge, live_model_env, monkeypatch):
    """Defence in depth: whatever a judge-owned run row says (an old row, an edited database),
    the worker's generator calls the configured provider/model, with params clamped again."""
    from counterproof import services
    from counterproof.db import connect, dumps
    from counterproof.worker import _effective_params

    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-" + "k" * 40)
    monkeypatch.setenv("COUNTERPROOF_LLM_TPM", "0")
    calls = []

    def provider(url, json=None, **_k):
        calls.append((url, json["model"]))
        return _Resp(401, {"error": "test provider refuses"})  # not retried: the generator stops at once

    monkeypatch.setattr(providers.httpx, "post", provider)
    ch = new_challenge(judge.post)
    run = judge.post(f"/api/challenges/{ch['id']}/runs", {"strategy": "model-assisted", "mode": "model-assisted"}).json()
    conn = connect()
    conn.execute("UPDATE runs SET params=? WHERE id=?", (dumps(EXPENSIVE | {"sequences_per_call": 50}), run["id"]))
    stored = services.get_run(conn, run["id"])
    p = _effective_params(stored, services.get_spec(conn, ch["spec_digest"]))
    assert (p["provider"], p["model"], p["sequences_per_call"]) == ("groq", "openai/gpt-oss-120b", 5)
    assert _effective_params(stored | {"owner": "operator"}, services.get_spec(conn, ch["spec_digest"]))["model"] == EXPENSIVE["model"]
    drain()
    assert calls and all("api.groq.com" in u and m == "openai/gpt-oss-120b" for u, m in calls), calls


def test_judges_queue_model_work_only_on_targets_that_use_the_configured_model(judge, operator, live_model_env):
    """An operator-published challenge may name another model; a judge cannot spend on it."""
    from counterproof import services
    from counterproof.canonical import digest
    from counterproof.db import connect
    from counterproof.spec import validate_candidate

    other = {"provider": "groq", "model": "some-expensive-model", "temperature": 0, "max_steps": 8}
    ch = new_challenge(op_post(operator), LLM, target_config=other)
    r = judge.post(f"/api/challenges/{ch['id']}/runs", {"strategy": "retry-replay"})
    assert r.status_code == 403 and "some-expensive-model" in r.json()["detail"]
    cand = make_candidate(ch["spec_digest"], BUDGET_ATTACK, "R1")
    assert judge.post(f"/api/challenges/{ch['id']}/submissions", {"candidate": cand}).status_code == 403
    conn = connect()
    norm, _ = validate_candidate(cand, services.get_spec(conn, ch["spec_digest"]), ch["spec_digest"])
    [cand_id] = services.save_candidates(conn, ch["id"], None, [{"digest": digest(norm), "candidate": norm,
                                                                 "local_check": {"summary": "test"}}])
    assert judge.post(f"/api/candidates/{cand_id}/submit").status_code == 403
    r = judge.post("/api/regressions", {"candidate_id": cand_id, "target": "llm-purchasing-agent@0.2.0"})
    assert r.status_code == 403 and "some-expensive-model" in r.json()["detail"]  # the replay would use the same model
    assert judge.get(f"/api/challenges/{ch['id']}").json()["runs"] == []
    assert operator.post(f"/api/challenges/{ch['id']}/runs", json={"strategy": "retry-replay"}).status_code == 200
    # an operator-published challenge on the configured model is open to judges
    same = new_challenge(op_post(operator), LLM)
    assert judge.post(f"/api/challenges/{same['id']}/runs", {"strategy": "retry-replay"}).status_code == 200


# ----------------------------------------------------------------------------- capacity
def test_per_session_active_jobs_and_the_global_queue_limit(judge, judge_b, operator, monkeypatch):
    ch = new_challenge(judge.post)
    for s in ("sequence-explorer", "retry-replay"):
        assert judge.post(f"/api/challenges/{ch['id']}/runs", {"strategy": s}).status_code == 200
    r = judge.post(f"/api/challenges/{ch['id']}/runs", {"strategy": "merchant-content"})
    assert r.status_code == 429 and "active jobs" in r.json()["detail"]
    assert judge.get("/api/session").json()["usage"]["active_jobs"] == 2
    assert judge_b.post(f"/api/challenges/{ch['id']}/runs", {"strategy": "retry-replay"}).status_code == 200
    monkeypatch.setenv("COUNTERPROOF_MAX_QUEUED_JOBS", "4")
    assert operator.post(f"/api/challenges/{ch['id']}/runs", json={"strategy": "retry-replay"}).status_code == 200
    full = operator.post(f"/api/challenges/{ch['id']}/runs", json={"strategy": "retry-replay"})
    assert full.status_code == 429 and "queue is full" in full.json()["detail"]
    cand = make_candidate(ch["spec_digest"], BUDGET_ATTACK, "R1")
    assert judge_b.post(f"/api/challenges/{ch['id']}/submissions", {"candidate": cand}).status_code == 429


def test_signing_in_again_does_not_reset_what_all_judges_may_use(api_app, operator, monkeypatch):
    """Every correct passcode opens a new session with fresh per-session quotas. Before, four
    sessions held 8 jobs against a per-session cap of 2, could fill the global queue (and lock
    the operator's scripts out) and spend the whole daily ceiling. All judge sessions together
    now share role-wide limits that sit below the global ones."""
    from counterproof.db import connect

    monkeypatch.setenv("COUNTERPROOF_JUDGE_TOTAL_ACTIVE_JOBS", "3")
    monkeypatch.setenv("COUNTERPROOF_MAX_QUEUED_JOBS", "5")
    with TestClient(api_app.app) as c1, TestClient(api_app.app) as c2, TestClient(api_app.app) as c3:
        j1, j2, j3 = Judge(c1), Judge(c2), Judge(c3)
        ch = new_challenge(j1.post)
        runs = f"/api/challenges/{ch['id']}/runs"
        assert j1.post(runs, {"strategy": "sequence-explorer"}).status_code == 200
        assert j1.post(runs, {"strategy": "retry-replay"}).status_code == 200
        assert j2.post(runs, {"strategy": "retry-replay"}).status_code == 200
        r = j3.post(runs, {"strategy": "retry-replay"})  # a brand-new session, its own quota untouched
        assert r.status_code == 429 and "judge sessions together" in r.json()["detail"]
        usage = j3.get("/api/session").json()["usage"]
        assert usage["active_jobs"] == 0 and usage["all_sessions_active_jobs"] == 3 and usage["all_sessions_max_active_jobs"] == 3
        # the queue the judges cannot fill still has room for the operator
        assert operator.post(runs, json={"strategy": "retry-replay"}).status_code == 200
        assert operator.post(runs, json={"strategy": "retry-replay"}).status_code == 200
        assert operator.post(runs, json={"strategy": "retry-replay"}).status_code == 429  # the global limit (5)
        # tokens: all judge sessions together, below the global ceiling
        monkeypatch.setenv("COUNTERPROOF_JUDGE_TOTAL_DAILY_TOKENS", "100")
        limits.record_usage(j1.session["owner"], None, "groq", "m", 60, 40)
        why = limits.guard_model_call(j3.session["owner"])
        assert why and "judge sessions" in why and "cost ceiling reached" in why
        assert limits.guard_model_call("operator") is None and limits.guard_model_call("signer") is None
        assert limits.guard_model_call(None) is None
        with pytest.raises(limits.LimitError) as e:  # a new model-using job for a fresh session is refused too
            limits.check_capacity(connect(), "judge:sess_fresh", model_involved=True)
        assert e.value.status == 429
        s = j3.get("/api/session").json()
        assert s["usage"]["tokens_remaining"] == 0 and s["usage"]["all_sessions_tokens_today"] == 100
        assert s["limits"]["all_sessions_daily_tokens"] == 100 and s["limits"]["all_sessions_active_jobs"] == 3


def test_every_forwarded_limit_can_be_set_in_dotenv():
    """Limit names that contain a secret hint ("TOKEN") must be listed as not secret, or the
    .env loader silently drops them and the default applies."""
    from counterproof.config import NOT_SECRET, SECRET_HINTS

    looks_secret = {k for k in limits.FORWARDED_SETTINGS if any(h in k for h in SECRET_HINTS)}
    assert looks_secret and looks_secret <= NOT_SECRET, looks_secret - NOT_SECRET


def test_judge_wide_defaults_leave_the_operator_headroom():
    j = limits.caps("judge")
    assert 0 < j.all_sessions_active_jobs < limits.max_queued_jobs()
    assert 0 < j.all_sessions_daily_tokens < limits.daily_token_ceiling()
    op = limits.caps("operator")
    assert op.all_sessions_active_jobs == 0 and op.all_sessions_daily_tokens == 0
    assert limits.role_of("signer") == "operator" and limits.role_of("judge:sess_x") == "judge"
    assert limits.role_of("mystery:x") == "judge"  # unknown owners get the tighter caps


# ----------------------------------------------------------------------------- operator stop
class _Resp:
    def __init__(self, status, body):
        self.status_code, self._body, self.text, self.headers = status, body, str(body), {}

    def json(self):
        return self._body


OK_BODY = {"model": "m", "choices": [{"message": {"content": "hi", "tool_calls": []}, "finish_reason": "stop"}],
           "usage": {"prompt_tokens": 3, "completion_tokens": 2}}


def _no_http(monkeypatch):
    def refuse(*_a, **_k):
        raise AssertionError("a model call reached the provider")

    monkeypatch.setattr(providers.httpx, "post", refuse)


def _llm_eval(client):
    """A live-model evaluation whose broker is a real ModelBroker over a ChatClient."""
    from counterproof.evaluator import evaluate

    spec, d = make_spec(LLM, target_config={"provider": "groq", "model": "s", "temperature": 0, "max_steps": 8})
    broker = providers.ModelBroker(client, max_calls=100, max_tokens=0, temperature=0.0)
    return evaluate(spec=spec, spec_dgst=d, candidate=make_candidate(d, BUDGET_ATTACK, "R1"), submission={}, broker=broker)


def test_operator_stop_cancels_refuses_and_fails_model_calls_as_unavailable(operator, judge, anon, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_" + "k" * 40)
    monkeypatch.setenv("COUNTERPROOF_LLM_TPM", "0")
    ch = new_challenge(judge.post)
    queued = judge.post(f"/api/challenges/{ch['id']}/runs", {"strategy": "retry-replay"}).json()
    running = operator.post(f"/api/challenges/{ch['id']}/runs", json={"strategy": "sequence-explorer"}).json()
    from counterproof.db import connect

    conn = connect()
    claimed = jobs.claim(conn, "busy-worker")  # the older job is now running
    assert claimed["id"] == queued["job_id"]
    assert judge.post("/api/operator/stop").status_code == 403
    out = operator.post("/api/operator/stop", json={"reason": "demo over"}).json()
    assert out["stop"]["active"] is True
    assert {j["id"]: j["to"] for j in out["jobs"]} == {queued["job_id"]: "cancelling", running["job_id"]: "cancelled"}
    assert operator.get(f"/api/runs/{running['id']}").json()["status"] == "cancelled"
    assert jobs.get(conn, queued["job_id"])["cancel_requested"] == 1
    # new jobs are refused; workers claim nothing
    r = judge.post(f"/api/challenges/{ch['id']}/runs", {"strategy": "retry-replay"})
    assert r.status_code == 503 and "operator stop in effect" in r.json()["detail"]
    assert operator.post(f"/api/challenges/{ch['id']}/runs", json={"strategy": "retry-replay"}).status_code == 503
    conn.execute("INSERT INTO jobs(id, kind, status, params, max_attempts, created_at) VALUES ('job_x','search','queued','{}',2,0)")
    assert jobs.claim(conn, "w") is None
    # a model call in flight is refused as a provider failure: runner_failure, never target_crash
    _no_http(monkeypatch)
    client = providers.ChatClient("groq", "s")
    with pytest.raises(providers.ProviderError) as e:
        client.chat([{"role": "user", "content": "x"}])
    assert e.value.kind == "unavailable" and "operator stop" in str(e.value)
    bundle = _llm_eval(providers.ChatClient("groq", "s"))
    assert bundle["verdict"]["outcome"] == "runner_failure"
    assert {r["run_outcome"] for r in bundle["replays"]} == {"runner_failure"}
    # status: operator only
    assert anon.get("/api/operator/status").status_code == 401
    assert judge.get("/api/operator/status").status_code == 403
    st = operator.get("/api/operator/status").json()
    assert st["stop"]["reason"] == "demo over" and st["queue"]["limit"] == 20
    assert judge.get("/api/session").json()["operator_stop"]["active"] is True
    # resume
    assert operator.post("/api/operator/resume").json()["stop"] is None
    conn.execute("DELETE FROM jobs WHERE id='job_x'")
    assert judge.post(f"/api/challenges/{ch['id']}/runs", {"strategy": "retry-replay"}).status_code == 200


def test_cancelled_evaluation_can_be_retried_after_a_stop(operator, judge):
    ch = new_challenge(judge.post)
    ev = judge.post(f"/api/challenges/{ch['id']}/submissions", {"candidate": make_candidate(ch["spec_digest"], BUDGET_ATTACK, "R1")}).json()
    operator.post("/api/operator/stop")
    ev = judge.get(f"/api/evaluations/{ev['id']}").json()
    assert ev["outcome"] == "cancelled" and ev["job"]["status"] == "cancelled"
    operator.post("/api/operator/resume")
    assert judge.post(f"/api/evaluations/{ev['id']}/retry").json()["status"] == "queued"
    drain()
    assert judge.get(f"/api/evaluations/{ev['id']}").json()["outcome"] == "verified_violation"


def test_attestation_requests_are_owned_limited_and_closed_by_the_stop(judge, operator):
    """Unit A's attestation job (the worker polls the signer for up to an hour): a caller's
    request is recorded against its session and counts toward its active jobs, the operator
    stop refuses new ones (503), and a queued one cancelled by the stop says why in the activity."""
    from counterproof.db import connect, dumps

    ch = new_challenge(judge.post)
    ev = judge.post(f"/api/challenges/{ch['id']}/submissions", {"candidate": make_candidate(ch["spec_digest"], BUDGET_ATTACK, "R1")}).json()
    drain()
    conn = connect()
    assert judge.get(f"/api/evaluations/{ev['id']}").json()["outcome"] == "verified_violation"
    # as if the challenge were funded on chain and the finding reward-eligible
    conn.execute("UPDATE challenges SET status='funded', onchain_id='9' WHERE id=?", (ch["id"],))
    conn.execute("UPDATE evaluations SET summary=? WHERE id=?", (dumps({"outcome": "verified_violation", "reward_eligible": True}), ev["id"]))
    r = judge.post(f"/api/evaluations/{ev['id']}/attest")
    assert r.status_code == 202 and r.json()["status"] == "queued", r.text
    job = r.json()["job"]
    assert job["kind"] == "attestation" and job["owner"] == judge.session["owner"]
    assert judge.get("/api/session").json()["usage"]["active_jobs"] == 1
    assert judge.post(f"/api/evaluations/{ev['id']}/attest").json()["job_id"] == job["id"]  # one active request, not two
    stopped = operator.post("/api/operator/stop", json={"reason": "demo over"}).json()
    assert {j["id"]: j["to"] for j in stopped["jobs"]}[job["id"]] == "cancelled"
    notes = [a["message"] for a in judge.get(f"/api/challenges/{ch['id']}").json()["activity"] if a["kind"] == "attestation.pending"]
    assert notes and "operator stop" in notes[0]
    r = judge.post(f"/api/evaluations/{ev['id']}/attest")
    assert r.status_code == 503 and "operator stop in effect" in r.json()["detail"]
    operator.post("/api/operator/resume")
    assert judge.post(f"/api/evaluations/{ev['id']}/attest").status_code == 202


# ----------------------------------------------------------------------------- token ledger and ceilings
def test_model_calls_are_recorded_against_the_session(monkeypatch):
    from counterproof.db import connect, migrate

    migrate(connect())
    monkeypatch.setenv("GROQ_API_KEY", "gsk_" + "k" * 40)
    monkeypatch.setenv("COUNTERPROOF_LLM_TPM", "0")
    monkeypatch.setattr(providers.httpx, "post", lambda *a, **k: _Resp(200, OK_BODY))
    client = providers.ChatClient("groq", "s")
    client.owner, client.job_id = "judge:sess_a", "job_1"
    client.chat([{"role": "user", "content": "x"}])
    row = connect().execute("SELECT * FROM model_usage").fetchone()
    assert (row["owner"], row["job_id"], row["prompt_tokens"] + row["completion_tokens"], row["day"]) == \
        ("judge:sess_a", "job_1", 5, limits.today())
    assert limits.tokens_today(connect(), "judge:sess_a") == 5 and limits.tokens_today(connect()) == 5


def test_token_ceiling_refuses_new_model_jobs_and_in_flight_calls(operator, judge, monkeypatch, live_model_env):
    from counterproof.db import connect

    monkeypatch.setenv("COUNTERPROOF_DAILY_TOKEN_CEILING", "100")
    monkeypatch.setenv("COUNTERPROOF_LLM_TPM", "0")
    ch = new_challenge(judge.post)
    limits.record_usage("someone", None, "groq", "m", 60, 40)
    r = judge.post(f"/api/challenges/{ch['id']}/runs", {"strategy": "model-assisted", "mode": "model-assisted"})
    assert r.status_code == 429 and "cost ceiling reached" in r.json()["detail"]
    llm_ch = new_challenge(op_post(operator), LLM)
    r = operator.post(f"/api/challenges/{llm_ch['id']}/runs", json={"strategy": "retry-replay"})
    assert r.status_code == 429 and "cost ceiling reached" in r.json()["detail"]
    # deterministic work costs no tokens and is still accepted
    assert judge.post(f"/api/challenges/{ch['id']}/runs", {"strategy": "retry-replay"}).status_code == 200
    # a call already in flight is refused before it reaches the provider, as "unavailable"
    _no_http(monkeypatch)
    with pytest.raises(providers.ProviderError) as e:
        providers.ChatClient("groq", "s").chat([{"role": "user", "content": "x"}])
    assert e.value.kind == "unavailable" and "cost ceiling reached" in str(e.value)
    assert _llm_eval(providers.ChatClient("groq", "s"))["verdict"]["outcome"] == "runner_failure"
    # per-session daily budget: one judge's spend does not stop the others
    monkeypatch.setenv("COUNTERPROOF_DAILY_TOKEN_CEILING", "1000000")
    monkeypatch.setenv("COUNTERPROOF_JUDGE_DAILY_TOKENS", "50")
    limits.record_usage("judge:sess_heavy", None, "groq", "m", 30, 20)
    assert "this session" in limits.guard_model_call("judge:sess_heavy")
    assert limits.guard_model_call("judge:sess_light") is None and limits.guard_model_call("operator") is None
    assert limits.tokens_today(connect()) == 150


# ----------------------------------------------------------------------------- challenger-bot gas
def test_candidate_submit_on_chain_is_operator_only(judge, operator, monkeypatch):
    from counterproof import chain, services
    from counterproof.canonical import digest
    from counterproof.db import connect
    from counterproof.spec import validate_candidate

    ch = new_challenge(judge.post)
    conn = connect()
    conn.execute("UPDATE challenges SET status='funded', onchain_id='7' WHERE id=?", (ch["id"],))
    spec = services.get_spec(conn, ch["spec_digest"])
    cand, _ = validate_candidate(make_candidate(ch["spec_digest"], BUDGET_ATTACK, "R1"), spec, ch["spec_digest"])
    [cand_id] = services.save_candidates(conn, ch["id"], None, [{"digest": digest(cand), "candidate": cand,
                                                                 "local_check": {"summary": "test"}}])
    sent = []

    def fake_commit(_conn, c, cnd, body):
        sent.append(cnd["id"])
        return {"id": "0x" + "5a" * 32, "source": "chain", "commit_tx": "0x" + "ab" * 32, "committed_at": int(time.time())}

    monkeypatch.setattr(chain, "commit_submission_as_challenger", fake_commit)
    r = judge.post(f"/api/candidates/{cand_id}/submit")
    assert r.status_code == 403 and "operator" in r.json()["detail"] and sent == []
    ev = operator.post(f"/api/candidates/{cand_id}/submit")
    assert ev.status_code == 200 and sent == [cand_id] and ev.json()["owner"] == "operator"


def test_a_judge_may_submit_on_an_offchain_challenge(judge):
    from counterproof import services
    from counterproof.canonical import digest
    from counterproof.db import connect
    from counterproof.spec import validate_candidate

    ch = new_challenge(judge.post)
    conn = connect()
    cand, _ = validate_candidate(make_candidate(ch["spec_digest"], BUDGET_ATTACK, "R1"),
                                 services.get_spec(conn, ch["spec_digest"]), ch["spec_digest"])
    [cand_id] = services.save_candidates(conn, ch["id"], None, [{"digest": digest(cand), "candidate": cand,
                                                                 "local_check": {"summary": "test"}}])
    ev = judge.post(f"/api/candidates/{cand_id}/submit")
    assert ev.status_code == 200 and ev.json()["source"] == "offchain"


# ----------------------------------------------------------------------------- chain receipts
CONTRACT = "0x" + "c0" * 20
OTHER = "0x" + "e0" * 20


class Rcpt(dict):
    def __getattr__(self, k):
        return self[k]


class FakeEvent:
    def __init__(self, logs):
        self.logs = logs

    def process_receipt(self, _rcpt):
        return self.logs


class FakeContract:
    def __init__(self, **events):
        self.events = type("Events", (), {k: staticmethod(lambda logs=v: FakeEvent(logs)) for k, v in events.items()})()


def _ev(address, **args):
    return {"address": address, "args": args, "event": "x"}


@pytest.fixture
def onchain_challenge(monkeypatch):
    from counterproof import services
    from counterproof.config import settings
    from counterproof.db import connect, migrate

    monkeypatch.setenv("COUNTERPROOF_CONTRACT", CONTRACT)
    monkeypatch.setenv("COUNTERPROOF_NETWORK", "anvil-local")
    settings.cache_clear()
    conn = connect()
    migrate(conn)
    spec, d = make_spec()
    services.store().put(spec)
    conn.execute("INSERT INTO specs(digest, format, title, target_key, json, created_at) VALUES (?,?,?,?,?,?)",
                 (d, spec["format"], spec["title"], "ref-purchasing-agent@1.0.0", services.dumps(spec), 0))
    cid = conn.execute("INSERT INTO challenges(spec_digest, status, network, chain_id, contract, onchain_id, created_at, updated_at) "
                       "VALUES (?,?,?,?,?,?,?,?)", (d, "funded", "anvil-local", 31337, CONTRACT, "3", 0, 0)).lastrowid
    return conn, services.get_challenge(conn, cid)


def _receipt_with(monkeypatch, to, **events):
    from counterproof import chain

    rcpt = Rcpt({"to": to, "status": 1, "blockNumber": 9, "from": "0x" + "11" * 20})
    monkeypatch.setattr(chain, "_receipt", lambda h, timeout=60: (None, FakeContract(**events), rcpt))


def test_verify_tx_rejects_receipts_and_logs_from_other_contracts(onchain_challenge, monkeypatch):
    from counterproof import chain, services

    conn, c = onchain_challenge
    h = "0x" + "aa" * 32
    refund = {"ChallengeRefunded": [_ev(CONTRACT, challengeId=3, publisher=PUBLISHER, reward=5)]}
    _receipt_with(monkeypatch, OTHER, **refund)  # sent to another contract
    with pytest.raises(chain.ChainError, match="not sent to the CounterProof contract"):
        chain.verify_tx(conn, c, h, "refund")
    forged = {"ChallengeRefunded": [_ev(OTHER, challengeId=3, publisher=PUBLISHER, reward=5)]}
    _receipt_with(monkeypatch, CONTRACT, **forged)  # our contract called, but the event came from another one
    with pytest.raises(chain.ChainError, match="no ChallengeRefunded event for this challenge"):
        chain.verify_tx(conn, c, h, "refund")
    other_id = {"ChallengeRefunded": [_ev(CONTRACT, challengeId=4, publisher=PUBLISHER, reward=5)]}
    _receipt_with(monkeypatch, CONTRACT, **other_id)  # a real refund of a different challenge
    with pytest.raises(chain.ChainError, match="no ChallengeRefunded event for this challenge"):
        chain.verify_tx(conn, c, h, "refund")
    settled_elsewhere = {"ChallengeSettled": [_ev(OTHER, challengeId=3, submissionId=b"\x01" * 32, recipient=PUBLISHER,
                                                  reward=5, evidenceDigest=b"\x02" * 32)]}
    _receipt_with(monkeypatch, CONTRACT, **settled_elsewhere)
    with pytest.raises(chain.ChainError, match="no ChallengeSettled event"):
        chain.verify_tx(conn, c, h, "settle")
    assert services.get_challenge(conn, c["id"])["status"] == "funded"
    assert conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 0
    _receipt_with(monkeypatch, CONTRACT, **refund)
    assert chain.verify_tx(conn, c, h, "refund")["status"] == "confirmed"
    assert services.get_challenge(conn, c["id"])["status"] == "refunded"


def test_verify_tx_on_a_local_chain_binds_contract_and_challenge(monkeypatch):
    """The same checks against real receipts: a refund on a second deployment of the contract,
    and a refund of another challenge on ours, cannot mark this challenge refunded."""
    from counterproof import chain, devchain, services
    from counterproof.config import settings
    from counterproof.db import connect, migrate

    if not devchain.ARTIFACT.exists():
        pytest.skip("contract not built (forge build)")
    try:
        devchain.anvil_exe()
    except FileNotFoundError:
        pytest.skip("anvil not installed")
    K = devchain.ANVIL_KEYS
    with devchain.Anvil() as a:
        w3 = devchain.web3_for(a.url)
        ours, theirs = devchain.deploy(w3), devchain.deploy(w3)
        monkeypatch.setenv("COUNTERPROOF_NETWORK", "anvil-local")
        monkeypatch.setenv("COUNTERPROOF_RPC_URL", a.url)
        monkeypatch.setenv("COUNTERPROOF_CONTRACT", ours.lower())
        settings.cache_clear()
        chain.abi.cache_clear()

        def create(addr):
            c = devchain.contract_at(w3, addr)
            now = w3.eth.get_block("latest").timestamp
            r = devchain.send(w3, K["publisher"], c.functions.createChallenge(
                secrets.token_bytes(32), devchain.address_of(K["evaluator"]), now + 600, now + 1200), value=1000)
            assert r.status == 1
            return c, int(c.events.ChallengeCreated().process_receipt(r)[0]["args"]["challengeId"])

        mine, mine_id = create(ours)
        _, other_id_on_ours = create(ours)
        foreign, foreign_id = create(theirs)
        assert foreign_id == mine_id  # same id on another deployment: exactly the confusable case
        w3.provider.make_request("evm_increaseTime", [1300])
        w3.provider.make_request("evm_mine", [])

        def refund(c, cid):
            r = devchain.send(w3, K["outsider"], c.functions.refund(cid))
            assert r.status == 1
            return "0x" + bytes(r.transactionHash).hex().removeprefix("0x")

        conn = connect()
        migrate(conn)
        spec, d = make_spec()
        services.store().put(spec)
        conn.execute("INSERT INTO specs(digest, format, title, target_key, json, created_at) VALUES (?,?,?,?,?,?)",
                     (d, spec["format"], spec["title"], "ref-purchasing-agent@1.0.0", services.dumps(spec), 0))
        cid = conn.execute("INSERT INTO challenges(spec_digest, status, network, chain_id, contract, onchain_id, created_at, updated_at) "
                           "VALUES (?,?,?,?,?,?,?,?)", (d, "funded", "anvil-local", 31337, ours.lower(), str(mine_id), 0, 0)).lastrowid
        row = services.get_challenge(conn, cid)
        with pytest.raises(chain.ChainError, match="not sent to the CounterProof contract"):
            chain.verify_tx(conn, row, refund(foreign, foreign_id), "refund")
        with pytest.raises(chain.ChainError, match="for this challenge"):
            chain.verify_tx(conn, row, refund(mine, other_id_on_ours), "refund")
        assert services.get_challenge(conn, cid)["status"] == "funded"
        assert chain.verify_tx(conn, row, refund(mine, mine_id), "refund")["status"] == "confirmed"
        assert services.get_challenge(conn, cid)["status"] == "refunded"


def test_failed_tx_reports_are_validated_and_never_overwrite_a_confirmed_row(onchain_challenge, operator):
    from counterproof import chain

    conn, c = onchain_challenge
    h = "0x" + "bb" * 32
    chain._track(conn, h, "settle", "confirmed", c["id"], "0x" + "11" * 20, {"recipient": "kept"}, 12)
    r = operator.post(f"/api/challenges/{c['id']}/transactions/failed", json={"kind": "settle", "error": "user rejected", "tx_hash": h})
    assert r.status_code == 200
    row = conn.execute("SELECT status, detail, error FROM transactions WHERE hash=?", (h,)).fetchone()
    assert row["status"] == "confirmed" and "kept" in row["detail"] and row["error"] is None
    assert operator.post(f"/api/challenges/{c['id']}/transactions/failed",
                         json={"kind": "settle", "error": "x", "tx_hash": "0x1234"}).status_code == 422
    assert operator.post(f"/api/challenges/{c['id']}/transactions/failed",
                         json={"kind": "anything", "error": "x"}).status_code == 422
    new = "0x" + "cc" * 32
    operator.post(f"/api/challenges/{c['id']}/transactions/failed", json={"kind": "withdraw", "error": "rejected", "tx_hash": new})
    assert conn.execute("SELECT status FROM transactions WHERE hash=?", (new,)).fetchone()["status"] == "failed"


def _second_challenge(conn, spec_digest: str, status: str = "awaiting_funding") -> int:
    return conn.execute("INSERT INTO challenges(spec_digest, status, network, chain_id, contract, created_at, updated_at) "
                        "VALUES (?,?,?,?,?,?,?)", (spec_digest, status, "anvil-local", 31337, CONTRACT, 0, 0)).lastrowid


def _created(spec_digest: str, spec: dict, challenge_id: int, address: str = CONTRACT) -> dict:
    from counterproof.canonical import to_bytes32

    return {"ChallengeCreated": [_ev(address, challengeId=challenge_id, specDigest=bytes.fromhex(to_bytes32(spec_digest)[2:]),
                                     evaluator=spec["evaluator"]["address"], reward=int(spec["reward"]["amount_wei"]),
                                     submissionDeadline=spec["deadlines"]["submission_deadline"],
                                     settlementDeadline=spec["deadlines"]["settlement_deadline"],
                                     publisher=spec["publisher"]["address"])]}


def test_receipts_never_rewrite_another_challenges_confirmed_transaction(onchain_challenge, monkeypatch):
    """verify_funding's mismatch branch used to overwrite a confirmed row's detail when the same
    hash was offered as another challenge's funding; a receipt also kept the kind and challenge
    of a row the browser had filed first. And the same funding offered by a second challenge on
    the same spec failed on the database's unique index (500)."""
    from counterproof import chain, services

    conn, c = onchain_challenge
    spec = services.get_spec(conn, c["spec_digest"])
    h = "0x" + "dd" * 32
    chain._track(conn, h, "fund", "confirmed", c["id"], "0x" + "11" * 20, {"onchain_id": "3", "reward_wei": "1000"}, 7)
    before = dict(conn.execute("SELECT * FROM transactions WHERE hash=?", (h,)).fetchone())
    # another challenge, on another spec, offers the same transaction as its funding
    other_spec, other_d = make_spec(title="Another challenge")
    services.store().put(other_spec)
    conn.execute("INSERT INTO specs(digest, format, title, target_key, json, created_at) VALUES (?,?,?,?,?,?)",
                 (other_d, other_spec["format"], other_spec["title"], "ref-purchasing-agent@1.0.0", services.dumps(other_spec), 0))
    other = services.get_challenge(conn, _second_challenge(conn, other_d))
    _receipt_with(monkeypatch, CONTRACT, **_created(c["spec_digest"], spec, 3))
    with pytest.raises(chain.ChainError, match="spec digest on chain differs"):
        chain.verify_funding(conn, other, other_spec, h)
    assert dict(conn.execute("SELECT * FROM transactions WHERE hash=?", (h,)).fetchone()) == before
    # a second challenge on the same spec: a clear refusal, not an integrity error
    twin = services.get_challenge(conn, _second_challenge(conn, c["spec_digest"]))
    with pytest.raises(chain.ChainError, match="already funds challenge"):
        chain.verify_funding(conn, twin, spec, h)
    assert services.get_challenge(conn, twin["id"])["status"] == "awaiting_funding"
    # a ChallengeCreated log emitted by another contract does not fund anything
    _receipt_with(monkeypatch, CONTRACT, **_created(other_d, other_spec, 11, address=OTHER))
    with pytest.raises(chain.ChainError, match="no ChallengeCreated event from the CounterProof contract"):
        chain.verify_funding(conn, other, other_spec, "0x" + "de" * 32)
    # the browser filed a hash first (wrong kind, wrong challenge); the receipt corrects both
    h2 = "0x" + "ee" * 32
    chain.record_failed_tx(conn, other["id"], h2, "withdraw", "wallet said no")
    _receipt_with(monkeypatch, CONTRACT, ChallengeRefunded=[_ev(CONTRACT, challengeId=3, publisher=PUBLISHER, reward=5)])
    assert chain.verify_tx(conn, c, h2, "refund")["status"] == "confirmed"
    row = conn.execute("SELECT kind, challenge_id, status, error FROM transactions WHERE hash=?", (h2,)).fetchone()
    assert (row["kind"], row["challenge_id"], row["status"], row["error"]) == ("refund", c["id"], "confirmed", None)


# ----------------------------------------------------------------------------- hosts and body size
def test_unknown_host_and_forwarded_host_are_refused(anon):
    assert anon.get("/api/health", headers={"Host": "evil.example"}).status_code == 400
    assert anon.get("/api/health", headers={"Host": "127.0.0.1:8010"}).status_code == 200
    assert anon.get("/api/health", headers={"X-Forwarded-Host": "rebound.evil.example:3000"}).status_code == 400
    assert anon.get("/api/health", headers={"X-Forwarded-Host": "localhost:3000"}).status_code == 200


def test_oversized_bodies_are_refused(operator):
    big = {"title": "x" * (300 * 1024)}
    assert operator.post("/api/specs/preview", json=big).status_code == 413
    json_ct = {"Content-Type": "application/json"}

    def chunks():  # no Content-Length: a chunked body
        for _ in range(40):
            yield b"x" * 10_000

    # Before, a chunked body over the limit failed inside FastAPI's body read and came back as
    # 400 "There was an error parsing the body"; it is refused as too large, as declared ones are.
    r = operator.post("/api/specs/preview", content=chunks(), headers=json_ct)
    assert r.status_code == 413 and "256 KB" in r.json()["detail"]
    body = json.dumps(spec_body()).encode()
    r = operator.post("/api/specs/preview", content=iter([body[:50], body[50:]]), headers=json_ct)
    assert r.status_code == 200, r.text  # a chunked body under the limit reaches the route intact


def test_non_finite_json_numbers_are_refused_not_a_server_error(judge, operator):
    """Python's JSON parser accepts NaN and Infinity (and 1e999 overflows to inf). Before, an
    Infinity budget or scope.max_actions reached int() and raised OverflowError (500), and a NaN
    run parameter was stored as JSON browsers cannot parse."""
    from counterproof import services
    from counterproof.db import connect

    ch = new_challenge(judge.post)
    h = {"X-CSRF-Token": judge.csrf, "Origin": ORIGIN, "Content-Type": "application/json"}
    for raw in ('{"strategy": "sequence-explorer", "budget": {"max_sequences": Infinity}}',
                '{"strategy": "sequence-explorer", "budget": {"max_sequences": -Infinity}}',
                '{"strategy": "sequence-explorer", "budget": {"max_sequences": 1e999}}',
                '{"strategy": "sequence-explorer", "params": {"note": NaN}}'):
        r = judge.c.post(f"/api/challenges/{ch['id']}/runs", content=raw, headers=h)
        assert r.status_code == 400 and "finite" in r.json()["detail"], (raw, r.status_code, r.text)
    raw = json.dumps(spec_body(scope={"max_actions": 4})).replace('"max_actions": 4', '"max_actions": Infinity')
    assert judge.c.post("/api/specs/preview", content=raw, headers=h).status_code == 400
    assert judge.get(f"/api/challenges/{ch['id']}").json()["runs"] == []
    # in-process callers get a 400 too, never an OverflowError
    with pytest.raises(services.ServiceError) as e:
        services.start_run(connect(), ch["id"], "sequence-explorer", budget={"max_sequences": float("inf")})
    assert e.value.status == 400
    with pytest.raises(services.ServiceError) as e:
        services.start_run(connect(), ch["id"], "sequence-explorer", params={"max_length": float("-inf")})
    assert e.value.status == 400
    with pytest.raises(limits.LimitError) as e:
        limits.judge_target_config({"max_steps": float("inf")}, True)
    assert e.value.status == 400
    # finite floats and large integers are untouched by the guard
    ok = operator.post(f"/api/challenges/{ch['id']}/runs", json={"strategy": "retry-replay", "budget": {"max_sequences": 10**30}})
    assert ok.status_code == 200 and ok.json()["budget"]["max_sequences"] == 100000


def test_ledger_survives_an_unmigrated_database(tmp_path, monkeypatch):
    """A model client never fails on a database the API has not migrated yet."""
    monkeypatch.setenv("COUNTERPROOF_DB", str(tmp_path / "fresh.db"))
    from counterproof.config import settings

    settings.cache_clear()
    assert limits.guard_model_call(None) is None
    limits.record_usage(None, None, "groq", "m", 1, 1)
    from counterproof.db import connect

    assert limits.tokens_today(connect()) == 2


def test_http_client_sends_the_bearer(monkeypatch):
    """Scripts authenticate as the operator with the token from the environment."""
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
    import operator_auth

    monkeypatch.setenv("COUNTERPROOF_OPERATOR_TOKEN", OPERATOR_TOKEN)
    assert operator_auth.headers() == {"Authorization": f"Bearer {OPERATOR_TOKEN}"}
    c = operator_auth.client("http://127.0.0.1:1")
    assert isinstance(c, httpx.Client) and c.headers["authorization"] == f"Bearer {OPERATOR_TOKEN}"
