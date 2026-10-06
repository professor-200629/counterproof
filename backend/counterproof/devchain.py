"""Local development chain helpers (anvil --network monad, chain id 31337).

The keys below are anvil's PUBLIC, well-known development keys (from Foundry's default
mnemonic). They exist only on a local anvil chain. `require_local` refuses to use them on
any chain whose id is not 31337, so they can never touch Monad testnet.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import time
from pathlib import Path

from .config import ROOT

ANVIL_CHAIN_ID = 31337
# Public anvil dev accounts 0-4 (never use outside a local anvil chain).
ANVIL_KEYS = {
    "publisher": "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "evaluator": "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "challenger": "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    "relayer": "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    "outsider": "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
}
ARTIFACT = ROOT / "contracts" / "out" / "CounterProofBounties.sol" / "CounterProofBounties.json"


def anvil_exe() -> str:
    found = shutil.which("anvil")
    if found:
        return found
    home = Path.home() / ".foundry" / "bin" / ("anvil.exe" if os.name == "nt" else "anvil")
    if home.exists():
        return str(home)
    raise FileNotFoundError("anvil not found; install Foundry >= 1.8")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Anvil:
    def __init__(self, port: int | None = None):
        self.port = port or free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.proc: subprocess.Popen | None = None

    def __enter__(self) -> "Anvil":
        self.proc = subprocess.Popen([anvil_exe(), "--network", "monad", "--port", str(self.port), "--chain-id",
                                      str(ANVIL_CHAIN_ID), "--silent"], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.5):
                    return self
            except OSError:
                if self.proc.poll() is not None:
                    raise RuntimeError(f"anvil exited: {self.proc.stderr.read().decode(errors='replace')[:500]}")
                time.sleep(0.2)
        raise RuntimeError("anvil did not start")

    def __exit__(self, *exc) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(timeout=10)


def web3_for(url: str):
    from web3 import Web3

    w3 = Web3(Web3.HTTPProvider(url, request_kwargs={"timeout": 20}))
    return w3


def require_local(w3) -> None:
    if w3.eth.chain_id != ANVIL_CHAIN_ID:
        raise RuntimeError(f"refusing to use public anvil dev keys on chain {w3.eth.chain_id}")


def address_of(key: str) -> str:
    from eth_account import Account

    return Account.from_key(key).address


def send(w3, key: str, fn=None, *, value: int = 0, data: str | None = None, to: str | None = None) -> dict:
    """Sign and send with an anvil dev key; returns the receipt (does not raise on revert)."""
    from eth_account import Account

    require_local(w3)
    acct = Account.from_key(key)
    base = {"from": acct.address, "nonce": w3.eth.get_transaction_count(acct.address, "pending"), "value": value,
            "chainId": w3.eth.chain_id}
    if fn is not None:
        tx = fn.build_transaction(base | {"gas": 1})
    else:
        tx = base | {"data": data} | ({"to": to} if to else {})
    # Monad (and anvil --network monad) bills the gas LIMIT, so keep it near the estimate.
    # A call expected to revert cannot be estimated; it gets a modest fixed limit.
    probe = {k: v for k, v in tx.items() if k != "gas"}
    try:
        tx["gas"] = int(w3.eth.estimate_gas(probe) * 1.15) + 5_000
    except Exception:
        tx["gas"] = 400_000 if fn is not None else 6_000_000
    tx.setdefault("maxFeePerGas", w3.eth.gas_price * 2)
    tx.setdefault("maxPriorityFeePerGas", 1)
    tx.pop("gasPrice", None)
    signed = acct.sign_transaction(tx)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    return w3.eth.wait_for_transaction_receipt(h, timeout=30)


def deploy(w3, key: str | None = None) -> str:
    art = json.loads(ARTIFACT.read_text(encoding="utf-8"))
    rcpt = send(w3, key or ANVIL_KEYS["publisher"], data=art["bytecode"]["object"])
    if rcpt.status != 1 or not rcpt.contractAddress:
        raise RuntimeError("deployment failed")
    return rcpt.contractAddress


def contract_at(w3, address: str):
    art = json.loads(ARTIFACT.read_text(encoding="utf-8"))
    return w3.eth.contract(address=w3.to_checksum_address(address), abi=art["abi"])
