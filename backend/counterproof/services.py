"""Domain services shared by the API and the worker.

State machines
  challenge:  awaiting_funding -> funded -> settled | refunded       (on-chain)
              offchain                                              (evidence only, no reward)
  run:        queued -> running -> candidate_found | no_violation_found | failed | cancelled
  candidate:  candidate_found -> submitted -> replaying -> verified_violation | not_reproduced |
              inconclusive | failed | cancelled
  evaluation: queued -> replaying -> <evidence outcome> | cancelled
"""

from __future__ import annotations

import json
import sqlite3
import time

from . import jobs
from .canonical import digest, from_bytes32, to_bytes32
from .config import network_label, settings
from .db import ArtifactStore, dumps, log_activity, new_id, now, row, rows, tx
from .spec import build_spec, norm_address, spec_digest, validate_candidate, validate_spec
from .strategies import STRATEGY_VERSION
from .strategies.catalog import STRATEGIES
from .targets import registry

TERMINAL_EVAL = {"verified_violation", "not_reproduced", "inconclusive", "target_crash", "timeout",
                 "malformed_submission", "runner_failure", "cancelled"}


class ServiceError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def store() -> ArtifactStore:
    return ArtifactStore()


# ---------------------------------------------------------------------- specs
def prepare_spec(req: dict) -> dict:
    """The single path from a publisher's request to a canonical spec. Preview and create
    both use it, so the digest a publisher reviews is exactly the digest that is funded."""
    s = settings()
    req = dict(req)
    req.setdefault("evaluator", s.evaluator_address or "")
    if not req["evaluator"]:
        raise ServiceError("no evaluator configured: set COUNTERPROOF_EVALUATOR_ADDRESS to the signer's address", 409)
    if "settlement" not in req and s.network != "offchain" and s.contract:
        req["settlement"] = {"chain_id": s.chain_id, "network": network_label(), "contract": s.contract}
    if "settlement" not in req:
        req["settlement"] = None
    if req["settlement"] is None:
        req["reward_wei"] = "0"
        req.setdefault("currency", "none (off-chain, evidence only)")
    req.setdefault("currency", "MON (Monad testnet native)" if s.network == "monad-testnet" else
                   "native test value on local anvil (not Monad)")
    try:
        return build_spec(req)
    except (ValueError, KeyError) as e:
        raise ServiceError(f"invalid challenge: {e}") from e


def create_spec(conn: sqlite3.Connection, req: dict) -> tuple[str, dict]:
    spec = prepare_spec(req)
    d = spec_digest(spec)
    store().put(spec)
    with tx(conn):
        conn.execute("INSERT OR IGNORE INTO specs(digest, format, title, target_key, supersedes, json, created_at) VALUES (?,?,?,?,?,?,?)",
                     (d, spec["format"], spec["title"], f"{spec['target']['adapter']}@{spec['target']['version']}",
                      spec["supersedes"], dumps(spec), now()))
    return d, spec


def get_spec(conn: sqlite3.Connection, d: str) -> dict:
    r = conn.execute("SELECT json FROM specs WHERE digest=?", (d,)).fetchone()
    if r is None:
        raise ServiceError("unknown specification", 404)
    spec = json.loads(r["json"])
    if spec_digest(spec) != d:
        raise ServiceError("stored specification failed its integrity check", 500)
    return spec


# ---------------------------------------------------------------------- challenges
def create_challenge(conn: sqlite3.Connection, spec_dgst: str) -> dict:
    spec = get_spec(conn, spec_dgst)
    s = settings()
    offchain = spec["settlement"] is None
    status = "offchain" if offchain else "awaiting_funding"
    network = "offchain" if offchain else s.network
    with tx(conn):
        cur = conn.execute(
            "INSERT INTO challenges(spec_digest, status, network, chain_id, contract, reward_wei, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (spec_dgst, status, network, None if offchain else spec["settlement"]["chain_id"],
             None if offchain else spec["settlement"]["contract"], spec["reward"]["amount_wei"], now(), now()))
        cid = cur.lastrowid
        log_activity(conn, "challenge.created", f"Challenge created for {spec['target']['adapter']}@{spec['target']['version']}"
                     + (" (off-chain, evidence only)" if offchain else " - awaiting funding"), cid, spec_dgst)
    return get_challenge(conn, cid)


