"""End-to-end run on MONAD TESTNET (chain 10143) with the role keys from .env.

  Create -> Fund -> Challenge -> Commit -> Replay -> Attest -> Settle -> Withdraw -> Patch -> Retest -> Export

Requires: scripts/keygen.py, the deployer funded from https://faucet.monad.xyz,
scripts/testnet.py fund-roles and scripts/testnet.py deploy. Runs the API, worker and
signer as separate local processes against the testnet contract; only the signer gets the
evaluator key. Every transaction is printed with its Monadscan link and written to
docs/evidence/testnet-e2e-<timestamp>.json.

  --with-refund   also fund a challenge against the repaired agent, wait out its
                  settlement window (~11 min) and refund it.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "scripts"))
os.environ["COUNTERPROOF_ROLE"] = "script"

import e2e_local as base  # noqa: E402
import testnet  # noqa: E402

EXPLORER = testnet.EXPLORER  # labelled "[fork rehearsal ...]" when COUNTERPROOF_FORK_REHEARSAL=1
REWARD = 10**16  # 0.01 MON (testnet)


def hx(rcpt) -> str:
    return "0x" + bytes(rcpt.transactionHash).hex()


def main() -> int:
    with_refund = "--with-refund" in sys.argv
    e = testnet.env()
    contract = e.get("COUNTERPROOF_CONTRACT")
    if not contract:
        raise SystemExit("deploy first: scripts/testnet.py deploy")
    w3 = testnet.w3()
    pub, chal, dep = testnet.acct("PUBLISHER_PRIVATE_KEY"), testnet.acct("COUNTERPROOF_CHALLENGER_PRIVATE_KEY"), testnet.acct("DEPLOYER_PRIVATE_KEY")
    c = w3.eth.contract(address=w3.to_checksum_address(contract), abi=json.loads(testnet.ARTIFACT.read_text())["abi"])
    stamp = time.strftime("%Y%m%d-%H%M%S")
    data_dir = ROOT / "data" / f"e2e-testnet-{stamp}"
    report_path = (testnet.OUT_DIR / f"fork-rehearsal-e2e-{stamp}.json" if testnet.REHEARSAL
                   else ROOT / "docs" / "evidence" / f"testnet-e2e-{stamp}.json")
    log = base.LOG
    ok = False
    s = base.Stack(testnet.RPC, contract.lower(), data_dir, network="monad-testnet",
                   evaluator_key=e["EVALUATOR_PRIVATE_KEY"], challenger_key=e["COUNTERPROOF_CHALLENGER_PRIVATE_KEY"])
    try:
        cfg = s.get("/api/config")
        assert cfg["signer"]["reachable"] and cfg["chain"]["reachable"] and cfg["chain"].get("contract_has_code"), cfg
        base.step("config", network=cfg["network_label"], contract=contract, signer=cfg["signer"]["address"],
                  rehearsal=testnet.REHEARSAL)
        agent = testnet.register_agent(w3, "ref-purchasing-agent@1.0.0")
        base.step("erc8004 identity", target="ref-purchasing-agent@1.0.0", agent_id=agent["agent_id"],
                  artifact_digest=agent["artifact_digest"], tx=agent["tx"], explorer=agent["explorer"])
        time.sleep(3)  # the publisher's funding tx sends value: keep it an "emptying" tx under the 10 MON reserve rule

        now = w3.eth.get_block("latest").timestamp
        spec = s.post("/api/specs", {"title": "Reference agent 1.0.0 keeps its purchasing promises (testnet)",
                                     "target": "ref-purchasing-agent@1.0.0", "rules": base.RULES, "publisher": pub.address,
                                     "publisher_name": "CounterProof demo publisher", "reward_wei": str(REWARD),
                                     "submission_deadline": now + 1800, "settlement_deadline": now + 3600})
        ch = s.post("/api/challenges", {"spec_digest": spec["digest"]})
        sp = spec["spec"]
        rcpt = testnet.send(w3, pub, {"to": c.address, "value": REWARD, "data": c.encode_abi("createChallenge", args=[
            bytes.fromhex(spec["digest"][7:]), w3.to_checksum_address(sp["evaluator"]["address"]),
            sp["deadlines"]["submission_deadline"], sp["deadlines"]["settlement_deadline"]])})
        funded = s.post(f"/api/challenges/{ch['id']}/funding", {"tx_hash": hx(rcpt)})
        base.step("fund", challenge=ch["id"], onchain_id=funded["onchain_id"], tx=hx(rcpt), explorer=EXPLORER.format(hx(rcpt)),
                  network="Monad Testnet 10143", spec_digest=spec["digest"])
        cid = ch["id"]
        base.run_strategies(s, cid)
        view = s.get(f"/api/challenges/{cid}")
        cands = {x["claimed_rule"]: x for x in view["candidates"]}
        ev = s.post(f"/api/candidates/{cands['R1']['id']}/submit")
        base.step("commit", submission_id=ev["submission_id"], tx=ev["commit_tx"], explorer=EXPLORER.format(ev["commit_tx"]))
        ev = s.wait(f"/api/evaluations/{ev['id']}", lambda v: v["status"] not in ("queued", "replaying"), what="evaluation")
        base.step("replay", outcome=ev["outcome"], evidence=ev["evidence_digest"])
        assert ev["outcome"] == "verified_violation"
        # The signer replays the committed candidate itself before it signs; it signs the digest
        # of its OWN verification bundle, which is the evidence the ERC-8004 report must carry.
        att = s.wait_attestation(cid, timeout=300)
        signed_evidence = att["evidence_digest"]
        base.step("attest", signer=att["signer"], expiry=att["expiry"], signer_evidence=signed_evidence,
                  worker_evidence=ev["evidence_digest"])
        m = att["typed_data"]["message"]
        assert signed_evidence and m["evidenceDigest"] == "0x" + signed_evidence[7:], (m["evidenceDigest"], signed_evidence)
        tup = (int(m["challengeId"]), bytes.fromhex(m["specDigest"][2:]), bytes.fromhex(m["submissionId"][2:]),
               bytes.fromhex(m["candidateDigest"][2:]), bytes.fromhex(m["evidenceDigest"][2:]),
               w3.to_checksum_address(m["challenger"]), w3.to_checksum_address(m["recipient"]), int(m["verdict"]), int(m["expiry"]))
        # relayed by the deployer account to show that the relayer does not receive the reward
        rcpt = testnet.send(w3, dep, {"to": c.address, "data": c.encode_abi("settle", args=[tup, bytes.fromhex(att["signature"][2:])])})
        r = s.post(f"/api/challenges/{cid}/transactions", {"tx_hash": hx(rcpt), "kind": "settle"})
        base.step("settle", tx=hx(rcpt), explorer=EXPLORER.format(hx(rcpt)), relayed_by=dep.address,
                  recipient=r["detail"]["recipient"], reward_wei=r["detail"]["reward_wei"], status=r["status"])
        settle_tx = hx(rcpt)
        time.sleep(2)
        # ERC-8004: the reporter re-checks the settlement on chain, then posts reputation feedback
        # to the official ReputationRegistry for the agent that declares this exact artifact digest.
        fb = testnet.report_violation(w3, bounties=c, onchain_id=int(funded["onchain_id"]), settle_tx=settle_tx,
                                      spec=sp, spec_digest=spec["digest"], evidence=s.get(f"/api/evidence/{signed_evidence}"),
                                      endpoint=f"{os.environ.get('COUNTERPROOF_PUBLIC_URL', 'https://counterproof.vercel.app')}/challenges/{cid}")
        base.step("erc8004 feedback", agent_id=fb["agent_id"], reporter=fb["reporter"], tag=f"{fb['tag1']}/{fb['tag2']}",
                  feedback_index=fb["feedback_index"], tx=fb["tx"], explorer=fb["explorer"])
        time.sleep(2)
        rcpt = testnet.send(w3, chal, {"to": c.address, "data": c.encode_abi("withdraw", args=[])})
        r = s.post(f"/api/challenges/{cid}/transactions", {"tx_hash": hx(rcpt), "kind": "withdraw"})
        base.step("withdraw", tx=hx(rcpt), explorer=EXPLORER.format(hx(rcpt)), amount_wei=r["detail"]["amount_wei"], to=r["detail"]["to"])

        reg = s.post("/api/regressions", {"candidate_id": cands["R1"]["id"], "target": "ref-purchasing-agent@1.1.0"})
        reg = s.wait(f"/api/regressions/{reg['id']}", lambda v: v["status"] not in ("queued", "replaying"), what="regression")
        base.step("retest repaired 1.1.0", outcome=reg["outcome"], evidence=reg["evidence_digest"])
        export = s.get(f"/api/regressions/{reg['id']}/export")
        (report_path.parent / f"regression-{'fork-rehearsal' if testnet.REHEARSAL else 'testnet'}-{stamp}.json").write_text(json.dumps(export, indent=2), encoding="utf-8")
        ok = reg["outcome"] == "not_reproduced"
        if with_refund:
            ok = ok and refund_leg(s, w3, c, pub)
    finally:
        s.close()
        network = ("FORK REHEARSAL: local anvil fork of Monad Testnet (chain 10143); no transaction reached Monad testnet"
                   if testnet.REHEARSAL else "Monad Testnet (chain 10143)")
        report = {"format": "counterproof.testnet-e2e/v1", "network": network, "contract": contract,
                  "result": "pass" if ok else "fail", "steps": log}
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
        print(f"\nRESULT: {report['result']} -> {report_path.relative_to(ROOT)}")
    return 0 if ok else 1


def refund_leg(s, w3, c, pub) -> bool:
    now = w3.eth.get_block("latest").timestamp
    spec = s.post("/api/specs", {"title": "Reference agent 1.1.0 keeps its purchasing promises (testnet)",
                                 "target": "ref-purchasing-agent@1.1.0", "rules": base.RULES, "publisher": pub.address,
                                 "reward_wei": str(REWARD // 2), "submission_deadline": now + 360, "settlement_deadline": now + 660})
    ch = s.post("/api/challenges", {"spec_digest": spec["digest"]})
    sp = spec["spec"]
    time.sleep(3)
    rcpt = testnet.send(w3, pub, {"to": c.address, "value": REWARD // 2, "data": c.encode_abi("createChallenge", args=[
        bytes.fromhex(spec["digest"][7:]), w3.to_checksum_address(sp["evaluator"]["address"]),
        sp["deadlines"]["submission_deadline"], sp["deadlines"]["settlement_deadline"]])})
    funded = s.post(f"/api/challenges/{ch['id']}/funding", {"tx_hash": hx(rcpt)})
    base.step("fund repaired", challenge=ch["id"], onchain_id=funded["onchain_id"], tx=hx(rcpt), explorer=EXPLORER.format(hx(rcpt)))
    runs = base.run_strategies(s, ch["id"])
    wait = sp["deadlines"]["settlement_deadline"] - w3.eth.get_block("latest").timestamp + 5
    print(f"waiting {wait}s for the settlement window to close")
    time.sleep(max(0, wait))
    rcpt = testnet.send(w3, pub, {"to": c.address, "data": c.encode_abi("refund", args=[int(funded["onchain_id"])])})
    r = s.post(f"/api/challenges/{ch['id']}/transactions", {"tx_hash": hx(rcpt), "kind": "refund"})
    base.step("refund", tx=hx(rcpt), explorer=EXPLORER.format(hx(rcpt)), reward_wei=r["detail"]["reward_wei"])
    return all(r["status"] == "no_violation_found" for r in runs)


if __name__ == "__main__":
    raise SystemExit(main())
