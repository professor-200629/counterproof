"""HTTP API: `uvicorn counterproof.api:app --port 8010` (or `python -m counterproof.api`).

The API never returns secrets. Transaction endpoints accept only a hash; amounts,
addresses and digests are read from the chain receipt, never from the request body.

Reads (GET) are public. Every POST/PUT/PATCH/DELETE needs the operator bearer token or a
judge/operator cookie session with its CSRF token (auth.py), enforced by one app-wide
dependency, so a new route is covered without opting in. Budgets, queue capacity, token
ceilings and the operator stop are enforced server-side (limits.py).
"""

from __future__ import annotations

import json
import threading
import time
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import __version__, auth, jobs, limits, services
from .canonical import digest
from .chain import ChainError
from .config import network_label, settings
from .db import connect, migrate
from .providers import MissingCredential, provider_status
from .redact import redact
from .rules.checker import checker_info
from .rules.templates import catalogue as rule_catalogue
from .runner.sandbox import backend_status
from .spec import market_info, runner_info, spec_digest, validate_candidate
from .strategies.catalog import STRATEGIES
from .targets import registry

_local = threading.local()


def db():
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = connect()
        _local.conn = conn
    return conn


@asynccontextmanager
async def lifespan(_app: FastAPI):
    migrate(connect())
    yield


# ----------------------------------------------------------------------------- authentication
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
# The only mutation open without credentials: signing in (passcode, rate-limited).
PUBLIC_MUTATIONS = frozenset({("POST", "/api/session")})


def _guard(request: Request) -> None:
    """App-wide dependency: every unsafe request must come from the operator or a session."""
    if request.method not in UNSAFE_METHODS or (request.method, request.url.path) in PUBLIC_MUTATIONS:
        return
    try:
        request.state.actor = auth.authenticate(db(), request.headers, request.cookies)
    except auth.AuthError as e:
        raise HTTPException(e.status, str(e), headers=e.headers or None) from None


def current_actor(request: Request) -> auth.Actor:
    actor = getattr(request.state, "actor", None)
    if actor is None:
        raise HTTPException(401, auth.SIGN_IN)
    return actor


def operator_actor(actor: auth.Actor = Depends(current_actor)) -> auth.Actor:
    if not actor.is_operator:
        raise HTTPException(403, "only the operator can do this")
    return actor


def _read_actor(request: Request) -> auth.Actor | None:
    """The caller of a GET, if any (bearer or cookie; no CSRF needed for a read)."""
    header = request.headers.get("authorization")
    if header:
        scheme, _, value = header.partition(" ")
        op = auth.operator_token()
        if scheme.lower() == "bearer" and op and value and auth._eq(value.strip(), op):
            return auth.Actor(role="operator", owner="operator", via="bearer")
        return None
    rec = auth.lookup_session(db(), request.cookies.get(auth.COOKIE))
    return auth.actor_from_session(rec) if rec else None


MAX_BODY_BYTES = 256 * 1024


class _TooLarge(Exception):
    pass


class BodyLimit:
    """413 for request bodies over MAX_BODY_BYTES (declared or streamed)."""

    def __init__(self, app, max_bytes: int = MAX_BODY_BYTES):
        self.app, self.max = app, max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        declared = dict(scope.get("headers") or []).get(b"content-length")
        if declared is not None:
            try:
                too_big = int(declared) > self.max
            except ValueError:
                too_big = True
            if too_big:
                return await self._refuse(send)
            return await self.app(scope, receive, send)
        seen, started = 0, False

        async def counted():
            nonlocal seen
            msg = await receive()
            if msg["type"] == "http.request":
                seen += len(msg.get("body", b""))
                if seen > self.max:
                    raise _TooLarge()
            return msg

        async def tracked(msg):
            nonlocal started
            started = started or msg["type"] == "http.response.start"
            await send(msg)

        try:
            await self.app(scope, counted, tracked)
        except _TooLarge:
            if not started:
                await self._refuse(send)

    async def _refuse(self, send):
        body = json.dumps({"detail": f"request body over {self.max // 1024} KB"}).encode()
        await send({"type": "http.response.start", "status": 413,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})


