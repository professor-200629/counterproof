"""Export a read-only snapshot of a running CounterProof API for a static, hosted console.

Every GET response the console needs is saved under web/public/snapshot/ with the same
path as the API (e.g. /api/challenges/1 -> snapshot/api/challenges/1.json), plus a
manifest recording when and from which network it was taken. The console's snapshot mode
(NEXT_PUBLIC_SNAPSHOT=1) reads these files, disables every action and labels all data as
"recorded". On-chain state can still be read live by the browser.

Usage: backend\\.venv\\Scripts\\python scripts\\export_snapshot.py [--api http://127.0.0.1:8010]
"""

from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
API = sys.argv[sys.argv.index("--api") + 1] if "--api" in sys.argv else "http://127.0.0.1:8010"
OUT = ROOT / "web" / "public" / "snapshot"
SECRET_HINTS = ("KEY", "SECRET", "TOKEN", "PRIVATE", "PASSWORD", "MNEMONIC")


def secret_values() -> set[str]:
    """Actual secret values from .env and the environment (never printed)."""
    import os

    vals = {v for k, v in os.environ.items() if v and len(v) >= 12 and any(h in k.upper() for h in SECRET_HINTS)}
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                if len(v.strip()) >= 12 and any(h in k.upper() for h in SECRET_HINTS):
                    vals.add(v.strip())
                    vals.add(v.strip().lower().removeprefix("0x"))
    return vals


def main() -> int:
    c = httpx.Client(base_url=API, timeout=60)
    if OUT.exists():
        shutil.rmtree(OUT)
    saved: list[str] = []
    secrets = secret_values()

    def save(path: str, data) -> None:
        text = json.dumps(data, indent=1)
        if any(v in text for v in secrets):
            raise SystemExit(f"refusing to export {path}: it contains a secret value")
        p = OUT / (path.lstrip("/") + ".json")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        saved.append(path)

    def get(path: str):
        r = c.get(path)
        r.raise_for_status()
        save(path, r.json())
        return r.json()

    cfg = get("/api/config")
    for p in ("/api/overview", "/api/targets", "/api/rule-templates", "/api/strategies"):
        get(p)
    for ch in get("/api/challenges"):
        view = get(f"/api/challenges/{ch['id']}")
        get(f"/api/challenges/{ch['id']}/settlement")
        get(f"/api/specs/{view['spec_digest']}")
        for reg in get(f"/api/challenges/{ch['id']}/regressions"):
            get(f"/api/regressions/{reg['id']}")
            if reg.get("evidence_digest"):
                get(f"/api/evidence/{reg['evidence_digest']}")
                get(f"/api/specs/{reg['spec_digest']}")
        for run in view["runs"]:
            get(f"/api/runs/{run['id']}")
        for cand in view["candidates"]:
            get(f"/api/candidates/{cand['id']}")
        for ev in view["evaluations"]:
            get(f"/api/evaluations/{ev['id']}")
            if ev.get("evidence_digest"):
                get(f"/api/evidence/{ev['evidence_digest']}")
    manifest = {"format": "counterproof.snapshot/v1", "taken_at": int(time.time()), "api": API,
                "network": cfg["network"], "network_label": cfg["network_label"], "contract": cfg["chain"]["contract"],
                "files": len(saved), "note": "Recorded responses from the evaluator. Read-only; nothing here is executed live."}
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    print(f"exported {len(saved)} responses to {OUT.relative_to(ROOT)} ({cfg['network_label']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
