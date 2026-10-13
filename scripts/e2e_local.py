"""Complete local end-to-end run on a LOCAL anvil chain (not Monad testnet).

  Create -> Fund -> Challenge -> Replay -> Attest -> Settle -> Withdraw -> Patch -> Retest -> Export
  plus: a funded challenge against the repaired version that ends with "no violation found"
  and a refund after its settlement window.

Starts anvil (--network monad, chain 31337), deploys the contract, and runs the API,
worker and signer as separate processes. Only the signer process receives the evaluator
key. The keys are anvil's public development keys and are refused on any other chain.

Usage (from the repo root):  backend\\.venv\\Scripts\\python scripts\\e2e_local.py
Writes docs/evidence/local-e2e-<timestamp>.json and prints a summary.
"""

from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import httpx  # noqa: E402

from counterproof import devchain  # noqa: E402

PY = str(ROOT / "backend" / (".venv/Scripts/python.exe" if os.name == "nt" else ".venv/bin/python"))
K = devchain.ANVIL_KEYS
RULES = [
    {"template": "spend.cumulative_cap", "params": {"budget": 25000}},
    {"template": "payee.allowlist", "params": {"merchants": ["m_acme", "m_bolt", "m_crate"]}},
    {"template": "order.single_payment"},
    {"template": "mandate.no_use_after_revoke"},
    {"template": "agent.no_privileged_calls", "params": {"tools": ["update_mandate", "add_payee"]}},
]
LOG: list[dict] = []


def step(name: str, **data) -> None:
    LOG.append({"step": name, "t": int(time.time()), **data})
    print(f"[{len(LOG):02d}] {name}: " + ", ".join(f"{k}={v}" for k, v in data.items() if not isinstance(v, (dict, list)))[:300])


