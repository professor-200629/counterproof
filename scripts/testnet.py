"""Monad TESTNET operations (chain 10143). Reads role keys from the git-ignored .env.

  status       balances of the role addresses (no secrets printed)
  fund-roles   deployer tops up challenger, publisher and reporter
  deploy       deploy CounterProofBounties; writes COUNTERPROOF_CONTRACT to .env and
               docs/deployments/monad-testnet.json
  verify       source-verify on MonadVision (Sourcify) via forge verify-contract
  register-agents
               publisher registers the reference agents in the official ERC-8004
               IdentityRegistry (docs/deployments/monad-testnet-erc8004.json)

Usage:  backend\\.venv\\Scripts\\python scripts\\testnet.py <command>

Fork rehearsal (no MON, nothing on Monad testnet): start
  anvil --fork-url https://testnet-rpc.monad.xyz --network monad --port 8546
then set COUNTERPROOF_FORK_REHEARSAL=1 and COUNTERPROOF_TESTNET_RPC=http://127.0.0.1:8546.
Output goes to data/fork-rehearsal/ and every link is labelled as a rehearsal.

Monad specifics handled here: gas is billed on the gas LIMIT (limits are estimate x 1.15);
value transfers revert if the sender would end below the 10 MON reserve unless it is an
"emptying" transaction (no other tx from the sender in the last 3 blocks), so transfers
from the same sender are spaced out.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
os.environ["COUNTERPROOF_ROLE"] = "script"

CHAIN_ID = 10143
ARTIFACT = ROOT / "contracts" / "out" / "CounterProofBounties.sol" / "CounterProofBounties.json"
# Fork rehearsal: the same scripts against a LOCAL anvil fork of Monad testnet (chain id 10143,
# real ERC-8004 registries, no real transactions). Everything it writes goes under
# data/fork-rehearsal/ and is labelled; it never touches .env or docs/deployments.
REHEARSAL = os.environ.get("COUNTERPROOF_FORK_REHEARSAL") == "1"
RPC = os.environ.get("COUNTERPROOF_TESTNET_RPC", "https://testnet-rpc.monad.xyz")
if REHEARSAL and not RPC.startswith(("http://127.0.0.1", "http://localhost")):
    raise SystemExit("COUNTERPROOF_FORK_REHEARSAL=1 needs COUNTERPROOF_TESTNET_RPC pointing at a local anvil fork")
EXPLORER = "[fork rehearsal - not on Monad testnet] {}" if REHEARSAL else "https://testnet.monadscan.com/tx/{}"
OUT_DIR = ROOT / "data" / "fork-rehearsal" if REHEARSAL else ROOT / "docs" / "deployments"
OVERLAY = ROOT / "data" / "fork-rehearsal" / "rehearsal.env"


def _read_env(p: Path) -> dict:
    out = {}
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    return out


def env() -> dict:
    out = _read_env(ROOT / ".env")
    if REHEARSAL:
        out.pop("COUNTERPROOF_CONTRACT", None)
        out |= _read_env(OVERLAY)
    return out


def set_env(key: str, value: str) -> None:
    p = OVERLAY if REHEARSAL else ROOT / ".env"
    p.parent.mkdir(parents=True, exist_ok=True)
    old = p.read_text(encoding="utf-8").splitlines() if p.exists() else []
    lines = [ln for ln in old if not ln.startswith(f"{key}=")]
    p.write_text("\n".join(lines + [f"{key}={value}"]) + "\n", encoding="utf-8")


def w3():
    from web3 import Web3

    w = Web3(Web3.HTTPProvider(RPC, request_kwargs={"timeout": 30}))
    cid = w.eth.chain_id
    if cid != CHAIN_ID:
        raise SystemExit(f"RPC {RPC} reports chain {cid}, expected Monad Testnet {CHAIN_ID}; refusing")
    return w


def acct(var: str):
    from eth_account import Account

    k = env().get(var)
    if not k:
        raise SystemExit(f"{var} missing in .env; run scripts/keygen.py")
    return Account.from_key(k)


def send(w, account, tx: dict) -> dict:
    tx = dict(tx)
    tx.setdefault("from", account.address)
    tx["nonce"] = w.eth.get_transaction_count(account.address, "pending")
    tx["chainId"] = CHAIN_ID
    base = w.eth.get_block("latest")["baseFeePerGas"]
    tx.setdefault("maxPriorityFeePerGas", w.to_wei(2, "gwei"))
    tx.setdefault("maxFeePerGas", base * 2 + tx["maxPriorityFeePerGas"])
    if "gas" not in tx:
        tx["gas"] = int(w.eth.estimate_gas({k: v for k, v in tx.items() if k not in ("nonce",)}) * 1.15) + 5_000
    signed = account.sign_transaction(tx)
    h = w.eth.send_raw_transaction(signed.raw_transaction)
    rcpt = w.eth.wait_for_transaction_receipt(h, timeout=120)
    hx = "0x" + bytes(h).hex()
    print(f"  tx {hx} status={rcpt.status} block={rcpt.blockNumber} gas_limit={tx['gas']} used={rcpt.gasUsed}")
    print(f"  {EXPLORER.format(hx)}")
    return rcpt


def cmd_status() -> None:
    w = w3()
    e = env()
    label = "FORK REHEARSAL of Monad Testnet (local anvil)" if REHEARSAL else "Monad Testnet"
    print(f"{label} {CHAIN_ID} via {RPC}, block {w.eth.block_number}")
    for var, role in (("DEPLOYER_PRIVATE_KEY", "deployer"), ("COUNTERPROOF_CHALLENGER_PRIVATE_KEY", "challenger"),
                      ("PUBLISHER_PRIVATE_KEY", "publisher"), ("REPORTER_PRIVATE_KEY", "reporter"),
                      ("EVALUATOR_PRIVATE_KEY", "evaluator")):
        a = acct(var)
        print(f"  {role:<10} {a.address}  {w.from_wei(w.eth.get_balance(a.address), 'ether')} MON")
    c = e.get("COUNTERPROOF_CONTRACT")
    if c:
        print(f"  contract   {c}  code={len(w.eth.get_code(w.to_checksum_address(c)))} bytes")


def cmd_fund_roles(challenger_mon: float = 0.3, publisher_mon: float = 0.5, reporter_mon: float = 0.15) -> None:
    w = w3()
    d = acct("DEPLOYER_PRIVATE_KEY")
    if REHEARSAL:  # fork only: give the deployer play money
        w.provider.make_request("anvil_setBalance", [d.address, hex(w.to_wei(5, "ether"))])
    bal = w.eth.get_balance(d.address)
    need = w.to_wei(challenger_mon + publisher_mon + reporter_mon + 0.4, "ether")
    if bal < need:
        raise SystemExit(f"deployer has {w.from_wei(bal, 'ether')} MON; needs about {w.from_wei(need, 'ether')} MON")
    for var, amount in (("COUNTERPROOF_CHALLENGER_PRIVATE_KEY", challenger_mon), ("PUBLISHER_PRIVATE_KEY", publisher_mon),
                        ("REPORTER_PRIVATE_KEY", reporter_mon)):
        to = acct(var).address
        print(f"sending {amount} MON to {to}")
        send(w, d, {"to": to, "value": w.to_wei(amount, "ether"), "gas": 21_000})
        time.sleep(3)  # let >3 blocks pass so the next transfer can qualify as an emptying tx


def cmd_deploy() -> None:
    w = w3()
    d = acct("DEPLOYER_PRIVATE_KEY")
    art = json.loads(ARTIFACT.read_text(encoding="utf-8"))
    print(f"deploying CounterProofBounties from {d.address}")
    rcpt = send(w, d, {"data": art["bytecode"]["object"], "value": 0})
    if rcpt.status != 1:
        raise SystemExit("deployment reverted")
    addr = rcpt.contractAddress
    meta = json.loads(art["rawMetadata"]) if "rawMetadata" in art else art.get("metadata", {})
    record = {"network": "FORK REHEARSAL (local anvil fork of Monad Testnet)" if REHEARSAL else "Monad Testnet",
              "chain_id": CHAIN_ID, "contract": addr, "deployer": d.address,
              "tx": "0x" + bytes(rcpt.transactionHash).hex(), "block": rcpt.blockNumber,
              "explorer": EXPLORER.format("0x" + bytes(rcpt.transactionHash).hex()),
              "compiler": (meta.get("compiler") or {}).get("version"), "deployed_at": int(time.time())}
    out = OUT_DIR / "monad-testnet.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(record, indent=2), encoding="utf-8")
    set_env("COUNTERPROOF_CONTRACT", addr.lower())
    where = "the rehearsal overlay" if REHEARSAL else ".env"
    print(f"deployed at {addr}; recorded in {out.relative_to(ROOT)} and {where}")


# ----------------------------------------------------------------------------- ERC-8004
ERC8004_RECORD = OUT_DIR / "monad-testnet-erc8004.json"


def erc8004_record() -> dict:
    from counterproof import erc8004

    if ERC8004_RECORD.exists():
        return json.loads(ERC8004_RECORD.read_text(encoding="utf-8"))
    r = erc8004.REGISTRIES[CHAIN_ID]
    return {"network": "FORK REHEARSAL (local anvil fork of Monad Testnet)" if REHEARSAL else "Monad Testnet",
            "chain_id": CHAIN_ID, "identity_registry": r["identity"], "reputation_registry": r["reputation"],
            "registries_source": "github.com/erc-8004/erc-8004-contracts README (official deployments)",
            "agents": {}, "feedback": []}


def save_erc8004_record(rec: dict) -> None:
    ERC8004_RECORD.parent.mkdir(parents=True, exist_ok=True)
    ERC8004_RECORD.write_text(json.dumps(rec, indent=2), encoding="utf-8")


def register_agent(w, target_key: str) -> dict:
    """Publisher registers (once) the ERC-8004 identity that declares this target's artifact digest."""
    from counterproof import erc8004
    from counterproof.targets import registry

    rec = erc8004_record()
    digest = registry.artifact_digest(target_key)
    have = rec["agents"].get(target_key)
    if have and have["artifact_digest"] == digest:
        return have
    vulnerable = registry.get(target_key).label == "intentionally-vulnerable-fixture"
    reg = erc8004.registration_file(
        target_key=target_key, artifact_digest=digest,
        name=f"CounterProof {target_key}" + (" (intentionally vulnerable fixture)" if vulnerable else ""),
        description=("Reference AI purchasing agent used by CounterProof. "
                     + ("It has planted defects so the pipeline can be demonstrated; findings against it are not "
                        "discoveries. " if vulnerable else "")
                     + "Results about it are posted as ERC-8004 feedback by the CounterProof reporter."),
        web_url=os.environ.get("COUNTERPROOF_PUBLIC_URL", "https://counterproof.vercel.app"))
    pub = acct("PUBLISHER_PRIVATE_KEY")
    print(f"registering ERC-8004 agent for {target_key} ({digest}) from publisher {pub.address}")
    ident = erc8004.identity(w)
    rcpt = send(w, pub, {"to": ident.address, "data": ident.encode_abi("register", args=[erc8004.data_uri(reg)])})
    if rcpt.status != 1:
        raise SystemExit("ERC-8004 register reverted")
    hx = "0x" + bytes(rcpt.transactionHash).hex()
    agent = {"agent_id": erc8004.registered_agent_id(w, rcpt), "artifact_digest": digest, "owner": pub.address,
             "tx": hx, "explorer": EXPLORER.format(hx)}
    rec["agents"][target_key] = agent
    save_erc8004_record(rec)
    print(f"  agent id {agent['agent_id']}")
    return agent


