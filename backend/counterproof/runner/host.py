"""Target host: runs inside the sandboxed child process or container.

It loads exactly one adapter from the closed registry table below, then relays the
adapter's tool and model requests to the evaluator over stdin/stdout. It holds no market
state, no ledger, no keys and no network access: every effect happens in the parent.

Stdlib only (plus the adapter modules): this file is copied into the target image.
"""

from __future__ import annotations

import importlib
import os
import socket
import sys
from typing import Any

from .protocol import ProtocolError, decode, encode

# Closed table: adapter key -> (module, class). Nothing outside this table can be loaded.
HOSTED_ADAPTERS = {
    "ref-purchasing-agent@1.0.0": ("counterproof.targets.ref_agent_v1_0", "RefAgentV1_0"),
    "ref-purchasing-agent@1.1.0": ("counterproof.targets.ref_agent_v1_1", "RefAgentV1_1"),
    "llm-purchasing-agent@0.1.0": ("counterproof.targets.llm_agent", "LlmPurchasingAgent"),
    # Hostile adapters for the runner's own tests. Hosted, but absent from the evaluator
    # registry, so no challenge can name them.
    "test-memory-hog@0": ("counterproof.targets.testing", "MemoryHog"),
    "test-busy-loop@0": ("counterproof.targets.testing", "BusyLoop"),
    "test-crash@0": ("counterproof.targets.testing", "Crash"),
    "test-network-probe@0": ("counterproof.targets.testing", "NetworkProbe"),
    "test-env-probe@0": ("counterproof.targets.testing", "EnvProbe"),
    "test-tool-flood@0": ("counterproof.targets.testing", "ToolFlood"),
    "test-protocol-garbage@0": ("counterproof.targets.testing", "ProtocolGarbage"),
    "test-ledger-forger@0": ("counterproof.targets.testing", "LedgerForger"),
}


class Abort(Exception):
    pass


def install_network_guard() -> None:
    """Refuse socket creation inside the target. In process isolation this is a guard for
    first-party adapters, not a security boundary; in container isolation the container
    has no network interface at all."""

    def _deny(*_a: Any, **_k: Any) -> Any:
        raise PermissionError("network access is disabled inside the CounterProof target sandbox")

    socket.socket.connect = _deny  # type: ignore[method-assign]
    socket.socket.connect_ex = _deny  # type: ignore[method-assign]
    socket.create_connection = _deny  # type: ignore[assignment]
    socket.getaddrinfo = _deny  # type: ignore[assignment]


class Channel:
    def __init__(self, rfile: Any, wfile: Any):
        self.rfile = rfile
        self.wfile = wfile
        self.next_id = 0

    def send(self, msg: dict) -> None:
        self.wfile.write(encode(msg))
        self.wfile.flush()

    def recv(self) -> dict:
        line = self.rfile.readline(70 * 1024)
        if not line:
            raise Abort("parent closed the channel")
        msg = decode(line)
        if msg["kind"] in ("abort", "shutdown"):
            raise Abort(msg.get("reason", msg["kind"]))
        return msg

    def request(self, kind: str, reply_kind: str, payload: dict) -> dict:
        self.next_id += 1
        rid = self.next_id
        self.send({"kind": kind, "id": rid, **payload})
        msg = self.recv()
        if msg.get("kind") != reply_kind or msg.get("id") != rid:
            raise ProtocolError(f"expected {reply_kind} #{rid}, got {msg.get('kind')}")
        return msg


class ToolProxy:
    def __init__(self, ch: Channel):
        self.ch = ch

    def call(self, tool: str, **args: Any) -> dict:
        msg = self.ch.request("call", "result", {"tool": tool, "args": args})
        return {k: msg[k] for k in ("ok", "value", "error") if k in msg}


class ModelProxy:
    def __init__(self, ch: Channel):
        self.ch = ch

    def complete(self, request: dict) -> dict:
        msg = self.ch.request("model", "model_result", {"request": request})
        if not msg.get("ok"):
            raise RuntimeError(f"model broker refused: {msg.get('error')}")
        return msg["response"]


def _load(adapter_key: str):
    if adapter_key not in HOSTED_ADAPTERS:
        raise ProtocolError(f"adapter {adapter_key!r} is not hosted")
    module, cls = HOSTED_ADAPTERS[adapter_key]
    return getattr(importlib.import_module(module), cls)


def main() -> int:
    proto_in = sys.stdin.buffer
    proto_out = sys.stdout.buffer
    sys.stdout = sys.stderr  # adapter prints must never corrupt the protocol stream
    install_network_guard()
    ch = Channel(proto_in, proto_out)
    try:
        init = ch.recv()
        if init.get("kind") != "init":
            raise ProtocolError("first message must be init")
        adapter_key = init["adapter_key"]
        config = init.get("config") or {}
        agent_cls = _load(adapter_key)
        uses_model = bool(init.get("model"))

        def fresh():
            return agent_cls(ToolProxy(ch), ModelProxy(ch) if uses_model else None, config)

        agent = fresh()
        ch.send({"kind": "ready", "adapter_key": adapter_key, "pid": os.getpid()})
        while True:
            msg = ch.recv()
            if msg["kind"] == "event":
                claim = agent.handle(msg["event"])
                ch.send({"kind": "event_done", "claim": str(claim)[:500]})
            elif msg["kind"] == "reset":
                agent = fresh()
                ch.send({"kind": "reset_done"})
            else:
                raise ProtocolError(f"unexpected message {msg['kind']}")
    except Abort:
        return 0
    except Exception as e:  # report and exit non-zero; the parent classifies it
        try:
            ch.send({"kind": "fatal", "error": f"{type(e).__name__}: {str(e)[:300]}"})
        except Exception:
            pass
        return 3
