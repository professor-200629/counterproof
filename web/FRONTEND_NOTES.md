# CounterProof web - foundation notes for page authors

Everything a page needs already exists: typed API client, react-query hooks, wallet
config, a tracked-transaction hook, UI primitives and "truth" components. Pages compose
these; they should not call `fetch`, invent status wording, or style verdict colours by hand.

Stack: Next.js 16.3.8 App Router (Turbopack), React 19, TypeScript, Tailwind v4, wagmi 3,
viem 2, @tanstack/react-query 5, lucide-react. Alias `@/*` -> `src/*`.

Checks (run from `web/`): `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm test` (vitest),
`pnpm build`. All four pass on the foundation.

---

## 0. Next 16 things that bite

- **`params` / `searchParams` are Promises.** Server page: `const { id } = await params;`.
  Client page: `const { id } = use(params);` or `useParams<{ id: string }>()` from
  `next/navigation`. A global helper exists: `export default async function Page(props: PageProps<"/challenges/[id]">)`.
- **`error.tsx` gets `retry`, not `reset`** (`({ error, retry }) => ...`). A root
  `src/app/error.tsx` and `src/app/not-found.tsx` already exist.
- Anything using hooks (all data hooks, wagmi, `Tabs`, form controls, `TimeAgo`...) must be
  in a `"use client"` file. The simplest pattern: keep `page.tsx` a server component that
  awaits `params`, exports `metadata`, and renders one client component
  (e.g. `src/app/challenges/[id]/challenge-view.tsx` with `"use client"`).
- `next lint` no longer exists; `pnpm lint` runs `eslint` directly.

## 1. Routes and shell

| Route | File | View |
| --- | --- | --- |
| `/` Overview | `src/app/page.tsx` | `components/overview/overview-view.tsx` |
| `/challenges` list | `src/app/challenges/page.tsx` | `components/overview/challenges-list-view.tsx` |
| `/challenges/new` create | `src/app/challenges/new/page.tsx` | `components/create/create-challenge.tsx` |
| `/challenges/[id]` detail (`?tab=promise\|testing\|findings\|activity`) | `src/app/challenges/[id]/page.tsx` | `components/challenge/challenge-detail.tsx` |
| `/challenges/[id]/settlement` (funding of an unfunded challenge happens here, `#step-funded`) | `src/app/challenges/[id]/settlement/page.tsx` | `components/settlement/settlement-view.tsx` |
| `/challenges/[id]/compare` repair / regression (`?candidate=`, `?target=`, `?regression=`) | `src/app/challenges/[id]/compare/page.tsx` | `components/compare/compare-view.tsx` |
| `/evaluations/[id]` evidence | `src/app/evaluations/[id]/page.tsx` | `components/evidence/evidence-viewer.tsx` |

Route states: `[id]` pages call `notFound()` for malformed ids (root `not-found.tsx`); a backend
404 renders an empty state through `QueryState`'s `notFound` prop; `challenges/[id]/loading.tsx`
and `evaluations/[id]/loading.tsx` give instant skeletons; `app/error.tsx` catches render errors
and `app/global-error.tsx` catches errors in the root layout. `src/test/routes.test.ts` renders
every view in its loading / error / not-found / empty / data state from real API fixtures.

`src/app/layout.tsx` loads Inter (`--font-inter`) and JetBrains Mono
(`--font-jetbrains-mono`) via `next/font/google`, wraps everything in `<Providers>` and
`<AppShell>`. Pages render only their content: start with `<PageHeader>` (the page's single
`<h1>`). The shell already provides:

- left nav (Overview, Create challenge, Challenges; collapses to a menu below `lg`);
- a standing **Trust model** note with the evaluator address (from `/api/config`);
- top bar: `<NetworkBadge>` ("Local anvil (31337) - not Monad", "Monad Testnet (10143)",
  "Off-chain only", plus amber "RPC unreachable" / "Chain id mismatch" / "Contract not
  deployed" when the backend reports them) and `<WalletButton>` (connect / switch chain /
  disconnect; the anvil mock connector is labelled "Local dev account (anvil) - never use on
  testnet");
- `<main id="main">` with max width 7xl and a skip link.

`src/components/providers.tsx` (`"use client"`): `Providers({ children })` =
`WagmiProvider(wagmiConfig)` + `QueryClientProvider(makeQueryClient())`.

### Proxy

`next.config.ts` rewrites `/api/:path*` -> `${BACKEND_URL}/api/:path*` (default
`http://127.0.0.1:8010`). The browser only ever calls same-origin `/api`. Rewrites are
resolved when `next build` / `next dev` starts, so set `BACKEND_URL` before building.
In snapshot mode (section 12) there is no rewrite and no backend.

Env: `BACKEND_URL` (server), `NEXT_PUBLIC_DEV_WALLET=1` (adds the anvil mock connector),
`NEXT_PUBLIC_ANVIL_RPC_URL` (optional, default `http://127.0.0.1:8545`),
`NEXT_PUBLIC_SNAPSHOT=1` (read-only recorded snapshot, section 12).

## 2. Theme tokens (`src/app/globals.css`)

Dark is the default, light follows `prefers-color-scheme`. Every text token passes WCAG AA
(>= 4.5:1) on canvas, surface, raised and the soft tone backgrounds (checked numerically).

| Tailwind class stem | Use |
| --- | --- |
| `bg-canvas` / `bg-surface` / `bg-raised` / `bg-inset` | page / cards / hovered rows, chips / code wells |
| `border-line` / `border-line-strong` | borders |
| `text-fg` / `text-muted` / `text-subtle` | primary / secondary / tertiary text |
| `bg-accent` `hover:bg-accent-hover` `text-accent-fg` `text-accent-text` `bg-accent-soft` `border-accent-line` | **interactive elements only** (buttons, links, active tab, focus) |
| `text-ok` `bg-ok-soft` `border-ok-line` `bg-ok` | green: observed passing check, not reproduced, confirmed tx |
| `text-warn` `bg-warn-soft` `border-warn-line` `bg-warn` | amber: uncertainty, inconclusive, pending, awaiting |
| `text-bad` `bg-bad-soft` `border-bad-line` `bg-bad` | red: verified violation, failed tx, failure |
| `font-sans` / `font-mono` | Inter / JetBrains Mono (digests, addresses, JSON, ledgers) |
| `tabular` | tabular numbers (utility class) |

Focus: every focusable element gets a 2px `--focus` outline on `:focus-visible`; do not
remove outlines. Reduced motion is respected globally.

## 3. API client - `src/lib/api.ts`

All types are derived from real backend responses. Key types:

- primitives: `Hex`, `UnixSeconds` (seconds, not ms), `Digest` (`"sha256:<64 hex>"`),
  `JsonValue`, `JsonObject`, `NetworkKind` (`"anvil-local" | "monad-testnet" | "offchain"`),
  `TargetLabel` (`"intentionally-vulnerable-fixture" | "repaired-fixture" | "independent-implementation" | "repaired-live-model"`;
  stored values - display words live in `lib/target-labels.ts`, see section 8),
  `Determinism`.
- statuses: `ChallengeStatus`, `RunStatus`, `CandidateStatus`, `EvaluationOutcome`,
  `EvaluationStatus` (`queued | replaying | <outcome>`), `RegressionStatus`, `JobStatus`,
  `ChainTxKind`, `ChainTxStatus`, `ReportableTxKind` (`settle | refund | withdraw`).
- config / catalogue: `AppConfig` (`network`, `network_label`, `chain: ChainStatus`,
  `evaluator_address`, `signer`, `challenger_bot`, `isolation.{process,container}`,
  `providers`, `live_model`, `components.{market,runner,checker}`), `Target` (`key` =
  `adapter@version` is what POST bodies expect; `label`, `planted_defects`, `provenance`,
  `requires_model`), `RuleTemplate` (`params_schema: JsonSchema`), `Strategy`.
- specs: `SpecRequest` (POST body), `SpecResponse { digest, spec: ChallengeSpec }`,
  `ChallengeSpec` (target, environment, initial_state, rules: `SpecRule[]` with `statement`,
  scope, limits, reproducibility, evaluator, `evaluator_trust`, deadlines, reward,
  settlement | null).
- challenges: `ChallengeRow` (table row), `ChallengeListItem` (list: + title, target, rules,
  deadlines, counts), `ChallengeView` (detail: + spec, target_info, runs: `RunSummary[]`,
  candidates: `CandidateSummary[]`, evaluations: `Evaluation[]`, attestation, transactions:
  `ChainTransaction[]`, activity: `ActivityEntry[]`).
- runs: `RunSummary`, `Run` (full), `RunRecord` (`sequences_tried`, `budget.max_sequences`,
  `tool_calls`, `model_calls`, `duration_ms`, `termination`, `samples`, `candidates`,
  `provenance`), `RunBudget`, `RunCreate`.
- candidates / evaluations: `Candidate` (`json: CandidateDocument`, `local_check`),
  `Evaluation` (`summary: EvaluationSummary | RetryPendingSummary | null` - read it with
  `finishedSummary(evaluation)`), `EvaluationSummary`, `PreviousAttempt`, `AttestationRow`.
- evidence: `EvidenceBundle` (`replays: EvidenceReplay[]` with `ledger: LedgerEvent[]`,
  `trace: TraceEntry[]`, `agent_claims_unverified`; `verdict: EvidenceVerdict` with
  `witness_seqs`; `limitations`; `timing`).
- settlement: `Settlement { challenge, attestation: SettlementAttestation | null, onchain:
  OnchainChallenge | null, onchain_error?, explorer_template }`, `AttestationTypedData`,
  `FundingResult`, `TxVerifyResult`.
- regressions: `Regression`, `RegressionExport`.

Errors: every non-2xx throws `ApiError { status, detail, kind, path, body }`; `detail` is the
backend's own text (FastAPI string / validation list / `{errors}` / `{refused}` normalised by
`normalizeDetail`). `status === 0` means the backend is unreachable
(`isBackendUnreachable(e)`). `kind` is `"chain"` or `"missing_credential"` when the backend
says so.

Functions:

```ts
apiRequest<T>(path: string, opts?: { method?, body?, query?, signal? }): Promise<T>
apiBase(): string            // "" in the browser, BACKEND_URL on the server
apiUrl(path): string         // "/api" + path, for <a href>
evidenceDownloadUrl(digest): string                    // ?download=true
regressionExportUrl(id, format?: "json" | "pytest"): string
finishedSummary(evaluation): EvaluationSummary | null

api.health() / getConfig() / getTargets() / getRuleTemplates() / getStrategies() / getOverview()
api.previewSpec(body: SpecRequest) / createSpec(body) / getSpec(digest)
api.createChallenge({ spec_digest }) / listChallenges() / getChallenge(id)
api.recordFunding(id, { tx_hash }) / recordTransaction(id, { tx_hash, kind })
api.recordFailedTransaction(id, { kind, error, tx_hash? }) / getSettlement(id)
api.startRun(challengeId, body: RunCreate) / getRun(runId) / cancelRun(runId)
api.getCandidate(id) / submitCandidate(id) / candidateDigest({ spec_digest, candidate })
api.submitExternal(challengeId, { candidate, submission_id? })
api.getEvaluation(id) / retryEvaluation(id) / attest(evaluationId)
api.getEvidence(digest) / getJob(id)
api.createRegression({ candidate_id, target }) / getRegression(id)
api.listChallengeRegressions(challengeId) / getRegressionExport(id)
```

## 4. Data hooks - `src/lib/queries.ts`

All reads return a react-query `UseQueryResult`. Optional last arg `{ enabled?: boolean }`.
Id arguments accept `null | undefined` (the query stays disabled until an id exists).
Polling (`POLL_MS = 1500`) is driven only by real backend state and stops by itself.

| Hook | Data | Polls while |
| --- | --- | --- |
| `useConfig()` | `AppConfig` | - (stale 30 s) |
| `useTargets()` / `useRuleTemplates()` / `useStrategies()` | catalogues | - |
| `useOverview()` | `Overview` | `active_runs > 0` |
| `useChallenges()` | `ChallengeListItem[]` | any `counts.active_runs > 0` |
| `useChallenge(id)` | `ChallengeView` | any run queued/running, evaluation queued/replaying, candidate submitted/replaying |
| `useSettlement(id, { poll? })` | `Settlement` | only if `poll: true` |
| `useChallengeRegressions(id)` | `Regression[]` | any regression queued/replaying |
| `useSpec(digest)` | `SpecResponse` | never (content-addressed) |
| `useRun(id)` | `Run` | queued/running |
| `useCandidate(id)` | `Candidate` | - |
| `useEvaluation(id)` | `Evaluation` | queued/replaying |
| `useEvidence(digest)` | `EvidenceBundle` | never (content-addressed) |
| `useRegression(id)` | `Regression` | queued/replaying |
| `useRegressionExport(id)` | `RegressionExport` | - (enable it only once the regression finished) |
| `useJob(id)` | `Job` | queued/running |

Mutations (`UseMutationResult`; call `.mutate(arg)` / `.mutateAsync(arg)`; each invalidates
the challenge, list and overview it touches):

```ts
usePreviewSpec()                     // mutate(body: SpecRequest) -> SpecResponse
useCreateSpec()                      // mutate(body: SpecRequest) -> SpecResponse
useCreateChallenge()                 // mutate({ spec_digest }) -> ChallengeRow
useStartRun(challengeId)             // mutate(body: RunCreate) -> Run
useCancelRun(challengeId)            // mutate(runId) -> Run
useSubmitCandidate(challengeId)      // mutate(candidateId) -> Evaluation
useSubmitExternal(challengeId)       // mutate({ candidate, submission_id? }) -> Evaluation
useRetryEvaluation(challengeId)      // mutate(evaluationId) -> Evaluation (runner_failure only)
useAttest(challengeId)               // mutate(evaluationId) -> AttestationRow
useCreateRegression(challengeId)     // mutate({ candidate_id, target }) -> Regression
useRecordFunding(challengeId)        // mutate(txHash)              (prefer useTrackedTx)
useRecordTransaction(challengeId)    // mutate({ tx_hash, kind })   (prefer useTrackedTx)
useRecordFailedTransaction(challengeId) // mutate({ kind, error, tx_hash? })
```

Also exported: `qk` (query keys; everything for one challenge lives under
`["challenge", id]`), `makeQueryClient()`, `POLL_MS`, type `QueryOpts`.

Creating a challenge = `useCreateSpec().mutateAsync(body)` -> `useCreateChallenge().mutateAsync({ spec_digest })`
-> (on-chain only) fund with `useTrackedTx({ kind: "fund", ... })` and `createChallengeArgs(spec, digest)`.

## 5. Status vocabulary - `src/lib/status.ts`

```ts
statusMeta(status: string | null | undefined, domain?: StatusDomain): { label, tone, icon, description }
type StatusDomain = "challenge" | "run" | "candidate" | "evaluation" | "regression" | "job" | "tx" | "onchain"
type Tone = "ok" | "warn" | "bad" | "neutral" | "accent"
humanize("no_violation_found") -> "No violation found"
KNOWN_STATUSES                      // every documented value per domain
isRunActive / isEvaluationActive / isRegressionActive(status): boolean
isChallengeActive(view): boolean
ACTIVE_RUN_STATUSES / ACTIVE_EVALUATION_STATUSES / ACTIVE_CANDIDATE_STATUSES / ACTIVE_REGRESSION_STATUSES
```