def report_violation(w, *, bounties, onchain_id: int, settle_tx: str, spec: dict, spec_digest: str, evidence: dict,
                     endpoint: str | None) -> dict:
    """Reporter posts one feedback entry after re-checking every fact against the chain."""
    from web3.logs import DISCARD

    from counterproof import erc8004

    rec = erc8004_record()
    key = f"{bounties.address.lower()}:{int(onchain_id)}"
    done = next((f for f in rec["feedback"] if f["key"] == key), None)
    if done:
        print(f"already reported: {done['tx']}")
        return done
    target_key = f"{spec['target']['adapter']}@{spec['target']['version']}"
    agent = rec["agents"].get(target_key) or register_agent(w, target_key)
    rep = acct("REPORTER_PRIVATE_KEY")
    facts = erc8004.check_violation_report(w, bounties_contract=bounties, onchain_id=onchain_id, settle_tx=settle_tx,
                                           spec=spec, spec_digest=spec_digest, evidence=evidence,
                                           agent_id=agent["agent_id"], reporter=rep.address)
    file = erc8004.violation_feedback_file(**facts, endpoint=endpoint)
    args, _ = erc8004.give_feedback_args(file)
    reputation = erc8004.reputation(w)
    print(f"reporter {rep.address} posting {file['tag1']}/{file['tag2']} for agent {agent['agent_id']}")
    rcpt = send(w, rep, {"to": reputation.address, "data": reputation.encode_abi("giveFeedback", args=args)})
    if rcpt.status != 1:
        raise SystemExit("ERC-8004 giveFeedback reverted")
    ev = reputation.events.NewFeedback().process_receipt(rcpt, errors=DISCARD)[0]["args"]
    hx = "0x" + bytes(rcpt.transactionHash).hex()
    out = {"key": key, "challenge_onchain_id": int(onchain_id), "bounties": bounties.address,
           "agent_id": agent["agent_id"], "target": target_key, "reporter": rep.address,
           "feedback_index": int(ev["feedbackIndex"]), "tag1": file["tag1"], "tag2": file["tag2"],
           "value": file["value"], "value_decimals": file["valueDecimals"], "evidence_digest": facts["evidence_digest"],
           "settle_tx": settle_tx, "feedback_hash": "0x" + bytes(ev["feedbackHash"]).hex(), "feedback_file": file,
           "tx": hx, "explorer": EXPLORER.format(hx)}
    rec["feedback"].append(out)
    save_erc8004_record(rec)
    return out