class ForwardedHostCheck:
    """DNS rebinding through the Next.js /api proxy: it rewrites Host to the backend and puts
    the browser's Host in X-Forwarded-Host, so that one must be an allowed host too."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            fwd = dict(scope.get("headers") or []).get(b"x-forwarded-host")
            if fwd is not None and not all(auth.host_allowed(h.strip()) for h in fwd.decode("latin-1").split(",")):
                body = b"Invalid host header"
                await send({"type": "http.response.start", "status": 400,
                            "headers": [(b"content-type", b"text/plain"), (b"content-length", str(len(body)).encode())]})
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)


app = FastAPI(title="CounterProof API", version=__version__, lifespan=lifespan, dependencies=[Depends(_guard)])
# Innermost first. CORS is not authentication: no credentials are allowed cross-origin.
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
                   allow_methods=["GET", "POST", "DELETE"], allow_headers=["Content-Type", auth.CSRF_HEADER],
                   allow_credentials=False)
app.add_middleware(BodyLimit)
app.add_middleware(ForwardedHostCheck)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=auth.allowed_hosts())


@app.exception_handler(services.ServiceError)
async def _service_error(_r: Request, e: services.ServiceError):
    return JSONResponse({"detail": redact(str(e))}, status_code=e.status)


@app.exception_handler(limits.LimitError)
async def _limit_error(_r: Request, e: limits.LimitError):
    return JSONResponse({"detail": redact(str(e)), "kind": "limit"}, status_code=e.status)


@app.exception_handler(ChainError)
async def _chain_error(_r: Request, e: ChainError):
    return JSONResponse({"detail": redact(str(e)), "kind": "chain"}, status_code=409)


@app.exception_handler(MissingCredential)
async def _missing_cred(_r: Request, e: MissingCredential):
    return JSONResponse({"detail": redact(str(e)), "kind": "missing_credential"}, status_code=409)


# ----------------------------------------------------------------------------- meta
@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "version": __version__, "time": int(time.time())}


@app.get("/api/config")
def config() -> dict:
    from .chain import challenger_identity, chain_status

    s = settings()
    challenger, recipient = challenger_identity()
    signer = {"url": s.signer_url, "reachable": False}
    try:
        import httpx

        r = httpx.get(f"{s.signer_url}/health", timeout=2)
        if r.status_code == 200:
            h = r.json()
            signer.update(reachable=True, configured=h.get("configured"), address=h.get("address"))
    except Exception:
        pass
    return {
        "version": __version__,
        "network": s.network, "network_label": network_label(),
        "chain": chain_status(),
        "evaluator_address": s.evaluator_address,
        "signer": signer,
        "challenger_bot": {"address": challenger, "recipient": recipient,
                           "can_commit": bool(__import__("os").environ.get("COUNTERPROOF_CHALLENGER_PRIVATE_KEY"))},
        "isolation": backend_status(),
        "default_isolation": s.default_isolation,
        "providers": provider_status(),
        "live_model": {"provider": s.llm_provider, "model": s.llm_model},
        "components": {"market": market_info(), "runner": runner_info(),
                       "checker": {k: v for k, v in checker_info().items() if k in ("name", "version", "digest")}},
    }


@app.get("/api/erc8004")
def erc8004_record() -> dict:
    """The ERC-8004 identities and feedback recorded by scripts/testnet.py (public chain facts only).
    Only feedback about this backend's contract is returned."""
    import os
    from pathlib import Path

    from . import erc8004
    from .config import ROOT

    s = settings()
    regs = erc8004.REGISTRIES.get(s.chain_id or 0)
    default = ROOT / "docs" / "deployments" / "monad-testnet-erc8004.json" if s.network == "monad-testnet" else None
    path = Path(os.environ["COUNTERPROOF_ERC8004_RECORD"]) if os.environ.get("COUNTERPROOF_ERC8004_RECORD") else default
    base = {"available": False, "chain_id": s.chain_id, "registries": regs}
    if not regs:
        return base | {"reason": f"no official ERC-8004 registries are recorded for {network_label()}"}
    if not path or not path.exists():
        return base | {"reason": "no ERC-8004 identities registered yet (scripts/testnet.py register-agents)"}
    rec = json.loads(path.read_text(encoding="utf-8"))
    if rec.get("chain_id") != s.chain_id:
        return base | {"reason": "the ERC-8004 record is for a different chain"}
    feedback = [f for f in rec.get("feedback", []) if s.contract and f.get("bounties", "").lower() == s.contract]
    return base | {"available": True, "network": rec.get("network"), "agents": rec.get("agents", {}),
                   "feedback": feedback, "registries_source": rec.get("registries_source")}