Pass `domain` when a word is shared: `failed` (run vs tx vs candidate), `verified_violation`
and `not_reproduced` in a regression read "Still violates" / "Not reproduced on new version".
`candidate_found` reads "Candidate found - unverified"; `no_violation_found` is green but its
description says it is not proof of safety. Unknown values render neutrally with the raw text.

## 6. Chain helpers - `src/lib/chain.ts`, wallet - `src/lib/wagmi.ts`

```ts
MONAD_TESTNET_ID = 10143; ANVIL_CHAIN_ID = 31337; MONADSCAN_TX_BASE = "https://testnet.monadscan.com/tx/"
MONAD_RESERVE_HINT, RECEIPT_MEANING, ATTESTATION_MEANING   // standing sentences
isDigest(v), digestToBytes32("sha256:..") -> "0x..", bytes32ToDigest("0x..") -> "sha256:..", isTxHash(v)
chainIdForNetwork(network) -> 10143 | 31337 | null;  networkForChainId(id) -> NetworkKind | null
networkLabel(network)   // "Monad Testnet (10143)" | "Local anvil (31337) - not Monad" | "Off-chain only"
txNetworkPhrase(chainId)// "Monad Testnet (10143)" | "local anvil (31337)" | "chain N"
isMonadTestnet(config) / isLocalAnvil(config) / isOffchain(config)
explorerTxUrl(config, hash) -> string | null          // MonadScan only; null for anvil / off-chain
explorerTxUrlForChainId(chainId, hash) -> string | null // for ChallengeView.transactions rows
nativeSymbol(network)   // "MON" | "ETH (local anvil test value)" | ""
formatWei(wei, network?, { maxDecimals? }) -> "1.5 MON"; parseMon("1.5") -> bigint | null
toChecksumAddress(v) -> Address | null
createChallengeArgs(spec, specDigest) -> { args: [bytes32, evaluator, subDeadline, settleDeadline], value }
settleArgs(typedData, signature) -> [attestationTuple, signature]   // for settle(a, sig)
```