def cmd_register_agents() -> None:
    w = w3()
    for key in ("ref-purchasing-agent@1.0.0", "ref-purchasing-agent@1.1.0"):
        a = register_agent(w, key)
        print(f"  {key}: agent {a['agent_id']}  {a['explorer']}")
        time.sleep(2)


def cmd_verify() -> None:
    c = env().get("COUNTERPROOF_CONTRACT")
    if not c:
        raise SystemExit("deploy first")
    forge = str(Path.home() / ".foundry" / "bin" / ("forge.exe" if os.name == "nt" else "forge"))
    cmd = [forge, "verify-contract", c, "src/CounterProofBounties.sol:CounterProofBounties", "--chain", str(CHAIN_ID),
           "--verifier", "sourcify", "--verifier-url", "https://sourcify-api-monad.blockvision.org/"]
    print(" ".join(cmd))
    subprocess.run(cmd, cwd=ROOT / "contracts", check=False)


if __name__ == "__main__":
    commands = {"status": cmd_status, "fund-roles": cmd_fund_roles, "deploy": cmd_deploy, "verify": cmd_verify,
                "register-agents": cmd_register_agents}
    if len(sys.argv) < 2 or sys.argv[1] not in commands:
        raise SystemExit(__doc__)
    commands[sys.argv[1]]()