@app.get("/api/targets")
def targets() -> list[dict]:
    return registry.catalogue()


@app.get("/api/rule-templates")
def rule_templates() -> list[dict]:
    return rule_catalogue()


@app.get("/api/strategies")
def strategies() -> list[dict]:
    out = [{"id": k, "title": v["title"], "description": v["description"], "defaults": v["defaults"],
            "targets_rules": v["targets_rules"], "mode": "deterministic"} for k, v in STRATEGIES.items()]
    out.append({"id": "model-assisted", "title": "Model-assisted generator", "mode": "model-assisted",
                "description": "A language model proposes sequences; only the deterministic checker decides.",
                "defaults": {}, "targets_rules": []})
    return out


@app.get("/api/overview")
def overview() -> dict:
    return services.overview(db())


# ----------------------------------------------------------------------------- sessions (auth.py)
class SessionCreate(BaseModel):
    passcode: str = Field(max_length=512)


def _session_view(actor: auth.Actor | None) -> dict:
    conn = db()
    stop = limits.stop_state(conn)
    if actor is None:
        return {"authenticated": False, "role": None, "auth_configured": auth.configured(), "operator_stop": stop,
                "limits": {"judge": _role_limits("judge")}}
    return {"authenticated": True, "role": actor.role, "via": actor.via, "owner": actor.owner,
            "expires_at": actor.expires_at, "csrf_token": actor.csrf_token, "operator_stop": stop,
            "limits": _role_limits(actor.role), "usage": limits.usage_view(conn, actor.owner, actor.role)}


def _role_limits(role: str) -> dict:
    out = limits.caps(role).as_dict()
    if role != "operator":
        provider, model = limits.configured_model()
        out |= {"model": f"{provider}/{model}", "temperature": 0, "max_steps": limits.JUDGE_MAX_STEPS}
    return out | {"max_queued_jobs": limits.max_queued_jobs()}


@app.post("/api/session")
def create_session(body: SessionCreate, request: Request) -> JSONResponse:
    """Sign in with the judge passcode (or the operator token): sets the session cookie and
    returns the CSRF token. Failed attempts are rate-limited per client and overall."""
    origin = auth.origin_of(request.headers)
    if request.headers.get("origin") and origin not in auth.allowed_origins():
        raise HTTPException(403, f"origin {origin} is not allowed to sign in here (COUNTERPROOF_ALLOWED_ORIGINS)")
    client = auth.client_key(request.client.host if request.client else None, request.headers.get("x-forwarded-for"))
    try:
        sid, rec = auth.sign_in(db(), body.passcode, client)
    except auth.AuthError as e:
        return JSONResponse({"detail": str(e)}, status_code=e.status, headers=e.headers or None)
    resp = JSONResponse(_session_view(auth.actor_from_session(rec)))
    resp.set_cookie(value=sid, **auth.cookie_kwargs(rec["expires_at"] - rec["created_at"]))
    return resp


@app.get("/api/session")
def get_session(request: Request) -> dict:
    """Who this browser (cookie) or script (bearer) is, its limits and today's usage."""
    return _session_view(_read_actor(request))


@app.delete("/api/session")
def delete_session(request: Request, actor: auth.Actor = Depends(current_actor)) -> JSONResponse:
    revoked = auth.revoke_session(db(), request.cookies.get(auth.COOKIE)) if actor.via == "cookie" else False
    resp = JSONResponse({"signed_out": revoked})
    resp.delete_cookie(auth.COOKIE, path="/api", httponly=True, samesite="strict", secure=auth.cookie_secure())
    return resp


# ----------------------------------------------------------------------------- operator controls
class OperatorStop(BaseModel):
    reason: str = Field(default="", max_length=200)


