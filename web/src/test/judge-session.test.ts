/**
 * The judge sign-in in the shell: present in the live console, absent from the recorded
 * snapshot (which has nothing to change). Refusals by the server's auth and limits are
 * shown in the server's own words, with a sign-in action for 401.
 */
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "./render";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  notFound: () => {
    throw new Error("notFound");
  },
}));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("judge sign-in in the shell", () => {
  it("is offered in the live console", async () => {
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT", "");
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT_MANIFEST", "");
    const { AppShell } = await import("@/components/shell/app-shell");
    const { text } = render(createElement(AppShell, null, createElement("p", null, "page")));
    expect(text).toContain("Judge sign-in");
  });

  it("shows the signed-in role instead once a session exists", async () => {
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT", "");
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT_MANIFEST", "");
    const { JudgeSession } = await import("@/components/shell/judge-session");
    const { qk } = await import("@/lib/queries");
    const session = {
      authenticated: true, role: "judge", via: "cookie", owner: "judge:sess_1", expires_at: 2_000_000_000, csrf_token: "t",
      operator_stop: null,
      limits: { max_sequences: 50, max_wall_seconds: 300, max_model_calls: 60, max_model_tokens: 60000, max_actions: 8,
        max_sequences_per_call: 5, max_active_jobs: 2, daily_tokens: 200000, max_queued_jobs: 20 },
      usage: { active_jobs: 0, max_active_jobs: 2, tokens_today: 0, daily_tokens: 200000, tokens_remaining: 200000,
        global_tokens_today: 0, global_daily_ceiling: 1000000, day: "2026-10-13" },
    };
    const { text } = render(createElement(JudgeSession), { data: [[qk.session, session]] });
    expect(text).toContain("Judge");
    expect(text).not.toContain("Judge sign-in");
  });

  it("is absent from the recorded snapshot", async () => {
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT", "1");
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT_MANIFEST", JSON.stringify({ taken_at: 1791308914, network: "offchain", network_label: "Off-chain only" }));
    const { AppShell } = await import("@/components/shell/app-shell");
    const { text } = render(createElement(AppShell, null, createElement("p", null, "page")));
    expect(text).not.toContain("Judge sign-in");
    expect(text).not.toContain("Sign in");
  });
});

describe("judge limits text", () => {
  it("names the limits all judge sessions share, and the model without claiming more", async () => {
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT", "");
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT_MANIFEST", "");
    const { judgeLimitsText } = await import("@/components/shell/judge-session");
    const judge = { max_sequences: 50, max_wall_seconds: 300, max_model_calls: 60, max_model_tokens: 60000, max_actions: 8,
      max_sequences_per_call: 5, max_active_jobs: 2, daily_tokens: 200000, all_sessions_active_jobs: 8,
      all_sessions_daily_tokens: 500000, max_queued_jobs: 20, model: "groq/openai/gpt-oss-120b", temperature: 0, max_steps: 8 };
    const text = judgeLimitsText({ authenticated: false, role: null, auth_configured: true, operator_stop: null, limits: { judge } });
    expect(text).toContain("2 active jobs at a time");
    expect(text).toContain("all judge sessions together 8 active jobs and 500,000 tokens a day");
    expect(text).toContain("live-model work only on groq/openai/gpt-oss-120b");
    expect(text).not.toContain("temperature");
    // a server from before the all-sessions limits: the clause is simply absent
    const older: Omit<typeof judge, "all_sessions_active_jobs" | "all_sessions_daily_tokens"> &
      Partial<Pick<typeof judge, "all_sessions_active_jobs" | "all_sessions_daily_tokens">> = { ...judge };
    delete older.all_sessions_active_jobs;
    delete older.all_sessions_daily_tokens;
    const before = judgeLimitsText({ authenticated: false, role: null, auth_configured: true, operator_stop: null, limits: { judge: older } });
    expect(before).not.toContain("all judge sessions");
  });
});

describe("refusals in the server's words", () => {
  it("titles 401/403/429/503 and keeps the detail; 401 offers sign-in", async () => {
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT", "");
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT_MANIFEST", "");
    const { ErrorState } = await import("@/components/ui/states");
    const { ApiError } = await import("@/lib/api");
    const cases = [
      [401, "Sign-in required", "sign in first"],
      [403, "Not allowed for this session", "only the operator can do this"],
      [429, "Limit reached", "the evaluator queue is full (20 jobs queued or running, limit 20)"],
      [503, "Paused by the operator", "operator stop in effect"],
    ] as const;
    for (const [status, title, detail] of cases) {
      const { text } = render(createElement(ErrorState, { error: new ApiError({ status, detail, path: "/challenges/1/runs" }) }));
      expect(text).toContain(title);
      expect(text).toContain(detail);
      expect(text.includes("Sign in"), String(status)).toBe(status === 401);
    }
  });
});
