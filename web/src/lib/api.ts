/**
 * Typed client for the CounterProof backend (FastAPI, all routes under /api).
 *
 * In the browser every call goes to same-origin `/api/...`; next.config.ts rewrites it to
 * `${BACKEND_URL}/api/...`. On the server (route handlers / server components) the
 * backend is called directly at BACKEND_URL.
 *
 * Types are derived from real backend responses (see FRONTEND_NOTES.md). Fields the
 * backend only sometimes sends are optional; JSON blobs whose shape depends on the rule
 * or strategy are typed as `JsonObject`.
 *
 * Snapshot mode (NEXT_PUBLIC_SNAPSHOT=1, see lib/snapshot.ts): every GET reads the recorded
 * response under /snapshot instead, a missing file is a 404 "not included in this recorded
 * snapshot", and every mutation throws a read-only ApiError without any request.
 */

import { NOT_IN_SNAPSHOT, READ_ONLY_DETAIL, READ_ONLY_KIND, SNAPSHOT_MODE, snapshotFile } from "./snapshot";

// ---------------------------------------------------------------------------- primitives
export type Hex = `0x${string}`;
/** Unix time in whole seconds (the backend's `created_at`, deadlines, expiry...). */
export type UnixSeconds = number;
/** Content digest, always `sha256:<64 hex>`. */
export type Digest = string;
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type NetworkKind = "anvil-local" | "monad-testnet" | "offchain";
export type TargetLabel = "intentionally-vulnerable-fixture" | "repaired-fixture" | "independent-implementation";
export type Determinism = "deterministic" | "stochastic";

export type ChallengeStatus = "awaiting_funding" | "funded" | "settled" | "refunded" | "offchain";
export type RunStatus = "queued" | "running" | "candidate_found" | "no_violation_found" | "failed" | "cancelled";
export type CandidateStatus =
  | "candidate_found"
  | "submitted"
  | "replaying"
  | "verified_violation"
  | "not_reproduced"
  | "inconclusive"
  | "failed"
  | "cancelled";
export type EvaluationOutcome =
  | "verified_violation"
  | "not_reproduced"
  | "inconclusive"
  | "target_crash"
  | "timeout"
  | "malformed_submission"
  | "runner_failure"
  | "cancelled";
export type EvaluationStatus = "queued" | "replaying" | EvaluationOutcome;
/** Regressions go queued -> <evaluation outcome>. */
export type RegressionStatus = "queued" | "replaying" | EvaluationOutcome;
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type ChainTxKind = "fund" | "commit" | "settle" | "withdraw" | "refund" | "deploy";
export type ChainTxStatus = "pending" | "confirmed" | "failed";
/** Kinds accepted by POST /api/challenges/{id}/transactions. */
export type ReportableTxKind = "settle" | "refund" | "withdraw";

// ---------------------------------------------------------------------------- config
export interface ComponentInfo {
  name: string;
  version: string;
  digest: Digest;
}

export interface ChainStatus {
  network: NetworkKind;
  label: string;
  chain_id: number | null;
  contract: string | null;
  rpc: string | null;
  reachable: boolean;
  /** Template containing `{hash}`; null for anvil and off-chain. */
  explorer_tx_url: string | null;
  rpc_chain_id?: number;
  block?: number;
  chain_id_matches?: boolean;
  contract_has_code?: boolean;
  error?: string;
}

export interface SignerStatus {
  url: string;
  reachable: boolean;
  configured?: boolean;
  address?: string | null;
}

export interface ChallengerBot {
  address: string;
  recipient: string;
  can_commit: boolean;
}

export interface IsolationBackend {
  available: boolean;
  detail: string;
}

export interface ProviderStatus {
  provider: string;
  key_env: string;
  configured: boolean;
  default_model: string;
}

export interface AppConfig {
  version: string;
  network: NetworkKind;
  network_label: string;
  chain: ChainStatus;
  evaluator_address: string | null;
  signer: SignerStatus;
  challenger_bot: ChallengerBot;
  isolation: { process: IsolationBackend; container: IsolationBackend } & Record<string, IsolationBackend>;
  default_isolation: string;
  providers: ProviderStatus[];
  live_model: { provider: string | null; model: string | null };
  components: { market: ComponentInfo; runner: ComponentInfo; checker: ComponentInfo };
}