@app.post("/api/operator/stop")
def operator_stop(body: OperatorStop | None = None, actor: auth.Actor = Depends(operator_actor)) -> dict:
    """Refuse new jobs and model calls, and cancel every queued or running job. Cancellation
    is cooperative: a model call or sequence already in flight finishes first."""
    return services.operator_stop(db(), actor, (body.reason if body else "") or "")


@app.post("/api/operator/resume")
def operator_resume(actor: auth.Actor = Depends(operator_actor)) -> dict:
    return services.operator_resume(db(), actor)


@app.get("/api/operator/status")
def operator_status(request: Request) -> dict:
    """Queue, usage, ceilings and the stop flag. Operator only (bearer or operator session)."""
    actor = _read_actor(request)
    if actor is None:
        raise HTTPException(401, auth.SIGN_IN)
    if not actor.is_operator:
        raise HTTPException(403, "only the operator can read the operator status")
    return services.operator_status(db())


# ----------------------------------------------------------------------------- specs & challenges
class SpecRequest(BaseModel):
    title: str
    target: str
    rules: list[dict]
    publisher: str
    publisher_name: str = ""
    reward_wei: str = "0"
    submission_deadline: int
    settlement_deadline: int
    eligible_rules: list[str] | None = None
    isolation: str | None = None
    target_config: dict | None = None
    scope: dict | None = None
    supersedes: str | None = None
    offchain: bool = False


def _spec_req(body: SpecRequest, actor: auth.Actor | None = None) -> dict:
    """The spec request. A judge's model target is fixed to the configured provider/model at
    temperature 0 with at most 8 agent steps, and scope.max_actions is capped (limits.py);
    the operator's choices pass through."""
    s = settings()
    req = body.model_dump(exclude_none=True)
    req["isolation"] = body.isolation or s.default_isolation
    offchain = req.pop("offchain", False)
    if offchain or s.network == "offchain":
        req["settlement"] = None
        req["reward_wei"] = "0"
    target = registry.get(body.target) if body.target in registry.ADAPTERS else None
    if actor is not None and not actor.is_operator:
        cfg = limits.judge_target_config(body.target_config, bool(target and target.requires_model))
        if cfg:
            req["target_config"] = cfg
        else:
            req.pop("target_config", None)
        cap = limits.caps(actor.role).max_actions
        scope = dict(req.get("scope") or {})
        if "max_actions" in scope:
            try:
                scope["max_actions"] = max(1, min(int(scope["max_actions"]), cap))
            except (TypeError, ValueError):
                raise HTTPException(400, "scope.max_actions must be an integer") from None
            req["scope"] = scope
        return req
    if target and target.requires_model and not body.target_config:
        req["target_config"] = {"provider": s.llm_provider or "groq", "model": s.llm_model or "openai/gpt-oss-20b",
                                "temperature": 0, "max_steps": 8}
    return req


@app.post("/api/specs/preview")
def preview_spec(body: SpecRequest, actor: auth.Actor = Depends(current_actor)) -> dict:
    spec = services.prepare_spec(_spec_req(body, actor))
    return {"digest": spec_digest(spec), "spec": spec}


@app.post("/api/specs")
def create_spec(body: SpecRequest, actor: auth.Actor = Depends(current_actor)) -> dict:
    d, spec = services.create_spec(db(), _spec_req(body, actor))
    return {"digest": d, "spec": spec}


@app.get("/api/specs/{d}")
def get_spec(d: str) -> dict:
    return {"digest": d, "spec": services.get_spec(db(), d)}


class ChallengeCreate(BaseModel):
    spec_digest: str


@app.post("/api/challenges")
def create_challenge(body: ChallengeCreate) -> dict:
    return services.create_challenge(db(), body.spec_digest)


@app.get("/api/challenges")
def list_challenges() -> list[dict]:
    return services.list_challenges(db())


@app.get("/api/challenges/{cid}")
def get_challenge(cid: int) -> dict:
    return services.challenge_view(db(), cid)


class TxBody(BaseModel):
    tx_hash: str = Field(pattern=r"^0x[0-9a-fA-F]{64}$")
    kind: str | None = None


