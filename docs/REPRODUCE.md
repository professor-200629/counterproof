# Reproduce CounterProof's results

The supported clean-clone command reconstructs challenge #3 and its repair from the public
specification, candidate, evidence bundles, model-proposal sidecar and regression export. It
needs Python and the backend dependencies. No private `data/` directory, existing SQLite
database, `.env`, wallet, operator token or signing key is needed.

| Mode | What actually happens | What it establishes |
|---|---|---|
| `offline` (default) | Reads public JSON; checks published digests, seals, candidate/spec bindings, ledger chains, trace digests, checker flags, rule parameters, replay policy and the recorded comparison. | The records are internally consistent. This does **not** prove an execution occurred or that the evaluator acted honestly. |
| `scripted` | Executes installed original 0.1.1 and repaired 0.2.0 in six fresh children, using the original recorded model proposals, the same attack actions, initial state, rules, limits and 2-of-3 policy. | The current code distinguishes them: original R5 3/3, repaired R5 0/3 completed, and the requested purchase settles in all repaired runs. It tests code enforcement, not what a model proposes today. |
| `live --allow-live` | Calls a real provider with **your own environment key**, at most 3 fresh runs per adapter, with the recorded limits and policy. | Actual outcomes on your date and provider, including completed counts, provider rejections, crashes and failures. No fixture fallback; no guarantee of reproducing the old model's choices. |

The recorded repaired live model proposed no privileged tool in its 3 completed runs. Those
runs did not exercise its dispatcher's block. The scripted comparison delivers the original
`update_mandate` proposal to both adapters and exercises the repaired block in code. Reports
keep model proposals, calls reaching the market, executed mandate updates, and settled
synthetic payments separate. SYN marketplace amounts are not testnet MON rewards.

## Get a clean checkout

**Verified here:** Windows, PowerShell, Python 3.13. The checks below also run against a temporary
copy of only the public code and snapshot, with no `data/` directory. Earlier full-stack runs
used Windows 11, Git Bash, Node 24/pnpm 9 and Foundry 1.8.5. **Linux/macOS are untested.**

Windows PowerShell:

```powershell
git clone https://github.com/professor-200629/counterproof
cd counterproof
cd backend
uv sync
cd ..
.\backend\.venv\Scripts\python.exe scripts\live_repair_replay.py --mode offline
.\backend\.venv\Scripts\python.exe scripts\live_repair_replay.py --mode scripted
```

Linux/macOS (untested):

```bash
git clone https://github.com/professor-200629/counterproof
cd counterproof
cd backend
uv sync
cd ..
backend/.venv/bin/python scripts/live_repair_replay.py --mode offline
backend/.venv/bin/python scripts/live_repair_replay.py --mode scripted
```

Contract submodules, Node and Foundry are needed only for the full local chain flow below.
`main` contains this guide and the reproduction command (published 2026-10-13, `114c2a3`); a
fresh clone from GitHub was checked with offline and scripted modes after publication.

## Offline record verification

The default source is the tracked public snapshot (`web/public/snapshot`). No network call
occurs in this mode unless `--url` is given. To fetch the hosted files instead:

```powershell
.\backend\.venv\Scripts\python.exe scripts\live_repair_replay.py --mode offline --url https://counterproof.vercel.app
```

```bash
# Linux/macOS (untested)
backend/.venv/bin/python scripts/live_repair_replay.py --mode offline --url https://counterproof.vercel.app
```

Public downloads use HTTPS without authorization, credentials, inherited proxy settings or
cookies. Credential-bearing URLs and redirects are refused. Files are size-bounded, parsed
as data, validated before execution, and copied into an isolated temporary directory that is
removed at exit. Downloaded Python test files are never executed by this command.

Expected recorded comparison: original R5 **3/3**, repaired R5 **0/3**, repaired runs completed
**3/3**, requested HDMI cable (`req-0`, quantity 1) paid **3/3**. The command validates each
payment against the matching created order, rather than accepting any unrelated payment.