// ---------------------------------------------------------------------------- catalogues
export interface Target {
  adapter: string;
  version: string;
  module_file: string;
  title: string;
  label: TargetLabel;
  determinism: Determinism;
  first_party: boolean;
  requires_model: boolean;
  description: string;
  planted_defects: string[];
  provenance: string;
  /** `adapter@version` - what POST /api/specs and /api/regressions expect as `target`. */
  key: string;
  artifact_digest: Digest;
  hosted: boolean;
}

export interface JsonSchema {
  type?: string;
  title?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  minItems?: number;
  maxItems?: number;
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface RuleTemplate {
  id: string;
  version: string;
  title: string;
  evidence: string;
  params_schema: JsonSchema;
}

export interface Strategy {
  id: string;
  title: string;
  description: string;
  defaults: JsonObject;
  targets_rules: string[];
  mode: "deterministic" | "model-assisted";
}

// ---------------------------------------------------------------------------- activity / overview
export interface ActivityEntry {
  id: number;
  challenge_id: number | null;
  /** e.g. `run.queued`, `evaluation.verified_violation`, `settle.confirmed`. */
  kind: string;
  message: string;
  /** Run / candidate / evaluation / regression id, spec digest or tx hash. */
  ref: string | null;
  created_at: UnixSeconds;
}

export interface Overview {
  challenges: number;
  funded: number;
  active_runs: number;
  verified_violations: number;
  settled: number;
  activity: ActivityEntry[];
}

// ---------------------------------------------------------------------------- specs
export interface RuleInput {
  template: string;
  params: JsonObject;
  id?: string;
}

/** Body of POST /api/specs/preview and POST /api/specs. */
export interface SpecRequest {
  title: string;
  /** Target key, `adapter@version`. */
  target: string;
  rules: RuleInput[];
  publisher: string;
  publisher_name?: string;
  /** Decimal string of wei. Forced to "0" for off-chain challenges. */
  reward_wei?: string;
  submission_deadline: UnixSeconds;
  settlement_deadline: UnixSeconds;
  eligible_rules?: string[];
  isolation?: string;
  target_config?: JsonObject;
  scope?: JsonObject;
  supersedes?: string;
  offchain?: boolean;
}

export interface SpecRule {
  id: string;
  template: string;
  template_version: string;
  params: JsonObject;
  statement: string;
}

export interface Merchant {
  id: string;
  name: string;
}

export interface Product {
  sku: string;
  merchant: string;
  name: string;
  price: number;
  description: string;
}

export interface InitialState {
  world_id: string;
  note: string;
  currency: string;
  merchants: Merchant[];
  products: Product[];
  mandate: {
    mandate_id: string;
    principal: string;
    budget: number;
    allowed_merchants: string[];
    status: string;
  };
  wallet: { account: string; balance: number };
}

export interface ChallengeSpec {
  format: string;
  title: string;
  publisher: { address: string; name: string };
  target: {
    adapter: string;
    version: string;
    artifact_digest: Digest;
    label: TargetLabel;
    determinism: Determinism;
    config: JsonObject;
  };
  environment: { market: ComponentInfo; runner: ComponentInfo; isolation: string };
  initial_state: InitialState;
  initial_state_digest: Digest;
  rules: SpecRule[];
  checker: ComponentInfo;
  scope: {
    allowed_actions: string[];
    content_skus: string[];
    max_actions: number;
    max_content_chars: number;
    notes: string;
  };
  limits: {
    max_tool_calls_per_event: number;
    max_tool_calls_total: number;
    max_model_calls: number;
    max_model_tokens: number;
    event_timeout_ms: number;
    total_timeout_ms: number;
    memory_mb: number;
    cpu_seconds: number;
  };
  reproducibility: Reproducibility;
  evaluator: { address: string; name: string };
  /** Always "declared-trusted": the evaluator is a trusted party, not a proof system. */
  evaluator_trust: string;
  deadlines: Deadlines;
  reward: {
    amount_wei: string;
    currency: string;
    eligible_outcomes: string[];
    eligible_rules: string[];
    policy: string;
    max_rewards: number;
  };
  /** null for off-chain challenges. */
  settlement: { chain_id: number; network: string; contract: string } | null;
  supersedes: Digest | null;
  revision: number;
}

export interface Reproducibility {
  mode: Determinism;
  replays: number;
  required_violations: number;
  statement: string;
}

export interface Deadlines {
  submission_deadline: UnixSeconds;
  settlement_deadline: UnixSeconds;
}

export interface SpecResponse {
  digest: Digest;
  spec: ChallengeSpec;
}

// ---------------------------------------------------------------------------- challenges
/** A row of the challenges table (POST /api/challenges, settlement.challenge). */
export interface ChallengeRow {
  id: number;
  spec_digest: Digest;
  status: ChallengeStatus;
  network: NetworkKind;
  chain_id: number | null;
  contract: string | null;
  /** On-chain challenge id (decimal string) once funded. */
  onchain_id: string | null;
  fund_tx: string | null;
  reward_wei: string;
  note: string | null;
  created_at: UnixSeconds;
  updated_at: UnixSeconds;
}

export interface ChallengeListItem extends ChallengeRow {
  title: string;
  target: { adapter: string; version: string; label: TargetLabel; determinism: Determinism };
  rules: { id: string; template: string; statement: string }[];
  deadlines: Deadlines;
  counts: {
    runs: number;
    active_runs: number;
    candidates: number;
    verified: number;
    not_reproduced: number;
  };
  supersedes: Digest | null;
}

export interface ChallengeView extends ChallengeRow {
  spec: ChallengeSpec;
  target_info: Target | null;
  runs: RunSummary[];
  candidates: CandidateSummary[];
  evaluations: Evaluation[];
  attestation: AttestationRow | null;
  transactions: ChainTransaction[];
  activity: ActivityEntry[];
}

// ---------------------------------------------------------------------------- runs
export interface RunBudget {
  max_sequences: number;
  max_wall_seconds: number;
  max_model_calls?: number;
  max_model_tokens?: number;
  max_cost_usd_micros?: number;
  shrink?: boolean;
}

export interface CandidateAction {
  type: string;
  [key: string]: JsonValue;
}

export interface CandidateDocument {
  format: string;
  challenge_spec_digest: Digest;
  challenger: string;
  recipient: string;
  claimed_rule: string;
  actions: CandidateAction[];
  salt: string;
  provenance: {
    strategy: string;
    strategy_version: string;
    run_id: string;
    model: string | null;
    note: string;
  };
}

/** Challenger-side self-check. Never evidence: only the evaluator's replay counts. */
export interface LocalCheck {
  rule_id: string;
  summary: string;
  observed: JsonObject;
  note: string;
}

export interface RunSample {
  actions: CandidateAction[];
  outcome: string;
  violated: string[];
}

export interface RunProvenance {
  strategy: string;
  mode: string;
  target_determinism: Determinism;
  inference: string;
  target_model?: string;
  target_model_calls?: number;
  target_model_tokens?: number;
  provider_errors?: string[];
  generator?: { model: string; calls: number; note: string };
}

/**
 * Search record of a run. Present (and updated about every 0.5 s) while running, complete
 * once finished. Progress must only ever be derived from these numbers.
 */
export interface RunRecord {
  strategy: string;
  strategy_version: string;
  params: JsonObject;
  budget: RunBudget;
  sequences_tried: number;
  tool_calls: number;
  model_calls: number;
  model_tokens: number;
  candidates: { candidate: CandidateDocument; digest: Digest; local_check: LocalCheck }[];
  errors: string[];
  run_outcomes: Record<string, number>;
  samples: RunSample[];
  /** Why the search stopped, e.g. "sequence budget exhausted", "search space exhausted". Empty while running. */
  termination: string;
  started_at: number;
  finished_at: number | null;
  rules_violated: string[];
  duration_ms: number;
  provenance?: RunProvenance;
  candidate_ids?: string[];
}

/** Run as embedded in the challenge view. */
export interface RunSummary {
  id: string;
  strategy: string;
  mode: string;
  status: RunStatus;
  created_at: UnixSeconds;
  updated_at: UnixSeconds;
  record: RunRecord | null;
  error: string | null;
}

export interface Job {
  id: string;
  kind: "search" | "evaluation" | "regression" | string;
  status: JobStatus;
  params: JsonObject;
  result: JsonObject | null;
  error: string | null;
  attempts: number;
  max_attempts: number;
  cancel_requested: number;
  worker: string | null;
  heartbeat_at: UnixSeconds | null;
  created_at: UnixSeconds;
  started_at: UnixSeconds | null;
  finished_at: UnixSeconds | null;
}

/** Full run (GET /api/runs/{id}, POST /api/challenges/{id}/runs). */
export interface Run extends RunSummary {
  challenge_id: number;
  job_id: string | null;
  strategy_version: string;
  params: JsonObject;
  budget: RunBudget;
  provenance: RunProvenance | null;
  job: Job | null;
}

export interface RunCreate {
  strategy: string;
  params?: JsonObject;
  budget?: Partial<RunBudget>;
  mode: "deterministic" | "model-assisted";
}

// ---------------------------------------------------------------------------- candidates / evaluations
export interface CandidateSummary {
  id: string;
  run_id: string | null;
  digest: Digest;
  claimed_rule: string;
  status: CandidateStatus;
  local_check: LocalCheck | null;
  created_at: UnixSeconds;
}

export interface Candidate extends CandidateSummary {
  challenge_id: number;
  json: CandidateDocument;
}

export interface ReplaySummary {
  index: number;
  run_outcome: string;
  ledger_digest: Digest | null;
  claimed_rule_violated: boolean;
}

/** An earlier attempt of an evaluation that was retried after a runner failure. */
export interface PreviousAttempt {
  outcome: EvaluationOutcome | null;
  evidence_digest: Digest | null;
  finished_at: UnixSeconds | null;
  reason: string | null;
}

export interface EvaluationSummary {
  outcome: EvaluationOutcome;
  reason: string;
  summary: string | null;
  rule: { rule_id: string; template: string; statement: string } | null;
  reward_eligible: boolean;
  replays: ReplaySummary[];
  /** Earlier runner-failure attempts, kept when an evaluation is retried. */
  previous_attempts?: PreviousAttempt[];
}

/** Summary of an evaluation re-queued after a runner failure: only the earlier attempts so far. */
export interface RetryPendingSummary {
  previous_attempts: PreviousAttempt[];
}

/** The finished summary of an evaluation, or null while it is queued / replaying / re-queued. */
export function finishedSummary(e: Pick<Evaluation, "summary"> | null | undefined): EvaluationSummary | null {
  const s = e?.summary;
  return s && "outcome" in s ? s : null;
}

export interface AttestationRow {
  id: string;
  challenge_id: number;
  evaluation_id: string;
  submission_id: string;
  typed_data: AttestationTypedData;
  signature: Hex;
  signer: string;
  expiry: UnixSeconds;
  created_at: UnixSeconds;
}

export interface Evaluation {
  id: string;
  challenge_id: number;
  submission_id: string;
  job_id: string | null;
  status: EvaluationStatus;
  outcome: EvaluationOutcome | null;
  evidence_digest: Digest | null;
  /**
   * Null until the first verdict. While a retried evaluation is re-queued it holds only
   * `previous_attempts` - read it through `finishedSummary(evaluation)`.
   */
  summary: EvaluationSummary | RetryPendingSummary | null;
  created_at: UnixSeconds;
  finished_at: UnixSeconds | null;
  challenger: string;
  recipient: string;
  commit_tx: string | null;
  source: "chain" | "offchain";
  candidate_id: string | null;
  candidate_digest?: Digest;
  /** Only on GET /api/evaluations/{id} and submit responses. */
  job?: Job | null;
  attestation?: AttestationRow | null;
  /** Set when the same candidate was already submitted (no second payable finding). */
  duplicate?: boolean;
}

// ---------------------------------------------------------------------------- evidence
export interface LedgerEvent {
  seq: number;
  type: string;
  data: JsonObject;
  hash: Digest;
  prev: Digest;
}

export interface TraceEntry {
  n: number;
  action_index: number;
  tool: string;
  args: JsonObject;
  response: JsonObject;
}

export interface EvidenceReplay {
  index: number;
  run_outcome: string;
  run_reason: string;
  ledger_digest: Digest | null;
  ledger_chain_valid: boolean;
  trace_digest: Digest | null;
  claimed_rule_violated: boolean;
  rules_violated: string[];
  stats: {
    actions?: number;
    duration_ms?: number;
    model_calls?: number;
    model_usage?: { completion_tokens: number; prompt_tokens: number };
    reused_child?: boolean;
    tool_calls?: number;
    [key: string]: JsonValue | undefined;
  };
  isolation: JsonObject | null;
  ledger: LedgerEvent[];
  trace: TraceEntry[];
  /** The agent's own statements. Shown only as "Agent's own claim - not used as evidence". */
  agent_claims_unverified: string[];
}

export interface EvidenceVerdict {
  outcome: EvaluationOutcome;
  reason: string;
  rule: { rule_id: string; template: string; statement: string } | null;
  expected: string | null;
  observed: JsonObject | null;
  summary: string | null;
  witness_seqs: number[] | null;
  other_rules_violated: string[];
  reward_eligible: boolean;
  validation_errors: string[];
}

export interface EvidenceBundle {
  format: string;
  evidence_digest?: Digest;
  challenge: {
    spec_digest: Digest;
    title: string;
    onchain_challenge_id: string | null;
    settlement: ChallengeSpec["settlement"];
  };
  target: ChallengeSpec["target"] | Omit<ChallengeSpec["target"], "config">;
  submission: {
    submission_id: string;
    challenger: string | null;
    recipient: string | null;
    candidate_digest: Digest | null;
    committed_candidate_digest: Digest | null;
  };
  evaluator: {
    address: string;
    software: string;
    market: ComponentInfo;
    runner: ComponentInfo;
    checker: ComponentInfo;
  };
  reproducibility: Reproducibility;
  candidate: CandidateDocument | null;
  claimed_rule: string | null;
  replays: EvidenceReplay[];
  verdict: EvidenceVerdict;
  limitations: string[];
  timing: { started_at: UnixSeconds; finished_at: UnixSeconds; duration_ms: number };
}

// ---------------------------------------------------------------------------- settlement / chain
export interface AttestationMessage {
  challengeId: number;
  specDigest: Hex;
  submissionId: Hex;
  candidateDigest: Hex;
  evidenceDigest: Hex;
  challenger: string;
  recipient: string;
  verdict: number;
  expiry: number;
}

export interface AttestationTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: "Attestation";
  message: AttestationMessage;
}

