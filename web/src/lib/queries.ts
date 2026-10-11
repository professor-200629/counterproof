/**
 * react-query hooks over lib/api.ts. Polling is only ever driven by real backend state:
 * a query polls every 1.5 s while something it shows is queued / running / replaying and
 * stops by itself when that work finishes. In snapshot mode (lib/snapshot.ts) nothing
 * polls or refetches: the data is a recording and cannot change.
 */
import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  api,
  type Digest,
  type JsonObject,
  type ReportableTxKind,
  type RunCreate,
  type SpecRequest,
} from "./api";
import { SNAPSHOT_MODE } from "./snapshot";
import { isChallengeActive, isEvaluationActive, isRegressionActive, isRunActive } from "./status";

export const POLL_MS = 1500;

/** Query keys. Everything about one challenge lives under ["challenge", id]. */
export const qk = {
  config: ["config"] as const,
  erc8004: ["erc8004"] as const,
  targets: ["targets"] as const,
  ruleTemplates: ["rule-templates"] as const,
  strategies: ["strategies"] as const,
  overview: ["overview"] as const,
  challenges: ["challenges"] as const,
  challenge: (id: number | string) => ["challenge", String(id)] as const,
  settlement: (id: number | string) => ["challenge", String(id), "settlement"] as const,
  challengeRegressions: (id: number | string) => ["challenge", String(id), "regressions"] as const,
  spec: (digest: string) => ["spec", digest] as const,
  run: (id: string) => ["run", id] as const,
  candidate: (id: string) => ["candidate", id] as const,
  evaluation: (id: string) => ["evaluation", id] as const,
  evidence: (digest: string) => ["evidence", digest] as const,
  regression: (id: string) => ["regression", id] as const,
  regressionExport: (id: string) => ["regression", id, "export"] as const,
  job: (id: string) => ["job", id] as const,
};

/** Do not retry client errors (4xx) - they will not change by retrying. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // A recorded snapshot never changes: fetch each file once, never refetch on focus.
      queries: SNAPSHOT_MODE
        ? { staleTime: Infinity, retry: shouldRetry, refetchOnWindowFocus: false, refetchOnReconnect: false }
        : { staleTime: 5_000, retry: shouldRetry, refetchOnWindowFocus: true },
      mutations: { retry: false },
    },
  });
}

export interface QueryOpts {
  /** Disable the query (e.g. until an id is known). Default true. */
  enabled?: boolean;
}

/** refetchInterval that polls while `active(data)`; never in snapshot mode. */
export function pollWhile<T>(active: (data: T | undefined) => boolean) {
  return (query: { state: { data: T | undefined } }): number | false =>
    !SNAPSHOT_MODE && active(query.state.data) ? POLL_MS : false;
}

/** refetchInterval for an explicit `poll` flag; never in snapshot mode. */
export function pollIf(poll: boolean | undefined): number | false {
  return !SNAPSHOT_MODE && poll ? POLL_MS : false;
}

// ---------------------------------------------------------------------------- reads
/** Backend configuration: network, chain, evaluator, signer, isolation, providers. */
export function useConfig(opts: QueryOpts = {}) {
  return useQuery({ queryKey: qk.config, queryFn: api.getConfig, staleTime: 30_000, enabled: opts.enabled ?? true });
}

/** ERC-8004 identities and feedback recorded for this backend's contract (Monad testnet only). */
export function useErc8004(opts: QueryOpts = {}) {
  return useQuery({ queryKey: qk.erc8004, queryFn: api.getErc8004, staleTime: 30_000, enabled: opts.enabled ?? true });
}

export function useTargets(opts: QueryOpts = {}) {
  return useQuery({ queryKey: qk.targets, queryFn: api.getTargets, staleTime: 300_000, enabled: opts.enabled ?? true });
}

export function useRuleTemplates(opts: QueryOpts = {}) {
  return useQuery({
    queryKey: qk.ruleTemplates,
    queryFn: api.getRuleTemplates,
    staleTime: 300_000,
    enabled: opts.enabled ?? true,
  });
}

export function useStrategies(opts: QueryOpts = {}) {
  return useQuery({ queryKey: qk.strategies, queryFn: api.getStrategies, staleTime: 300_000, enabled: opts.enabled ?? true });
}

/** Counts + latest activity. Polls while any run is active. */
export function useOverview(opts: QueryOpts = {}) {
  return useQuery({
    queryKey: qk.overview,
    queryFn: api.getOverview,
    enabled: opts.enabled ?? true,
    refetchInterval: pollWhile((d) => !!d && d.active_runs > 0),
  });
}

