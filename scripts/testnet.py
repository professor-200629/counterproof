"""Monad TESTNET operations (chain 10143). Reads role keys from the git-ignored .env.

  status       balances of the role addresses (no secrets printed)
  fund-roles   deployer tops up challenger and publisher
  deploy       deploy CounterProofBounties; writes COUNTERPROOF_CONTRACT to .env and
               docs/deployments/monad-testnet.json
  verify       source-verify on MonadVision (Sourcify) via forge verify-contract

Usage:  backend\\.venv\\Scripts\\python scripts\\testnet.py <command>

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

RPC = os.environ.get("COUNTERPROOF_TESTNET_RPC", "https://testnet-rpc.monad.xyz")
CHAIN_ID = 10143
EXPLORER = "https://testnet.monadscan.com/tx/{}"
ARTIFACT = ROOT / "contracts" / "out" / "CounterProofBounties.sol" / "CounterProofBounties.json"


def env() -> dict:
    out = {}
    p = ROOT / ".env"
    for line in p.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def set_env(key: str, value: str) -> None:
    p = ROOT / ".env"
    lines = [ln for ln in p.read_text(encoding="utf-8").splitlines() if not ln.startswith(f"{key}=")]
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
    print(f"Monad Testnet {CHAIN_ID} via {RPC}, block {w.eth.block_number}")
    for var, role in (("DEPLOYER_PRIVATE_KEY", "deployer"), ("COUNTERPROOF_CHALLENGER_PRIVATE_KEY", "challenger"),
                      ("PUBLISHER_PRIVATE_KEY", "publisher"), ("EVALUATOR_PRIVATE_KEY", "evaluator")):
        a = acct(var)
        print(f"  {role:<10} {a.address}  {w.from_wei(w.eth.get_balance(a.address), 'ether')} MON")
    c = e.get("COUNTERPROOF_CONTRACT")
    if c:
        print(f"  contract   {c}  code={len(w.eth.get_code(w.to_checksum_address(c)))} bytes")


def cmd_fund_roles(challenger_mon: float = 0.3, publisher_mon: float = 0.5) -> None:
    w = w3()
    d = acct("DEPLOYER_PRIVATE_KEY")
    bal = w.eth.get_balance(d.address)
    need = w.to_wei(challenger_mon + publisher_mon + 0.4, "ether")
    if bal < need:
        raise SystemExit(f"deployer has {w.from_wei(bal, 'ether')} MON; needs about {w.from_wei(need, 'ether')} MON")
    for var, amount in (("COUNTERPROOF_CHALLENGER_PRIVATE_KEY", challenger_mon), ("PUBLISHER_PRIVATE_KEY", publisher_mon)):
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
    record = {"network": "Monad Testnet", "chain_id": CHAIN_ID, "contract": addr, "deployer": d.address,
              "tx": "0x" + bytes(rcpt.transactionHash).hex(), "block": rcpt.blockNumber,
              "explorer": EXPLORER.format("0x" + bytes(rcpt.transactionHash).hex()),
              "compiler": (meta.get("compiler") or {}).get("version"), "deployed_at": int(time.time())}
    out = ROOT / "docs" / "deployments" / "monad-testnet.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(record, indent=2), encoding="utf-8")
    set_env("COUNTERPROOF_CONTRACT", addr.lower())
    print(f"deployed at {addr}; recorded in {out.relative_to(ROOT)} and .env")


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
    commands = {"status": cmd_status, "fund-roles": cmd_fund_roles, "deploy": cmd_deploy, "verify": cmd_verify}
    if len(sys.argv) < 2 or sys.argv[1] not in commands:
        raise SystemExit(__doc__)
    commands[sys.argv[1]]()