export interface SettlementAttestation {
  typed_data: AttestationTypedData;
  signature: Hex;
  signer: string;
  expiry: UnixSeconds;
  evaluation_id: string;
}

/** The contract's view of a challenge (read from chain by the backend). */
export interface OnchainChallenge {
  publisher: string;
  evaluator: string;
  submission_deadline: UnixSeconds;
  settlement_deadline: UnixSeconds;
  status: "none" | "funded" | "settled" | "refunded" | string;
  reward_wei: string;
  spec_digest: Digest;
  settled_submission: Hex;
}

export interface Settlement {
  challenge: ChallengeRow;
  attestation: SettlementAttestation | null;
  onchain: OnchainChallenge | null;
  onchain_error?: string;
  /** Explorer template with `{hash}`, null for anvil / off-chain. */
  explorer_template: string | null;
}

export interface ChainTransaction {
  hash: string;
  chain_id: number;
  kind: ChainTxKind;
  status: ChainTxStatus;
  challenge_id: number | null;
  from_addr: string | null;
  detail: JsonObject | null;
  block_number: number | null;
  error: string | null;
  created_at: UnixSeconds;
  updated_at: UnixSeconds;
}

export interface FundingResult {
  onchain_id: string;
  block: number;
  challenge: ChallengeRow;
  explorer: string | null;
}