/** Challenge list. Polls while any challenge has active runs. */
export function useChallenges(opts: QueryOpts = {}) {
  return useQuery({
    queryKey: qk.challenges,
    queryFn: api.listChallenges,
    enabled: opts.enabled ?? true,
    refetchInterval: pollWhile((d) => !!d && d.some((c) => c.counts.active_runs > 0)),
  });
}

/**
 * Full challenge view (spec, runs, candidates, evaluations, attestation, transactions,
 * activity). Polls every 1.5 s while any run / evaluation / candidate is queued, running or
 * replaying.
 */
export function useChallenge(id: number | string | null | undefined, opts: QueryOpts = {}) {
  return useQuery({
    queryKey: qk.challenge(id ?? ""),
    queryFn: () => api.getChallenge(id as number | string),
    enabled: (opts.enabled ?? true) && id !== null && id !== undefined && id !== "",
    refetchInterval: pollWhile((d) => isChallengeActive(d)),
  });
}

export function useSettlement(id: number | string | null | undefined, opts: QueryOpts & { poll?: boolean } = {}) {
  return useQuery({
    queryKey: qk.settlement(id ?? ""),
    queryFn: () => api.getSettlement(id as number | string),
    enabled: (opts.enabled ?? true) && id !== null && id !== undefined && id !== "",
    refetchInterval: pollIf(opts.poll),
  });
}

export function useChallengeRegressions(id: number | string | null | undefined, opts: QueryOpts = {}) {
  return useQuery({
    queryKey: qk.challengeRegressions(id ?? ""),
    queryFn: () => api.listChallengeRegressions(id as number | string),
    enabled: (opts.enabled ?? true) && id !== null && id !== undefined && id !== "",
    refetchInterval: pollWhile((d) => !!d && d.some((r) => isRegressionActive(r.status))),
  });
}

export function useSpec(digest: Digest | null | undefined, opts: QueryOpts = {}) {
  return useQuery({
    queryKey: qk.spec(digest ?? ""),
    queryFn: () => api.getSpec(digest as Digest),
    enabled: (opts.enabled ?? true) && !!digest,
    staleTime: Infinity, // content-addressed
  });
}

/** One run; polls while queued / running. */
export function useRun(id: string | null | undefined, opts: QueryOpts = {}) {
  return useQuery({
    queryKey: qk.run(id ?? ""),
    queryFn: () => api.getRun(id as string),
    enabled: (opts.enabled ?? true) && !!id,
    refetchInterval: pollWhile((d) => !!d && isRunActive(d.status)),
  });
}

export function useCandidate(id: string | null | undefined, opts: QueryOpts = {}) {
  return useQuery({
    queryKey: qk.candidate(id ?? ""),
    queryFn: () => api.getCandidate(id as string),
    enabled: (opts.enabled ?? true) && !!id,
  });
}

/** One evaluation; polls while queued / replaying. */
export function useEvaluation(id: string | null | undefined, opts: QueryOpts = {}) {
  return useQuery({
    queryKey: qk.evaluation(id ?? ""),
    queryFn: () => api.getEvaluation(id as string),
    enabled: (opts.enabled ?? true) && !!id,
    refetchInterval: pollWhile((d) => !!d && isEvaluationActive(d.status)),
  });
}

/** Evidence bundle by digest (content-addressed, never refetched). */
export function useEvidence(digest: Digest | null | undefined, opts: QueryOpts = {}) {
  return useQuery({
    queryKey: qk.evidence(digest ?? ""),
    queryFn: () => api.getEvidence(digest as Digest),
    enabled: (opts.enabled ?? true) && !!digest,
    staleTime: Infinity,
  });
}

/** One regression replay; polls until it has an outcome. */
export function useRegression(id: string | null | undefined, opts: QueryOpts = {}) {
  return useQuery({
    queryKey: qk.regression(id ?? ""),
    queryFn: () => api.getRegression(id as string),
    enabled: (opts.enabled ?? true) && !!id,
    refetchInterval: pollWhile((d) => !!d && isRegressionActive(d.status)),
  });
}

/** The exported regression test (JSON form) once the regression has finished. */
export function useRegressionExport(id: string | null | undefined, opts: QueryOpts = {}) {
  return useQuery({
    queryKey: qk.regressionExport(id ?? ""),
    queryFn: () => api.getRegressionExport(id as string),
    enabled: (opts.enabled ?? true) && !!id,
  });
}

export function useJob(id: string | null | undefined, opts: QueryOpts = {}) {
  return useQuery({
    queryKey: qk.job(id ?? ""),
    queryFn: () => api.getJob(id as string),
    enabled: (opts.enabled ?? true) && !!id,
    refetchInterval: pollWhile((d) => !!d && (d.status === "queued" || d.status === "running")),
  });
}

// ---------------------------------------------------------------------------- mutations
/** Canonical spec + digest for a draft, without storing it. */
export function usePreviewSpec() {
  return useMutation({ mutationFn: (body: SpecRequest) => api.previewSpec(body) });
}

