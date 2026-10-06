"""Challenger strategies: bounded searches for counterexamples.

A strategy proposes action sequences; the shared harness (`harness.py`) runs each one
against the target in the challenger's own sandbox, checks the agreed rules locally and
shrinks any hit to a minimal sequence. A strategy hit is only a *candidate*: it becomes a
verified finding solely through the evaluator's independent replay.
"""

STRATEGY_VERSION = "1.0.0"
