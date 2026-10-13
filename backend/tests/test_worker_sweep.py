"""The worker's orphan sweep never kills a running target container.

Every target container carries the label counterproof.target=1, whoever started it: another
worker, or the evaluator's signer replaying a committed candidate itself before it signs.
An idle worker sweeps every ~15 s. The old sweep (`docker ps -aq --filter label=...` then
`docker rm -f`) removed running containers too; a signer child killed that way ends its
replay as `target_crash`, a replay that did not violate, and the signer records a final
'rejected' for a valid finding.

Docker is not needed: `subprocess.run` is replaced by a small simulation of the two docker
commands (filters with the same key are OR'd, different keys AND'd; `rm` without -f refuses
a running container).
"""

from __future__ import annotations

import subprocess

import pytest

LABEL = "counterproof.target=1"


class FakeDocker:
    def __init__(self, containers: dict[str, tuple[str, str | None]]):
        self.containers = dict(containers)  # id -> (status, label)
        self.calls: list[list[str]] = []

    def run(self, cmd, *args, **kwargs):
        cmd = list(cmd)
        self.calls.append(cmd)
        if cmd[:1] != ["docker"]:
            raise AssertionError(f"unexpected command {cmd}")
        if cmd[1] == "ps":
            filters = [cmd[i + 1] for i, a in enumerate(cmd) if a == "--filter"]
            labels = [f.split("=", 1)[1] for f in filters if f.startswith("label=")]
            statuses = [f.split("=", 1)[1] for f in filters if f.startswith("status=")]
            ids = [c for c, (status, label) in self.containers.items()
                   if all(label == want for want in labels) and (not statuses or status in statuses)]
            return subprocess.CompletedProcess(cmd, 0, stdout="".join(f"{i}\n" for i in ids), stderr="")
        if cmd[1] == "rm":
            force = "-f" in cmd
            for c in [a for a in cmd[2:] if not a.startswith("-")]:
                if c in self.containers and (force or self.containers[c][0] != "running"):
                    del self.containers[c]
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="not simulated")


@pytest.fixture
def docker(monkeypatch):
    fake = FakeDocker({
        "signer-replay": ("running", LABEL),   # the signer replaying a committed candidate
        "other-worker": ("running", LABEL),    # another worker's evaluation
        "starting": ("created", LABEL),        # `docker run` between create and start
        "crashed-exited": ("exited", LABEL),   # left behind by a crashed worker
        "crashed-dead": ("dead", LABEL),
        "unrelated-exited": ("exited", None),  # not a CounterProof target
    })
    monkeypatch.setattr(subprocess, "run", fake.run)
    return fake


def test_worker_recovery_never_removes_a_running_target_container(docker):
    """An idle worker's periodic recovery removes only stopped target containers. Before the
    fix it ran `docker rm -f` on every labelled container, killing live replays."""
    from counterproof.worker import Worker

    Worker(name="idle-worker").recover()
    assert set(docker.containers) == {"signer-replay", "other-worker", "starting", "unrelated-exited"}
    assert not any(c[:2] == ["docker", "rm"] and "-f" in c for c in docker.calls)


def test_sweep_without_docker_is_a_no_op(monkeypatch):
    from counterproof.worker import sweep_stopped_targets

    def missing(*a, **k):
        raise FileNotFoundError("docker")

    monkeypatch.setattr(subprocess, "run", missing)
    assert sweep_stopped_targets() == 0
