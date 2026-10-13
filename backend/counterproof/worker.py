"""Background worker: `python -m counterproof.worker`.

Claims queued jobs (search runs, evaluations, regressions, attestation requests), runs each
in a thread with a cancel event, heartbeats every second and propagates cancellation
requests from the API. On start it recovers jobs a previous worker left in `running`.

An attestation job asks the evaluator's signer, which replays the committed candidate
itself before it signs (minutes for a live model), and polls it until it signs, refuses or
reports a failure. The evaluation job only queues it; it never waits for the signer.
"""

from __future__ import annotations

import logging
import os
import socket
import subprocess
import threading
import time
import traceback

from . import jobs, services
from .db import connect, migrate, now
from .evaluator import evaluate
from .redact import redact
from .strategies.catalog import STRATEGIES
from .strategies.harness import Budget, Harness

log = logging.getLogger("counterproof.worker")

TARGET_LABEL = "label=counterproof.target=1"  # the label sandbox.DockerBackend gives every target container


def sweep_stopped_targets() -> int:
    """Remove target containers that have stopped but were not removed (a crashed worker).

    Never a running one. Every target container carries the same label, whoever started it:
    another worker, and the evaluator's signer, which replays each committed candidate itself
    (minutes for a live model) before it signs. A child killed from outside ends its replay as
    `target_crash`, which counts as a replay that did not violate, so sweeping running
    containers could turn a valid finding into a final refusal. A running orphan is left
    alone: its `docker run -i` client died with its worker, which closes the container's
    stdin, so the target normally exits and `--rm` removes it; one that does not is left to
    the operator rather than risk killing a live replay. `docker rm` is called without -f,
    so a container that is running by then is refused, not killed.
    """
    try:
        r = subprocess.run(["docker", "ps", "-aq", "--filter", TARGET_LABEL, "--filter", "status=exited",
                            "--filter", "status=dead"], capture_output=True, text=True, timeout=10)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return 0
    ids = r.stdout.split() if r.returncode == 0 else []
    if ids:
        subprocess.run(["docker", "rm", *ids], capture_output=True, timeout=30)
    return len(ids)


def _sync_domain_after_recovery(conn, changed: list[dict]) -> None:
    for ch in changed:
        j = jobs.get(conn, ch["id"])
        p = j["params"]
        status = {"queued": "queued", "failed": "failed", "cancelled": "cancelled"}[ch["to"]]
        if j["kind"] == "search":
            conn.execute("UPDATE runs SET status=?, error=?, updated_at=? WHERE id=?",
                         (status, j["error"], now(), p["run_id"]))
        elif j["kind"] == "evaluation":
            conn.execute("UPDATE evaluations SET status=? WHERE id=?",
                         ("queued" if status == "queued" else "runner_failure" if status == "failed" else "cancelled", p["evaluation_id"]))
            if status != "queued":
                conn.execute("UPDATE evaluations SET outcome=?, finished_at=? WHERE id=?",
                             ("runner_failure" if status == "failed" else "cancelled", now(), p["evaluation_id"]))
        elif j["kind"] == "regression":
            conn.execute("UPDATE regressions SET status=? WHERE id=?", (status, p["regression_id"]))
        elif j["kind"] == "attestation" and status != "queued":
            services.log_activity(conn, "attestation.pending", f"Attestation not obtained: the job was {status} when its "
                                  "worker stopped; request it again", p.get("challenge_id"), p["evaluation_id"])


def _effective_budget(run: dict, spec: dict) -> dict:
    """Defence in depth: clamp the stored budget again to the owner's role caps before the
    harness sees it (rows queued before the API clamped, or edited in the database)."""
    from .limits import clamp_budget, role_of
    from .targets import registry

    target = registry.ADAPTERS.get(f"{spec['target']['adapter']}@{spec['target']['version']}")
    model_involved = run["mode"] == "model-assisted" or bool(target and target.requires_model)
    budget, _ = clamp_budget(run["budget"], role_of(run.get("owner")), model_involved)
    return budget


def _bind_spend(client, owner: str | None, job_id: str | None) -> None:
    """Attribute the client's model calls to who queued the job (ledger, per-session budget)."""
    client.owner = owner
    client.job_id = job_id