export interface TxVerifyResult {
  status: "confirmed" | "failed";
  detail?: JsonObject;
  explorer?: string | null;
}

// ---------------------------------------------------------------------------- regressions
export interface Regression {
  id: string;
  source_candidate_id: string;
  source_challenge_id: number;
  target_key: string;
  spec_digest: Digest;
  job_id: string | null;
  status: RegressionStatus;
  outcome: EvaluationOutcome | null;
  evidence_digest: Digest | null;
  created_at: UnixSeconds;
  finished_at: UnixSeconds | null;
  /** Present on GET /api/regressions/{id}; absent in the per-challenge list. */
  job?: Job | null;
}

export interface RegressionExport {
  format: string;
  name: string;
  source: {
    challenge_spec_digest: Digest;
    candidate_digest: Digest;
    evidence_digest: Digest | null;
    original_outcome: EvaluationOutcome | null;
  };
  rule: SpecRule;
  rules: SpecRule[];
  initial_state: InitialState;
  initial_state_digest: Digest;
  actions: CandidateAction[];
  expectation: string;
  last_result: {
    target: string;
    outcome: EvaluationOutcome | null;
    evidence_digest: Digest | null;
    spec_digest: Digest;
  };
}

// ---------------------------------------------------------------------------- errors
/** An HTTP error from the backend. `detail` is the backend's own explanation, normalised to text. */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;
  /** Backend error class when it sends one: "chain" | "missing_credential". */
  readonly kind: string | null;
  readonly path: string;
  readonly body: unknown;

  constructor(opts: { status: number; detail: string; kind?: string | null; path: string; body?: unknown }) {
    super(opts.detail || `Request failed with HTTP ${opts.status}`);
    this.name = "ApiError";
    this.status = opts.status;
    this.detail = opts.detail;
    this.kind = opts.kind ?? null;
    this.path = opts.path;
    this.body = opts.body;
  }
}

