/**
 * Authenticated changes (backend auth.py): the browser sends the session cookie same-origin
 * and the CSRF token, kept in memory only, on every mutation; a 401 asks the shell to open
 * the sign-in panel; snapshot mode never sends anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Call = [string, RequestInit];

function normalEnv() {
  vi.stubEnv("NEXT_PUBLIC_SNAPSHOT", "");
  vi.stubEnv("NEXT_PUBLIC_SNAPSHOT_MANIFEST", "");
}

/** A browser-ish global: `window` exists, so the client behaves as in the browser. */
function browserWindow(): EventTarget {
  const w = new EventTarget();
  vi.stubGlobal("window", w);
  return w;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const SESSION = {
  authenticated: true,
  role: "judge",
  via: "cookie",
  owner: "judge:sess_1",
  expires_at: 2_000_000_000,
  csrf_token: "csrf-abc",
  operator_stop: null,
  limits: {
    max_sequences: 50,
    max_wall_seconds: 300,
    max_model_calls: 60,
    max_model_tokens: 60000,
    max_actions: 8,
    max_sequences_per_call: 5,
    max_active_jobs: 2,
    daily_tokens: 200000,
    max_queued_jobs: 20,
    model: "groq/openai/gpt-oss-120b",
  },
  usage: {
    active_jobs: 1,
    max_active_jobs: 2,
    tokens_today: 1200,
    daily_tokens: 200000,
    tokens_remaining: 198800,
    global_tokens_today: 5000,
    global_daily_ceiling: 1000000,
    day: "2026-10-13",
  },
};

beforeEach(() => {
  vi.resetModules();
  normalEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("mutations carry the session", () => {
  it("signs in without a CSRF header, then sends the token and same-origin credentials on changes", async () => {
    browserWindow();
    const fetchMock = vi.fn(async (url: string) => (url.endsWith("/api/session") ? json(SESSION) : json({ id: "run_1" })));
    vi.stubGlobal("fetch", fetchMock);
    const { api, getCsrfToken } = await import("@/lib/api");
    await api.signIn("pass");
    const [signUrl, signInit] = fetchMock.mock.calls[0] as unknown as Call;
    expect(signUrl).toBe("/api/session");
    expect(signInit.method).toBe("POST");
    expect((signInit.headers as Record<string, string>)["X-CSRF-Token"]).toBeUndefined();
    expect(signInit.credentials).toBe("same-origin");
    expect(getCsrfToken()).toBe("csrf-abc");

    await api.cancelRun("run_1");
    const [url, init] = fetchMock.mock.calls[1] as unknown as Call;
    expect(url).toBe("/api/runs/run_1/cancel");
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("csrf-abc");
    expect(init.credentials).toBe("same-origin");

    await api.getRun("run_1");
    const [, getInit] = fetchMock.mock.calls[2] as unknown as Call;
    expect((getInit.headers as Record<string, string>)["X-CSRF-Token"]).toBeUndefined(); // reads carry no token
  });

  it("after a reload, reads the token from GET /api/session before the first change", async () => {
    browserWindow();
    const fetchMock = vi.fn(async (url: string) => (url.endsWith("/api/session") ? json(SESSION) : json({ id: "e" })));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("@/lib/api");
    await api.retryEvaluation("eval_1");
    const urls = fetchMock.mock.calls.map((c) => (c as unknown as Call)[0]);
    expect(urls).toEqual(["/api/session", "/api/evaluations/eval_1/retry"]);
    const [, init] = fetchMock.mock.calls[1] as unknown as Call;
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("csrf-abc");
  });

  it("a 401 on a change asks the shell to open sign-in and forgets the token", async () => {
    const w = browserWindow();
    const seen: unknown[] = [];
    w.addEventListener("counterproof:auth-required", (e) => seen.push((e as CustomEvent).detail));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ detail: "sign in first: judges use the passcode (Judge sign-in)" }, 401)),
    );
    const { api, ApiError, getCsrfToken, setCsrfToken, isAuthRequired } = await import("@/lib/api");
    setCsrfToken("stale");
    const err = await api.startRun(1, { strategy: "s", mode: "deterministic" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(isAuthRequired(err)).toBe(true);
    expect((err as InstanceType<typeof ApiError>).detail).toContain("sign in first");
    expect(seen).toHaveLength(1);
    expect(getCsrfToken()).toBeNull();
  });

  it("shows the server's words for limits (429), role refusals (403) and the operator stop (503)", async () => {
    browserWindow();
    const { api, setCsrfToken } = await import("@/lib/api");
    setCsrfToken("t");
    for (const [status, detail] of [
      [429, "this session already has 2 active jobs (limit 2); wait for one to finish or cancel it"],
      [403, "judge sessions use the configured model groq/openai/gpt-oss-120b"],
      [503, "operator stop in effect: no new jobs or model calls until the operator resumes"],
    ] as const) {
      vi.stubGlobal("fetch", vi.fn(async () => json({ detail, kind: "limit" }, status)));
      const err = (await api.startRun(1, { strategy: "s", mode: "deterministic" }).catch((e: unknown) => e)) as {
        status: number;
        detail: string;
      };
      expect(err.status).toBe(status);
      expect(err.detail).toBe(detail);
    }
  });

  it("signing out forgets the token even when the server refuses", async () => {
    browserWindow();
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "expired" }, 401)));
    const { api, getCsrfToken, setCsrfToken } = await import("@/lib/api");
    setCsrfToken("t");
    await api.signOut().catch(() => null);
    expect(getCsrfToken()).toBeNull();
  });
});

describe("session helpers", () => {
  it("names the caps and the remaining budget", async () => {
    const { judgeLimitsText, sessionSummary } = await import("@/components/shell/judge-session");
    const { sessionLimits } = await import("@/lib/api");
    type S = Parameters<typeof sessionLimits>[0];
    expect(judgeLimitsText(SESSION as unknown as S)).toBe(
      "up to 50 sequences and 300 s per run, 2 active jobs at a time, 200,000 model tokens a day, live-model work only on groq/openai/gpt-oss-120b",
    );
    expect(sessionSummary(SESSION as unknown as S)).toMatch(/^Judge until .+ - 198,800 model tokens left today$/);
    const anon = { authenticated: false, role: null, auth_configured: true, operator_stop: null, limits: { judge: SESSION.limits } };
    expect(sessionLimits(anon as unknown as S)?.max_sequences).toBe(50);
    expect(sessionSummary(anon as unknown as S)).toBe("");
  });

  it("the run form starts within the server caps", async () => {
    const { initialBudget } = await import("@/components/challenge/strategy-card");
    type Caps = NonNullable<Parameters<typeof initialBudget>[1]>;
    expect(initialBudget(false)).toEqual({ max_sequences: 120, max_wall_seconds: 90 });
    expect(initialBudget(false, SESSION.limits as unknown as Caps)).toEqual({ max_sequences: 50, max_wall_seconds: 90 });
    expect(initialBudget(true, SESSION.limits as unknown as Caps)).toEqual({ max_sequences: 12, max_wall_seconds: 300 });
  });
});

describe("snapshot mode", () => {
  it("never asks for a session or sends a change", async () => {
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT", "1");
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT_MANIFEST", JSON.stringify({ taken_at: 1, network: "offchain", network_label: "x" }));
    browserWindow();
    const fetchMock = vi.fn(async () => json({}));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("@/lib/api");
    await expect(api.signIn("x")).rejects.toThrow(/read-only recorded snapshot/);
    await expect(api.signOut()).rejects.toThrow(/read-only recorded snapshot/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