/** Store the spec (content-addressed). Follow with useCreateChallenge({spec_digest}). */
export function useCreateSpec() {
  return useMutation({ mutationFn: (body: SpecRequest) => api.createSpec(body) });
}

export function useCreateChallenge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { spec_digest: Digest }) => api.createChallenge(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.challenges });
      void qc.invalidateQueries({ queryKey: qk.overview });
    },
  });
}

function useInvalidateChallenge(challengeId: number | string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: qk.challenge(challengeId) });
    void qc.invalidateQueries({ queryKey: qk.challenges });
    void qc.invalidateQueries({ queryKey: qk.overview });
  };
}

export function useStartRun(challengeId: number | string) {
  const invalidate = useInvalidateChallenge(challengeId);
  return useMutation({ mutationFn: (body: RunCreate) => api.startRun(challengeId, body), onSuccess: invalidate });
}

export function useCancelRun(challengeId: number | string) {
  const invalidate = useInvalidateChallenge(challengeId);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.cancelRun(runId),
    onSuccess: (run) => {
      qc.setQueryData(qk.run(run.id), run);
      invalidate();
    },
  });
}

/** Submit a candidate for independent replay by the evaluator. */
export function useSubmitCandidate(challengeId: number | string) {
  const invalidate = useInvalidateChallenge(challengeId);
  return useMutation({ mutationFn: (candidateId: string) => api.submitCandidate(candidateId), onSuccess: invalidate });
}

/** A human challenger reveals a candidate they committed themselves. */
export function useSubmitExternal(challengeId: number | string) {
  const invalidate = useInvalidateChallenge(challengeId);
  return useMutation({
    mutationFn: (body: { candidate: JsonObject; submission_id?: string | null }) => api.submitExternal(challengeId, body),
    onSuccess: invalidate,
  });
}

/** Re-queue an evaluation that ended in runner_failure (other verdicts are final). */
export function useRetryEvaluation(challengeId: number | string) {
  const qc = useQueryClient();
  const invalidate = useInvalidateChallenge(challengeId);
  return useMutation({
    mutationFn: (evaluationId: string) => api.retryEvaluation(evaluationId),
    onSuccess: (evaluation) => {
      qc.setQueryData(qk.evaluation(evaluation.id), evaluation);
      invalidate();
    },
  });
}

/** Ask the evaluator's signer for an attestation (funded challenges only). */
export function useAttest(challengeId: number | string) {
  const qc = useQueryClient();
  const invalidate = useInvalidateChallenge(challengeId);
  return useMutation({
    mutationFn: (evaluationId: string) => api.attest(evaluationId),
    onSuccess: (_att, evaluationId) => {
      void qc.invalidateQueries({ queryKey: qk.settlement(challengeId) });
      void qc.invalidateQueries({ queryKey: qk.evaluation(evaluationId) });
      invalidate();
    },
  });
}

/** Replay a verified candidate's action sequence against another target version. */
export function useCreateRegression(challengeId: number | string) {
  const qc = useQueryClient();
  const invalidate = useInvalidateChallenge(challengeId);
  return useMutation({
    mutationFn: (body: { candidate_id: string; target: string }) => api.createRegression(body),
    onSuccess: (reg) => {
      qc.setQueryData(qk.regression(reg.id), reg);
      void qc.invalidateQueries({ queryKey: qk.challengeRegressions(challengeId) });
      invalidate();
    },
  });
}

/** Report a funding tx hash (prefer useTrackedTx, which calls this for you). */
export function useRecordFunding(challengeId: number | string) {
  const qc = useQueryClient();
  const invalidate = useInvalidateChallenge(challengeId);
  return useMutation({
    mutationFn: (txHash: string) => api.recordFunding(challengeId, { tx_hash: txHash }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.settlement(challengeId) });
      invalidate();
    },
  });
}

/** Report a settle / refund / withdraw tx hash (prefer useTrackedTx). */
export function useRecordTransaction(challengeId: number | string) {
  const qc = useQueryClient();
  const invalidate = useInvalidateChallenge(challengeId);
  return useMutation({
    mutationFn: (body: { tx_hash: string; kind: ReportableTxKind }) => api.recordTransaction(challengeId, body),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.settlement(challengeId) });
      invalidate();
    },
  });
}

/** Report a wallet rejection / send error (prefer useTrackedTx). */
export function useRecordFailedTransaction(challengeId: number | string) {
  const invalidate = useInvalidateChallenge(challengeId);
  return useMutation({
    mutationFn: (body: { kind: string; error: string; tx_hash?: string | null }) =>
      api.recordFailedTransaction(challengeId, body),
    onSettled: invalidate,
  });
}
