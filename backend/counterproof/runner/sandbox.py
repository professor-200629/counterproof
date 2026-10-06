"""Isolation backends for target execution.

* ``container`` - Docker: no network, read-only root, non-root user, all capabilities
  dropped, no-new-privileges, pids/memory/CPU limits, tmpfs scratch, removed after use.
  Requires a running Docker engine and the ``counterproof-target`` image.
* ``process`` - a fresh child Python process with an empty environment (no secrets),
  a socket guard, and (on Windows) a Job Object capping memory, CPU time and process
  count. This is NOT a security boundary against hostile code. It is only offered for
  first-party adapters from the closed registry, whose inputs are validated data.

If a challenge requires an isolation level that is not available, `select_backend`
raises `IsolationUnavailable` and the evaluator fails closed - it never falls back to a
weaker level silently.
"""

from __future__ import annotations

import os
import queue
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from .protocol import MAX_LINE_BYTES, ProtocolError, decode, encode

BACKEND_ROOT = Path(__file__).resolve().parents[2]
HOST_ENTRY = Path(__file__).resolve().with_name("host_entry.py")
TARGET_IMAGE = os.environ.get("COUNTERPROOF_TARGET_IMAGE", "counterproof-target:dev")


class IsolationUnavailable(Exception):
    pass


@dataclass
class ResourceLimits:
    memory_mb: int = 256
    cpu_seconds: int = 20


@dataclass
class ChildInfo:
    isolation: str
    detail: dict = field(default_factory=dict)


class Child:
    """A running target host. Lines are read on a background thread so the parent can
    wait with a timeout on every platform."""

    def __init__(self, proc: subprocess.Popen, info: ChildInfo, cleanup=None):
        self.proc = proc
        self.info = info
        self._cleanup = cleanup
        self.lines: queue.Queue = queue.Queue()
        self.stderr_tail = bytearray()
        self.bytes_out = 0
        self.max_bytes_out = 4 * 1024 * 1024
        self._closed = False
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stdout(self) -> None:
        try:
            while True:
                line = self.proc.stdout.readline(MAX_LINE_BYTES + 1)
                if not line:
                    break
                self.bytes_out += len(line)
                if len(line) > MAX_LINE_BYTES or self.bytes_out > self.max_bytes_out:
                    self.lines.put(("error", "output limit exceeded"))
                    return
                self.lines.put(("line", line))
        except Exception as e:  # pipe closed underneath us
            self.lines.put(("error", f"read failed: {e}"))
        finally:
            self.lines.put(("eof", None))

    def _read_stderr(self) -> None:
        try:
            for chunk in iter(lambda: self.proc.stderr.read(1024), b""):
                self.stderr_tail.extend(chunk)
                if len(self.stderr_tail) > 8192:
                    del self.stderr_tail[:-8192]
        except Exception:
            pass

    def send(self, msg: dict) -> None:
        try:
            self.proc.stdin.write(encode(msg))
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError, ValueError) as e:
            raise ChildGone(f"child not accepting input: {e}") from None

    def recv(self, timeout: float) -> dict:
        try:
            kind, payload = self.lines.get(timeout=max(0.0, timeout))
        except queue.Empty:
            raise ChildTimeout() from None
        if kind == "line":
            return decode(payload)
        if kind == "error":
            raise ProtocolError(payload)
        raise ChildGone("child exited")

    def exit_code(self, wait: float = 0.0) -> int | None:
        try:
            return self.proc.wait(timeout=wait) if wait else self.proc.poll()
        except subprocess.TimeoutExpired:
            return None

    def stderr_text(self) -> str:
        return self.stderr_tail.decode("utf-8", "replace")[-2000:]

    def close(self, graceful: bool = True) -> None:
        if self._closed:
            return
        self._closed = True
        if graceful and self.proc.poll() is None:
            try:
                self.send({"kind": "shutdown"})
            except ChildGone:
                pass
            if self.exit_code(wait=2.0) is None:
                self.proc.kill()
        elif self.proc.poll() is None:
            self.proc.kill()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        for s in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                s.close()
            except Exception:
                pass
        if self._cleanup:
            self._cleanup(self)


class ChildGone(Exception):
    pass


class ChildTimeout(Exception):
    pass


