/**
 * Read-only snapshot mode (NEXT_PUBLIC_SNAPSHOT=1): the path mapping shared with
 * scripts/export_snapshot.py, the API client reading static files and refusing every
 * mutation, no polling, and the banner wording. The mode is read when a module loads, so
 * each test stubs the environment and imports fresh modules.
 */
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatUnix } from "@/lib/format";
import { deadlineAtSnapshot, parseSnapshotManifest, snapshotBannerText, snapshotFile, type SnapshotManifest } from "@/lib/snapshot";

const MANIFEST: SnapshotManifest = {
  format: "counterproof.snapshot/v1",
  taken_at: 1791308914,
  network: "anvil-local",
  network_label: "Local anvil chain (31337) - not Monad testnet",
  chain_id: 31337,
  contract: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  explorer_tx_url: null,
  challenges_included: [3],
  challenges_on_evaluator: 6,
  files: 21,
  note: "Recorded responses from the CounterProof evaluator. Read-only: nothing on this site runs live.",
};

const DIGEST = `sha256:${"ab12".repeat(16)}`;
const DIGEST_FILE = `sha256_${"ab12".repeat(16)}`;

function snapshotEnv(manifest: SnapshotManifest | null = MANIFEST) {
  vi.stubEnv("NEXT_PUBLIC_SNAPSHOT", "1");
  vi.stubEnv("NEXT_PUBLIC_SNAPSHOT_MANIFEST", manifest ? JSON.stringify(manifest) : "");
}

