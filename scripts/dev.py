"""Run the whole CounterProof stack for development and demos.

  python scripts/dev.py local      anvil (--network monad, chain 31337, state persisted in
                                   data/local) + contract + signer + API + worker + web.
                                   Uses anvil's public dev keys; the web app offers the
                                   labelled "Local dev account" wallet. NOT Monad.
  python scripts/dev.py testnet    Monad Testnet (10143) with keys and contract from .env.
                                   --data DIR serves another data directory (e.g. an
                                   e2e_testnet.py run); with COUNTERPROOF_FORK_REHEARSAL=1 it
                                   runs against the local fork rehearsal, labelled as such.
  python scripts/dev.py offchain   no chain: evidence only, no rewards.
  add --no-web to skip the Next.js dev server; --workers N (default 2) runs N job workers
  so a slow live-model run does not block other jobs (claiming a job is atomic).

Ports: web 3000, API 8010, signer 8011, anvil 8545. Ctrl+C stops everything.
Each process receives only the secrets its role needs. The web dev server listens on
127.0.0.1 only (its /api proxy would otherwise expose the API to the network).

Who may change things (backend/counterproof/auth.py): the operator token
(COUNTERPROOF_OPERATOR_TOKEN from the environment or .env, else generated for this launch and
written to data/operator.token for scripts/operator.py and the other scripts) and the judge
passcode (COUNTERPROOF_JUDGE_PASSCODE from the environment or .env, else generated for this
launch into data/judge.passcode). Only the API process receives them; neither is printed.
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
PY = str(ROOT / "backend" / (".venv/Scripts/python.exe" if os.name == "nt" else ".venv/bin/python"))


def read_env() -> dict:
    p = ROOT / ".env"
    out = {}
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                if v.strip():
                    out[k.strip()] = v.strip()
    return out


def wait_port(port: int, timeout: float = 60) -> None:
    import socket

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.3)
    raise RuntimeError(f"port {port} did not open")


AUTH_NOTE = ""


def api_auth(env_file: dict) -> dict:
    """The operator token and judge passcode, for the API process only. Never printed: the
    console says where each one is, so the owner can hand the passcode to a judge."""
    global AUTH_NOTE
    sys.path.insert(0, str(ROOT / "scripts"))
    import operator_auth

    op = os.environ.get("COUNTERPROOF_OPERATOR_TOKEN") or env_file.get("COUNTERPROOF_OPERATOR_TOKEN")
    op_src = "COUNTERPROOF_OPERATOR_TOKEN"
    if not op:
        op, op_src = secrets.token_urlsafe(32), "generated for this launch"
    operator_auth.write_token_file(op)
    judge = os.environ.get("COUNTERPROOF_JUDGE_PASSCODE") or env_file.get("COUNTERPROOF_JUDGE_PASSCODE")
    passcode_file = ROOT / "data" / "judge.passcode"
    if judge:
        judge_src = "COUNTERPROOF_JUDGE_PASSCODE (environment or .env)"
    else:
        judge = secrets.token_urlsafe(9)
        passcode_file.parent.mkdir(parents=True, exist_ok=True)
        passcode_file.write_text(judge, encoding="utf-8")
        judge_src = f"generated for this launch: see {passcode_file.relative_to(ROOT)}"
    AUTH_NOTE = (f"Judge sign-in passcode: {judge_src}. Operator token: {op_src} "
                 f"(scripts read {operator_auth.TOKEN_FILE.relative_to(ROOT)}; stop everything with scripts/operator.py stop).")
    return {"COUNTERPROOF_OPERATOR_TOKEN": op, "COUNTERPROOF_JUDGE_PASSCODE": judge}


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "local"
    web = "--no-web" not in sys.argv
    from counterproof import devchain

    procs: list[tuple[str, subprocess.Popen]] = []
    base = {k: v for k, v in os.environ.items()
            if not any(h in k.upper() for h in ("KEY", "TOKEN", "SECRET", "PRIVATE", "PASSWORD", "PASSCODE"))}
    base |= {"PYTHONIOENCODING": "utf-8", "COUNTERPROOF_ENV_FILE": str(ROOT / "data" / "no.env")}
    env_file = read_env()
    token = secrets.token_hex(16)
    roles: dict[str, dict] = {"signer": {}, "api": {}, "worker": {}}
    providers = {k: v for k, v in {**os.environ, **env_file}.items() if k in ("GROQ_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY")}

    if mode == "local":
        data = ROOT / "data" / "local"
        data.mkdir(parents=True, exist_ok=True)
        state = data / "anvil-state.json"
        anvil = subprocess.Popen([devchain.anvil_exe(), "--network", "monad", "--port", "8545", "--chain-id", "31337",
                                  "--state", str(state), "--state-interval", "5", "--silent"])
        procs.append(("anvil", anvil))
        wait_port(8545)
        w3 = devchain.web3_for("http://127.0.0.1:8545")
        dep = data / "deployment.json"
        contract = json.loads(dep.read_text())["contract"] if dep.exists() else None
        if not contract or len(w3.eth.get_code(w3.to_checksum_address(contract))) == 0:
            contract = devchain.deploy(w3)
            dep.write_text(json.dumps({"contract": contract, "chain_id": 31337, "network": "anvil-local"}), encoding="utf-8")
            print(f"deployed CounterProofBounties at {contract} on local anvil (31337)")
        K = devchain.ANVIL_KEYS
        common = {"COUNTERPROOF_NETWORK": "anvil-local", "COUNTERPROOF_CONTRACT": contract.lower(),
                  "COUNTERPROOF_RPC_URL": "http://127.0.0.1:8545", "COUNTERPROOF_DATA_DIR": str(data),
                  "COUNTERPROOF_EVALUATOR_ADDRESS": devchain.address_of(K["evaluator"]).lower(),
                  "COUNTERPROOF_CHALLENGER_ADDRESS": devchain.address_of(K["challenger"]).lower()}
        roles["signer"]["EVALUATOR_PRIVATE_KEY"] = K["evaluator"]
        roles["api"]["COUNTERPROOF_CHALLENGER_PRIVATE_KEY"] = K["challenger"]
        web_env = {"NEXT_PUBLIC_DEV_WALLET": "1"}
    elif mode == "testnet":
        # COUNTERPROOF_FORK_REHEARSAL=1: against the local anvil fork used by scripts/testnet.py
        # (contract from its overlay; every page is labelled as a rehearsal).
        rehearsal = os.environ.get("COUNTERPROOF_FORK_REHEARSAL") == "1"
        if rehearsal:
            sys.path.insert(0, str(ROOT / "scripts"))
            import testnet as tn

            env_file = {k: v for k, v in tn.env().items() if v}
        need = ("COUNTERPROOF_CONTRACT", "EVALUATOR_PRIVATE_KEY", "COUNTERPROOF_EVALUATOR_ADDRESS")
        missing = [k for k in need if k not in env_file]
        if missing:
            raise SystemExit(f"missing in .env: {missing} (run scripts/keygen.py and scripts/testnet.py deploy)")
        # --data DIR serves another data directory, e.g. the one an e2e_testnet.py run wrote
        data = Path(sys.argv[sys.argv.index("--data") + 1]).resolve() if "--data" in sys.argv else ROOT / "data" / "testnet"
        common = {"COUNTERPROOF_NETWORK": "monad-testnet", "COUNTERPROOF_CONTRACT": env_file["COUNTERPROOF_CONTRACT"],
                  "COUNTERPROOF_DATA_DIR": str(data), "COUNTERPROOF_EVALUATOR_ADDRESS": env_file["COUNTERPROOF_EVALUATOR_ADDRESS"]}
        if rehearsal:
            common |= {"COUNTERPROOF_RPC_URL": tn.RPC, "COUNTERPROOF_ERC8004_RECORD": str(tn.ERC8004_RECORD)}
        roles["signer"]["EVALUATOR_PRIVATE_KEY"] = env_file["EVALUATOR_PRIVATE_KEY"]
        if "COUNTERPROOF_CHALLENGER_PRIVATE_KEY" in env_file:
            roles["api"]["COUNTERPROOF_CHALLENGER_PRIVATE_KEY"] = env_file["COUNTERPROOF_CHALLENGER_PRIVATE_KEY"]
            from eth_account import Account

            common["COUNTERPROOF_CHALLENGER_ADDRESS"] = Account.from_key(env_file["COUNTERPROOF_CHALLENGER_PRIVATE_KEY"]).address.lower()
        web_env = {}
    elif mode == "offchain":
        data = ROOT / "data" / "offchain"
        common = {"COUNTERPROOF_NETWORK": "offchain", "COUNTERPROOF_DATA_DIR": str(data),
                  "COUNTERPROOF_EVALUATOR_ADDRESS": env_file.get("COUNTERPROOF_EVALUATOR_ADDRESS", "0x" + "e7" * 20)}
        web_env = {}
    else:
        raise SystemExit(__doc__)

    for k in ("COUNTERPROOF_LLM_PROVIDER", "COUNTERPROOF_LLM_MODEL"):
        if k in env_file:
            common[k] = env_file[k]
    from counterproof.limits import FORWARDED_SETTINGS

    for k in FORWARDED_SETTINGS:  # server-side limits and auth settings: not secrets, but some names hold "TOKEN"
        if os.environ.get(k) or env_file.get(k):
            common[k] = os.environ.get(k) or env_file[k]
    common |= {"COUNTERPROOF_SIGNER_TOKEN": token, "COUNTERPROOF_SIGNER_URL": "http://127.0.0.1:8011"}
    roles["worker"] |= providers
    roles["api"] |= providers
    roles["api"] |= api_auth(env_file)
    # The signer replays every submission itself before it signs, live-model ones included,
    # so its model broker needs the provider key (target children never receive it).
    roles["signer"] |= providers
    workers = int(sys.argv[sys.argv.index("--workers") + 1]) if "--workers" in sys.argv else 2
    services = [("signer", "counterproof.signer"), ("api", "counterproof.api")] + [("worker", "counterproof.worker")] * workers
    for name, module in services:
        env = base | common | roles[name] | {"COUNTERPROOF_ROLE": name}
        procs.append((name, subprocess.Popen([PY, "-m", module], cwd=str(ROOT / "backend"), env=env)))
    wait_port(8010)
    if web:
        npm = "pnpm.cmd" if os.name == "nt" else "pnpm"
        procs.append(("web", subprocess.Popen([npm, "dev", "--port", "3000", "--hostname", "127.0.0.1"], cwd=str(ROOT / "web"),
                                              env=base | web_env | {"BACKEND_URL": "http://127.0.0.1:8010"})))
    print(f"\nCounterProof ({mode}) running: web http://127.0.0.1:3000 (or http://localhost:3000)  "
          f"api http://127.0.0.1:8010/api/config\n{AUTH_NOTE}\nCtrl+C to stop.")
    try:
        while all(p.poll() is None for _, p in procs):
            time.sleep(1)
        dead = [n for n, p in procs if p.poll() is not None]
        print(f"stopped because {dead} exited")
        return 1
    except KeyboardInterrupt:
        return 0
    finally:
        for name, p in reversed(procs):
            if p.poll() is None:
                p.terminate()  # anvil state is saved every 5 s (--state-interval)
        for _, p in procs:
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()


if __name__ == "__main__":
    raise SystemExit(main())