def get_challenge(conn: sqlite3.Connection, cid: int) -> dict:
    c = row(conn.execute("SELECT * FROM challenges WHERE id=?", (cid,)).fetchone())
    if c is None:
        raise ServiceError("unknown challenge", 404)
    return c


def challenge_view(conn: sqlite3.Connection, cid: int) -> dict:
    c = get_challenge(conn, cid)
    spec = get_spec(conn, c["spec_digest"])
    c["spec"] = spec
    c["target_info"] = next((a for a in registry.catalogue()
                             if a["adapter"] == spec["target"]["adapter"] and a["version"] == spec["target"]["version"]), None)
    c["runs"] = rows(conn.execute("SELECT id, strategy, mode, status, created_at, updated_at, record, error FROM runs "
                                  "WHERE challenge_id=? ORDER BY created_at DESC", (cid,)))
    c["candidates"] = rows(conn.execute("SELECT id, run_id, digest, claimed_rule, status, local_check, created_at FROM candidates "
                                        "WHERE challenge_id=? ORDER BY created_at DESC", (cid,)))
    c["evaluations"] = rows(conn.execute("SELECT e.*, s.challenger, s.recipient, s.commit_tx, s.source, s.candidate_id FROM evaluations e "
                                         "JOIN submissions s ON s.id=e.submission_id WHERE e.challenge_id=? ORDER BY e.created_at DESC", (cid,)))
    c["attestation"] = row(conn.execute("SELECT * FROM attestations WHERE challenge_id=?", (cid,)).fetchone())
    c["transactions"] = rows(conn.execute("SELECT * FROM transactions WHERE challenge_id=? ORDER BY created_at", (cid,)))
    c["activity"] = rows(conn.execute("SELECT * FROM activity WHERE challenge_id=? ORDER BY id DESC LIMIT 50", (cid,)))
    return c


def list_challenges(conn: sqlite3.Connection) -> list[dict]:
    out = []
    for c in rows(conn.execute("SELECT * FROM challenges ORDER BY id DESC")):
        spec = get_spec(conn, c["spec_digest"])
        c["title"] = spec["title"]
        c["target"] = {k: spec["target"][k] for k in ("adapter", "version", "label", "determinism")}
        c["rules"] = [{"id": r["id"], "template": r["template"], "statement": r["statement"]} for r in spec["rules"]]
        c["deadlines"] = spec["deadlines"]
        c["counts"] = dict(conn.execute(
            "SELECT (SELECT COUNT(*) FROM runs WHERE challenge_id=:c) runs,"
            " (SELECT COUNT(*) FROM runs WHERE challenge_id=:c AND status IN ('queued','running')) active_runs,"
            " (SELECT COUNT(*) FROM candidates WHERE challenge_id=:c) candidates,"
            " (SELECT COUNT(*) FROM evaluations WHERE challenge_id=:c AND outcome='verified_violation') verified,"
            " (SELECT COUNT(*) FROM evaluations WHERE challenge_id=:c AND outcome='not_reproduced') not_reproduced",
            {"c": c["id"]}).fetchone())
        c["supersedes"] = spec["supersedes"]
        out.append(c)
    return out


