"""HTTP API: `uvicorn counterproof.api:app --port 8010` (or `python -m counterproof.api`).

The API never returns secrets. Transaction endpoints accept only a hash; amounts,
addresses and digests are read from the chain receipt, never from the request body.
"""

from __future__ import annotations

import json
import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel, Field

from . import __version__, jobs, services
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


app = FastAPI(title="CounterProof API", version=__version__, lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
                   allow_methods=["*"], allow_headers=["*"])


@app.exception_handler(services.ServiceError)
async def _service_error(_r: Request, e: services.ServiceError):
    return JSONResponse({"detail": redact(str(e))}, status_code=e.status)


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


def _spec_req(body: SpecRequest) -> dict:
    s = settings()
    req = body.model_dump(exclude_none=True)
    req["isolation"] = body.isolation or s.default_isolation
    offchain = req.pop("offchain", False)
    if offchain or s.network == "offchain":
        req["settlement"] = None
        req["reward_wei"] = "0"
    target = registry.get(body.target) if body.target in registry.ADAPTERS else None
    if target and target.requires_model and not body.target_config:
        req["target_config"] = {"provider": s.llm_provider or "groq", "model": s.llm_model or "openai/gpt-oss-20b",
                                "temperature": 0, "max_steps": 8}
    return req


@app.post("/api/specs/preview")
def preview_spec(body: SpecRequest) -> dict:
    spec = services.prepare_spec(_spec_req(body))
    return {"digest": spec_digest(spec), "spec": spec}


@app.post("/api/specs")
def create_spec(body: SpecRequest) -> dict:
    d, spec = services.create_spec(db(), _spec_req(body))
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
    kind: str
    error: str
    tx_hash: str | None = None


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
def start_run(cid: int, body: RunCreate) -> dict:
    if body.mode == "model-assisted":
        from .providers import ChatClient, PROVIDERS

        provider = (body.params or {}).get("provider") or settings().llm_provider or "groq"
        ChatClient(provider, settings().llm_model or PROVIDERS.get(provider, {}).get("default_model", ""))
    return services.start_run(db(), cid, body.strategy, body.params, body.budget, body.mode)


@app.get("/api/runs/{rid}")
def get_run(rid: str) -> dict:
    return services.get_run(db(), rid)


@app.post("/api/runs/{rid}/cancel")
def cancel_run(rid: str) -> dict:
    return services.cancel_run(db(), rid)


@app.get("/api/candidates/{cand_id}")
def get_candidate(cand_id: str) -> dict:
    return services.get_candidate(db(), cand_id)


@app.post("/api/candidates/{cand_id}/submit")
def submit_candidate(cand_id: str) -> dict:
    return services.submit_candidate(db(), cand_id)


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
def external_submission(cid: int, body: ExternalSubmission) -> dict:
    return services.submit_external(db(), cid, body.candidate, body.submission_id)


@app.get("/api/evaluations/{eid}")
def get_evaluation(eid: str) -> dict:
    return services.get_evaluation(db(), eid)


@app.post("/api/evaluations/{eid}/retry")
def retry_evaluation(eid: str) -> dict:
    return services.retry_evaluation(db(), eid)


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
def create_regression(body: RegressionCreate) -> dict:
    return services.create_regression(db(), body.candidate_id, body.target)


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
  provider's API key are set.

Run from the CounterProof backend:  uv run pytest path/to/this_file.py
"""

import json
import os

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
    assert result["outcome"] == "not_violated", result
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
