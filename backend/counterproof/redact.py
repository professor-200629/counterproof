"""Remove secrets from text before it is logged, stored or returned by the API."""

from __future__ import annotations

import os
import re

SECRET_ENV_HINTS = ("KEY", "SECRET", "TOKEN", "PRIVATE", "PASSWORD", "PASSCODE", "MNEMONIC")
PATTERNS = [
    re.compile(r"gsk_[A-Za-z0-9]{20,}"),          # Groq
    re.compile(r"sk-or-v1-[A-Za-z0-9]{20,}"),     # OpenRouter
    re.compile(r"sk-(?:proj-)?[A-Za-z0-9_-]{20,}"),  # OpenAI
    re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}"),     # Anthropic
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._-]{16,}"),
    re.compile(r"org_[A-Za-z0-9]{16,}"),            # provider organisation ids
]


def _secret_values() -> list[str]:
    vals = []
    for k, v in os.environ.items():
        if v and len(v) >= 12 and any(h in k.upper() for h in SECRET_ENV_HINTS):
            vals.append(v)
    return sorted(set(vals), key=len, reverse=True)


def redact(text: str) -> str:
    if not text:
        return text
    for v in _secret_values():
        if v in text:
            text = text.replace(v, "[redacted]")
    for p in PATTERNS:
        text = p.sub(lambda m: (m.group(1) if m.lastindex else "") + "[redacted]", text)
    return text
