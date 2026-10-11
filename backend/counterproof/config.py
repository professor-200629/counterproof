"""Configuration from environment variables (see ../.env.example).

Secrets (evaluator key, challenger key, provider API keys) are read only by the processes
that need them, are never returned by the API and are never passed to target sandboxes.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


PROVIDER_KEYS = {"GROQ_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"}
# Which secrets each process may load from .env. Everything else that looks secret is
# skipped, so e.g. the API and worker never hold the evaluator's signing key.
ROLE_SECRETS = {
    "signer": {"EVALUATOR_PRIVATE_KEY", "COUNTERPROOF_SIGNER_TOKEN"},
    "api": {"COUNTERPROOF_CHALLENGER_PRIVATE_KEY", "COUNTERPROOF_SIGNER_TOKEN"} | PROVIDER_KEYS,
    "worker": {"COUNTERPROOF_SIGNER_TOKEN"} | PROVIDER_KEYS,
    "script": None,  # deployment/key scripts may read everything
}
SECRET_HINTS = ("KEY", "SECRET", "TOKEN", "PRIVATE", "MNEMONIC", "PASSWORD")


def role() -> str:
    r = os.environ.get("COUNTERPROOF_ROLE", "api")
    return r if r in ROLE_SECRETS else "api"


def _load_dotenv() -> None:
    """Minimal .env loader (KEY=VALUE lines); real environment variables win. Secrets are
    loaded only if this process's role needs them (COUNTERPROOF_ROLE)."""
    p = Path(os.environ.get("COUNTERPROOF_ENV_FILE", ROOT / ".env"))
    if not p.exists():
        return
    allowed = ROLE_SECRETS[role()]
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if not v:
            continue
        if allowed is not None and any(h in k.upper() for h in SECRET_HINTS) and k not in allowed:
            continue
        os.environ.setdefault(k, v)


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    db_path: Path
    artifacts_dir: Path
    network: str  # anvil-local | monad-testnet | offchain
    rpc_url: str | None
    chain_id: int | None
    contract: str | None
    explorer_tx_url: str | None
    evaluator_address: str | None
    signer_url: str
    signer_token: str | None
    api_port: int
    default_isolation: str
    llm_provider: str | None
    llm_model: str | None


NETWORKS = {
    "anvil-local": {"chain_id": 31337, "rpc_url": "http://127.0.0.1:8545", "explorer_tx_url": None,
                    "label": "Local anvil chain (31337) - not Monad testnet"},
    "monad-testnet": {"chain_id": 10143, "rpc_url": "https://testnet-rpc.monad.xyz",
                      "explorer_tx_url": "https://testnet.monadscan.com/tx/{hash}", "label": "Monad Testnet (10143)"},
    "offchain": {"chain_id": None, "rpc_url": None, "explorer_tx_url": None,
                 "label": "Off-chain only - no settlement"},
}


@lru_cache
def settings() -> Settings:
    _load_dotenv()
    data = Path(os.environ.get("COUNTERPROOF_DATA_DIR", ROOT / "data"))
    network = os.environ.get("COUNTERPROOF_NETWORK", "anvil-local")
    if network not in NETWORKS:
        raise ValueError(f"COUNTERPROOF_NETWORK must be one of {sorted(NETWORKS)}")
    n = NETWORKS[network]
    contract = os.environ.get("COUNTERPROOF_CONTRACT") or None
    return Settings(
        data_dir=data,
        db_path=Path(os.environ.get("COUNTERPROOF_DB", data / "counterproof.db")),
        artifacts_dir=data / "artifacts",
        network=network,
        rpc_url=os.environ.get("COUNTERPROOF_RPC_URL") or n["rpc_url"],
        chain_id=n["chain_id"],
        contract=contract.lower() if contract else None,
        explorer_tx_url=n["explorer_tx_url"],
        evaluator_address=(os.environ.get("COUNTERPROOF_EVALUATOR_ADDRESS") or "").lower() or None,
        signer_url=os.environ.get("COUNTERPROOF_SIGNER_URL", "http://127.0.0.1:8011"),
        signer_token=os.environ.get("COUNTERPROOF_SIGNER_TOKEN") or None,
        api_port=int(os.environ.get("COUNTERPROOF_API_PORT", "8010")),
        default_isolation=os.environ.get("COUNTERPROOF_ISOLATION", "process"),
        llm_provider=os.environ.get("COUNTERPROOF_LLM_PROVIDER") or None,
        llm_model=os.environ.get("COUNTERPROOF_LLM_MODEL") or None,
    )


REHEARSAL_SUFFIX = " - FORK REHEARSAL (local anvil fork, not Monad testnet)"


def network_label() -> str:
    label = NETWORKS[settings().network]["label"]
    return label + REHEARSAL_SUFFIX if os.environ.get("COUNTERPROOF_FORK_REHEARSAL") == "1" else label
