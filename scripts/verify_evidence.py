"""Re-check CounterProof's recorded evidence yourself.

Reads the recorded console snapshot (the files behind https://counterproof.vercel.app, also in
web/public/snapshot of the repository) and checks, for every challenge in it:

  offline  - each spec file's content hashes to its name (canonical JSON, SHA-256);
           - each evidence bundle's seal: evidence_digest == digest(bundle without it);
           - recheck_bundle(): every replay ledger's hash chain from the committed initial
             state, the deterministic checker re-run over each ledger, the k-of-n policy, the
             verdict and reward eligibility;
  --chain  - read-only calls to the public Monad testnet RPC: the challenge status in the
             CounterProofBounties contract, the settle receipt's ChallengeSettled event and
             its evidence digest (must equal the attested one), and each ERC-8004 feedback entry
             (readFeedback) plus keccak256 of its feedback file.

What this does NOT do: it does not re-run the agent (that needs the model provider and, for
the recorded runs, the source at git tag testnet-2026-10-11 - see docs/REPRODUCE.md). Passing
checks show the records are internally consistent and match the chain; they do not prove the
evaluator ran honestly, and they say nothing about AI safety in general.

  backend\\.venv\\Scripts\\python scripts\\verify_evidence.py [--snapshot web/public/snapshot | --url https://counterproof.vercel.app] [--chain]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from counterproof.canonical import canonical_json, digest, from_bytes32  # noqa: E402
from counterproof.evaluator import recheck_bundle, verify_seal  # noqa: E402

RPC = "https://testnet-rpc.monad.xyz"


class Source:
    def __init__(self, base: str):
        self.base = base
        self.http = None
        if base.startswith("https://"):
            import httpx

            parsed = urlsplit(base)
            if parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise ValueError("public snapshot URL must not contain credentials, query parameters or a fragment")
            self.http = httpx.Client(timeout=30, trust_env=False, follow_redirects=False, auth=None,
                                     headers={"Accept": "application/json"})

    def get(self, rel: str):
        rel = rel.replace(":", "_")
        if self.http:
            self.http.cookies.clear()
            r = self.http.get(f"{self.base.rstrip('/')}/snapshot/{rel}")
            r.raise_for_status()
            return r.json()
        return json.loads((Path(self.base) / rel).read_text(encoding="utf-8"))


def main() -> int:
    if "--url" in sys.argv:
        src = Source(sys.argv[sys.argv.index("--url") + 1])
    else:
        src = Source(str(Path(sys.argv[sys.argv.index("--snapshot") + 1]) if "--snapshot" in sys.argv
                         else ROOT / "web" / "public" / "snapshot"))
    use_chain = "--chain" in sys.argv
    manifest = src.get("manifest.json")
    print(f"snapshot: {manifest.get('network_label')} contract {manifest.get('contract')} taken_at {manifest.get('taken_at')}")
    problems: list[str] = []
    w3 = contract = None
    if use_chain:
        from web3 import Web3

        from counterproof.chain import abi

        w3 = Web3(Web3.HTTPProvider(RPC, request_kwargs={"timeout": 30}))
        if w3.eth.chain_id != manifest.get("chain_id"):
            raise SystemExit(f"RPC chain {w3.eth.chain_id} differs from the snapshot's {manifest.get('chain_id')}")
        contract = w3.eth.contract(address=w3.to_checksum_address(manifest["contract"]), abi=abi())

    for row in src.get("api/challenges.json"):
        cid = row["id"]
        view = src.get(f"api/challenges/{cid}.json")
        spec_file = src.get(f"api/specs/{view['spec_digest']}.json")
        spec = spec_file["spec"]
        ok_spec = digest(spec) == view["spec_digest"]
        target = f"{spec['target']['adapter']}@{spec['target']['version']}"
        print(f"\nchallenge {cid}: {target} [{spec['target']['label']}] status={view['status']} spec digest ok={ok_spec}")
        if not ok_spec:
            problems.append(f"challenge {cid}: spec content does not hash to {view['spec_digest']}")
        for ev in view["evaluations"]:
            if not ev.get("evidence_digest"):
                continue
            b = src.get(f"api/evidence/{ev['evidence_digest']}.json")
            sealed = verify_seal(b) and b.get("evidence_digest") == ev["evidence_digest"]
            issues = recheck_bundle(b, spec) if b["verdict"]["outcome"] == "verified_violation" else []
            hits = sum(1 for r in b["replays"] if r["claimed_rule_violated"])
            print(f"  evaluation {ev['id']}: {b['verdict']['outcome']}, claimed {b['claimed_rule']} violated in {hits} of "
                  f"{len(b['replays'])} replays (policy: {spec['reproducibility']['required_violations']} of "
                  f"{spec['reproducibility']['replays']}); seal ok={sealed}; recheck problems={issues or 'none'}")
            if not sealed:
                problems.append(f"evaluation {ev['id']}: seal/digest mismatch")
            problems += [f"evaluation {ev['id']}: {p}" for p in issues]
        att = view.get("attestation")
        if att:
            m = json.loads(att["typed_data"])["message"] if isinstance(att.get("typed_data"), str) else att["typed_data"]["message"]
            att_ev = from_bytes32(m["evidenceDigest"])
            print(f"  attestation: evidenceDigest {att_ev[:23]}..., recipient {m['recipient']}, signer {att['signer']}")
            if use_chain:
                ch = contract.functions.getChallenge(int(view["onchain_id"])).call()
                status = {1: "funded", 2: "settled", 3: "refunded"}.get(int(ch[4]), str(ch[4]))
                print(f"  chain: challenge #{view['onchain_id']} status {status}; spec digest on chain ok="
                      f"{from_bytes32(ch[6]) == view['spec_digest']}")
                if from_bytes32(ch[6]) != view["spec_digest"]:
                    problems.append(f"challenge {cid}: on-chain spec digest differs")
                for t in view["transactions"]:
                    if t["kind"] == "settle" and t["status"] == "confirmed":
                        rcpt = w3.eth.get_transaction_receipt(t["hash"])
                        evs = [e for e in contract.events.ChallengeSettled().process_receipt(rcpt)
                               if e["address"].lower() == contract.address.lower()]
                        on = from_bytes32(evs[0]["args"]["evidenceDigest"]) if evs else None
                        print(f"  chain: settle {t['hash'][:14]}... ChallengeSettled evidenceDigest == attested: {on == att_ev}")
                        if on != att_ev:
                            problems.append(f"challenge {cid}: settled evidence digest differs from the attestation")

    if use_chain:
        from counterproof import erc8004

        rec = src.get("api/erc8004.json")
        if rec.get("available"):
            rep = erc8004.reputation(w3)
            for f in rec.get("feedback", []):
                got = rep.functions.readFeedback(int(f["agent_id"]), w3.to_checksum_address(f["reporter"]), int(f["feedback_index"])).call()
                hash_ok = erc8004.keccak_hex(canonical_json(f["feedback_file"])) == f["feedback_hash"]
                same = (int(got[0]), int(got[1]), got[2], got[3], bool(got[4])) == (f["value"], f["value_decimals"], f["tag1"], f["tag2"], False)
                print(f"\nERC-8004 agent {f['agent_id']} feedback #{f['feedback_index']}: on chain {got[2]}/{got[3]} matches={same}; "
                      f"feedback file hash ok={hash_ok}")
                if not (same and hash_ok):
                    problems.append(f"ERC-8004 feedback for agent {f['agent_id']} does not match")

    print("\nRESULT:", "all checks passed" if not problems else f"{len(problems)} problem(s)")
    for p in problems:
        print("  -", p)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
