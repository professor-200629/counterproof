"""Operator controls for a running CounterProof API.

  python scripts/operator.py status            queue, today's model tokens, ceiling, stop flag
  python scripts/operator.py stop [reason]     refuse new jobs and model calls; cancel every
                                               queued or running job
  python scripts/operator.py resume            allow new jobs and model calls again
  add --api http://127.0.0.1:8010 for another API.

Authenticates with the operator bearer token (COUNTERPROOF_OPERATOR_TOKEN, else
data/operator.token written by scripts/dev.py). Cancellation is cooperative: a sequence or a
model call already in flight finishes first (a model call can take a minute, longer while the
provider rate-limits), and every later model call is refused as "unavailable", which the
evaluator records as runner_failure (retryable), never as a verdict about the target.

Run as a script only. (Named after its job; `import operator` elsewhere still gets the
standard library module, which the interpreter loads before this directory is on the path.)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import operator_auth  # noqa: E402

API = sys.argv[sys.argv.index("--api") + 1] if "--api" in sys.argv else "http://127.0.0.1:8010"


def main(argv: list[str]) -> int:
    args = [a for i, a in enumerate(argv) if a not in ("--api", "--json") and (i == 0 or argv[i - 1] != "--api")]
    cmd = args[0] if args else "status"
    if cmd not in ("status", "stop", "resume"):
        print(__doc__)
        return 2
    c = operator_auth.client(API, timeout=30)
    c.headers.update(operator_auth.require_headers())
    if cmd == "status":
        r = c.get("/api/operator/status")
    elif cmd == "stop":
        r = c.post("/api/operator/stop", json={"reason": " ".join(args[1:])[:200]})
    else:
        r = c.post("/api/operator/resume")
    if r.status_code != 200:
        print(f"{cmd}: HTTP {r.status_code}: {r.text[:400]}", file=sys.stderr)
        return 1
    out = r.json()
    if cmd == "status":
        q, u = out["queue"], out["usage"]
        print(f"stop: {'IN EFFECT - ' + (out['stop'].get('reason') or 'no reason given') if out['stop'] else 'not in effect'}")
        print(f"queue: {q['queued']} queued, {q['running']} running (limit {q['limit']})")
        print(f"model tokens today ({u['day']} UTC): {u['tokens_today']} of {u['daily_ceiling']}")
        for j in q["jobs"]:
            print(f"  {j['id']}  {j['kind']:<11} {j['status']:<8} {j.get('owner') or '-'}"
                  + ("  (cancel requested)" if j.get("cancel_requested") else ""))
    elif cmd == "stop":
        print(f"operator stop in effect; {len(out['jobs'])} job(s) asked to stop:")
        for j in out["jobs"]:
            print(f"  {j['id']}  {j['kind']:<11} -> {j['to']}")
        print(out["note"])
    else:
        print("resumed: new jobs and model calls are allowed again")
    if "--json" in argv:
        print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
