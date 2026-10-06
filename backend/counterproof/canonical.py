"""Canonical JSON and digests.

Every artifact that is hashed (challenge specs, candidates, ledgers, evidence bundles)
goes through `canonical_json`, a strict subset of RFC 8785 (JCS):

* object keys must be ASCII strings and are sorted;
* no insignificant whitespace;
* only integers, never floats (amounts are integer synthetic cents or decimal-string wei),
  so number formatting can never differ between implementations;
* strings are UTF-8, not escaped to ASCII.

Digests are SHA-256 and written as ``sha256:<64 hex>``. The same 32 bytes are stored
on chain as ``bytes32`` (see `to_bytes32`).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Iterable

DIGEST_PREFIX = "sha256:"


class CanonicalError(ValueError):
    pass


def _check(value: Any, path: str = "$") -> None:
    if value is None or isinstance(value, (bool, str)):
        return
    if isinstance(value, int):
        if abs(value) > 2**53 - 1:
            raise CanonicalError(f"{path}: integer outside the safe range; encode large values as strings")
        return
    if isinstance(value, float):
        raise CanonicalError(f"{path}: floats are not allowed in canonical documents")
    if isinstance(value, (list, tuple)):
        for i, item in enumerate(value):
            _check(item, f"{path}[{i}]")
        return
    if isinstance(value, dict):
        for k, v in value.items():
            if not isinstance(k, str) or not k.isascii():
                raise CanonicalError(f"{path}: keys must be ASCII strings, got {k!r}")
            _check(v, f"{path}.{k}")
        return
    raise CanonicalError(f"{path}: unsupported type {type(value).__name__}")


def canonical_json(value: Any) -> bytes:
    _check(value)
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def digest(value: Any) -> str:
    return DIGEST_PREFIX + sha256_hex(canonical_json(value))


def digest_bytes(data: bytes) -> str:
    return DIGEST_PREFIX + sha256_hex(data)


def is_digest(value: Any) -> bool:
    if not isinstance(value, str) or not value.startswith(DIGEST_PREFIX):
        return False
    hexpart = value[len(DIGEST_PREFIX):]
    return len(hexpart) == 64 and all(c in "0123456789abcdef" for c in hexpart)


def to_bytes32(d: str) -> str:
    """``sha256:<hex>`` -> ``0x<hex>`` for the contract."""
    if not is_digest(d):
        raise CanonicalError(f"not a digest: {d!r}")
    return "0x" + d[len(DIGEST_PREFIX):]


def from_bytes32(b: str | bytes) -> str:
    if isinstance(b, (bytes, bytearray)):
        hexpart = bytes(b).hex()
    else:
        hexpart = b[2:] if b.startswith("0x") else b
    hexpart = hexpart.lower()
    if len(hexpart) != 64:
        raise CanonicalError("bytes32 must be 32 bytes")
    return DIGEST_PREFIX + hexpart


def source_digest(files: Iterable[Path], root: Path) -> str:
    """Digest of a set of source files: relative POSIX path + content, sorted by path.

    Line endings are normalised to LF so a Windows checkout and a Linux container image
    built from the same commit produce the same digest.
    """
    entries = []
    for f in sorted(set(files), key=lambda p: p.relative_to(root).as_posix()):
        content = f.read_bytes().replace(b"\r\n", b"\n")
        entries.append({"path": f.relative_to(root).as_posix(), "sha256": sha256_hex(content)})
    return digest({"files": entries})