`wagmi.ts`: `wagmiConfig` (`ssr: true`, chains `[monadTestnet, anvilLocal]`, connectors
`injected()` + `mock(ANVIL_DEV_ACCOUNTS)` only when `NEXT_PUBLIC_DEV_WALLET === "1"`),
`monadTestnet` (viem's chain with the explorer overridden to testnet.monadscan.com),
`anvilLocal` (= viem `foundry`, no explorer), `DEV_WALLET_ENABLED`, `ANVIL_DEV_ACCOUNTS`,
`DEV_WALLET_LABEL`, `connectorLabel(connector)`, type `SupportedChainId` (10143 | 31337),
`supportedChainIdFor(config.network)` -> `SupportedChainId | undefined` (use it for `useTrackedTx({ chainId })`).
The wagmi `Register` is declared, so wagmi hooks are typed against this config. wagmi v3:
use `useConnection()` (not `useAccount`), `useWriteContract().mutateAsync`.

Contract ABI: `counterProofAbi` in `src/lib/abi.ts` (regenerate with
`python scripts/sync_abi.py` from the repo root). Contract address: `config.chain.contract`.

## 7. Wallet transactions - `src/lib/tx.ts` (+ pure `src/lib/tx-machine.ts`)

State machine (pure, unit tested in `src/lib/__tests__/tx-machine.test.ts`):

```
idle -> awaiting_signature -> pending(hash) -> confirmed(hash, block)
                           |                -> failed(hash, reason)   (reverted / receipt error)
                           -> rejected(reason)                        (user said no)
                           -> failed(reason)                          (could not send, no hash)
```

`TxState`, `TxEvent`, `txReducer`, `initialTxState`, `isTerminal`, `isConfirmed` (true only
for a success receipt of the same hash), `isBusy`, `txHash`, `isUserRejection(err)`,
`errorReason(err)`. A failed or rejected transaction can never become confirmed.

Hook (client only):

```ts
const tx = useTrackedTx({
  kind: "fund" | "settle" | "refund" | "withdraw",
  challengeId,                 // backend id; hash is reported to it. null = do not report
  chainId?: SupportedChainId,  // supportedChainIdFor(config.network); wallet is asked to switch
  onConfirmed?: (hash, block) => void,
});
// tx: { state: TxState, report: BackendReport, send, reset, hash, isBusy, chainId, explorerUrl }

const r = await tx.send({
  address: config.chain.contract as `0x${string}`,
  abi: counterProofAbi,
  functionName: "createChallenge",
  ...createChallengeArgs(view.spec, view.spec_digest),   // { args, value }
});
// r: { ok: true, hash } | { ok: false, rejected: boolean, reason }
```

What it does: wallet signature -> hash -> `useWaitForTransactionReceipt` -> state machine ->
POST the hash to `/api/challenges/{id}/funding` (kind `fund`) or `/transactions` (others); the
backend reads the receipt from chain and is the only source of recorded values. Rejections
and send errors go to `/transactions/failed`. `report` is
`idle | reporting | verified(result) | failure_recorded | error(error) | skipped`; for
settle/refund/withdraw `verified.result.status` may still be `"failed"` (reverted on chain).
`explorerUrl` is MonadScan on 10143 and always null on anvil.

Render it with `<TxStatus {...tx} label="Funding" />` (see 9).

## 8. UI primitives - `src/components/ui` (import from `@/components/ui`)

(client) = uses hooks; render from client components.

- `Button({ variant?: "primary"|"secondary"|"ghost"|"danger", size?: "sm"|"md", icon?, busy?, busyLabel?, ...button props })`
  - `busy` disables and swaps the label; no spinner. `ButtonLink({ href, variant?, size?, icon?, external? })`; `buttonClasses(variant, size, className)`.
- `Badge({ tone?: Tone, size?: "sm"|"md"|"lg", icon?, ...span props })`.
- `StatusBadge({ status, domain?, size?, label?, showIcon?, className? })` - label + semantic colour + icon from `statusMeta`; description as tooltip and sr-only text. `StatusIconGlyph({ icon, className })`.
- `ProvenanceBadge({ kind: "target", value: TargetLabel, requiresModel?, size? })` - `intentionally-vulnerable-fixture` renders a large amber "Intentionally vulnerable fixture - planted defects"; `repaired-fixture` -> "Repaired fixture"; `independent-implementation` -> "Live-model agent (team-written, no planted defects)"; `repaired-live-model` -> "Repaired live-model agent (team-written)". Every adapter was written by the CounterProof team (the hosted model is third-party), so the console never says "independent". The words come from `lib/target-labels.ts` (`targetLabelText`, `isLiveModelLabel`, `adapterOfKey`, ...); target badges wrap instead of truncating. `({ kind: "network", value: NetworkKind })` -> network label.
- `Card({ as?, tone?, padded?, ...props })`, `CardHeader({ title, level?: 2|3|4, description?, actions?, eyebrow?, id? })`, `CardBody`, `CardFooter`, `Callout({ tone?, title?, icon?, role?: "status"|"note"|"alert", children })`.
- `Section({ title, description?, actions?, id?, level?: 2|3, children })` (labelled `<section>`), `PageHeader({ title, description?, meta?, actions?, breadcrumb? })` (the page `<h1>`).
- `StatGrid({ columns?: 2-6, children })` + `Stat({ label, value, hint?, tone?, mono? })` (a `<dl>`); `KeyValueList({ items: { label, value, key? }[] })`.
- `Table({ caption?, showCaption?, dense?, ... })`, `THead`, `TBody`, `TR({ highlighted? })`, `TH`, `TD({ mono?, numeric? })` - scrolls horizontally inside its own box.
- `Tabs({ items: { id, label, badge?, content, disabled? }[], label, value?, defaultValue?, onChange?, keepMounted? })` (client) - WAI-ARIA tabs, arrows / Home / End.
- `Digest({ value, label?, head?, tail?, full?, copy?, href?, emptyText? })` - mono, middle-truncated (`sha256:8e1b6aee…6910`), full value in `title`, copy button.
- `Address({ value, label?, showRole?, full?, copy?, href?, note?, emptyText? })` - `0x1234…abcd` + copy.
- `CopyButton({ value, label?, showText? })` (client).
- `TimeAgo({ ts })`, `DateTime({ ts, seconds? })`, `Countdown({ to, prefix?, expiredText? })`, `useNow(intervalMs)` (client). All take **unix seconds**; SSR renders UTC text, the client switches to relative / local. Countdown turns amber under one hour.
- `EmptyState({ title, description?, action?, icon?, compact? })`.
- `ErrorState({ error, title?, onRetry?, compact? })` - shows the backend `detail`, HTTP status and path; "Backend unreachable" when status 0.
- `Loading({ label, rows?, card? })`, `Skeleton({ className })` - skeletons only, no spinners or fake percentages.
- `QueryState({ query, label, rows?, card? })` - Loading / ErrorState / null:
  `if (!q.data) return <QueryState query={q} label="challenge" />;`
- `JsonView({ value, label?, collapsedDepth?, maxHeight?, copy? })` - collapsible `<details>` tree, mono, copy as JSON.
- `Stepper({ steps: { id, label, description?, state: "complete"|"current"|"upcoming"|"error"|"warning"|"skipped", href? }[], label, orientation? })`.
- Forms (client): `Field({ label, htmlFor, hint?, error?, required? })`, `Input({ label, hint?, error?, mono?, ...input props })`, `Textarea(...)`, `Select({ label, options?: { value, label, disabled? }[], placeholder?, ... })`, `Checkbox({ label, description?, ...input props })`, `NumberField({ label, value: number | null, onChange, min?, max?, step?, integer?, unit?, hint?, error? })`. Labels, hints and errors are wired with `aria-describedby` / `aria-invalid`.
- `toneSurface`, `toneText`, `toneFill` - class maps per `Tone`.
- `TextLink({ href, external?, download? })` - the one inline link (next/link inside the app, new tab + glyph for
  http(s), plain `<a download>` for API files); `Mono` chip and `MonoList({ items, label?, empty? })` for ids.
- `Breadcrumbs({ items })` + `challengeCrumbs(id, title, page?)` - "Challenges / <title> / Settlement" on every
  challenge sub-page.
- `Disclosure({ summary, bare?, defaultOpen?, onToggle? })` - native `<details>` with a chevron.
- `MatchMark({ ok: boolean | null, subject? | okText?/badText?, unknownText? })` - an observed comparison made on
  the page (digest vs digest, address vs address): green match, red mismatch, muted when not comparable.
- `ReasonList({ reasons })` - why a control is disabled (amber, announced).
- `StepMarker({ state, number, size? })` - the round marker shared by `Stepper` and the settlement timeline.
- `QueryState` also takes `notFound={{ title, description?, action? }}` (404 -> empty state) and `errorTitle`;
  `isNotFound(error)`.

## 9. Domain components - `src/components`

- `truth.tsx`: `AgentClaims({ claims })` - renders `agent_claims_unverified` under the
  label "Agent's own claim - not used as evidence" (never show those strings any other
  way); `Limitations({ items, title? })`; `TrustStatement({ kind: "attestation" | "receipt" | "llm" | "not-proof" })`;
  `NoViolationFacts({ target, rules, record, budget?, strategy?, limitations? })` - everything
  "No violation found" must show (tested version, rules, sequences tried, budget, why it
  stopped, work done, "not proof the agent is safe"). Constants: `AGENT_CLAIM_LABEL`,
  `LOCAL_CHECK_NOTE`, `NOT_PROOF_OF_SAFETY`, `LLM_NEVER_DECIDES`.
- `run-progress.tsx`: `RunProgress({ status, record, budget? })` - `sequences_tried / budget.max_sequences`, tool calls, model calls, `duration_ms`, termination. Shows "no progress reported yet" when there is no record.
- `tx-status.tsx`: `TxStatus({ state, report?, chainId?, explorerUrl?, label })` (spread the
  `useTrackedTx` result), `MonadReserveNotice({ network })` (funding step on Monad testnet:
  10 MON reserve + full gas limit billed), `LocalChainNotice({ network })`.
- `activity-list.tsx`: `ActivityList({ entries, limit?, renderRef? })` - backend activity
  log verbatim; `activityTone(kind)`; `ActivityRef({ entry, chainId?, linkChallenge?, linkSettlement? })` -
  the one way to link an entry's ref (evaluation, run, candidate, regression, spec digest, tx hash).
- `tx-hash.tsx`: `TxHash({ hash, chainId, label? })` - a transaction hash with its network: MonadScan link on
  10143, "local anvil (31337) transaction - no public explorer" on anvil.
- `job-facts.tsx`: `JobFacts({ job, requestedAt, requestedLabel? })` - a background job's reported status,
  attempt, worker and heartbeat (no progress estimates).
- `evidence/action-list.tsx`: `ActionList({ actions, products?, merchants?, currency? })` - a counterexample in
  plain words (used by evidence, findings and before / after).
- `evidence/verdict.tsx`: `VerdictBadge` = `StatusBadge` in the evaluation domain; `VerdictBanner`.
- `create/funding-panel.tsx`: `FundingPanel({ config, created, onDiscard?, inPlace? })` - createChallenge +
  receipt verification; used at the end of the create wizard and, `inPlace`, on the settlement page.
- `shell/`: `AppShell`, `NAV_ITEMS`, `NetworkBadge`, `WalletButton({ className? })`.

## 10. Truth rules - how to apply them with these pieces

- Target provenance: put `<ProvenanceBadge kind="target" value={spec.target.label} requiresModel={target_info?.requires_model} />` next to every result about a target.
- A run's `candidate_found` and `local_check` are challenger self-checks: show
  `LOCAL_CHECK_NOTE`. Only an `Evaluation` outcome is evidence.
- "No violation found": always `<NoViolationFacts>`; never a bare green tick.
- Progress: only `<RunProgress>` (real numbers). Never animate or estimate.
- Attestations: show `<TrustStatement kind="attestation" />`; call the evaluator a
  "declared trusted evaluator"; a signature is an attestation, not a proof; never "trustless".
- Receipts: show `<TrustStatement kind="receipt" />` next to confirmed transactions.
- Networks: use `txNetworkPhrase(chainId)` / `networkLabel(network)`; anvil is never "Monad"
  and has no explorer link (`explorerTxUrl*` return null).
- Payout: the reward goes to the recipient bound at commit time (`attestation.typed_data.message.recipient`); anyone may relay `settle`.
- Model output never decides payouts: `<TrustStatement kind="llm" />` where model-assisted search is offered.
- No invented data: every number, address, hash and message comes from the API or the chain.
- Repairs are same-family only: "the repaired version" of a target is another version of the SAME
  adapter (`lib/target-labels.ts` `replayRelation`: `repair` | `same-version` | `other-family`;
  `compare-view.tsx` `repairTargets` / `defaultTargetKey` / `isRepairOf`; the live picker offers
  nothing else). Only a `repair` fills the "After" column by default. A recorded regression on the
  original key is labelled "same version re-run, not a repair", one on another adapter "different
  agent family"; neither is ever read as a repair. For a live-model target, a regression result is
  stated with replay counts as bounded statistical evidence (whatever the outcome), never "the
  repaired version resisted". Regression status badges are neutral about which version ran
  ("Not reproduced on replay" / "Violated on replay").
- Before / after in a recording: the compare page's lead sentence (`compareDescription`) and the
  entry links (`compare/compare-link-label.ts`, used by the challenge header, the findings tab and
  the evidence page) say whether a repair was recorded ("Before / after (no repair recorded)");
  they never announce a recorded comparison that does not exist. Live, the links name the action.
- Witness rows: `verdict.witness_seqs` belongs to the FIRST violating replay only. Other replays
  mark their own witnesses, derived from their own ledger by `witnessSeqs` (`compare/ledger-facts.ts`,
  the backend checker's per-template rule); `evidence/replays.tsx` `replayWitness` says which.

### Overview first screen

`overview-view.tsx` renders, in order: the page header, `FeaturedFinding`
(`overview/featured-finding.tsx`), the counts and a currency legend (testnet MON rewards vs
synthetic SYN marketplace amounts), then challenges, activity and environment. The featured card
picks (pure helpers in `overview/featured-data.ts`) the newest challenge whose target is a
live-model agent with a verified violation, else the newest verified violation (its fixture
badge stays amber and large). From recorded API data only it states the promise, the agent and
model, the injected merchant text (quoted, truncated with a toggle), the attempted privileged
call and the market's refusal (ledger + trace), the replay tally against the spec's policy, what
was settled / withdrawn (`lib/reward-facts.ts`) and the ERC-8004 feedback, whether a SAME-family
repair was replayed ("Repair: not yet replayed for this agent" otherwise), and links to inspect
(evidence, settlement, spec JSON, README, docs/REPRODUCE.md). Digests and ledger digests sit in a
collapsed disclosure. Counts: "Awaiting settlement" (backend `funded`, status funded now), "Ever
funded" and the live-model / planted-fixture split of verified violations are derived from
`/api/challenges` (no backend change).

Shared helpers outside components: `lib/format.ts` also has `plural(n, one, many?)`, `formatBytes`,
`sameHex(a, b) -> boolean | null`; `lib/json.ts` has `asNumber` / `asString` / `asStringList`;
`lib/chain.ts` has `digestMatchesBytes32(bytes32, "sha256:..") -> boolean | null`.

Status colours: an evaluation outcome has one tone everywhere (`statusMeta`): red only for
`verified_violation`, green only for `not_reproduced`, amber for every outcome that is not a
verdict about the rule (inconclusive, timeout, target crash, malformed submission, runner failure).

## 11. Tests

`pnpm test` (vitest, node env, `vitest.config.mts`): `src/test/routes.test.ts` (every route view in
its loading, error, not-found, empty and data states, rendered from real backend responses in
`src/test/fixtures/`, with truth-label and link checks; helpers in `src/test/render.ts`), page
helper tests next to their pages (`create`, `settlement`, `compare`), and `src/lib/__tests__/tx-machine.test.ts`
(rejection, revert after pending, confirmation, receipt error, a failed tx never becomes
confirmed, stale / foreign receipts, retry, rejection detection, error reasons) and
`src/lib/__tests__/lib.test.ts` (digest <-> bytes32, explorer links only on MonadScan,
anvil never labelled Monad, MON parsing/formatting, createChallenge args, status coverage of
every documented status, FastAPI detail normalisation, formatting helpers). Snapshot mode
has its own two test files (section 12).

## 12. Snapshot mode (hosted, read-only)

`NEXT_PUBLIC_SNAPSHOT=1` at **build time** turns the console into a read-only recording for
public hosting (Vercel). The evaluator (API, worker, signer, chain) runs only on the owner's
machine; the hosted site must never look as if it runs anything. Normal mode is unchanged.

Data: `scripts/export_snapshot.py` writes every GET response the console needs to
`public/snapshot/`, plus `public/snapshot/manifest.json` (`format`, `taken_at` unix s,
`network`, `network_label`, `chain_id`, `contract`, `explorer_tx_url`,
`challenges_included[]`, `challenges_on_evaluator`, `files`, `note`). Path rule (shared with
the script, `snapshotFile()` in `lib/snapshot.ts`): `/api/evidence/sha256:ab12` ->
`/snapshot/api/evidence/sha256_ab12.json` (every `:` -> `_`, append `.json`);
`/api/regressions/{id}/export?format=pytest` -> `/snapshot/api/regressions/{id}/export.pytest.txt`.

Where it is implemented:

| Piece | File | Behaviour in snapshot mode |
| --- | --- | --- |
| Mode + manifest | `lib/snapshot.ts` | `SNAPSHOT_MODE`, `SNAPSHOT_MANIFEST`, `SNAPSHOT_TAKEN_AT`, `SNAPSHOT_SOURCE_URL` (the one place for the repo URL: defaults to the public repository `https://github.com/professor-200629/counterproof`; `NEXT_PUBLIC_SNAPSHOT_SOURCE_URL` overrides it, https only), `REPRODUCE_DOC_URL` (its `docs/REPRODUCE.md`), `snapshotFile`, `snapshotBannerText`, `deadlineAtSnapshot`, `READ_ONLY_DETAIL`, `NOT_IN_SNAPSHOT` |
| Build | `next.config.ts` | no `/api` rewrite; inlines `public/snapshot/manifest.json` as `NEXT_PUBLIC_SNAPSHOT_MANIFEST`; **fails the build** when it is missing or malformed |
| Transport | `lib/api.ts` | every GET fetches `snapshotFile("/api" + path)`; 404 -> `ApiError(404, "... not included in this recorded snapshot")`; every POST throws `ApiError(405, READ_ONLY_DETAIL, kind "read_only_snapshot")` with no request; `evidenceDownloadUrl` / `specJsonUrl` / `regressionExportUrl` return the static files (links carry `download`, with `evidenceFilename` / `regressionExportFilename`) |
| Polling | `lib/queries.ts` | `pollWhile` / `pollIf` return `false`; `staleTime: Infinity`, no refetch on focus / reconnect |
| Clock | `components/ui/time.tsx`, `overview/deadline.tsx` | `useNow()` is frozen at `taken_at` (state such as "submissions closed" or "attestation expired" is judged at snapshot time); `Countdown` / `Deadline` never count: "passed at snapshot time" / "not passed at snapshot time (1 h 00 min 00 s left then)"; `TimeAgo` shows the absolute time |
| Shell | `shell/app-shell.tsx`, `shell/snapshot-banner.tsx`, `shell/network-badge.tsx` | non-dismissable banner above every page ("Recorded snapshot - read-only. Taken <UTC> from the CounterProof evaluator on <network_label>. Nothing on this site runs live: ... <N> of <M> challenges included." + "How to run it yourself"), a "Recorded snapshot - read-only" badge in the sticky top bar, no wallet button or notices, the network badge shows the recorded network (`networkLabel(manifest.network)`) and no live RPC health; wagmi never reconnects and the dev-account connector is off |
| Not found | `ui/states.tsx` | a 404 reads "This <thing> is not included in this recorded snapshot" (not "does not exist"); load failures say "Recorded snapshot file could not be loaded" |
| Actions | `components/snapshot.tsx` `ReadOnlyNote({ action })` | replaces each control (strategy Run + budget form, Cancel run, Submit candidate, Retry replay, Request / Ask for attestation, Fund, Relay settle, Withdraw, Refund, Start regression) with an inline note and the README link; never a disabled button that looks clickable |
| Create | `app/challenges/new/page.tsx` -> `create/snapshot-create.tsx` | the five wizard steps (`create/steps.ts`) explained read-only, README link; no wizard (its first step needs `POST /api/specs/preview`) |
| Recorded marks | `RecordedMark` in `components/snapshot.tsx` | next to values that could pass for live: Active runs, environment reachability ("Reachable at snapshot time"), contract values and status on the settlement page; texts such as "queued or running when recorded" |
| Chain reads | `settlement/actions.tsx` `canReadChainLive(network)` | the only browser-side contract read is `credits()`; in snapshot mode it runs only when the recorded network is `monad-testnet` (public RPC, chain 10143) and is labelled "read live from the contract on Monad testnet"; on anvil it is not attempted: "local anvil chain - not reachable from this hosted snapshot; values below are as recorded". Signature recovery (`recoverTypedDataAddress`) still runs in the browser: it is local arithmetic, not a chain read |

Rules for new code: read data only through `lib/api.ts` (so the snapshot mapping applies);
gate every new mutation control on `SNAPSHOT_MODE` and render `ReadOnlyNote` instead; never
poll outside `pollWhile` / `pollIf`; do not add a chain read that runs in snapshot mode on a
non-Monad network.

Build and preview: `NEXT_PUBLIC_SNAPSHOT=1 pnpm build && pnpm start` (bash). On Vercel: root
directory `web`, env `NEXT_PUBLIC_SNAPSHOT=1`, no `BACKEND_URL`; `public/snapshot/` must be in
the deployed tree. Tests: `src/lib/__tests__/snapshot.test.ts` (path mapping incl. `:` -> `_`,
GETs read static files, missing file -> 404 wording, every mutation throws the read-only error
without a request, download URLs, no polling, banner text with `taken_at` and network label,
every file of the sample snapshot reachable by the mapping) and `src/test/snapshot-mode.test.ts`
(views rendered from `public/snapshot` with the mode on: banner, no wallet, no action buttons,
the recorded network's chain-read wording read from `manifest.json` (anvil or Monad testnet),
static download links, the create explainer, the not-included 404, the featured finding with
every value checked against the recorded files (and pinned literally for the challenge #3 evidence
digest), a recording without a live-model finding failing rather than skipping, compare never
offering another agent family or a re-run of the original as the repair, the entry-link wording,
each replay's witness rows rendered from its own ledger, and the evidence page's withdraw answer). `src/lib/__tests__/judge-view.test.ts` covers label words, source / REPRODUCE
links, reward lookups, featured selection and per-replay witness rows.
