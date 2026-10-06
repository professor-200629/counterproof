"""Entry point executed in the child: `python -s -B host_entry.py`.

The child starts with a minimal environment (no secrets, no PYTHONPATH), so the backend
root is put on sys.path explicitly here.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from counterproof.runner.host import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