/** True when the backend could not be reached at all (network error, proxy 5xx with no body). */
export function isBackendUnreachable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 0;
}

/**
 * FastAPI sends `detail` as a string, a list of validation errors, or an object such as
 * `{errors: [...]}` / `{refused: [...]}`. Turn any of these into readable text.
 */
export function normalizeDetail(detail: unknown): string {
  if (detail == null) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        if (d && typeof d === "object" && "msg" in d) {
          const item = d as { msg: unknown; loc?: unknown };
          const loc = Array.isArray(item.loc) ? item.loc.filter((p) => p !== "body").join(".") : "";
          return loc ? `${loc}: ${String(item.msg)}` : String(item.msg);
        }
        return normalizeDetail(d);
      })
      .filter(Boolean)
      .join("; ");
  }
  if (typeof detail === "object") {
    const obj = detail as Record<string, unknown>;
    for (const key of ["refused", "errors"]) {
      if (Array.isArray(obj[key])) {
        const label = key === "refused" ? "refused: " : "";
        return label + (obj[key] as unknown[]).map((x) => normalizeDetail(x)).join("; ");
      }
    }
    if (typeof obj.detail !== "undefined") return normalizeDetail(obj.detail);
    if (typeof obj.message === "string") return obj.message;
    try {
      return JSON.stringify(detail);
    } catch {
      return String(detail);
    }
  }
  return String(detail);
}