@app.post("/api/challenges/{cid}/funding")
def record_funding(cid: int, body: TxBody) -> dict:
    from . import chain

    conn = db()
    c = services.get_challenge(conn, cid)
    if c["status"] not in ("awaiting_funding",):
        raise HTTPException(409, f"challenge is {c['status']}")
    spec = services.get_spec(conn, c["spec_digest"])
    out = chain.verify_funding(conn, c, spec, body.tx_hash)
    return out | {"challenge": services.get_challenge(conn, cid), "explorer": chain.explorer_tx(body.tx_hash)}


@app.post("/api/challenges/{cid}/transactions")
def record_tx(cid: int, body: TxBody) -> dict:
    from . import chain

    if body.kind not in ("settle", "refund", "withdraw"):
        raise HTTPException(400, "kind must be settle, refund or withdraw")
    conn = db()
    return chain.verify_tx(conn, services.get_challenge(conn, cid), body.tx_hash, body.kind)


class FailedTx(BaseModel):
    kind: Literal["fund", "commit", "settle", "refund", "withdraw", "deploy"]
    error: str
    tx_hash: str | None = Field(default=None, pattern=r"^0x[0-9a-fA-F]{64}$")


@app.post("/api/challenges/{cid}/transactions/failed")
def record_failed(cid: int, body: FailedTx) -> dict:
    from . import chain

    chain.record_failed_tx(db(), cid, body.tx_hash, body.kind, body.error)
    return {"recorded": True}


@app.get("/api/challenges/{cid}/settlement")
def settlement(cid: int) -> dict:
    """Everything a wallet needs to relay the attestation; the contract enforces the rest."""
    from . import chain

    conn = db()
    c = services.get_challenge(conn, cid)
    att = conn.execute("SELECT * FROM attestations WHERE challenge_id=?", (cid,)).fetchone()
    out = {"challenge": c, "attestation": None, "onchain": None, "explorer_template": settings().explorer_tx_url}
    if att:
        out["attestation"] = {"typed_data": json.loads(att["typed_data"]), "signature": att["signature"],
                              "signer": att["signer"], "expiry": att["expiry"], "evaluation_id": att["evaluation_id"]}
    if c["onchain_id"]:
        try:
            out["onchain"] = chain.read_challenge(int(c["onchain_id"]))
        except Exception as e:
            out["onchain_error"] = redact(str(e))[:200]
    return out


# ----------------------------------------------------------------------------- runs & candidates
class RunCreate(BaseModel):
    strategy: str
    params: dict | None = None
    budget: dict | None = None
    mode: str = "deterministic"


@app.post("/api/challenges/{cid}/runs")
def start_run(cid: int, body: RunCreate, actor: auth.Actor = Depends(current_actor)) -> dict:
    """The response's `budget` is the effective (clamped) budget; `budget_clamped` lists the
    fields the server lowered to the caller's role caps."""
    params = body.params
    if body.mode == "model-assisted":
        from .providers import ChatClient, PROVIDERS

        if not actor.is_operator:
            params = limits.judge_run_model(params or {})
        provider = (params or {}).get("provider") or settings().llm_provider or "groq"
        ChatClient(provider, settings().llm_model or PROVIDERS.get(provider, {}).get("default_model", ""))
    return services.start_run(db(), cid, body.strategy, params, body.budget, body.mode, actor=actor)


@app.get("/api/runs/{rid}")
def get_run(rid: str) -> dict:
    return services.get_run(db(), rid)


@app.post("/api/runs/{rid}/cancel")
def cancel_run(rid: str, actor: auth.Actor = Depends(current_actor)) -> dict:
    return services.cancel_run(db(), rid, actor=actor)


@app.get("/api/candidates/{cand_id}")
def get_candidate(cand_id: str) -> dict:
    return services.get_candidate(db(), cand_id)


@app.post("/api/candidates/{cand_id}/submit")
def submit_candidate(cand_id: str, actor: auth.Actor = Depends(current_actor)) -> dict:
    """On an on-chain challenge this signs commitSubmission with the challenger bot's key
    (gas): operator only. Judges may submit on off-chain challenges (no transaction)."""
    return services.submit_candidate(db(), cand_id, actor=actor)


class DigestBody(BaseModel):
    spec_digest: str
    candidate: dict