# ---------------------------------------------------------------------- runs
def start_run(conn: sqlite3.Connection, cid: int, strategy: str, params: dict | None = None,
              budget: dict | None = None, mode: str = "deterministic") -> dict:
    c = get_challenge(conn, cid)
    if c["status"] in ("settled", "refunded"):
        raise ServiceError(f"challenge is {c['status']}; no further testing")
    if c["status"] == "awaiting_funding":
        raise ServiceError("fund the challenge before running challengers against it")
    spec = get_spec(conn, c["spec_digest"])
    if time.time() > spec["deadlines"]["submission_deadline"]:
        raise ServiceError("the submission deadline has passed")
    if mode == "deterministic" and strategy not in STRATEGIES:
        raise ServiceError(f"unknown strategy {strategy}")
    if mode == "model-assisted" and strategy != "model-assisted":
        raise ServiceError("model-assisted mode uses the model-assisted strategy")
    spec_target = registry.get(f"{spec['target']['adapter']}@{spec['target']['version']}")
    if spec_target.requires_model and not settings().llm_provider:
        raise ServiceError("this target needs a live model: set COUNTERPROOF_LLM_PROVIDER and its API key", 409)
    defaults = STRATEGIES[strategy]["defaults"] if strategy in STRATEGIES else {}
    p = defaults | (params or {})
    b = {"max_sequences": 120, "max_wall_seconds": 90} | (budget or {})
    if spec_target.requires_model or mode == "model-assisted":
        b = {"max_sequences": 12, "max_wall_seconds": 900, "max_model_calls": 80, "max_model_tokens": 120_000} | (budget or {})
    rid = new_id("run")
    with tx(conn):
        jid = jobs.enqueue(conn, "search", {"run_id": rid})
        conn.execute("INSERT INTO runs(id, challenge_id, job_id, strategy, strategy_version, mode, params, budget, status, "
                     "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                     (rid, cid, jid, strategy, STRATEGY_VERSION, mode, dumps(p), dumps(b), "queued", now(), now()))
        log_activity(conn, "run.queued", f"{strategy} queued (budget {b.get('max_sequences')} sequences / {b.get('max_wall_seconds')} s)", cid, rid)
    return get_run(conn, rid)


def get_run(conn: sqlite3.Connection, rid: str) -> dict:
    r = row(conn.execute("SELECT * FROM runs WHERE id=?", (rid,)).fetchone())
    if r is None:
        raise ServiceError("unknown run", 404)
    r["job"] = jobs.get(conn, r["job_id"]) if r["job_id"] else None
    return r


def cancel_run(conn: sqlite3.Connection, rid: str) -> dict:
    r = get_run(conn, rid)
    state = jobs.request_cancel(conn, r["job_id"])
    if state == "cancelled":
        conn.execute("UPDATE runs SET status='cancelled', updated_at=? WHERE id=?", (now(), rid))
        log_activity(conn, "run.cancelled", f"{r['strategy']} cancelled before it started", r["challenge_id"], rid)
    return get_run(conn, rid)


def save_run_progress(conn: sqlite3.Connection, rid: str, record: dict, status: str | None = None) -> None:
    if status:
        conn.execute("UPDATE runs SET record=?, status=?, updated_at=? WHERE id=?", (dumps(record), status, now(), rid))
    else:
        conn.execute("UPDATE runs SET record=?, updated_at=? WHERE id=?", (dumps(record), now(), rid))


def save_candidates(conn: sqlite3.Connection, cid: int, rid: str, found: list[dict]) -> list[str]:
    ids = []
    with tx(conn):
        for f in found:
            existing = conn.execute("SELECT id FROM candidates WHERE challenge_id=? AND digest=?", (cid, f["digest"])).fetchone()
            if existing:
                ids.append(existing["id"])
                continue
            store().put(f["candidate"])
            cand_id = new_id("cand")
            conn.execute("INSERT INTO candidates(id, challenge_id, run_id, digest, claimed_rule, json, local_check, status, created_at) "
                         "VALUES (?,?,?,?,?,?,?,?,?)", (cand_id, cid, rid, f["digest"], f["candidate"]["claimed_rule"],
                                                        dumps(f["candidate"]), dumps(f["local_check"]), "candidate_found", now()))
            log_activity(conn, "candidate.found", f"Candidate for {f['candidate']['claimed_rule']}: {f['local_check']['summary']}",
                         cid, cand_id)
            ids.append(cand_id)
    return ids


# ---------------------------------------------------------------------- submissions & evaluations
def get_candidate(conn: sqlite3.Connection, cand_id: str) -> dict:
    r = row(conn.execute("SELECT * FROM candidates WHERE id=?", (cand_id,)).fetchone())
    if r is None:
        raise ServiceError("unknown candidate", 404)
    return r


def submit_candidate(conn: sqlite3.Connection, cand_id: str) -> dict:
    """Commit (on chain when the challenge is funded) and queue an independent replay.
    Re-submitting the same candidate returns the existing evaluation - a replay can never
    produce a second payable finding."""
    cand = get_candidate(conn, cand_id)
    c = get_challenge(conn, cand["challenge_id"])
    existing = conn.execute("SELECT e.id FROM evaluations e JOIN submissions s ON s.id=e.submission_id "
                            "WHERE s.challenge_id=? AND s.candidate_digest=?", (c["id"], cand["digest"])).fetchone()
    if existing:
        return get_evaluation(conn, existing["id"]) | {"duplicate": True}
    spec = get_spec(conn, c["spec_digest"])
    if time.time() > spec["deadlines"]["submission_deadline"]:
        raise ServiceError("the submission deadline has passed")
    body = cand["json"]
    if c["status"] == "offchain":
        sub = {"id": new_id("sub"), "source": "offchain", "commit_tx": None, "committed_at": now()}
    elif c["status"] == "funded":
        from . import chain

        sub = chain.commit_submission_as_challenger(conn, c, cand, body)
    else:
        raise ServiceError(f"challenge is {c['status']}; submissions are closed")
    return _create_evaluation(conn, c, cand_id, cand["digest"], body["challenger"], body["recipient"], sub)


def _create_evaluation(conn, c: dict, cand_id: str | None, cand_digest: str, challenger: str, recipient: str, sub: dict) -> dict:
    eid = new_id("eval")
    with tx(conn):
        conn.execute("INSERT INTO submissions(id, challenge_id, candidate_id, candidate_digest, challenger, recipient, commit_tx, "
                     "committed_at, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                     (sub["id"], c["id"], cand_id, cand_digest, challenger, recipient, sub["commit_tx"], sub["committed_at"],
                      sub["source"], now()))
        jid = jobs.enqueue(conn, "evaluation", {"evaluation_id": eid})
        conn.execute("INSERT INTO evaluations(id, challenge_id, submission_id, job_id, status, created_at) VALUES (?,?,?,?,?,?)",
                     (eid, c["id"], sub["id"], jid, "queued", now()))
        if cand_id:
            conn.execute("UPDATE candidates SET status='submitted' WHERE id=?", (cand_id,))
        log_activity(conn, "submission.created", f"Submission {sub['id'][:18]} queued for independent replay"
                     + (f" (commit tx {sub['commit_tx'][:12]}...)" if sub["commit_tx"] else ""), c["id"], eid)
    return get_evaluation(conn, eid)