Optional read-only on-chain checks of the wider snapshot (internet required, no key):

```powershell
.\backend\.venv\Scripts\python.exe scripts\verify_evidence.py --url https://counterproof.vercel.app --chain
```

```bash
# Linux/macOS (untested)
backend/.venv/bin/python scripts/verify_evidence.py --url https://counterproof.vercel.app --chain
```

These also check the historical Monad testnet settlement evidence digests and ERC-8004
feedback. A chain receipt proves that a transaction happened; it does not prove the evaluator
ran honestly. Reward settlement credited testnet MON; the separate recorded withdrawal
transaction paid it out. Neither is a synthetic SYN shopping payment.

## Execute the scripted regression

```powershell
.\backend\.venv\Scripts\python.exe scripts\live_repair_replay.py --mode scripted --output work\scripted-check.json
.\backend\.venv\Scripts\python.exe -m pytest backend\tests\test_public_reproduction.py -q
```

```bash
# Linux/macOS (untested)
backend/.venv/bin/python scripts/live_repair_replay.py --mode scripted --output work/scripted-check.json
backend/.venv/bin/python -m pytest backend/tests/test_public_reproduction.py -q
```

The output report contains new specs, candidates, sealed evidence bundles, proposal sidecars,
actual ledgers, current artifact digests and elapsed time. It must show a completed original
violation and a completed repaired nonviolation **with the requested purchase**; otherwise
the scripted command exits unsuccessfully. The original-versus-repaired check discriminates
between the implementations rather than asserting the recorded verdict. The optional
`--output` path must be new: existing reports are never overwritten.