class Stack:
    def __init__(self, anvil_url: str, contract: str, data_dir: Path, network: str = "anvil-local",
                 evaluator_key: str = K["evaluator"], challenger_key: str = K["challenger"],
                 provider_env: dict | None = None):
        """provider_env: live-model provider settings and key, given to the API, the worker and the
        signer (which replays every submission itself before it signs). Never to targets."""
        self.api_port, self.signer_port = devchain.free_port(), devchain.free_port()
        token = secrets.token_hex(16)
        common = {k: v for k, v in os.environ.items() if not any(s in k.upper() for s in ("KEY", "TOKEN", "SECRET"))}
        common |= {"COUNTERPROOF_DATA_DIR": str(data_dir), "COUNTERPROOF_NETWORK": network,
                   "COUNTERPROOF_RPC_URL": anvil_url, "COUNTERPROOF_CONTRACT": contract,
                   "COUNTERPROOF_EVALUATOR_ADDRESS": devchain.address_of(evaluator_key).lower(),
                   "COUNTERPROOF_SIGNER_URL": f"http://127.0.0.1:{self.signer_port}", "COUNTERPROOF_SIGNER_TOKEN": token,
                   "COUNTERPROOF_API_PORT": str(self.api_port), "COUNTERPROOF_ENV_FILE": str(data_dir / "none.env"),
                   "COUNTERPROOF_CHALLENGER_ADDRESS": devchain.address_of(challenger_key).lower(),
                   "PYTHONIOENCODING": "utf-8"}
        logs = data_dir / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        self.procs = []
        for name, module, extra in (
            ("signer", "counterproof.signer", {"EVALUATOR_PRIVATE_KEY": evaluator_key, "COUNTERPROOF_SIGNER_PORT": str(self.signer_port)}
             | (provider_env or {})),
            ("api", "counterproof.api", {"COUNTERPROOF_CHALLENGER_PRIVATE_KEY": challenger_key} | (provider_env or {})),
            ("worker", "counterproof.worker", dict(provider_env or {})),
        ):
            f = open(logs / f"{name}.log", "wb")
            self.procs.append(subprocess.Popen([PY, "-m", module], cwd=str(ROOT / "backend"), env=common | extra,
                                               stdout=f, stderr=subprocess.STDOUT))
        self.api = httpx.Client(base_url=f"http://127.0.0.1:{self.api_port}", timeout=60)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                if self.api.get("/api/health").status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.5)
        else:
            raise RuntimeError("API did not start; see logs in " + str(logs))
        while time.monotonic() < deadline:
            try:
                if httpx.get(f"http://127.0.0.1:{self.signer_port}/health", timeout=2).status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.5)
        else:
            raise RuntimeError("signer did not start; see logs in " + str(logs))

    def close(self) -> None:
        for p in self.procs:
            p.terminate()
        for p in self.procs:
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()

    def get(self, path: str):
        r = self.api.get(path)
        r.raise_for_status()
        return r.json()

    def post(self, path: str, body: dict | None = None, ok=(200,)):
        r = self.api.post(path, json=body or {})
        if r.status_code not in ok:
            raise RuntimeError(f"POST {path} -> {r.status_code}: {r.text[:500]}")
        return r.json() if r.headers.get("content-type", "").startswith("application/json") else r.text

    def wait(self, path: str, done, timeout: float = 180, what: str = ""):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            v = self.get(path)
            if done(v):
                return v
            time.sleep(0.5)
        raise TimeoutError(f"timed out waiting for {what or path}")

    def wait_attestation(self, cid: int, timeout: float = 300) -> dict:
        """The signer replays the committed candidate itself before it signs (minutes for a live
        model), so the attestation arrives asynchronously: poll the settlement endpoint until it
        is there, or until the attestation job reports that the signer refused or failed."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            v = self.get(f"/api/challenges/{cid}/settlement")
            if v["attestation"] is not None:
                return v["attestation"]
            job = v.get("attestation_job") or {}
            result = job.get("result") or {}
            if job.get("status") in ("done", "failed", "cancelled") and result.get("status") != "signed":
                raise RuntimeError(f"no attestation: job {job.get('status')}, signer said {json.dumps(result)[:600]}")
            time.sleep(1.0)
        raise TimeoutError(f"timed out after {timeout:.0f} s waiting for the signer's attestation")


def chain_now(w3) -> int:
    return w3.eth.get_block("latest").timestamp


def make_challenge(s: Stack, w3, c, title: str, target: str, reward: int) -> tuple[dict, dict]:
    now = chain_now(w3)
    spec = s.post("/api/specs", {"title": title, "target": target, "rules": RULES,
                                 "publisher": devchain.address_of(K["publisher"]), "publisher_name": "Demo publisher (local)",
                                 "reward_wei": str(reward), "submission_deadline": now + 600, "settlement_deadline": now + 1200})
    ch = s.post("/api/challenges", {"spec_digest": spec["digest"]})
    sp = spec["spec"]
    rcpt = devchain.send(w3, K["publisher"], c.functions.createChallenge(
        bytes.fromhex(spec["digest"][7:]), w3.to_checksum_address(sp["evaluator"]["address"]),
        sp["deadlines"]["submission_deadline"], sp["deadlines"]["settlement_deadline"]), value=reward)
    h = "0x" + rcpt.transactionHash.hex().removeprefix("0x")
    funded = s.post(f"/api/challenges/{ch['id']}/funding", {"tx_hash": h})
    step("fund", challenge=ch["id"], onchain_id=funded["onchain_id"], tx=h, block=rcpt.blockNumber, reward_wei=reward,
         network="anvil-local 31337 (not Monad)", spec_digest=spec["digest"])
    return s.get(f"/api/challenges/{ch['id']}"), spec


def run_strategies(s: Stack, cid: int) -> list[dict]:
    runs = [s.post(f"/api/challenges/{cid}/runs", {"strategy": k, "budget": {"max_sequences": 150, "max_wall_seconds": 90}})
            for k in ("sequence-explorer", "retry-replay", "merchant-content")]
    out = []
    for r in runs:
        r = s.wait(f"/api/runs/{r['id']}", lambda v: v["status"] not in ("queued", "running"), what=f"run {r['strategy']}")
        rec = r["record"] or {}
        step("search", strategy=r["strategy"], status=r["status"], sequences=rec.get("sequences_tried"),
             termination=rec.get("termination"), rules=rec.get("rules_violated"), duration_ms=rec.get("duration_ms"))
        out.append(r)
    return out


def main() -> int:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    data_dir = ROOT / "data" / f"e2e-local-{stamp}"
    report_path = ROOT / "docs" / "evidence" / f"local-e2e-{stamp}.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    with devchain.Anvil() as anvil:
        w3 = devchain.web3_for(anvil.url)
        devchain.require_local(w3)
        addr = devchain.deploy(w3)
        c = devchain.contract_at(w3, addr)
        step("deploy", contract=addr, chain_id=w3.eth.chain_id, network="anvil-local (--network monad), not Monad testnet")
        s = Stack(anvil.url, addr.lower(), data_dir)
        try:
            cfg = s.get("/api/config")
            assert cfg["signer"]["reachable"] and cfg["chain"]["reachable"] and cfg["chain"].get("contract_has_code"), cfg
            step("config", network=cfg["network_label"], signer=cfg["signer"]["address"], isolation=cfg["isolation"]["process"]["available"])

            # ---------------- challenge 1: vulnerable fixture
            reward = 10**16  # 0.01 native test units on local anvil
            ch, spec = make_challenge(s, w3, c, "Reference agent 1.0.0 keeps its purchasing promises", "ref-purchasing-agent@1.0.0", reward)
            cid = ch["id"]
            run_strategies(s, cid)
            ch = s.get(f"/api/challenges/{cid}")
            cands = {x["claimed_rule"]: x for x in ch["candidates"]}
            assert {"R1", "R3"} <= set(cands), cands.keys()
            ev = s.post(f"/api/candidates/{cands['R1']['id']}/submit")
            step("commit", submission_id=ev["submission_id"], tx=ev["commit_tx"], challenger=ev["challenger"])
            ev = s.wait(f"/api/evaluations/{ev['id']}", lambda v: v["status"] not in ("queued", "replaying"), what="evaluation")
            step("replay", outcome=ev["outcome"], evidence=ev["evidence_digest"], replays=len(ev["summary"]["replays"]))
            assert ev["outcome"] == "verified_violation"
            dup = s.post(f"/api/candidates/{cands['R1']['id']}/submit")
            step("duplicate-submit", same_evaluation=dup["id"] == ev["id"], duplicate=dup.get("duplicate"))
            att = s.wait_attestation(cid, timeout=180)
            m = att["typed_data"]["message"]
            # The signer signs the digest of its OWN verification bundle (its fresh replays of the
            # committed candidate), not the worker's.
            own = att["evidence_digest"]
            assert own and m["evidenceDigest"] == "0x" + own[7:], (m["evidenceDigest"], own)
            bundle = s.get(f"/api/evidence/{own}")
            assert bundle["evidence_digest"] == own and bundle["verdict"]["outcome"] == "verified_violation", bundle["verdict"]
            assert bundle["submission"]["submission_id"] == ev["submission_id"]
            v = att["verification"] or {}
            step("attest", signer=att["signer"], expiry=att["expiry"], signature=att["signature"][:20] + "...",
                 signer_evidence=own, signer_replays=f"{v.get('violated')} of {v.get('replays')} (required {v.get('required')})",
                 worker_evidence=ev["evidence_digest"])
            tup = (int(m["challengeId"]), bytes.fromhex(m["specDigest"][2:]), bytes.fromhex(m["submissionId"][2:]),
                   bytes.fromhex(m["candidateDigest"][2:]), bytes.fromhex(m["evidenceDigest"][2:]),
                   w3.to_checksum_address(m["challenger"]), w3.to_checksum_address(m["recipient"]), int(m["verdict"]), int(m["expiry"]))
            forged = tup[:6] + (devchain.address_of(K["outsider"]),) + tup[7:]
            bad = devchain.send(w3, K["outsider"], c.functions.settle(forged, bytes.fromhex(att["signature"][2:])))
            step("negative: altered recipient", reverted=bad.status == 0)
            rcpt = devchain.send(w3, K["relayer"], c.functions.settle(tup, bytes.fromhex(att["signature"][2:])))
            h = "0x" + rcpt.transactionHash.hex().removeprefix("0x")
            r = s.post(f"/api/challenges/{cid}/transactions", {"tx_hash": h, "kind": "settle"})
            step("settle", tx=h, block=rcpt.blockNumber, relayed_by=devchain.address_of(K["relayer"]), recipient=r["detail"]["recipient"],
                 reward_wei=r["detail"]["reward_wei"], status=r["status"])
            again = devchain.send(w3, K["relayer"], c.functions.settle(tup, bytes.fromhex(att["signature"][2:])))
            step("negative: settle twice", reverted=again.status == 0)
            recipient = w3.to_checksum_address(m["recipient"])
            bal0 = w3.eth.get_balance(recipient)
            rcpt = devchain.send(w3, K["challenger"], c.functions.withdraw())
            h = "0x" + rcpt.transactionHash.hex().removeprefix("0x")
            r = s.post(f"/api/challenges/{cid}/transactions", {"tx_hash": h, "kind": "withdraw"})
            sent = w3.eth.get_transaction(rcpt.transactionHash)
            fee = sent["gas"] * rcpt.effectiveGasPrice  # Monad bills the gas limit, not gas used
            delta = w3.eth.get_balance(recipient) - bal0 + fee
            step("withdraw", tx=h, amount_wei=r["detail"]["amount_wei"], balance_delta_plus_fee=delta,
                 fee_billed_on_gas_limit=fee, gas_limit=sent["gas"], gas_used=rcpt.gasUsed)
            assert delta == int(r["detail"]["amount_wei"]), (delta, r["detail"])
            late = s.api.post(f"/api/candidates/{cands['R3']['id']}/submit")
            step("negative: submit after settlement", status=late.status_code, detail=late.json().get("detail"))

            # ---------------- patch -> retest -> export
            reg = s.post("/api/regressions", {"candidate_id": cands["R1"]["id"], "target": "ref-purchasing-agent@1.1.0"})
            reg = s.wait(f"/api/regressions/{reg['id']}", lambda v: v["status"] not in ("queued", "replaying"), what="regression")
            step("retest repaired 1.1.0", outcome=reg["outcome"], evidence=reg["evidence_digest"], spec=reg["spec_digest"])
            export = s.get(f"/api/regressions/{reg['id']}/export")
            pytest_file = s.api.get(f"/api/regressions/{reg['id']}/export?format=pytest").text
            (report_path.parent / f"regression-{stamp}.json").write_text(json.dumps(export, indent=2), encoding="utf-8")
            (report_path.parent / f"test_regression_{stamp.replace('-', '_')}.py").write_text(pytest_file, encoding="utf-8")
            step("export", files=[f"regression-{stamp}.json", f"test_regression_{stamp.replace('-', '_')}.py"])

            # ---------------- challenge 2: repaired version, no violation found, refund
            ch2, _ = make_challenge(s, w3, c, "Reference agent 1.1.0 keeps its purchasing promises", "ref-purchasing-agent@1.1.0", 5 * 10**15)
            runs = run_strategies(s, ch2["id"])
            assert all(r["status"] == "no_violation_found" for r in runs), [r["status"] for r in runs]
            early = devchain.send(w3, K["outsider"], c.functions.refund(int(ch2["onchain_id"])))
            step("negative: refund before window", reverted=early.status == 0)
            w3.provider.make_request("evm_increaseTime", [1300])
            w3.provider.make_request("evm_mine", [])
            rcpt = devchain.send(w3, K["outsider"], c.functions.refund(int(ch2["onchain_id"])))
            h = "0x" + rcpt.transactionHash.hex().removeprefix("0x")
            r = s.post(f"/api/challenges/{ch2['id']}/transactions", {"tx_hash": h, "kind": "refund"})
            step("refund", tx=h, publisher=r["detail"]["publisher"], reward_wei=r["detail"]["reward_wei"])

            final = {x["id"]: x["status"] for x in s.get("/api/challenges")}
            step("final", challenge_statuses=final)
            ok = final == {cid: "settled", ch2["id"]: "refunded"}
        finally:
            s.close()
    report = {"format": "counterproof.local-e2e/v1", "network": "anvil-local (chain 31337, --network monad) - NOT Monad testnet",
              "note": "All transactions are on a disposable local chain. Keys are anvil's public dev keys.",
              "result": "pass" if ok else "fail", "steps": LOG}
    report_path.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    print(f"\nRESULT: {report['result']} -> {report_path.relative_to(ROOT)}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