// ---------------------------------------------------------------------------- transport
const SERVER_BACKEND = (process.env.BACKEND_URL ?? "http://127.0.0.1:8010").replace(/\/+$/, "");

/** Base URL for API calls: same-origin in the browser, BACKEND_URL on the server. */
export function apiBase(): string {
  return typeof window === "undefined" ? SERVER_BACKEND : "";
}

/** Browser-usable URL for an API path (for links such as downloads). `path` starts with "/". */
export function apiUrl(path: string): string {
  return `/api${path}`;
}

type Query = Record<string, string | number | boolean | undefined | null>;

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
}

/** Low-level request. Throws ApiError with the backend's `detail` on any non-2xx. */
export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  if (SNAPSHOT_MODE) return snapshotRequest<T>(path, opts);
  const fullPath = withQuery(path, opts.query);
  const url = `${apiBase()}/api${fullPath}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      headers: opts.body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
      cache: "no-store",
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError({
      status: 0,
      detail: `Backend unreachable (${e instanceof Error ? e.message : String(e)}). Is the API running on BACKEND_URL?`,
      path: fullPath,
    });
  }
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    let detail = obj ? normalizeDetail(obj.detail ?? obj) : typeof parsed === "string" ? parsed.slice(0, 400) : "";
    if (!detail) detail = `HTTP ${res.status} ${res.statusText}`.trim();
    // The Next proxy answers 500 with an empty/HTML body when the backend is down.
    const unreachable = (res.status === 500 || res.status === 502 || res.status === 504) && !obj;
    throw new ApiError({
      status: unreachable ? 0 : res.status,
      detail: unreachable ? `Backend unreachable through the /api proxy (HTTP ${res.status}). Is the API running on BACKEND_URL?` : detail,
      kind: obj && typeof obj.kind === "string" ? obj.kind : null,
      path: fullPath,
      body: parsed,
    });
  }
  return parsed as T;
}

/**
 * Snapshot mode: a GET reads the recorded response from its static file (lib/snapshot.ts);
 * anything else throws the read-only error before any request is made.
 */
async function snapshotRequest<T>(path: string, opts: RequestOptions): Promise<T> {
  const fullPath = withQuery(path, opts.query);
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  if (method !== "GET") {
    throw new ApiError({ status: 405, detail: READ_ONLY_DETAIL, kind: READ_ONLY_KIND, path: fullPath });
  }
  const file = snapshotFile(`/api${fullPath}`);
  let res: Response;
  try {
    res = await fetch(file, { headers: { Accept: "application/json, text/plain" }, signal: opts.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError({
      status: 0,
      detail: `Could not load the recorded snapshot file ${file} (${e instanceof Error ? e.message : String(e)}).`,
      path: fullPath,
    });
  }
  if (res.status === 404) {
    throw new ApiError({ status: 404, detail: `/api${fullPath} is ${NOT_IN_SNAPSHOT}.`, path: fullPath });
  }
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError({ status: res.status, detail: `Could not load the recorded snapshot file ${file} (HTTP ${res.status}).`, path: fullPath });
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------- ERC-8004
/** An ERC-8004 identity the publisher registered for a CounterProof target (GET /api/erc8004). */
export interface Erc8004Agent {
  agent_id: number;
  /** The artifact digest the agent's own registration file declares. */
  artifact_digest: Digest;
  owner: string;
  tx: string;
  explorer: string;
}

/** One feedback entry the reporter posted to the official ReputationRegistry. */
export interface Erc8004Feedback {
  key: string;
  challenge_onchain_id: number;
  bounties: string;
  agent_id: number;
  target: string;
  reporter: string;
  feedback_index: number;
  tag1: string;
  tag2: string;
  value: number;
  value_decimals: number;
  evidence_digest: Digest;
  settle_tx: string;
  feedback_hash: string;
  feedback_file: JsonObject;
  tx: string;
  explorer: string;
}

export interface Erc8004Record {
  available: boolean;
  reason?: string;
  chain_id: number | null;
  registries: { identity: string; reputation: string } | null;
  network?: string;
  agents?: Record<string, Erc8004Agent>;
  feedback?: Erc8004Feedback[];
  registries_source?: string;
}

// ---------------------------------------------------------------------------- endpoints
export const api = {
  health: () => apiRequest<{ ok: boolean; version: string; time: UnixSeconds }>("/health"),
  getConfig: () => apiRequest<AppConfig>("/config"),
  getErc8004: () => apiRequest<Erc8004Record>("/erc8004"),
  getTargets: () => apiRequest<Target[]>("/targets"),
  getRuleTemplates: () => apiRequest<RuleTemplate[]>("/rule-templates"),
  getStrategies: () => apiRequest<Strategy[]>("/strategies"),
  getOverview: () => apiRequest<Overview>("/overview"),

  previewSpec: (body: SpecRequest) => apiRequest<SpecResponse>("/specs/preview", { body }),
  createSpec: (body: SpecRequest) => apiRequest<SpecResponse>("/specs", { body }),
  getSpec: (digest: Digest) => apiRequest<SpecResponse>(`/specs/${enc(digest)}`),

  createChallenge: (body: { spec_digest: Digest }) => apiRequest<ChallengeRow>("/challenges", { body }),
  listChallenges: () => apiRequest<ChallengeListItem[]>("/challenges"),
  getChallenge: (id: number | string) => apiRequest<ChallengeView>(`/challenges/${enc(String(id))}`),

  /** Report a funding tx hash; the backend reads the receipt and ChallengeCreated event from chain. */
  recordFunding: (id: number | string, body: { tx_hash: string }) =>
    apiRequest<FundingResult>(`/challenges/${enc(String(id))}/funding`, { body }),
  /** Report a settle/refund/withdraw tx hash; the backend verifies the receipt from chain. */
  recordTransaction: (id: number | string, body: { tx_hash: string; kind: ReportableTxKind }) =>
    apiRequest<TxVerifyResult>(`/challenges/${enc(String(id))}/transactions`, { body }),
  /** Report a wallet rejection or send error (no receipt exists). */
  recordFailedTransaction: (id: number | string, body: { kind: string; error: string; tx_hash?: string | null }) =>
    apiRequest<{ recorded: boolean }>(`/challenges/${enc(String(id))}/transactions/failed`, { body }),
  getSettlement: (id: number | string) => apiRequest<Settlement>(`/challenges/${enc(String(id))}/settlement`),

  startRun: (challengeId: number | string, body: RunCreate) =>
    apiRequest<Run>(`/challenges/${enc(String(challengeId))}/runs`, { body }),
  getRun: (runId: string) => apiRequest<Run>(`/runs/${enc(runId)}`),
  cancelRun: (runId: string) => apiRequest<Run>(`/runs/${enc(runId)}/cancel`, { method: "POST" }),

  getCandidate: (candidateId: string) => apiRequest<Candidate>(`/candidates/${enc(candidateId)}`),
  submitCandidate: (candidateId: string) =>
    apiRequest<Evaluation>(`/candidates/${enc(candidateId)}/submit`, { method: "POST" }),
  candidateDigest: (body: { spec_digest: Digest; candidate: JsonObject }) =>
    apiRequest<{ digest: Digest; candidate: CandidateDocument }>("/candidates/digest", { body }),
  submitExternal: (challengeId: number | string, body: { candidate: JsonObject; submission_id?: string | null }) =>
    apiRequest<Evaluation>(`/challenges/${enc(String(challengeId))}/submissions`, { body }),

  getEvaluation: (evaluationId: string) => apiRequest<Evaluation>(`/evaluations/${enc(evaluationId)}`),
  /** Re-queue an evaluation whose outcome is runner_failure (409 for any other verdict - those are final). */
  retryEvaluation: (evaluationId: string) =>
    apiRequest<Evaluation>(`/evaluations/${enc(evaluationId)}/retry`, { method: "POST" }),
  /** Ask the evaluator's signer for an EIP-712 attestation (funded challenges only). */
  attest: (evaluationId: string) => apiRequest<AttestationRow>(`/evaluations/${enc(evaluationId)}/attest`, { method: "POST" }),

  getEvidence: (digest: Digest) => apiRequest<EvidenceBundle>(`/evidence/${enc(digest)}`),
  getJob: (jobId: string) => apiRequest<Job>(`/jobs/${enc(jobId)}`),

  createRegression: (body: { candidate_id: string; target: string }) => apiRequest<Regression>("/regressions", { body }),
  getRegression: (regressionId: string) => apiRequest<Regression>(`/regressions/${enc(regressionId)}`),
  listChallengeRegressions: (challengeId: number | string) =>
    apiRequest<Regression[]>(`/challenges/${enc(String(challengeId))}/regressions`),
  getRegressionExport: (regressionId: string) => apiRequest<RegressionExport>(`/regressions/${enc(regressionId)}/export`),
} as const;

/** A download link for an API path: the API itself, or the recorded static file in snapshot mode. */
function downloadUrl(path: string): string {
  return SNAPSHOT_MODE ? snapshotFile(apiUrl(path)) : apiUrl(path);
}

/** The content-addressed spec as JSON (rules, parameters, initial state, target): GET /api/specs/{digest}. */
export function specJsonUrl(digest: Digest): string {
  return downloadUrl(`/specs/${enc(digest)}`);
}

/** Link that downloads the evidence bundle as a JSON file. Render it with a `download` attribute. */
export function evidenceDownloadUrl(digest: Digest): string {
  return downloadUrl(`/evidence/${enc(digest)}?download=true`);
}

/** Link that downloads a regression test: JSON fixture or a generated pytest file. */
export function regressionExportUrl(regressionId: string, format: "json" | "pytest" = "json"): string {
  return downloadUrl(`/regressions/${enc(regressionId)}/export${format === "pytest" ? "?format=pytest" : ""}`);
}

/** File name for a downloaded regression test (the `download` attribute; static snapshot files have no Content-Disposition). */
export function regressionExportFilename(regressionId: string, format: "json" | "pytest" = "json"): string {
  const safe = regressionId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return format === "pytest" ? `test_regression_${safe}.py` : `regression_${safe}.json`;
}

/** File name for a downloaded evidence bundle. */
export function evidenceFilename(digest: Digest): string {
  return `evidence-${digest.replace(/^sha256:/, "").slice(0, 12)}.json`;
}
