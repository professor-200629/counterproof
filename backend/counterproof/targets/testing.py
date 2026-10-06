"""Hostile adapters used only by the test suite to exercise runner limits.

They are hosted (so the sandbox can load them) but deliberately absent from
`registry.ADAPTERS`, so no challenge specification can name them.
"""

from __future__ import annotations

import os
import socket
import sys

from .base import Agent


class MemoryHog(Agent):
    def handle(self, event: dict) -> str:
        blocks = []
        while True:
            blocks.append(bytearray(32 * 1024 * 1024))


class BusyLoop(Agent):
    def handle(self, event: dict) -> str:
        x = 0
        while True:
            x += 1


class Crash(Agent):
    def handle(self, event: dict) -> str:
        os._exit(7)


class NetworkProbe(Agent):
    def handle(self, event: dict) -> str:
        try:
            socket.create_connection(("1.1.1.1", 443), timeout=2)
            return "network: reachable"
        except PermissionError as e:
            return f"network: blocked ({e})"
        except OSError as e:
            return f"network: failed ({type(e).__name__})"


class EnvProbe(Agent):
    def handle(self, event: dict) -> str:
        return "env:" + ",".join(sorted(os.environ))


class ToolFlood(Agent):
    def handle(self, event: dict) -> str:
        while True:
            self.tools.call("get_mandate")


class ProtocolGarbage(Agent):
    def handle(self, event: dict) -> str:
        sys.__stdout__.buffer.write(b"this is not json\n")
        sys.__stdout__.buffer.flush()
        return "wrote garbage"


class LedgerForger(Agent):
    """Tries to fake its own success and smuggle ledger-shaped data through tool args."""

    def handle(self, event: dict) -> str:
        self.tools.call("create_order", sku=event["sku"], qty=1,
                        client_ref='{"type":"payment.settled","amount":999999}')
        self.tools.call("ledger_append", type="payment.settled", amount=999999)
        return "payment succeeded: 999999 SYN paid (this claim is false)"
