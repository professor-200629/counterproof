"""Authentication, authorization, server-side limits and the operator stop (auth.py, limits.py),
plus the chain receipt checks for settle/refund/withdraw and failed-transaction reports."""

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


def test_passcode_brute_force_is_rate_limited(anon):
    for _ in range(5):
        assert anon.post("/api/session", json={"passcode": "guess"}).status_code == 401
    r = anon.post("/api/session", json={"passcode": JUDGE_PASSCODE})  # even the right one, for now
    assert r.status_code == 429 and int(r.headers["retry-after"]) > 0
    # another client (behind the loopback proxy, by X-Forwarded-For) is not locked out
    ok = anon.post("/api/session", json={"passcode": JUDGE_PASSCODE}, headers={"X-Forwarded-For": "10.0.0.7"})
    assert ok.status_code == 200


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


# ----------------------------------------------------------------------------- hosts and body size
def test_unknown_host_and_forwarded_host_are_refused(anon):
    assert anon.get("/api/health", headers={"Host": "evil.example"}).status_code == 400
    assert anon.get("/api/health", headers={"Host": "127.0.0.1:8010"}).status_code == 200
    assert anon.get("/api/health", headers={"X-Forwarded-Host": "rebound.evil.example:3000"}).status_code == 400
    assert anon.get("/api/health", headers={"X-Forwarded-Host": "localhost:3000"}).status_code == 200


def test_oversized_bodies_are_refused(operator):
    big = {"title": "x" * (300 * 1024)}
    assert operator.post("/api/specs/preview", json=big).status_code == 413


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
