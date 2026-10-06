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


def snapshot_file(api_path: str, suffix: str = ".json") -> Path:
    """/api/evidence/sha256:ab -> api/evidence/sha256_ab.json (':' is not allowed in Windows
    file names). The web app's snapshot mode applies the same mapping."""
    return Path(api_path.lstrip("/").replace(":", "_") + suffix)


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
        p = OUT / snapshot_file(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        saved.append(path)

    def get(path: str):
        r = c.get(path)
        r.raise_for_status()
        save(path, r.json())
        return r.json()

    only = None
    if "--challenges" in sys.argv:
        only = {int(x) for x in sys.argv[sys.argv.index("--challenges") + 1].split(",")}
    cfg = get("/api/config")
    for p in ("/api/targets", "/api/rule-templates", "/api/strategies"):
        get(p)
    all_challenges = c.get("/api/challenges").json()
    chosen = [ch for ch in all_challenges if only is None or ch["id"] in only]
    save("/api/challenges", chosen)
    overview = c.get("/api/overview").json()
    if only is not None:
        overview["activity"] = [a for a in overview["activity"] if a.get("challenge_id") in only]
        overview["challenges"] = len(chosen)
        for k, st in (("funded", "funded"), ("settled", "settled")):
            overview[k] = sum(1 for ch in chosen if ch["status"] == st)
        overview["verified_violations"] = sum(ch["counts"]["verified"] for ch in chosen)
        overview["active_runs"] = 0
    save("/api/overview", overview)
    for ch in chosen:
        view = get(f"/api/challenges/{ch['id']}")
        get(f"/api/challenges/{ch['id']}/settlement")
        get(f"/api/specs/{view['spec_digest']}")
        for reg in get(f"/api/challenges/{ch['id']}/regressions"):
            get(f"/api/regressions/{reg['id']}")
            get(f"/api/regressions/{reg['id']}/export")
            py = c.get(f"/api/regressions/{reg['id']}/export?format=pytest")
            if py.status_code == 200:
                target = OUT / snapshot_file(f"/api/regressions/{reg['id']}/export", ".pytest.txt")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(py.text, encoding="utf-8")
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
    manifest = {"format": "counterproof.snapshot/v1", "taken_at": int(time.time()),
                "network": cfg["network"], "network_label": cfg["network_label"], "chain_id": cfg["chain"]["chain_id"],
                "contract": cfg["chain"]["contract"], "explorer_tx_url": cfg["chain"]["explorer_tx_url"],
                "challenges_included": [ch["id"] for ch in chosen], "challenges_on_evaluator": len(all_challenges),
                "files": len(saved),
                "note": "Recorded responses from the CounterProof evaluator. Read-only: nothing on this site runs live."}
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    print(f"exported {len(saved)} responses to {OUT.relative_to(ROOT)} ({cfg['network_label']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