def submit_external(conn: sqlite3.Connection, cid: int, candidate: dict, submission_id: str | None) -> dict:
    """A human challenger: they committed on chain themselves (submission_id) and now reveal
    the candidate to the evaluator. The binding (challenger, recipient, digest, time) is read
    from the chain, never from the request."""
    c = get_challenge(conn, cid)
    spec = get_spec(conn, c["spec_digest"])
    norm, errors = validate_candidate(candidate, spec, c["spec_digest"])
    if norm is None:
        raise ServiceError("malformed candidate: " + "; ".join(errors[:5]))
    d = digest(norm)
    existing = conn.execute("SELECT e.id FROM evaluations e JOIN submissions s ON s.id=e.submission_id "
                            "WHERE s.challenge_id=? AND s.candidate_digest=?", (cid, d)).fetchone()
    if existing:
        return get_evaluation(conn, existing["id"]) | {"duplicate": True}
    store().put(norm)
    if c["status"] == "offchain":
        sub = {"id": new_id("sub"), "source": "offchain", "commit_tx": None, "committed_at": now()}
        return _create_evaluation(conn, c, None, d, norm["challenger"], norm["recipient"], sub)
    if not submission_id:
        raise ServiceError("commit the candidate digest on chain first and pass its submission id")
    from . import chain

    onchain = chain.read_submission(submission_id)
    if onchain is None or onchain["challenge_id"] != c["onchain_id"]:
        raise ServiceError("submission not found on chain for this challenge", 404)
    if onchain["candidate_digest"] != d:
        raise ServiceError("candidate does not match the committed digest")
    sub = {"id": submission_id.lower(), "source": "chain", "commit_tx": None, "committed_at": onchain["committed_at"]}
    return _create_evaluation(conn, c, None, d, onchain["challenger"], onchain["recipient"], sub)