@app.post("/api/candidates/digest")
def candidate_digest(body: DigestBody) -> dict:
    spec = services.get_spec(db(), body.spec_digest)
    norm, errors = validate_candidate(body.candidate, spec, body.spec_digest)
    if norm is None or errors:
        raise HTTPException(400, {"errors": errors})
    return {"digest": digest(norm), "candidate": norm}


class ExternalSubmission(BaseModel):
    candidate: dict
    submission_id: str | None = None


@app.post("/api/challenges/{cid}/submissions")
def external_submission(cid: int, body: ExternalSubmission, actor: auth.Actor = Depends(current_actor)) -> dict:
    return services.submit_external(db(), cid, body.candidate, body.submission_id, actor=actor)


@app.get("/api/evaluations/{eid}")
def get_evaluation(eid: str) -> dict:
    return services.get_evaluation(db(), eid)


@app.post("/api/evaluations/{eid}/retry")
def retry_evaluation(eid: str, actor: auth.Actor = Depends(current_actor)) -> dict:
    return services.retry_evaluation(db(), eid, actor=actor)


@app.post("/api/evaluations/{eid}/attest")
def attest(eid: str) -> dict:
    from . import chain

    return chain.request_attestation(db(), eid)


@app.get("/api/evidence/{d}")
def get_evidence(d: str, download: bool = False) -> Response:
    bundle = services.evidence(db(), d)
    body = json.dumps(bundle, indent=2)
    headers = {"Content-Disposition": f'attachment; filename="evidence-{d[7:19]}.json"'} if download else {}
    return Response(body, media_type="application/json", headers=headers)


@app.get("/api/model-proposals/{d}")
def get_model_proposals(d: str) -> dict:
    """Read-only: what the evaluator's model broker saw the model propose (sidecar of an
    evidence bundle). Served only for digests recorded on an evaluation or regression."""
    return services.model_proposals(db(), d)


@app.get("/api/jobs/{jid}")
def get_job(jid: str) -> dict:
    j = jobs.get(db(), jid)
    if not j:
        raise HTTPException(404, "unknown job")
    return j


# ----------------------------------------------------------------------------- regression
class RegressionCreate(BaseModel):
    candidate_id: str
    target: str


@app.post("/api/regressions")
def create_regression(body: RegressionCreate, actor: auth.Actor = Depends(current_actor)) -> dict:
    return services.create_regression(db(), body.candidate_id, body.target, actor=actor)


@app.get("/api/regressions/{rid}")
def get_regression(rid: str) -> dict:
    return services.get_regression(db(), rid)


@app.get("/api/challenges/{cid}/regressions")
def list_regressions(cid: int) -> list[dict]:
    from .db import rows

    return rows(db().execute("SELECT * FROM regressions WHERE source_challenge_id=? ORDER BY created_at DESC", (cid,)))