The already published generated pytest is a second, narrower check:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest docs\evidence\test_regression_llm_0_2_0_20261013_092750.py -rs
```

```bash
# Linux/macOS (untested)
backend/.venv/bin/python -m pytest docs/evidence/test_regression_llm_0_2_0_20261013_092750.py -rs
```

Expected: 2 passed, 1 skipped. The live test is opt-in. Each scripted test executes a fresh
adapter child; its recorded proposals stand in for the provider.

## Fresh live replay with your own key

Live mode is explicitly enabled. The command **never reads `.env`**. Set the provider key
only in your local environment, do not put it on the command line or in a saved report.
The default configuration preserves the recorded Groq `openai/gpt-oss-120b`, temperature 0,
and max 8 agent steps. Provider/model availability and quota may have changed.

Windows PowerShell:

```powershell
$env:GROQ_API_KEY = 'YOUR_OWN_KEY'
.\backend\.venv\Scripts\python.exe scripts\live_repair_replay.py --mode live --allow-live --max-seconds 1800 --output work\fresh-live.json
Remove-Item Env:GROQ_API_KEY
```

Linux/macOS (untested):

```bash
export GROQ_API_KEY='YOUR_OWN_KEY'
backend/.venv/bin/python scripts/live_repair_replay.py --mode live --allow-live --max-seconds 1800 --output work/fresh-live.json
unset GROQ_API_KEY
```

Changing providers requires an explicit new model, for example `--provider openai --model
YOUR_AVAILABLE_MODEL` with `OPENAI_API_KEY`, or `--provider openrouter --model
YOUR_AVAILABLE_MODEL` with `OPENROUTER_API_KEY`. A changed configuration is recorded as a new
configuration and does not reproduce the historical provider/model exactly. The source records
stay unchanged. If the historical model is unavailable, the command reports the actual error.

The run uses a new temporary cost ledger and scratch directory, resource-limited first-party
children with minimal environments, and the evaluator-side broker. Provider keys are never
passed to those children or written into reports. The original limits (40 model calls / 60,000
tokens / 600 seconds per replay, maximum 8 agent steps) remain bound in the fresh specs. The
command adds a 1,800-second total cancellation budget by default, configurable from 1 to 3,600
seconds; an in-flight HTTP request can take up to 60 additional seconds to return.

Reports say how many runs actually completed, violated R5, were rejected by the provider, or
ended abnormally. Missing credentials, provider failure, provider rejection, or an incomplete
run never produce a successful repair. A completed live run without the original violation
is reported honestly: it may not reproduce the historical finding today. No chain transaction,
attestation, MON payout or ERC-8004 feedback is created by this command.

**Executed once on 2026-10-13 at 16:37 UTC** (Windows 11, operator's own Groq key, default
recorded configuration): report [`docs/evidence/public-reproduction-live-20261013-163751.json`](evidence/public-reproduction-live-20261013-163751.json),
377.8 s elapsed, not cancelled. Current-source original `0.1.1`: R5 violated in **3/3** completed
runs; the model proposed `update_mandate` once per run, each call reached the synthetic market and
was refused (0 mandate updates executed). Current-source repaired `0.2.0`: R5 **0/3**, 3/3 completed;
the model proposed no privileged tool, so the in-code block was again not exercised live. The
requested purchase was paid in 3/3 runs of each. This is one bounded run on one date with one
hosted model, not a guarantee; its specs are new off-chain bindings, not the funded historical one.

## Historical source versus fresh bindings

The 2026-10-11 funded specification pins the historical adapter artifact. Adding 0.2.0 changed
a shared host file included in all adapter digests. Therefore the current-source executions
above create **new off-chain specs and candidates**, with accurate current target, runner,
market and checker digests. They preserve actions, initial state, rule parameters and policy,
and identify the historical source as provenance. They are not executions under the old
funded artifact binding. Historical specs and evidence are immutable and never rewritten.

Exact-source execution under the 2026-10-11 historical binding requires a separate checkout:

```powershell
git clone --branch testnet-2026-10-11 https://github.com/professor-200629/counterproof counterproof-historical
cd counterproof-historical\backend
uv sync
cd ..
```

```bash
# Linux/macOS (untested)
git clone --branch testnet-2026-10-11 https://github.com/professor-200629/counterproof counterproof-historical
cd counterproof-historical/backend
uv sync
cd ..
```

That tag is commit `51c0832` and predates the repaired adapter and this new command. Use its
historical evaluator code to run the original funded specification; do not bypass its digest
checks or claim the current original adapter's changed digest is the historical one. Fresh
provider outputs can still differ even with the exact source. This guide's supported
clean-clone comparison intentionally uses current installed source with new accurate bindings.

## Full local pipeline and judge/operator permissions

For an end-to-end operator demonstration, install Node/pnpm and Foundry, initialise the
contract submodules and build the contracts, then run:

```powershell
git submodule update --init --recursive
cd contracts
forge build
cd ..
.\backend\.venv\Scripts\python.exe scripts\e2e_local.py
```

```bash
# Linux/macOS (untested)
git submodule update --init --recursive
cd contracts
forge build
cd ..
backend/.venv/bin/python scripts/e2e_local.py
```

This creates its own local operator stack and writes a **new** local report. Anvil chain
31337 is local simulation, **not Monad testnet**. A testnet fork rehearsal is also local;
neither sends historical Monad testnet transactions again. The clean-clone offline/scripted
commands above are enough for the actual local action in a recording.

On a running local application, judges sign in with the provided judge passcode and can
create off-chain challenges, run bounded searches, submit their own off-chain candidates and
run regressions, subject to session ownership/model/budget limits. A judge **cannot** use
the operator's challenger-bot route to commit a funded candidate or spend its gas.

For a fresh **funded** challenge, the operator/publisher funds it with its own wallet. A human
judge/challenger must use their own funded wallet to commit the normalised candidate digest
and recipient before the deadline, then reveal the candidate with the resulting submission id
via `POST /api/challenges/{id}/submissions` under their authenticated session. The evaluator
reads the commitment binding from chain. The challenger-bot `POST /api/candidates/{id}/submit`
route is operator-only on funded challenges; it is available to judges only off-chain. These
extra wallet steps are not required for the supported reproduction command.

The hosted URL is a read-only evidence explorer; it cannot start any of these local runs.
Independent human reproduction and external-agent evaluation remain **pending**.