def get_evaluation(conn: sqlite3.Connection, eid: str) -> dict:
    e = row(conn.execute("SELECT e.*, s.challenger, s.recipient, s.commit_tx, s.source, s.candidate_id, s.candidate_digest "
                         "FROM evaluations e JOIN submissions s ON s.id=e.submission_id WHERE e.id=?", (eid,)).fetchone())
    if e is None:
        raise ServiceError("unknown evaluation", 404)
    e["job"] = jobs.get(conn, e["job_id"]) if e["job_id"] else None
    e["attestation"] = row(conn.execute("SELECT * FROM attestations WHERE evaluation_id=?", (eid,)).fetchone())
    from .chain import attestation_job

    e["attestation_job"] = attestation_job(conn, evaluation_id=eid)
    return e


def retry_evaluation(conn: sqlite3.Connection, eid: str) -> dict:
    """Re-queue an evaluation whose replays could not run (runner_failure). Earlier
    attempts stay recorded in the summary; verdicts other than runner_failure are final."""
    e = get_evaluation(conn, eid)
    if e["status"] in ("queued", "replaying"):
        return e
    if e["outcome"] != "runner_failure":
        raise ServiceError(f"only runner failures can be retried; this evaluation is {e['outcome']}", 409)
    c = get_challenge(conn, e["challenge_id"])
    if c["status"] in ("settled", "refunded"):
        raise ServiceError(f"challenge is {c['status']}")
    summary = e["summary"] if isinstance(e["summary"], dict) else {}
    attempts = list(summary.get("previous_attempts", [])) + [
        {"outcome": e["outcome"], "evidence_digest": e["evidence_digest"], "finished_at": e["finished_at"],
         "reason": summary.get("reason")}]
    with tx(conn):
        jid = jobs.enqueue(conn, "evaluation", {"evaluation_id": eid})
        conn.execute("UPDATE evaluations SET status='queued', outcome=NULL, evidence_digest=NULL, finished_at=NULL, "
                     "job_id=?, summary=? WHERE id=?", (jid, dumps({"previous_attempts": attempts}), eid))
        if e["candidate_id"]:
            conn.execute("UPDATE candidates SET status='submitted' WHERE id=?", (e["candidate_id"],))
        log_activity(conn, "evaluation.retry", f"Evaluation re-queued after a runner failure (attempt {len(attempts) + 1})",
                     e["challenge_id"], eid)
    return get_evaluation(conn, eid)


def evaluation_inputs(conn: sqlite3.Connection, eid: str) -> tuple[dict, str, dict, dict]:
    e = get_evaluation(conn, eid)
    c = get_challenge(conn, e["challenge_id"])
    spec = get_spec(conn, c["spec_digest"])
    candidate = store().get(e["candidate_digest"]) if store().exists(e["candidate_digest"]) else None
    if candidate is None and e["candidate_id"]:
        candidate = get_candidate(conn, e["candidate_id"])["json"]
    submission = {"submission_id": e["submission_id"], "challenger": e["challenger"], "recipient": e["recipient"],
                  "candidate_digest": e["candidate_digest"], "challenge_id": c["onchain_id"]}
    return spec, c["spec_digest"], candidate, submission