function normalEnv() {
  vi.stubEnv("NEXT_PUBLIC_SNAPSHOT", "");
  vi.stubEnv("NEXT_PUBLIC_SNAPSHOT_MANIFEST", "");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("snapshot file mapping (same rule as scripts/export_snapshot.py)", () => {
  it("replaces every ':' with '_' and appends .json under /snapshot", () => {
    expect(snapshotFile("/api/evidence/sha256:ab12")).toBe("/snapshot/api/evidence/sha256_ab12.json");
    expect(snapshotFile("/api/specs/a:b:c")).toBe("/snapshot/api/specs/a_b_c.json");
    expect(snapshotFile("/api/challenges/3")).toBe("/snapshot/api/challenges/3.json");
    expect(snapshotFile("/api/challenges/3/settlement")).toBe("/snapshot/api/challenges/3/settlement.json");
    expect(snapshotFile("/api/config")).toBe("/snapshot/api/config.json");
    expect(snapshotFile("/api/rule-templates")).toBe("/snapshot/api/rule-templates.json");
  });

  it("decodes URL-encoded ids first (the client sends sha256%3A...)", () => {
    expect(snapshotFile("/api/evidence/sha256%3Aab12")).toBe("/snapshot/api/evidence/sha256_ab12.json");
  });

  it("maps the pytest export to its .pytest.txt file and ignores download=true", () => {
    expect(snapshotFile("/api/regressions/reg_1/export")).toBe("/snapshot/api/regressions/reg_1/export.json");
    expect(snapshotFile("/api/regressions/reg_1/export?format=pytest")).toBe("/snapshot/api/regressions/reg_1/export.pytest.txt");
    expect(snapshotFile("/api/evidence/sha256%3Aab12?download=true")).toBe("/snapshot/api/evidence/sha256_ab12.json");
  });

  it("finds every recorded response of the sample snapshot in public/snapshot", () => {
    const publicDir = new URL("../../../public/", import.meta.url);
    const file = (apiPath: string) => new URL(`.${snapshotFile(apiPath)}`, publicDir);
    const manifestFile = new URL("./snapshot/manifest.json", publicDir);
    if (!existsSync(manifestFile)) return; // no snapshot exported in this checkout
    const manifest = parseSnapshotManifest(readFileSync(manifestFile, "utf8"));
    expect(manifest).not.toBeNull();
    const paths = ["/api/config", "/api/targets", "/api/rule-templates", "/api/strategies", "/api/overview", "/api/challenges"];
    for (const id of manifest!.challenges_included) {
      const view = JSON.parse(readFileSync(file(`/api/challenges/${id}`), "utf8")) as {
        spec_digest: string;
        runs: { id: string }[];
        candidates: { id: string }[];
        evaluations: { id: string; evidence_digest: string | null }[];
      };
      paths.push(`/api/challenges/${id}/settlement`, `/api/challenges/${id}/regressions`, `/api/specs/${encodeURIComponent(view.spec_digest)}`);
      for (const r of view.runs) paths.push(`/api/runs/${r.id}`);
      for (const c of view.candidates) paths.push(`/api/candidates/${c.id}`);
      for (const e of view.evaluations) {
        paths.push(`/api/evaluations/${e.id}`);
        if (e.evidence_digest) paths.push(`/api/evidence/${encodeURIComponent(e.evidence_digest)}`);
      }
    }
    for (const p of paths) expect(existsSync(file(p)), `${p} -> ${snapshotFile(p)}`).toBe(true);
  });
});

describe("snapshot API client", () => {
  it("reads GETs from the static files", async () => {
    snapshotEnv();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("@/lib/api");
    await expect(api.getEvidence(DIGEST)).resolves.toEqual({ ok: true });
    await api.getChallenge(3);
    await api.getRegressionExport("reg_1");
    const urls = fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(urls).toEqual([
      `/snapshot/api/evidence/${DIGEST_FILE}.json`,
      "/snapshot/api/challenges/3.json",
      "/snapshot/api/regressions/reg_1/export.json",
    ]);
  });

  it("turns a missing file into the not-found error, worded for the snapshot", async () => {
    snapshotEnv();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>404</html>", { status: 404 })));
    const { api, ApiError } = await import("@/lib/api");
    const err = await api.getChallenge(5).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(404);
    expect((err as InstanceType<typeof ApiError>).detail).toContain("not included in this recorded snapshot");
  });

  it("refuses every mutation with the read-only error, without a request", async () => {
    snapshotEnv();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { api, ApiError } = await import("@/lib/api");
    const { READ_ONLY_DETAIL } = await import("@/lib/snapshot");
    expect(READ_ONLY_DETAIL).toBe("This is a read-only recorded snapshot; actions need the evaluator backend (see README)");
    const spec = {
      title: "t",
      target: "a@1",
      rules: [],
      publisher: "0x0",
      submission_deadline: 1,
      settlement_deadline: 2,
    };
    const calls: [string, () => Promise<unknown>][] = [
      ["previewSpec", () => api.previewSpec(spec)],
      ["createSpec", () => api.createSpec(spec)],
      ["createChallenge", () => api.createChallenge({ spec_digest: DIGEST })],
      ["recordFunding", () => api.recordFunding(3, { tx_hash: "0x1" })],
      ["recordTransaction", () => api.recordTransaction(3, { tx_hash: "0x1", kind: "settle" })],
      ["recordFailedTransaction", () => api.recordFailedTransaction(3, { kind: "settle", error: "x" })],
      ["startRun", () => api.startRun(3, { strategy: "s", mode: "deterministic" })],
      ["cancelRun", () => api.cancelRun("run_1")],
      ["submitCandidate", () => api.submitCandidate("cand_1")],
      ["candidateDigest", () => api.candidateDigest({ spec_digest: DIGEST, candidate: {} })],
      ["submitExternal", () => api.submitExternal(3, { candidate: {} })],
      ["retryEvaluation", () => api.retryEvaluation("eval_1")],
      ["attest", () => api.attest("eval_1")],
      ["createRegression", () => api.createRegression({ candidate_id: "cand_1", target: "a@2" })],
    ];
    for (const [name, call] of calls) {
      const err = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, name).toBeInstanceOf(ApiError);
      expect((err as Error).message, name).toBe(READ_ONLY_DETAIL);
      expect((err as InstanceType<typeof ApiError>).kind, name).toBe("read_only_snapshot");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("links downloads to the static files", async () => {
    snapshotEnv();
    const { evidenceDownloadUrl, regressionExportUrl, specJsonUrl } = await import("@/lib/api");
    expect(evidenceDownloadUrl(DIGEST)).toBe(`/snapshot/api/evidence/${DIGEST_FILE}.json`);
    expect(specJsonUrl(DIGEST)).toBe(`/snapshot/api/specs/${DIGEST_FILE}.json`);
    expect(regressionExportUrl("reg_1", "json")).toBe("/snapshot/api/regressions/reg_1/export.json");
    expect(regressionExportUrl("reg_1", "pytest")).toBe("/snapshot/api/regressions/reg_1/export.pytest.txt");
  });

  it("normal mode is unchanged: /api paths, POSTs reach the backend", async () => {
    normalEnv();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "run_1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { api, evidenceDownloadUrl, regressionExportUrl } = await import("@/lib/api");
    await api.cancelRun("run_1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url.endsWith("/api/runs/run_1/cancel")).toBe(true);
    expect(init.method).toBe("POST");
    expect(evidenceDownloadUrl(DIGEST)).toBe(`/api/evidence/${encodeURIComponent(DIGEST)}?download=true`);
    expect(regressionExportUrl("reg_1", "pytest")).toBe("/api/regressions/reg_1/export?format=pytest");
  });
});

describe("polling", () => {
  const active = { state: { data: 1 } };

  it("never polls or refetches in snapshot mode", async () => {
    snapshotEnv();
    const { pollWhile, pollIf, makeQueryClient } = await import("@/lib/queries");
    expect(pollWhile(() => true)(active)).toBe(false);
    expect(pollIf(true)).toBe(false);
    const defaults = makeQueryClient().getDefaultOptions().queries;
    expect(defaults?.refetchOnWindowFocus).toBe(false);
    expect(defaults?.refetchOnReconnect).toBe(false);
    expect(defaults?.staleTime).toBe(Infinity);
  });

  it("still polls active work outside snapshot mode", async () => {
    normalEnv();
    const { pollWhile, pollIf, POLL_MS, makeQueryClient } = await import("@/lib/queries");
    expect(pollWhile(() => true)(active)).toBe(POLL_MS);
    expect(pollWhile(() => false)(active)).toBe(false);
    expect(pollIf(true)).toBe(POLL_MS);
    expect(makeQueryClient().getDefaultOptions().queries?.refetchOnWindowFocus).toBe(true);
  });

  it("every refetchInterval in queries.ts goes through pollWhile / pollIf", () => {
    const src = readFileSync(new URL("../queries.ts", import.meta.url), "utf8");
    const intervals = [...src.matchAll(/refetchInterval:\s*([^\n]+)/g)].map((m) => m[1]);
    expect(intervals.length).toBeGreaterThan(5);
    for (const v of intervals) expect(v).toMatch(/^(pollWhile|pollIf)\(/);
  });
});

describe("banner and recorded time", () => {
  it("names when, from which network, and how much was recorded", () => {
    const text = snapshotBannerText(MANIFEST);
    expect(text).toContain("Recorded snapshot - read-only.");
    expect(text).toContain(`Taken ${formatUnix(MANIFEST.taken_at, { utc: true })} from the CounterProof evaluator`);
    expect(text).toContain(MANIFEST.network_label);
    expect(text).toContain("Nothing on this site runs live: the replays, verdicts, signatures and transactions shown were recorded from the evaluator's run.");
    expect(text).toContain("1 of 6 challenges included.");
    expect(snapshotBannerText(null)).toContain("Recorded snapshot - read-only.");
  });

  it("parses the inlined manifest and rejects a malformed one", () => {
    expect(parseSnapshotManifest(JSON.stringify(MANIFEST))).toEqual(MANIFEST);
    expect(parseSnapshotManifest("not json")).toBeNull();
    expect(parseSnapshotManifest({ network: "anvil-local" })).toBeNull();
  });

  it("judges deadlines at snapshot time instead of counting down", () => {
    expect(deadlineAtSnapshot(MANIFEST.taken_at - 60, MANIFEST.taken_at)).toBe("passed at snapshot time");
    expect(deadlineAtSnapshot(MANIFEST.taken_at + 3600, MANIFEST.taken_at)).toBe("not passed at snapshot time (1 h 00 min 00 s left then)");
  });

  it("freezes the console clock at taken_at in snapshot mode", async () => {
    snapshotEnv();
    const snap = await import("@/lib/snapshot");
    expect(snap.SNAPSHOT_MODE).toBe(true);
    expect(snap.SNAPSHOT_TAKEN_AT).toBe(MANIFEST.taken_at);
    expect(snap.SNAPSHOT_MANIFEST?.network_label).toBe(MANIFEST.network_label);
  });
});