class Worker:
    def __init__(self, name: str | None = None, poll: float = 0.5):
        self.name = name or f"{socket.gethostname()}:{os.getpid()}"
        self.poll = poll
        self.conn = connect()
        migrate(self.conn)
        self.stop = threading.Event()

    def recover(self) -> list[dict]:
        changed = jobs.recover(self.conn)
        _sync_domain_after_recovery(self.conn, changed)
        try:
            sweep_stopped_targets()
        except Exception:
            pass
        for ch in changed:
            log.warning("recovered job %s (%s) -> %s", ch["id"], ch["kind"], ch["to"])
        return changed

    def run_forever(self) -> None:
        self.recover()
        last_recover = time.monotonic()
        while not self.stop.is_set():
            if time.monotonic() - last_recover > 15:
                self.recover()
                last_recover = time.monotonic()
            job = jobs.claim(self.conn, self.name)
            if job is None:
                time.sleep(self.poll)
                continue
            self.execute(job)

    def execute(self, job: dict) -> None:
        cancel = threading.Event()
        result: dict = {}
        holder: dict = {}

        def target():
            try:
                holder["result"] = self.handle(job, cancel)
            except Exception as e:  # recorded below; never crash the worker loop
                holder["error"] = f"{type(e).__name__}: {redact(str(e))[:500]}"
                holder["trace"] = redact(traceback.format_exc()[-2000:])

        t = threading.Thread(target=target, daemon=True)
        t.start()
        hb = connect()
        try:
            while t.is_alive():
                t.join(timeout=1.0)
                if jobs.heartbeat(hb, job["id"]) and not cancel.is_set():
                    cancel.set()
        finally:
            hb.close()
        if "error" in holder:
            log.error("job %s failed: %s", job["id"], holder["error"])
            jobs.finish(self.conn, job["id"], "failed", error=holder["error"])
            self._mark_failed(job, holder["error"])
        else:
            result = holder.get("result") or {}
            jobs.finish(self.conn, job["id"], "cancelled" if cancel.is_set() else "done", result=result)

    def _mark_failed(self, job: dict, error: str) -> None:
        p = job["params"]
        if job["kind"] == "search":
            self.conn.execute("UPDATE runs SET status='failed', error=?, updated_at=? WHERE id=?", (error, now(), p["run_id"]))
        elif job["kind"] == "evaluation":
            self.conn.execute("UPDATE evaluations SET status='runner_failure', outcome='runner_failure', finished_at=? WHERE id=?",
                              (now(), p["evaluation_id"]))
        elif job["kind"] == "regression":
            self.conn.execute("UPDATE regressions SET status='failed', finished_at=? WHERE id=?", (now(), p["regression_id"]))
        elif job["kind"] == "attestation":
            services.log_activity(self.conn, "attestation.pending", f"Attestation not obtained: {error[:300]}",
                                  p.get("challenge_id"), p["evaluation_id"])

    # ------------------------------------------------------------------ handlers
    def handle(self, job: dict, cancel: threading.Event) -> dict:
        kind = job["kind"]
        if kind == "search":
            return self._search(job["params"]["run_id"], cancel)
        if kind == "evaluation":
            return self._evaluation(job["params"]["evaluation_id"], cancel)
        if kind == "regression":
            return self._regression(job["params"]["regression_id"], job["params"]["candidate"], cancel)
        if kind == "attestation":
            return self._attestation(job["id"], job["params"]["evaluation_id"], cancel)
        raise ValueError(f"unknown job kind {kind}")

    def _search(self, rid: str, cancel: threading.Event) -> dict:
        conn = self.conn
        run = services.get_run(conn, rid)
        c = services.get_challenge(conn, run["challenge_id"])
        spec = services.get_spec(conn, c["spec_digest"])
        conn.execute("UPDATE runs SET status='running', updated_at=? WHERE id=?", (now(), rid))
        services.log_activity(conn, "run.started", f"{run['strategy']} started", c["id"], rid)
        from .chain import challenger_identity
        from .providers import broker_for_spec, provenance_for

        challenger, recipient = challenger_identity()
        budget = Budget(**{k: v for k, v in _effective_budget(run, spec).items() if k in Budget.__dataclass_fields__})
        broker = broker_for_spec(spec, budget)
        if broker is not None:
            broker.client.cancel = cancel
            _bind_spend(broker.client, run.get("owner"), run.get("job_id"))
        last = [0.0]

        def progress(record: dict) -> None:
            if time.monotonic() - last[0] > 0.5:
                last[0] = time.monotonic()
                services.save_run_progress(conn, rid, record)

        if run["strategy"] == "model-assisted":
            from .strategies.model_assisted import ModelAssisted

            gen = ModelAssisted(spec, run["params"], budget)
            gen.client.cancel = cancel
            _bind_spend(gen.client, run.get("owner"), run.get("job_id"))
            proposals, model_label = gen.proposals(), gen.label
        else:
            proposals, model_label = STRATEGIES[run["strategy"]]["fn"](spec, run["params"]), None
        h = Harness(spec=spec, spec_dgst=c["spec_digest"], strategy=run["strategy"], params=run["params"], budget=budget,
                    challenger=challenger, recipient=recipient, run_id=rid, cancel=cancel, progress=progress,
                    broker=broker, model_label=model_label)
        if run["strategy"] == "model-assisted":
            gen.bind(h)
        record = h.explore(proposals).as_dict()
        record["provenance"] = provenance_for(spec, run, broker)
        if run["strategy"] == "model-assisted":
            record["provenance"]["generator"] = {
                "model": gen.label, "calls": gen.calls,
                "note": "model proposals are inputs only; candidates come from the deterministic checker"}
        ids = services.save_candidates(conn, c["id"], rid, record["candidates"])
        record["candidate_ids"] = ids
        if cancel.is_set():
            status = "cancelled"
        elif record["termination"].startswith("failed"):
            status = "failed"
        elif record["sequences_tried"] == 0 and not ids:
            # Nothing was tested: never report this as "no violation found".
            status = "failed"
            record["termination"] = f"failed: no sequence was tested ({record['termination']})"
        else:
            status = "candidate_found" if ids else "no_violation_found"
        services.save_run_progress(conn, rid, record, status)
        conn.execute("UPDATE runs SET provenance=?, error=? WHERE id=?",
                     (services.dumps(record["provenance"]), "; ".join(record["errors"][:3]) or None, rid))
        if status == "failed":
            msg = (f"{run['strategy']}: failed after {record['sequences_tried']} counted sequence(s) - {record['termination']}"
                   + (f"; {len(ids)} candidate(s) recorded before the failure" if ids else ""))
        elif status == "cancelled":
            msg = f"{run['strategy']}: cancelled after {record['sequences_tried']} sequence(s)"
        elif ids:
            msg = f"{run['strategy']}: {len(ids)} candidate(s) for {', '.join(record['rules_violated'])}"
        else:
            msg = f"{run['strategy']}: no violation found in {record['sequences_tried']} sequences ({record['termination']})"
        services.log_activity(conn, f"run.{status}", msg, c["id"], rid)
        return {"status": status, "candidates": ids}

    def _evaluation(self, eid: str, cancel: threading.Event) -> dict:
        conn = self.conn
        spec, d, candidate, submission = services.evaluation_inputs(conn, eid)
        conn.execute("UPDATE evaluations SET status='replaying' WHERE id=?", (eid,))
        e = services.get_evaluation(conn, eid)
        if e["candidate_id"]:
            conn.execute("UPDATE candidates SET status='replaying' WHERE id=?", (e["candidate_id"],))
        from .providers import broker_for_spec, recording_broker

        broker = broker_for_spec(spec, None)
        if broker is not None:
            broker.client.cancel = cancel
            _bind_spend(broker.client, e.get("owner"), e.get("job_id"))
        recorder = recording_broker(broker)  # what the model proposed, per replay (sidecar, not evidence)
        bundle = evaluate(spec=spec, spec_dgst=d, candidate=candidate, submission=submission,
                          broker=recorder or broker, cancel=cancel, on_replay=recorder and recorder.on_replay)
        services.save_model_proposals(conn, "evaluations", eid, recorder, bundle)
        e = services.record_evaluation(conn, eid, bundle)
        out = {"outcome": bundle["verdict"]["outcome"], "evidence_digest": e["evidence_digest"]}
        if bundle["verdict"]["outcome"] == "verified_violation" and bundle["verdict"]["reward_eligible"] and \
                services.get_challenge(conn, e["challenge_id"])["status"] == "funded":
            from .chain import enqueue_attestation

            out["attestation_job"] = enqueue_attestation(conn, eid)["id"]
        return out

    def _attestation(self, job_id: str, eid: str, cancel: threading.Event) -> dict:
        """Poll the signer until it signs, refuses or fails (it replays the candidate itself)."""
        from . import chain

        conn = self.conn
        cid = services.get_evaluation(conn, eid)["challenge_id"]
        deadline = time.monotonic() + chain.ATTESTATION_POLL_LIMIT
        announced = False
        last: dict = {}
        first = True
        while True:
            if cancel.is_set():
                return {"status": "cancelled", **last}
            try:
                # The first call is the request (it may retry a failed verification); the
                # rest only poll its outcome, so a provider failure is reported, not re-run.
                res = chain.request_attestation(conn, eid, retry_failed=first)
                first = first and res["status"] == "unavailable"
            except chain.ChainError as ex:
                services.log_activity(conn, "attestation.refused", f"Attestation not requested: {redact(str(ex))[:300]}", cid, eid)
                return {"status": "not_requested", "detail": redact(str(ex))[:300]}
            last = {k: v for k, v in res.items() if k != "attestation"}
            jobs.progress(conn, job_id, last)
            status = res["status"]
            if status == "signed":
                a = res["attestation"]
                return {"status": "signed", "change": res.get("change"), "attestation_id": a["id"], "expiry": a["expiry"],
                        "evidence_digest": a.get("evidence_digest"), "verification": a.get("verification")}
            if status == "refused":
                services.log_activity(conn, "attestation.refused", "The evaluator's signer refused: "
                                      + "; ".join(res["refused"])[:400], cid, eid)
                return last
            if status == "failed":
                services.log_activity(conn, "attestation.failed", ("The evaluator's signer could not complete its own replay "
                                      f"(not a verdict; request the attestation again to retry): {res['detail']}")[:500], cid, eid)
                return last
            if status == "pending" and not announced:
                announced = True
                v = res.get("verification") or {}
                what = (f"{v.get('replays')} fresh {v.get('mode')} replay(s), at least {v.get('required')} must violate the rule"
                        if v.get("replays") else "another submission for this challenge first")
                services.log_activity(conn, "attestation.verifying", "The evaluator's signer is replaying the committed "
                                      f"candidate itself before it signs ({what})", cid, eid)
            if time.monotonic() > deadline:
                services.log_activity(conn, "attestation.pending", "Attestation not obtained yet: the signer had not finished "
                                      f"after {int(chain.ATTESTATION_POLL_LIMIT)} s ({last.get('detail') or status}); "
                                      "request it again", cid, eid)
                return {**last, "status": "timed_out"}
            cancel.wait(chain.ATTESTATION_POLL_SECONDS)

    def _regression(self, rid: str, candidate: dict, cancel: threading.Event) -> dict:
        conn = self.conn
        r = services.get_regression(conn, rid)
        spec = services.get_spec(conn, r["spec_digest"])
        conn.execute("UPDATE regressions SET status='replaying' WHERE id=?", (rid,))
        from .providers import broker_for_spec, recording_broker

        broker = broker_for_spec(spec, None)
        if broker is not None:
            broker.client.cancel = cancel
            _bind_spend(broker.client, r.get("owner"), r.get("job_id"))
        recorder = recording_broker(broker)
        bundle = evaluate(spec=spec, spec_dgst=r["spec_digest"], candidate=candidate,
                          submission={"submission_id": f"regression:{rid}", "challenger": candidate["challenger"],
                                      "recipient": candidate["recipient"]},
                          broker=recorder or broker, cancel=cancel, on_replay=recorder and recorder.on_replay)
        services.save_model_proposals(conn, "regressions", rid, recorder, bundle)
        r = services.record_regression(conn, rid, bundle)
        return {"outcome": r["outcome"]}  # the regression's reading, not only the evaluator's verdict


def main() -> None:
    os.environ.setdefault("COUNTERPROOF_ROLE", "worker")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    w = Worker()
    log.info("worker %s started", w.name)
    try:
        w.run_forever()
    except KeyboardInterrupt:
        log.info("worker stopping")


if __name__ == "__main__":
    main()
