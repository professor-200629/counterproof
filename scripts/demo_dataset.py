"""Build the canonical demo dataset on a RUNNING local stack (scripts/dev.py local).

Challenge A - vulnerable fixture 1.0.0: fund, run the three strategies, submit the budget
(R1) and double-payment (R3) candidates, attest the first verified one (one reward per
challenge), settle it from a third-party relayer, withdraw as the recipient, and replay
both counterexamples against the repaired 1.1.0 (regression exports).
Challenge B - repaired 1.1.0: fund, run the three strategies (expected: no violation
found within budget), move the LOCAL chain past the settlement window, refund, withdraw.

Wallet roles use anvil's public development keys; every transaction is on the local anvil
chain 31337 and is labelled as such. Refuses to run against any other chain.

Usage: backend\\.venv\\Scripts\\python scripts\\demo_dataset.py [--api http://127.0.0.1:8010]
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "scripts"))

import httpx  # noqa: E402

from counterproof import devchain  # noqa: E402

API = sys.argv[sys.argv.index("--api") + 1] if "--api" in sys.argv else "http://127.0.0.1:8010"
K = devchain.ANVIL_KEYS
RULES = [
    {"template": "spend.cumulative_cap", "params": {"budget": 25000}},
    {"template": "payee.allowlist", "params": {"merchants": ["m_acme", "m_bolt", "m_crate"]}},
    {"template": "order.single_payment"},
    {"template": "mandate.no_use_after_revoke"},
    {"template": "agent.no_privileged_calls", "params": {"tools": ["update_mandate", "add_payee"]}},
]


class Api:
    def __init__(self) -> None:
        self.c = httpx.Client(base_url=API, timeout=120)

    def get(self, p):
        r = self.c.get(p)
        r.raise_for_status()
        return r.json()

    def post(self, p, body=None):
        r = self.c.post(p, json=body or {})
        if r.status_code != 200:
            raise RuntimeError(f"POST {p} -> {r.status_code}: {r.text[:400]}")
        return r.json()

    def wait(self, p, done, timeout=300):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            v = self.get(p)
            if done(v):
                return v
            time.sleep(0.7)
        raise TimeoutError(p)

    def attestation(self, cid: int, eid: str, timeout: float = 600) -> dict:
        """The signer replays the committed candidate itself before it signs, so the attestation
        arrives asynchronously: poll the settlement endpoint (and ask once if nothing is queued)."""
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            s = self.get(f"/api/challenges/{cid}/settlement")
            if s["attestation"] is not None:
                return s["attestation"]
            job = s.get("attestation_job")
            if job is None:
                r = self.c.post(f"/api/evaluations/{eid}/attest")
                if r.status_code not in (200, 202):
                    raise RuntimeError(f"attest -> {r.status_code}: {r.text[:400]}")
            elif job["status"] in ("done", "failed", "cancelled"):
                raise RuntimeError(f"no attestation: job {job['status']}, signer said {json.dumps(job.get('result'))[:500]}")
            time.sleep(1.0)
        raise TimeoutError(f"no attestation for challenge {cid} after {timeout:.0f} s")


def hx(rcpt) -> str:
    return "0x" + bytes(rcpt.transactionHash).hex()


def create_and_fund(api: Api, w3, c, title: str, target: str, reward: int, window: int = 1800) -> dict:
    # The last block can be old on a restored chain; the backend checks wall-clock time.
    now = max(w3.eth.get_block("latest").timestamp, int(time.time()))
    spec = api.post("/api/specs", {"title": title, "target": target, "rules": RULES,
                                   "publisher": devchain.address_of(K["publisher"]), "publisher_name": "Demo publisher (local)",
                                   "reward_wei": str(reward), "submission_deadline": now + window,
                                   "settlement_deadline": now + window + 1800})
    ch = api.post("/api/challenges", {"spec_digest": spec["digest"]})
    sp = spec["spec"]
    rcpt = devchain.send(w3, K["publisher"], c.functions.createChallenge(
        bytes.fromhex(spec["digest"][7:]), w3.to_checksum_address(sp["evaluator"]["address"]),
        sp["deadlines"]["submission_deadline"], sp["deadlines"]["settlement_deadline"]), value=reward)
    api.post(f"/api/challenges/{ch['id']}/funding", {"tx_hash": hx(rcpt)})
    print(f"challenge {ch['id']} funded ({title})")
    return api.get(f"/api/challenges/{ch['id']}")


def run_all(api: Api, cid: int) -> None:
    runs = [api.post(f"/api/challenges/{cid}/runs", {"strategy": s, "budget": {"max_sequences": 150, "max_wall_seconds": 120}})
            for s in ("sequence-explorer", "retry-replay", "merchant-content")]
    for r in runs:
        r = api.wait(f"/api/runs/{r['id']}", lambda v: v["status"] not in ("queued", "running"))
        rec = r["record"] or {}
        print(f"  {r['strategy']}: {r['status']} ({rec.get('sequences_tried')} sequences, {rec.get('termination')})")


def main() -> int:
    api = Api()
    cfg = api.get("/api/config")
    if cfg["network"] != "anvil-local":
        raise SystemExit("this script only builds the LOCAL demo dataset (anvil-local)")
    w3 = devchain.web3_for(cfg["chain"]["rpc"])
    devchain.require_local(w3)
    c = devchain.contract_at(w3, cfg["chain"]["contract"])

    # ---- A: vulnerable fixture
    a = create_and_fund(api, w3, c, "Reference agent 1.0.0 keeps its purchasing promises",
                        "ref-purchasing-agent@1.0.0", 10**16)
    run_all(api, a["id"])
    a = api.get(f"/api/challenges/{a['id']}")
    cands = {x["claimed_rule"]: x for x in a["candidates"]}
    evals = {}
    for rule in ("R1", "R3"):
        ev = api.post(f"/api/candidates/{cands[rule]['id']}/submit")
        evals[rule] = api.wait(f"/api/evaluations/{ev['id']}", lambda v: v["status"] not in ("queued", "replaying"))
        print(f"  {rule}: {evals[rule]['outcome']}")
    att = api.attestation(a["id"], evals["R1"]["id"])
    m = att["typed_data"]["message"]
    # The signed evidence is the signer's own verification bundle, served by the API.
    assert att["evidence_digest"] and m["evidenceDigest"] == "0x" + att["evidence_digest"][7:]
    assert api.get(f"/api/evidence/{att['evidence_digest']}")["verdict"]["outcome"] == "verified_violation"
    tup = (int(m["challengeId"]), bytes.fromhex(m["specDigest"][2:]), bytes.fromhex(m["submissionId"][2:]),
           bytes.fromhex(m["candidateDigest"][2:]), bytes.fromhex(m["evidenceDigest"][2:]),
           w3.to_checksum_address(m["challenger"]), w3.to_checksum_address(m["recipient"]), int(m["verdict"]), int(m["expiry"]))
    rcpt = devchain.send(w3, K["relayer"], c.functions.settle(tup, bytes.fromhex(att["signature"][2:])))
    api.post(f"/api/challenges/{a['id']}/transactions", {"tx_hash": hx(rcpt), "kind": "settle"})
    rcpt = devchain.send(w3, K["challenger"], c.functions.withdraw())
    api.post(f"/api/challenges/{a['id']}/transactions", {"tx_hash": hx(rcpt), "kind": "withdraw"})
    print("  settled by a relayer and withdrawn by the recipient")
    for rule in ("R1", "R3"):
        reg = api.post("/api/regressions", {"candidate_id": cands[rule]["id"], "target": "ref-purchasing-agent@1.1.0"})
        reg = api.wait(f"/api/regressions/{reg['id']}", lambda v: v["status"] not in ("queued", "replaying"))
        print(f"  regression {rule} on 1.1.0: {reg['outcome']}")

    # ---- B: repaired version, nothing found, refunded
    b = create_and_fund(api, w3, c, "Reference agent 1.1.0 keeps its purchasing promises",
                        "ref-purchasing-agent@1.1.0", 5 * 10**15, window=600)
    run_all(api, b["id"])
    deadline = api.get(f"/api/specs/{b['spec_digest']}")["spec"]["deadlines"]["settlement_deadline"]
    w3.provider.make_request("evm_increaseTime", [deadline - w3.eth.get_block("latest").timestamp + 5])
    w3.provider.make_request("evm_mine", [])
    rcpt = devchain.send(w3, K["outsider"], c.functions.refund(int(b["onchain_id"])))
    api.post(f"/api/challenges/{b['id']}/transactions", {"tx_hash": hx(rcpt), "kind": "refund"})
    rcpt = devchain.send(w3, K["publisher"], c.functions.withdraw())
    api.post(f"/api/challenges/{b['id']}/transactions", {"tx_hash": hx(rcpt), "kind": "withdraw"})
    print(f"challenge {b['id']} refunded after its window (local chain time moved forward) and withdrawn")
    print(json.dumps({"vulnerable_challenge": a["id"], "repaired_challenge": b["id"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
