"use client";

import { KeyRound, LogOut, OctagonPause, UserCheck } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { ErrorState } from "@/components/ui/states";
import { AUTH_REQUIRED_EVENT, ApiError, sessionLimits, type SessionInfo } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatNumber, formatUnix } from "@/lib/format";
import { qk, useSession, useSignIn, useSignOut } from "@/lib/queries";
import { SNAPSHOT_MODE } from "@/lib/snapshot";

/** One line on what a judge session may do, from the server's own caps. */
export function judgeLimitsText(session: SessionInfo | null | undefined): string {
  const l = sessionLimits(session);
  if (!l) return "";
  const parts = [
    `up to ${formatNumber(l.max_sequences)} sequences and ${formatNumber(l.max_wall_seconds)} s per run`,
    l.max_active_jobs ? `${l.max_active_jobs} active jobs at a time` : null,
    l.daily_tokens ? `${formatNumber(l.daily_tokens)} model tokens a day` : null,
    l.model ? `live-model work on ${l.model} at temperature 0` : null,
  ].filter(Boolean);
  return parts.join(", ");
}

/** "Judge until 18:40 - 41,200 model tokens left today" for the signed-in badge. */
export function sessionSummary(session: SessionInfo | null | undefined): string {
  if (!session?.authenticated) return "";
  const role = session.role === "operator" ? "Operator" : "Judge";
  const until = session.expires_at ? ` until ${formatUnix(session.expires_at)}` : "";
  const left = session.usage.tokens_remaining;
  return `${role}${until}${left !== null ? ` - ${formatNumber(left)} model tokens left today` : ""}`;
}

/**
 * Header control for the demo session: "Judge sign-in" opens a passcode panel; once signed in
 * it shows the role, when the session ends and the remaining model-token budget, with sign-out.
 * A change refused with 401 anywhere in the app (AUTH_REQUIRED_EVENT) opens the panel and says
 * why. The passcode goes to the backend once; the session lives in an HttpOnly cookie the
 * page cannot read, and the CSRF token only in memory. Not rendered in snapshot mode.
 */
export function JudgeSession({ className }: { className?: string }) {
  const session = useSession();
  const signIn = useSignIn();
  const signOut = useSignOut();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [passcode, setPasscode] = useState("");
  const panelId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onAuthRequired = (e: Event) => {
      const err = (e as CustomEvent).detail;
      setReason(err instanceof ApiError ? err.detail : "Sign in to make changes.");
      setOpen(true);
      void qc.invalidateQueries({ queryKey: qk.session });
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
  }, [qc]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDoc);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [open]);

  if (SNAPSHOT_MODE) return null;
  const s = session.data;
  const signedIn = !!s?.authenticated;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!passcode) return;
    signIn.mutate(passcode, {
      onSuccess: () => {
        setPasscode("");
        setReason(null);
        setOpen(false);
      },
    });
  };

  return (
    <div ref={wrapRef} className={cn("relative", className)}>
      <Button
        size="sm"
        variant={signedIn ? "secondary" : "primary"}
        icon={signedIn ? <UserCheck /> : <KeyRound />}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          if (!open) void session.refetch(); // usage and active jobs change as work finishes
          setOpen(!open);
        }}
        title={signedIn ? sessionSummary(s) : undefined}
      >
        {signedIn ? (s.role === "operator" ? "Operator" : "Judge") : "Judge sign-in"}
      </Button>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label={signedIn ? "Session" : "Judge sign-in"}
          className="absolute right-0 top-full z-30 mt-2 w-[min(22rem,calc(100vw-2rem))] space-y-3 rounded-lg border border-line bg-surface p-4 text-sm shadow-lg"
        >
          {s?.operator_stop ? (
            <Badge tone="warn" size="lg" icon={<OctagonPause />}>
              Operator stop in effect: nothing new can start{s.operator_stop.reason ? ` (${s.operator_stop.reason})` : ""}.
            </Badge>
          ) : null}
          {signedIn ? (
            <>
              <p className="font-medium text-fg">{sessionSummary(s)}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted">
                <dt>Active jobs</dt>
                <dd className="tabular text-fg">
                  {s.usage.active_jobs}
                  {s.usage.max_active_jobs ? ` of ${s.usage.max_active_jobs}` : ""}
                </dd>
                <dt>Model tokens today</dt>
                <dd className="tabular text-fg">
                  {formatNumber(s.usage.tokens_today)}
                  {s.usage.daily_tokens ? ` of ${formatNumber(s.usage.daily_tokens)}` : ""}
                </dd>
                <dt>Evaluator, all sessions</dt>
                <dd className="tabular text-fg">
                  {formatNumber(s.usage.global_tokens_today)} of {formatNumber(s.usage.global_daily_ceiling)} tokens
                </dd>
              </dl>
              <p className="text-xs text-muted">Server limits for this session: {judgeLimitsText(s)}.</p>
              <Button size="sm" icon={<LogOut />} busy={signOut.isPending} busyLabel="Signing out..." onClick={() => signOut.mutate()}>
                Sign out
              </Button>
            </>
          ) : (
            <form onSubmit={submit} className="space-y-3">
              {reason ? (
                <p role="status" className="text-xs text-warn">
                  {reason}
                </p>
              ) : null}
              {s && !s.authenticated && !s.auth_configured ? (
                <p className="text-xs text-bad">This evaluator has no judge passcode configured; changes are disabled.</p>
              ) : null}
              <Input
                label="Judge passcode"
                type="password"
                autoComplete="current-password"
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                hint={`A judge session lasts up to 8 hours with server limits: ${judgeLimitsText(s) || "loading"}.`}
              />
              <Button type="submit" variant="primary" size="sm" disabled={!passcode} busy={signIn.isPending} busyLabel="Signing in...">
                Sign in
              </Button>
              {signIn.isError ? <ErrorState error={signIn.error} title="Sign-in refused" compact /> : null}
            </form>
          )}
        </div>
      ) : null}
    </div>
  );
}