def record_evaluation(conn: sqlite3.Connection, eid: str, bundle: dict) -> dict:
    d = put_evidence(bundle)
    outcome = bundle["verdict"]["outcome"]
    summary = {"outcome": outcome, "reason": bundle["verdict"]["reason"], "summary": bundle["verdict"]["summary"],
               "rule": bundle["verdict"]["rule"], "reward_eligible": bundle["verdict"]["reward_eligible"],
               "replays": [{k: r[k] for k in ("index", "run_outcome", "ledger_digest", "claimed_rule_violated")}
                           for r in bundle["replays"]]}
    e = get_evaluation(conn, eid)
    prior = e["summary"].get("previous_attempts") if isinstance(e["summary"], dict) else None
    if prior:
        summary["previous_attempts"] = prior
    cand_status = {"verified_violation": "verified_violation", "not_reproduced": "not_reproduced",
                   "inconclusive": "inconclusive", "cancelled": "cancelled"}.get(outcome, "failed")
    with tx(conn):
        conn.execute("UPDATE evaluations SET status=?, outcome=?, evidence_digest=?, summary=?, finished_at=? WHERE id=?",
                     (outcome, outcome, d, dumps(summary), now(), eid))
        if e["candidate_id"]:
            conn.execute("UPDATE candidates SET status=? WHERE id=?", (cand_status, e["candidate_id"]))
        log_activity(conn, f"evaluation.{outcome}",
                     f"Independent replay: {outcome.replace('_', ' ')} - {bundle['verdict']['reason']}", e["challenge_id"], eid)
    return get_evaluation(conn, eid)


def put_evidence(bundle: dict) -> str:
    """Store the sealed body under its seal digest, so the evaluation's evidence digest, the
    digest inside the bundle and the digest the evaluator attests are one and the same."""
    body = {k: v for k, v in bundle.items() if k != "evidence_digest"}
    d = store().put(body)
    if d != bundle.get("evidence_digest"):
        raise ServiceError("evidence bundle seal does not match its contents", 500)
    return d


def load_evidence(d: str) -> dict:
    body = store().get(d)
    if "evidence_digest" in body:  # stored by an earlier version with the field inside
        return body
    return {**body, "evidence_digest": d}


def evidence(conn: sqlite3.Connection, d: str) -> dict:
    """Serve a bundle the backend recorded: a worker evaluation, a regression, the signer's own
    verification bundle behind an attestation, or the signer's bundle for a refused request."""
    ok = conn.execute("SELECT 1 FROM evaluations WHERE evidence_digest=? UNION SELECT 1 FROM regressions WHERE evidence_digest=? "
                      "UNION SELECT 1 FROM attestations WHERE evidence_digest=? "
                      "UNION SELECT 1 FROM jobs WHERE kind='attestation' AND json_extract(result, '$.verification.evidence_digest')=?",
                      (d, d, d, d)).fetchone()
    if not ok:
        raise ServiceError("unknown evidence bundle", 404)
    return load_evidence(d)


# ---------------------------------------------------------------------- regression (patch -> retest -> export)
def create_regression(conn: sqlite3.Connection, cand_id: str, target_key: str) -> dict:
    cand = get_candidate(conn, cand_id)
    c = get_challenge(conn, cand["challenge_id"])
    old = get_spec(conn, c["spec_digest"])
    try:
        registry.get(target_key)
    except KeyError as e:
        raise ServiceError(str(e)) from e
    req = {
        "title": f"Regression: {old['title']} -> {target_key}",
        "target": target_key,
        "publisher": old["publisher"]["address"], "publisher_name": old["publisher"]["name"],
        "evaluator": old["evaluator"]["address"], "evaluator_name": old["evaluator"]["name"],
        "rules": [{"id": r["id"], "template": r["template"], "params": r["params"]} for r in old["rules"]],
        "initial_state": old["initial_state"], "scope": old["scope"], "isolation": old["environment"]["isolation"],
        "submission_deadline": int(time.time()) + 3600, "settlement_deadline": int(time.time()) + 7200,
        "reward_wei": "0", "currency": "none (regression replay, no reward)", "settlement": None,
        "supersedes": c["spec_digest"], "revision": old["revision"] + 1,
    }
    try:
        new_spec = build_spec(req)
    except (ValueError, KeyError) as e:
        raise ServiceError(f"cannot build regression spec: {e}") from e
    nd = spec_digest(new_spec)
    store().put(new_spec)
    rebound = dict(cand["json"], challenge_spec_digest=nd,
                   provenance=dict(cand["json"]["provenance"], note=f"regression replay of candidate {cand['digest']}"))
    rid = new_id("reg")
    with tx(conn):
        conn.execute("INSERT OR IGNORE INTO specs(digest, format, title, target_key, supersedes, json, created_at) VALUES (?,?,?,?,?,?,?)",
                     (nd, new_spec["format"], new_spec["title"], target_key, c["spec_digest"], dumps(new_spec), now()))
        jid = jobs.enqueue(conn, "regression", {"regression_id": rid, "candidate": rebound})
        conn.execute("INSERT INTO regressions(id, source_candidate_id, source_challenge_id, target_key, spec_digest, job_id, status, created_at) "
                     "VALUES (?,?,?,?,?,?,?,?)", (rid, cand_id, c["id"], target_key, nd, jid, "queued", now()))
        log_activity(conn, "regression.queued", f"Same action sequence queued against {target_key}", c["id"], rid)
    return get_regression(conn, rid)


