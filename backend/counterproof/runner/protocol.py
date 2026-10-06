"""Line-delimited JSON protocol between the evaluator (parent) and the target host (child).

Parent -> child: init, event, result, model_result, reset, abort, shutdown
Child -> parent: ready, call, model, event_done, reset_done, fatal

Stdlib only: this module is copied into the target container image.
"""

from __future__ import annotations

import json

MAX_LINE_BYTES = 64 * 1024


class ProtocolError(Exception):
    pass


def encode(msg: dict) -> bytes:
    line = json.dumps(msg, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("ascii") + b"\n"
    if len(line) > MAX_LINE_BYTES:
        raise ProtocolError(f"message of {len(line)} bytes exceeds {MAX_LINE_BYTES}")
    return line


def decode(line: bytes) -> dict:
    if len(line) > MAX_LINE_BYTES:
        raise ProtocolError("line too long")
    try:
        msg = json.loads(line.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise ProtocolError(f"not JSON: {e}") from None
    if not isinstance(msg, dict) or not isinstance(msg.get("kind"), str):
        raise ProtocolError("message must be an object with a 'kind'")
    return msg
