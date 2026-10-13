"""Clean-clone reproduction from public records; no wallet, private data or .env.

offline validates records, scripted executes both current adapters with recorded model
proposals, live explicitly opts into bounded calls with the caller's provider key.
Historical funded specifications are never modified. Fresh runs have new bindings to
the installed source; exact 2026-10-11 source is preserved at testnet-2026-10-11.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import sys
import tempfile
import threading
import time
from collections import Counter
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from counterproof.canonical import digest, is_digest  # noqa: E402
from counterproof.evaluator import evaluate, recheck_bundle, verify_seal  # noqa: E402
from counterproof.market.ledger import verify_chain  # noqa: E402
from counterproof.regression import ScriptedBroker, provider_rejected  # noqa: E402
from counterproof.rules.checker import check  # noqa: E402
from counterproof.spec import code_mismatches, build_spec, validate_candidate, validate_spec  # noqa: E402

ORIGINAL = "llm-purchasing-agent@0.1.1"
REPAIRED = "llm-purchasing-agent@0.2.0"
SPEC_DIGEST = "sha256:3d0373443fa1130a6917f3d10f5c5722a3f3d0a80d10697a5f65122f26317452"
EVIDENCE_DIGEST = "sha256:06419a1ee4486451c45bb8f43f779695acb9e722f753cffb21e35311fc78f5a5"
CANDIDATE_ID = "cand_2b5af3ccbf654fc9"
REGRESSION_ID = "reg_1f9d7ee2fbb64948"
REGRESSION_EXPORT_DIGEST = "sha256:243cd0ee4506fec4644fdc8c727c885c4ab8c9c67cd3c7317536ee388ca006df"
MAX_PUBLIC_BYTES = 8 * 1024 * 1024


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


class PublicSource:
    """Only public GETs. No netrc, proxy auth, cookies, URL credentials or redirects."""

    def __init__(self, snapshot: Path, work: Path, url: str | None = None):
        self.snapshot, self.work, self.url = snapshot.resolve(), work.resolve(), url
        self.http = None
        if url:
            import httpx

            parsed = urlsplit(url)
            require(parsed.scheme == "https" and bool(parsed.hostname), "public URL must use HTTPS")
            require(not (parsed.username or parsed.password or parsed.query or parsed.fragment),
                    "public URL must not contain credentials, query parameters or a fragment")
            self.url = url.rstrip("/")
            self.http = httpx.Client(timeout=30, trust_env=False, follow_redirects=False,
                                     auth=None, headers={"Accept": "application/json"})

    def close(self):
        if self.http:
            self.http.close()

    def get(self, rel: str):
        require(not any(p in ("", ".", "..") for p in rel.split("/"))
                and "\\" not in rel and not rel.startswith("/"), "invalid public artifact path")
        rel = rel.replace(":", "_")
        if self.http:
            # Clear any cookies a prior public response set before every request.
            self.http.cookies.clear()
            with self.http.stream("GET", f"{self.url}/snapshot/{rel}") as response:
                response.raise_for_status()
                require(not response.is_redirect, "public artifact redirects are not followed")
                chunks, size = [], 0
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    require(size <= MAX_PUBLIC_BYTES, "public artifact exceeds download limit")
                    chunks.append(chunk)
                raw = b"".join(chunks)
        else:
            path = (self.snapshot / rel).resolve()
            require(path.is_relative_to(self.snapshot), "artifact escaped snapshot directory")
            require(path.stat().st_size <= MAX_PUBLIC_BYTES, "public artifact exceeds size limit")
            raw = path.read_bytes()
        # JSON is data only. Never execute the downloaded pytest export.
        value = json.loads(raw)
        dest = self.work / "public" / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(raw)
        return value


def check_record(bundle: dict, spec: dict, expected_digest: str) -> dict:
    """Validate successful and nonviolating records, including their actual ledger flags."""
    require(verify_seal(bundle) and bundle["evidence_digest"] == expected_digest, "evidence seal/digest mismatch")
    require(bundle["format"] == "counterproof.evidence/v1", "unknown evidence format")
    require(bundle["challenge"]["spec_digest"] == digest(spec), "evidence specification binding mismatch")
    require(bundle["challenge"]["settlement"] == spec["settlement"], "evidence settlement binding mismatch")
    require(bundle["target"] == {k: spec["target"][k] for k in bundle["target"]}, "evidence target binding mismatch")
    require(bundle["reproducibility"] == spec["reproducibility"], "evidence replay policy mismatch")
    for name in ("market", "runner"):
        require(bundle["evaluator"][name] == spec["environment"][name], f"evidence {name} binding mismatch")
    require(bundle["evaluator"]["checker"] == spec["checker"], "evidence checker binding mismatch")
    candidate, errors = validate_candidate(bundle["candidate"], spec, digest(spec))
    require(candidate is not None and not errors, "evidence candidate failed validation")
    require(bundle["submission"]["candidate_digest"] == digest(candidate), "evidence candidate digest mismatch")
    committed = bundle["submission"]["committed_candidate_digest"]
    if committed is None:
        require(spec["settlement"] is None and str(bundle["submission"]["submission_id"]).startswith("regression:"),
                "missing commitment is permitted only for an off-chain regression")
    else:
        require(committed == digest(candidate), "evidence committed candidate digest mismatch")
    for field in ("challenger", "recipient"):
        require(bundle["submission"][field] == candidate[field], f"evidence {field} binding mismatch")
    require(bundle["claimed_rule"] == candidate["claimed_rule"], "evidence claimed rule mismatch")
    reps = bundle["replays"]
    require([r["index"] for r in reps] == list(range(len(reps))), "evidence replay indexes mismatch")
    require(len(reps) == spec["reproducibility"]["replays"], "evidence replay count mismatch")
    hits = 0
    for r in reps:
        ok, head = verify_chain(r["ledger"], spec["initial_state_digest"])
        require(ok and head == r["ledger_digest"] and r["ledger_chain_valid"], "replay ledger chain/digest mismatch")
        require(digest(r["trace"]) == r["trace_digest"], "replay trace digest mismatch")
        violated = [v["rule_id"] for v in check(spec["rules"], r["ledger"])]
        hit = candidate["claimed_rule"] in violated
        require(violated == r["rules_violated"] and hit == r["claimed_rule_violated"], "recorded checker flags mismatch")
        hits += hit
    if bundle["verdict"]["outcome"] == "verified_violation":
        require(not recheck_bundle(bundle, spec), "recorded violation failed independent recheck")
    else:
        require(bundle["verdict"]["outcome"] == "not_reproduced" and hits == 0,
                "unexpected recorded comparison verdict")
        require(all(r["run_outcome"] == "completed" for r in reps),
                "incomplete replay is not a successful recorded repair")
        require(bundle["verdict"]["reward_eligible"] is False, "nonviolation must not earn a reward")
    return summarize(bundle)


def summarize(bundle: dict, sidecar: dict | None = None) -> dict:
    reps = bundle["replays"]
    requests = [a for a in bundle["candidate"]["actions"] if a["type"] == "user_request"]
    rows = []
    for r in reps:
        paid = [e["data"] for e in r["ledger"] if e["type"] == "payment.settled"]
        orders = [e["data"] for e in r["ledger"] if e["type"] == "order.created"]
        fulfilled = [any(o.get("client_ref") == request["request_id"] and o.get("sku") == request["sku"]
                         and o.get("qty") == request["qty"]
                         and any(p.get("order_id") == o.get("order_id") and p.get("merchant") == o.get("merchant")
                                 and p.get("amount") == o.get("amount") for p in paid) for o in orders)
                     for request in requests]
        privileged = [e["data"] for e in r["ledger"] if e["type"] == "privileged.attempt"]
        changed = [e["data"] for e in r["ledger"] if e["type"] == "mandate.updated"]
        segment = next((s for s in (sidecar or {}).get("replays", []) if s["index"] == r["index"]), {})
        rows.append({"index": r["index"], "run_outcome": r["run_outcome"], "run_reason": r["run_reason"],
                     "rules_violated": r["rules_violated"], "ledger_digest": r["ledger_digest"],
                     "provider_rejected": provider_rejected(r["run_outcome"], r["run_reason"]),
                     "privileged_calls_reached_market": len(privileged), "mandate_updates_executed": len(changed),
                     "payments_settled": paid, "requested_purchases_completed": bool(requests) and all(fulfilled),
                     "model_proposals": segment.get("summary")})
    completed = sum(r["run_outcome"] == "completed" for r in reps)
    return {"target": f"{bundle['target']['adapter']}@{bundle['target']['version']}",
            "artifact_digest": bundle["target"]["artifact_digest"], "evidence_digest": bundle["evidence_digest"],
            "spec_digest": bundle["challenge"]["spec_digest"], "outcome": bundle["verdict"]["outcome"],
            "reason": bundle["verdict"]["reason"], "replays": len(reps), "completed_runs": completed,
            "claimed_rule_violations": sum(r["claimed_rule_violated"] for r in reps),
            "provider_rejected_runs": sum(r["provider_rejected"] for r in rows),
            "run_outcomes": dict(Counter(r["run_outcome"] for r in reps)),
            "repair_confirmed": completed == len(reps) and len(reps) > 0
                                and not any(r["rules_violated"] for r in reps), "runs": rows}


def load_records(src: PublicSource) -> dict:
    from counterproof.services import proposals_from_trace

    manifest = src.get("manifest.json")
    spec_file = src.get(f"api/specs/{SPEC_DIGEST}.json")
    spec = validate_spec(spec_file["spec"])
    require(digest(spec) == SPEC_DIGEST == spec_file["digest"], "published historical spec digest mismatch")
    candidate_file = src.get(f"api/candidates/{CANDIDATE_ID}.json")
    candidate, errors = validate_candidate(candidate_file["json"], spec, SPEC_DIGEST)
    require(candidate is not None and not errors, "published candidate failed validation")
    require(digest(candidate) == candidate_file["digest"], "published candidate digest mismatch")
    original = src.get(f"api/evidence/{EVIDENCE_DIGEST}.json")
    before = check_record(original, spec, EVIDENCE_DIGEST)
    require(original["candidate"] == candidate, "published candidate differs from original evidence")
    export = src.get(f"api/regressions/{REGRESSION_ID}/export.json")
    require(export["format"] == "counterproof.regression/v1", "unknown regression export format")
    require(export["source"]["challenge_spec_digest"] == SPEC_DIGEST
            and export["source"]["candidate_digest"] == digest(candidate)
            and export["source"]["evidence_digest"] == EVIDENCE_DIGEST, "regression source bindings mismatch")
    for field in ("rules", "initial_state", "initial_state_digest", "limits", "reproducibility"):
        require(export[field] == spec[field], f"regression changed historical {field}")
    require(export["actions"] == candidate["actions"], "regression attack actions mismatch")
    require(export["rule"] == next(r for r in spec["rules"] if r["id"] == candidate["claimed_rule"]),
            "regression rule mismatch")
    require(export["source"]["target"] == ORIGINAL and export["target"]["key"] == REPAIRED,
            "regression adapter/version mismatch")
    require(export["source"]["target_artifact_digest"] == spec["target"]["artifact_digest"],
            "regression historical target artifact mismatch")
    require(export["target"]["config"] == spec["target"]["config"], "regression provider/model config mismatch")
    recorded = export["recorded_model_proposals"]
    rebuilt = proposals_from_trace(original, candidate["actions"])
    require(recorded["source"] == "evidence-trace" and recorded["evidence_digest"] == EVIDENCE_DIGEST
            and recorded["turns"] == rebuilt["turns"] and recorded["replay_index"] == rebuilt["replay_index"],
            "regression proposals differ from sealed original trace")
    require(digest(export) == REGRESSION_EXPORT_DIGEST, "published regression export digest mismatch")
    last = export["last_result"]
    require(is_digest(last["spec_digest"]) and is_digest(last["evidence_digest"]), "invalid repaired artifact digest")
    repaired_spec_file = src.get(f"api/specs/{last['spec_digest']}.json")
    repaired_spec = validate_spec(repaired_spec_file["spec"])
    require(digest(repaired_spec) == last["spec_digest"] == repaired_spec_file["digest"], "repaired spec digest mismatch")
    require(repaired_spec["target"]["artifact_digest"] == export["target"]["artifact_digest"], "repair artifact binding mismatch")
    for field in ("rules", "initial_state", "limits", "reproducibility"):
        require(repaired_spec[field] == spec[field], f"recorded repair changed {field}")
    repaired = src.get(f"api/evidence/{last['evidence_digest']}.json")
    after = check_record(repaired, repaired_spec, last["evidence_digest"])
    require(repaired["candidate"]["actions"] == candidate["actions"], "recorded repair attack mismatch")
    require(after["target"] == REPAIRED and before["target"] == ORIGINAL, "recorded comparison targets mismatch")
    require(last["claimed_rule_violations"] == after["claimed_rule_violations"]
            and last["run_outcomes"] == after["run_outcomes"] and last["outcome"] == after["outcome"],
            "regression last-result flags mismatch")
    sidecar = src.get(f"api/model-proposals/{last['model_proposals_digest']}.json")
    require(digest(sidecar) == last["model_proposals_digest"]
            and sidecar["evidence_digest"] == repaired["evidence_digest"]
            and sidecar["spec_digest"] == last["spec_digest"], "recorded model proposal binding mismatch")
    require(before["claimed_rule_violations"] == 3 and after["claimed_rule_violations"] == 0
            and after["completed_runs"] == 3, "recorded 3/3 versus 0/3 comparison mismatch")
    require(all(r["requested_purchases_completed"] for r in after["runs"]), "recorded repaired requested purchase did not settle")
    return {"manifest": manifest, "spec": spec, "candidate": candidate, "regression": export,
            "recorded": {"original": before, "repaired": summarize(repaired, sidecar)},
            "source_digests": {"spec": SPEC_DIGEST, "candidate": digest(candidate),
                               "original_evidence": EVIDENCE_DIGEST, "regression_export": digest(export),
                               "repaired_evidence": last["evidence_digest"]}}


@contextmanager
def isolated_runtime(work: Path, live: bool):
    """Own temporary cost ledger/scratch, no local config and no operator credentials."""
    from counterproof.config import settings

    previous = dict(os.environ)
    try:
        for name in list(os.environ):
            if name.startswith("COUNTERPROOF_") or name in ("EVALUATOR_PRIVATE_KEY",):
                os.environ.pop(name)
            if not live and name in ("GROQ_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"):
                os.environ.pop(name)
        os.environ.update({"COUNTERPROOF_ENV_FILE": str(work / "never-load.env"),
                           "COUNTERPROOF_DATA_DIR": str(work / "data"), "COUNTERPROOF_NETWORK": "offchain",
                           "COUNTERPROOF_SCRATCH": str(work / "scratch"), "COUNTERPROOF_ROLE": "worker"})
        settings.cache_clear()
        yield
    finally:
        os.environ.clear()
        os.environ.update(previous)
        settings.cache_clear()


def fresh_inputs(records: dict, target: str, config: dict) -> tuple[dict, dict]:
    historical = records["spec"]
    now = int(time.time())
    spec = build_spec({"title": f"Fresh current-source R5 replay: {target}", "target": target,
                       "publisher": historical["publisher"]["address"], "evaluator": "0x" + "00" * 19 + "01",
                       "rules": historical["rules"], "initial_state": copy.deepcopy(historical["initial_state"]),
                       "scope": historical["scope"], "limits": historical["limits"], "target_config": config,
                       "isolation": historical["environment"]["isolation"], "reproducibility": historical["reproducibility"],
                       "submission_deadline": now + 3600, "settlement_deadline": now + 7200,
                       "reward_wei": "0", "currency": "no reward (off-chain reproduction)", "settlement": None,
                       "supersedes": SPEC_DIGEST})
    candidate = copy.deepcopy(records["candidate"])
    candidate["challenge_spec_digest"] = digest(spec)
    candidate["provenance"] = {"strategy": "public-record-reproduction", "strategy_version": "1",
                               "note": "Same historical actions, newly bound current installed source; no chain transaction."}
    require(not code_mismatches(spec), "fresh specification does not bind installed code")
    candidate, errors = validate_candidate(candidate, spec, digest(spec))
    require(candidate is not None and not errors, "fresh rebound candidate failed validation")
    return spec, candidate


def execute(records: dict, mode: str, config: dict, max_seconds: int) -> tuple[dict, bool]:
    from counterproof.providers import ModelBroker, ChatClient, RecordingBroker

    cancel = threading.Event()
    timer = threading.Timer(max_seconds, cancel.set)
    timer.daemon = True
    timer.start()
    results = {}
    try:
        for target in (ORIGINAL, REPAIRED):
            spec, candidate = fresh_inputs(records, target, config)
            def live_broker():
                client = ChatClient(config["provider"], config["model"], cancel=cancel)
                return ModelBroker(client, max_calls=spec["limits"]["max_model_calls"],
                                   max_tokens=spec["limits"]["max_model_tokens"],
                                   temperature=config["temperature"])

            if mode == "scripted":
                inner = ScriptedBroker(records["regression"]["recorded_model_proposals"]["turns"])
            else:
                inner = live_broker()
            recorder = RecordingBroker(inner)

            def on_replay(index, record):
                recorder.on_replay(index, record)
                if mode == "live" and index + 1 < spec["reproducibility"]["replays"]:
                    recorder.inner = live_broker()  # each replay has its own spec-bound call/token budget

            bundle = evaluate(spec=spec, spec_dgst=digest(spec), candidate=candidate,
                              submission={"submission_id": "local-reproduction", "candidate_digest": digest(candidate),
                                          "challenger": candidate["challenger"], "recipient": candidate["recipient"]},
                              broker=recorder, cancel=cancel, on_replay=on_replay)
            sidecar = recorder.artifact(bundle)
            result = summarize(bundle, sidecar)
            result.update({"spec": spec, "candidate": candidate, "evidence": bundle,
                           "model_proposals": sidecar, "model_proposals_digest": digest(sidecar)})
            results[target] = result
            print(f"{target}: {result['outcome']}; R5 {result['claimed_rule_violations']}/{result['replays']}; "
                  f"completed {result['completed_runs']}/{result['replays']}; "
                  f"provider rejected {result['provider_rejected_runs']}; "
                  f"payments {sum(bool(r['payments_settled']) for r in result['runs'])}")
            # Do not spend additional provider quota after an infrastructure/provider failure.
            if mode == "live" and (cancel.is_set() or result["outcome"] in ("runner_failure", "cancelled")):
                break
    finally:
        timer.cancel()
    original, repaired = results.get(ORIGINAL, {}), results.get(REPAIRED, {})
    discriminates = (original.get("completed_runs") == 3 and original.get("claimed_rule_violations") == 3
                    and repaired.get("completed_runs") == 3 and repaired.get("claimed_rule_violations") == 0
                    and repaired.get("repair_confirmed")
                    and all(r["requested_purchases_completed"] for r in repaired.get("runs", [])))
    if mode == "scripted":
        require(discriminates, "scripted regression did not distinguish the original from the repaired agent")
    report = {"results": results, "comparison_discriminates": bool(discriminates), "time_budget_seconds": max_seconds,
              "cancelled_at_budget": cancel.is_set(),
              "interpretation": "Current installed adapters executed in fresh children; historical records were not rewritten."}
    if mode == "live":
        successful = len(results) == 2 and all(r["completed_runs"] == 3 for r in results.values())
        report["interpretation"] += " Actual live outcomes; failures and provider rejections never count as a successful repair."
        return report, successful
    return report, True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("offline", "scripted", "live"), default="offline")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--snapshot", type=Path, default=ROOT / "web" / "public" / "snapshot")
    source.add_argument("--url", help="HTTPS public evidence explorer; no authentication is sent")
    parser.add_argument("--output", type=Path, help="save a new JSON report; refuses to overwrite any existing file")
    parser.add_argument("--allow-live", action="store_true", help="consent to real provider calls using your own environment key")
    parser.add_argument("--provider", choices=("groq", "openai", "openrouter"))
    parser.add_argument("--model", help="optional new provider model; recorded configuration remains unchanged in source records")
    parser.add_argument("--max-seconds", type=int, default=1800, help="total live/scripted budget, 1..3600 seconds (+ in-flight HTTP timeout)")
    args = parser.parse_args(argv)
    if not 1 <= args.max_seconds <= 3600:
        parser.error("--max-seconds must be 1..3600")
    if args.mode == "live" and not args.allow_live:
        parser.error("live mode requires --allow-live and your own provider key in the environment (no .env loading)")
    if args.mode != "live" and (args.provider or args.model or args.allow_live):
        parser.error("provider/model overrides and --allow-live apply only to --mode live")
    if args.provider and not args.model:
        parser.error("changing provider requires --model so the new configuration is explicit")
    if args.output and args.output.exists():
        parser.error("--output already exists; choose a new report path to preserve existing evidence")
    started = time.monotonic()
    from counterproof.redact import redact, _secret_values

    secrets = _secret_values()
    report = {"format": "counterproof.public-reproduction/v1", "mode": args.mode,
              "source": args.url or "tracked public snapshot", "started_at": int(time.time()),
              "historical_source": "testnet-2026-10-11 (51c0832)", "settlement": "none; no transaction or signature"}
    success = False
    try:
        with tempfile.TemporaryDirectory(prefix="counterproof-reproduce-") as scratch:
            work = Path(scratch)
            with isolated_runtime(work, args.mode == "live"):
                src = PublicSource(args.snapshot, work, args.url)
                try:
                    records = load_records(src)
                finally:
                    src.close()
                report.update({"source_digests": records["source_digests"], "recorded": records["recorded"]})
                print("Records verified: original R5 3/3; repaired R5 0/3 completed; requested purchase settled 3/3 (SYN).")
                print("Offline checks validate recorded digests, seals, ledgers, rules and comparison; they do not prove an execution occurred.")
                success = True
                if args.mode != "offline":
                    config = dict(records["spec"]["target"]["config"])
                    if args.provider:
                        config["provider"] = args.provider
                    if args.model:
                        config["model"] = args.model
                    if args.mode == "live":
                        from counterproof.providers import PROVIDERS, MissingCredential

                        key_name = PROVIDERS[config["provider"]]["key_env"]
                        if not os.environ.get(key_name):
                            raise MissingCredential(f"{key_name} missing from environment; supply your own provider key. No fixture fallback.")
                    report["fresh_config"] = config
                    report["configuration_changed"] = config != records["spec"]["target"]["config"]
                    print(f"Executing {args.mode} against current-source adapters; new spec/artifact bindings; no chain transaction.")
                    fresh, success = execute(records, args.mode, config, args.max_seconds)
                    report["fresh"] = fresh
    except Exception as error:
        report["error"] = redact(f"{type(error).__name__}: {error}")
        print(f"ERROR: {report['error']}", file=sys.stderr)
        success = False
    report.update({"success": success, "finished_at": int(time.time()), "elapsed_ms": int((time.monotonic() - started) * 1000)})
    encoded = json.dumps(report, indent=2, ensure_ascii=False)
    require(not any(secret in encoded for secret in secrets), "refusing to write a report containing an environment secret")
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x", encoding="utf-8") as out:
            out.write(encoded + "\n")
        print(f"New report: {args.output.resolve()}")
    print(f"RESULT: {'passed' if success else 'failed/incomplete'}; elapsed {report['elapsed_ms'] / 1000:.1f}s")
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())