@app.get("/api/regressions/{rid}/export")
def export_regression(rid: str, format: str = "json") -> Response:
    data = services.export_regression(db(), rid)
    if format == "pytest":
        return PlainTextResponse(_pytest_file(data), headers={"Content-Disposition": f'attachment; filename="test_{data["name"].replace(".", "_").replace("-", "_")}.py"'})
    return Response(json.dumps(data, indent=2), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="regression-{data["name"]}.json"'})


_PYTEST_TEMPLATE = '''"""CounterProof regression test (generated).

Replays the counterexample __CANDIDATE__
(original outcome: __ORIGINAL_OUTCOME__ against __ORIGINAL__, evidence __EVIDENCE__)
and asserts: __EXPECTATION__.

Every test really executes the adapter in a fresh child process from the committed initial
state and runs the deterministic checker over the new ledger; none asserts a recorded verdict.

- test___NAME___does_not_regress: the version under test (default __TARGET__, override with
  COUNTERPROOF_TARGET) completes the run without violating __RULE__.
- test___NAME___original_version_still_fails: the original version (__ORIGINAL__), when it is
  installed, still violates __RULE__ on the same replay, so the test discriminates.
- Live-model targets: the model's recorded proposals from the original evaluation are served
  back by a scripted broker (offline, deterministic). That tests what the agent's code does with
  those proposals, not what a model would propose today. test___NAME___live_model_k_of_n asks
  the real model (k-of-n) and is skipped unless COUNTERPROOF_REGRESSION_LIVE=1 and the
  provider's API key are set. It fails on any live run that violates __RULE__ and on any real
  crash or timeout. A run the provider ended by rejecting the model's generation (Groq rejects a
  call to a tool the agent does not offer with HTTP 400 tool_use_failed; the runner records
  target_crash) is neither: the agent never saw that proposal and nothing from it reached the
  market. Such runs are reported in a warning; if no run completed, the test is skipped as not
  tested. A provider outage (runner_failure) is skipped too: it is not evidence either way.

Run from the CounterProof backend:  uv run pytest path/to/this_file.py
"""

import json
import os
import warnings

import pytest

from counterproof.regression import LIVE_ENV, replay_regression, replay_regression_live
from counterproof.targets import registry

REGRESSION = json.loads(r"""__JSON__""")
RULE = REGRESSION["rule"]["id"]
TARGET = os.environ.get("COUNTERPROOF_TARGET", REGRESSION["last_result"]["target"])
ORIGINAL = (REGRESSION.get("source") or {}).get("target")
REQUIRES_MODEL = bool((REGRESSION.get("target") or {}).get("requires_model"))


def test___NAME___does_not_regress():
    result = replay_regression(REGRESSION, TARGET)
    assert result["run_outcome"] == "completed", (result["run_outcome"], result["run_reason"])
    assert RULE not in result["rules_violated"], result["violations"]


def test___NAME___original_version_still_fails():
    if not ORIGINAL or ORIGINAL == TARGET or ORIGINAL not in registry.ADAPTERS:
        pytest.skip(f"original version {ORIGINAL} is not installed or is the version under test")
    result = replay_regression(REGRESSION, ORIGINAL)
    assert RULE in result["rules_violated"], (result["run_outcome"], result["run_reason"], result["violations"])


@pytest.mark.skipif(os.environ.get(LIVE_ENV) != "1",
                    reason="live-model replay is opt-in: set COUNTERPROOF_REGRESSION_LIVE=1 and the provider's API key")
def test___NAME___live_model_k_of_n():
    if not REQUIRES_MODEL:
        pytest.skip("deterministic target: the scripted replay above is the whole regression")
    result = replay_regression_live(REGRESSION, TARGET)
    if result["outcome"] == "runner_failure":
        pytest.skip(f"model provider unavailable, not evidence either way: {result['runs'][-1]['run_reason']}")
    assert result["violations"] == 0, result  # a live run broke the rule
    assert result["other_abnormal_runs"] == 0, result  # a real crash or timeout
    rejected = sorted({n for r in result["runs"] for n in r["provider_rejected_tools"]})
    if result["completed_runs"] == 0:
        pytest.skip(f"not tested: all {result['replays']} live runs ended when the provider rejected the model's "
                    f"generation (tools {rejected}); the agent never saw those proposals")
    if result["provider_rejected_runs"]:
        warnings.warn(f"{result['provider_rejected_runs']} of {result['replays']} live runs ended when the provider "
                      f"rejected the model's generation (tools {rejected}); the rule held in every run, and the "
                      f"agent's own guard was exercised in the {result['completed_runs']} completed run(s) only")
'''


def _pytest_file(data: dict) -> str:
    src = data.get("source") or {}
    fields = {
        "__CANDIDATE__": str(src.get("candidate_digest")),
        "__ORIGINAL_OUTCOME__": str(src.get("original_outcome")),
        "__ORIGINAL__": str(src.get("target") or "the original version"),
        "__EVIDENCE__": str(src.get("evidence_digest")),
        "__EXPECTATION__": str(data["expectation"]).replace('"""', "'''"),
        "__TARGET__": str(data["last_result"]["target"]),
        "__RULE__": str(data["rule"]["id"]),
        "__NAME__": "".join(ch if ch.isalnum() else "_" for ch in data["rule"]["template"]),
    }
    out = _PYTEST_TEMPLATE
    for k, v in fields.items():
        out = out.replace(k, v)
    return out.replace("__JSON__", json.dumps(data))


def main() -> None:
    import os

    import uvicorn

    os.environ.setdefault("COUNTERPROOF_ROLE", "api")
    uvicorn.run("counterproof.api:app", host="127.0.0.1", port=settings().api_port, log_level="info")


if __name__ == "__main__":
    main()