def get_regression(conn: sqlite3.Connection, rid: str) -> dict:
    r = row(conn.execute("SELECT * FROM regressions WHERE id=?", (rid,)).fetchone())
    if r is None:
        raise ServiceError("unknown regression", 404)
    r["job"] = jobs.get(conn, r["job_id"]) if r["job_id"] else None
    return r


def record_regression(conn: sqlite3.Connection, rid: str, bundle: dict) -> dict:
    d = put_evidence(bundle)
    with tx(conn):
        conn.execute("UPDATE regressions SET status=?, outcome=?, evidence_digest=?, finished_at=? WHERE id=?",
                     (bundle["verdict"]["outcome"], bundle["verdict"]["outcome"], d, now(), rid))
        r = get_regression(conn, rid)
        log_activity(conn, "regression.done", f"Regression against {r['target_key']}: {bundle['verdict']['outcome'].replace('_', ' ')}",
                     r["source_challenge_id"], rid)
    return get_regression(conn, rid)


def export_regression(conn: sqlite3.Connection, rid: str) -> dict:
    r = get_regression(conn, rid)
    cand = get_candidate(conn, r["source_candidate_id"])
    src = get_challenge(conn, r["source_challenge_id"])
    spec = get_spec(conn, r["spec_digest"])
    src_eval = row(conn.execute("SELECT e.evidence_digest, e.outcome FROM evaluations e JOIN submissions s ON s.id=e.submission_id "
                                "WHERE s.candidate_id=?", (cand["id"],)).fetchone())
    rule = next(x for x in spec["rules"] if x["id"] == cand["claimed_rule"])
    return {
        "format": "counterproof.regression/v1",
        "name": f"{rule['template']}-{cand['digest'][7:19]}",
        "source": {"challenge_spec_digest": src["spec_digest"], "candidate_digest": cand["digest"],
                   "evidence_digest": src_eval and src_eval["evidence_digest"], "original_outcome": src_eval and src_eval["outcome"]},
        "rule": {k: rule[k] for k in ("id", "template", "template_version", "params", "statement")},
        "rules": spec["rules"],
        "initial_state": spec["initial_state"],
        "initial_state_digest": spec["initial_state_digest"],
        "actions": cand["json"]["actions"],
        "expectation": f"no violation of {rule['id']} ({rule['template']})",
        "last_result": {"target": r["target_key"], "outcome": r["outcome"], "evidence_digest": r["evidence_digest"],
                        "spec_digest": r["spec_digest"]},
    }


# ---------------------------------------------------------------------- overview
def overview(conn: sqlite3.Connection) -> dict:
    q = lambda sql: conn.execute(sql).fetchone()[0]  # noqa: E731
    return {
        "challenges": q("SELECT COUNT(*) FROM challenges"),
        "funded": q("SELECT COUNT(*) FROM challenges WHERE status='funded'"),
        "active_runs": q("SELECT COUNT(*) FROM runs WHERE status IN ('queued','running')"),
        "verified_violations": q("SELECT COUNT(*) FROM evaluations WHERE outcome='verified_violation'"),
        "settled": q("SELECT COUNT(*) FROM challenges WHERE status='settled'"),
        "activity": rows(conn.execute("SELECT * FROM activity ORDER BY id DESC LIMIT 30")),
    }


__all__ = ["ServiceError", "create_spec", "create_challenge", "start_run", "submit_candidate", "to_bytes32", "from_bytes32",
           "norm_address", "validate_spec"]