# --------------------------------------------------------------------------- process
def _minimal_env() -> dict:
    env = {"PYTHONHASHSEED": "0", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"}
    if os.name == "nt":
        env["SYSTEMROOT"] = os.environ.get("SYSTEMROOT", r"C:\Windows")
    return env


def _child_python() -> str:
    """The real interpreter. On Windows a venv's python.exe is a launcher that starts the
    base interpreter as a second process, which the one-process job limit forbids. The
    target host needs only the standard library and this package (put on sys.path by
    host_entry.py), so the base interpreter is sufficient."""
    return getattr(sys, "_base_executable", None) or sys.executable


class _WinJob:
    """Windows Job Object: memory cap, CPU-time cap, one active process, kill on close."""

    def __init__(self, limits: ResourceLimits):
        import ctypes
        from ctypes import wintypes

        self.ctypes = ctypes
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateJobObjectW.restype = wintypes.HANDLE
        k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        k32.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
        k32.CloseHandle.argtypes = [wintypes.HANDLE]
        self.k32 = k32

        class IO(ctypes.Structure):
            _fields_ = [(n, ctypes.c_ulonglong) for n in ("r", "w", "o", "rb", "wb", "ob")]

        class Basic(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                        ("SchedulingClass", wintypes.DWORD)]

        class Extended(ctypes.Structure):
            _fields_ = [("Basic", Basic), ("Io", IO), ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                        ("PeakJobMemoryUsed", ctypes.c_size_t)]

        self.Extended = Extended
        self.handle = k32.CreateJobObjectW(None, None)
        if not self.handle:
            raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")
        info = Extended()
        PROCESS_TIME, ACTIVE_PROCESS, PROCESS_MEMORY, KILL_ON_CLOSE, DIE_ON_EXC = 0x2, 0x8, 0x100, 0x2000, 0x400
        info.Basic.LimitFlags = PROCESS_TIME | ACTIVE_PROCESS | PROCESS_MEMORY | KILL_ON_CLOSE | DIE_ON_EXC
        info.Basic.PerProcessUserTimeLimit = limits.cpu_seconds * 10_000_000
        info.Basic.ActiveProcessLimit = 1
        info.ProcessMemoryLimit = limits.memory_mb * 1024 * 1024
        if not k32.SetInformationJobObject(self.handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
            raise OSError(ctypes.get_last_error(), "SetInformationJobObject failed")

    def assign(self, proc: subprocess.Popen) -> None:
        if not self.k32.AssignProcessToJobObject(self.handle, int(proc._handle)):  # type: ignore[attr-defined]
            raise OSError(self.ctypes.get_last_error(), "AssignProcessToJobObject failed")

    def peak_memory(self) -> int | None:
        info = self.Extended()
        ok = self.k32.QueryInformationJobObject(self.handle, 9, self.ctypes.byref(info), self.ctypes.sizeof(info), None)
        return int(info.PeakProcessMemoryUsed) if ok else None

    def close(self) -> None:
        if self.handle:
            self.k32.CloseHandle(self.handle)
            self.handle = None


def _posix_limits(limits: ResourceLimits):
    def apply() -> None:  # runs in the child before exec
        import resource

        mem = limits.memory_mb * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (mem, mem))
        resource.setrlimit(resource.RLIMIT_CPU, (limits.cpu_seconds, limits.cpu_seconds))
        resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
        os.setsid()

    return apply


class ProcessBackend:
    name = "process"

    def available(self) -> tuple[bool, str]:
        return True, "fresh child process; minimal environment; socket guard; OS resource limits (not a security sandbox)"

    def spawn(self, limits: ResourceLimits) -> Child:
        job = None
        kwargs: dict = {}
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        else:
            kwargs["preexec_fn"] = _posix_limits(limits)
        scratch = Path(os.environ.get("COUNTERPROOF_SCRATCH", BACKEND_ROOT.parent / "data" / "scratch")) / uuid.uuid4().hex
        scratch.mkdir(parents=True, exist_ok=True)
        proc = subprocess.Popen(
            [_child_python(), "-s", "-B", str(HOST_ENTRY)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=str(scratch), env=_minimal_env(), **kwargs,
        )
        detail = {"backend": "process", "os": os.name, "limits": {"memory_mb": limits.memory_mb, "cpu_seconds": limits.cpu_seconds}}
        if os.name == "nt":
            try:
                job = _WinJob(limits)
                job.assign(proc)
                detail["job_object"] = True
            except OSError as e:
                proc.kill()
                raise IsolationUnavailable(f"could not apply Windows job limits: {e}") from e

        def cleanup(child: Child) -> None:
            if job is not None:
                child.info.detail["peak_memory_bytes"] = job.peak_memory()
                job.close()
            _rmtree(scratch)

        return Child(proc, ChildInfo("process", detail), cleanup)


def _rmtree(path: Path) -> None:
    import shutil

    shutil.rmtree(path, ignore_errors=True)


# --------------------------------------------------------------------------- container
class DockerBackend:
    name = "container"

    def __init__(self, image: str = TARGET_IMAGE):
        self.image = image
        self._cache: tuple[float, bool, str] | None = None

    def available(self) -> tuple[bool, str]:
        if self._cache and time.monotonic() - self._cache[0] < 30:
            return self._cache[1], self._cache[2]
        ok, why = self._probe()
        self._cache = (time.monotonic(), ok, why)
        return ok, why

    def _probe(self) -> tuple[bool, str]:
        try:
            r = subprocess.run(["docker", "info", "--format", "{{.ServerVersion}}"], capture_output=True, text=True, timeout=8)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, f"docker unavailable: {type(e).__name__}"
        if r.returncode != 0 or not r.stdout.strip():
            return False, "docker engine is not running"
        img = subprocess.run(["docker", "image", "inspect", "--format", "{{.Id}}", self.image], capture_output=True, text=True, timeout=8)
        if img.returncode != 0:
            return False, f"target image {self.image} is not built (run scripts/build_target_image)"
        return True, f"docker {r.stdout.strip()}, image {img.stdout.strip()[:19]}"

    def spawn(self, limits: ResourceLimits) -> Child:
        ok, why = self.available()
        if not ok:
            raise IsolationUnavailable(why)
        name = f"cp-target-{uuid.uuid4().hex[:12]}"
        cmd = [
            "docker", "run", "--rm", "-i", "--name", name, "--label", "counterproof.target=1",
            "--network", "none", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
            "--user", "10001:10001", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--pids-limit", "32", "--memory", f"{limits.memory_mb}m", "--memory-swap", f"{limits.memory_mb}m",
            "--cpus", "0.5", "--ulimit", f"cpu={limits.cpu_seconds}", "-e", "PYTHONHASHSEED=0",
            self.image, "python", "-s", "-B", "/app/counterproof/runner/host_entry.py",
        ]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        def cleanup(_child: Child) -> None:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=20)

        detail = {"backend": "container", "image": self.image, "container": name, "network": "none",
                  "read_only_root": True, "user": "10001:10001", "limits": {"memory_mb": limits.memory_mb,
                  "cpu_seconds": limits.cpu_seconds, "pids": 32}}
        return Child(proc, ChildInfo("container", detail), cleanup)

    @staticmethod
    def sweep_orphans() -> int:
        """Remove containers left behind by a crashed worker."""
        try:
            r = subprocess.run(["docker", "ps", "-aq", "--filter", "label=counterproof.target=1"],
                               capture_output=True, text=True, timeout=10)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return 0
        ids = r.stdout.split()
        if ids:
            subprocess.run(["docker", "rm", "-f", *ids], capture_output=True, timeout=30)
        return len(ids)


BACKENDS = {"process": ProcessBackend(), "container": DockerBackend()}


def backend_status() -> dict:
    return {name: dict(zip(("available", "detail"), b.available())) for name, b in BACKENDS.items()}


def select_backend(required: str):
    """Return the backend for exactly the isolation level the challenge requires."""
    b = BACKENDS.get(required)
    if b is None:
        raise IsolationUnavailable(f"unknown isolation level {required!r}")
    if os.environ.get("COUNTERPROOF_DISABLE_ISOLATION", "").lower() in ("1", "true", required):
        raise IsolationUnavailable(f"{required} isolation disabled by configuration")
    ok, why = b.available()
    if not ok:
        raise IsolationUnavailable(why)
    return b
