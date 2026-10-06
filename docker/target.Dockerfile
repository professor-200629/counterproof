# Target sandbox image for COUNTERPROOF_ISOLATION=container.
# Contains only the target host, the protocol and the target adapters - no market, ledger,
# checker, keys or network tools. Run by the evaluator with:
#   --network none --read-only --tmpfs /tmp --user 10001:10001 --cap-drop ALL
#   --security-opt no-new-privileges --pids-limit 32 --memory --cpus
# Build from the repo root:  docker build -f docker/target.Dockerfile -t counterproof-target:dev .
FROM python:3.13-slim

RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin target
WORKDIR /app
COPY backend/counterproof/__init__.py /app/counterproof/__init__.py
COPY backend/counterproof/targets/ /app/counterproof/targets/
COPY backend/counterproof/runner/__init__.py backend/counterproof/runner/host.py \
     backend/counterproof/runner/host_entry.py backend/counterproof/runner/protocol.py \
     /app/counterproof/runner/

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONHASHSEED=0
USER 10001:10001
CMD ["python", "-s", "-B", "/app/counterproof/runner/host_entry.py"]
