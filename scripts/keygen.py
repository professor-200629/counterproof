"""Generate dedicated Monad TESTNET keys for CounterProof roles.

Writes private keys only to the git-ignored repo-root .env (creating it from
.env.example if needed) and prints ADDRESSES only. Existing keys are never overwritten.
These keys are for testnet value only - never send real funds to them.

  deployer    deploys the contract and tops up the other roles (needs testnet MON)
  evaluator   signs attestations inside the signer process (needs no MON)
  challenger  the challenger bot: commits candidates and withdraws rewards (needs a little MON)
  publisher   scripted publisher for the testnet end-to-end run (needs reward + gas); owns the
              reference agents' ERC-8004 identities
  reporter    posts ERC-8004 reputation feedback for settled results (needs a little MON); must
              never own or operate an agent it reports on
"""

from __future__ import annotations

import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

ROLES = {
    "DEPLOYER_PRIVATE_KEY": "deployer",
    "EVALUATOR_PRIVATE_KEY": "evaluator",
    "COUNTERPROOF_CHALLENGER_PRIVATE_KEY": "challenger",
    "PUBLISHER_PRIVATE_KEY": "publisher",
    "REPORTER_PRIVATE_KEY": "reporter",
}


def main() -> None:
    import os

    from eth_account import Account

    os.environ["COUNTERPROOF_ROLE"] = "script"

    env = ROOT / ".env"
    if not env.exists():
        env.write_text((ROOT / ".env.example").read_text(encoding="utf-8"), encoding="utf-8")
    lines = env.read_text(encoding="utf-8").splitlines()
    present = {ln.split("=", 1)[0].strip(): ln.split("=", 1)[1].strip() for ln in lines if "=" in ln and not ln.lstrip().startswith("#")}
    out = list(lines)
    addresses = {}
    for var, role in ROLES.items():
        key = present.get(var, "")
        if not key:
            key = "0x" + secrets.token_hex(32)
            out = [ln for ln in out if not ln.startswith(f"{var}=")] + [f"{var}={key}"]
        addresses[role] = Account.from_key(key).address
    if not present.get("COUNTERPROOF_SIGNER_TOKEN"):
        out = [ln for ln in out if not ln.startswith("COUNTERPROOF_SIGNER_TOKEN=")] + [f"COUNTERPROOF_SIGNER_TOKEN={secrets.token_hex(24)}"]
    ev = [ln for ln in out if not ln.startswith("COUNTERPROOF_EVALUATOR_ADDRESS=")] + [f"COUNTERPROOF_EVALUATOR_ADDRESS={addresses['evaluator'].lower()}"]
    env.write_text("\n".join(ev) + "\n", encoding="utf-8")
    print("Keys are in .env (git-ignored). Addresses:")
    for role, addr in addresses.items():
        print(f"  {role:<11} {addr}")
    print("\nFund the deployer from https://faucet.monad.xyz (Monad Testnet, chain 10143);")
    print("scripts/testnet.py fund-roles then tops up the challenger, publisher and reporter from it.")


if __name__ == "__main__":
    main()
