import type { Tone } from "@/lib/status";

export type { Tone };

/** Text + soft background + border for a semantic tone (badges, callouts). */
export const toneSurface: Record<Tone, string> = {
  ok: "text-ok bg-ok-soft border-ok-line",
  warn: "text-warn bg-warn-soft border-warn-line",
  bad: "text-bad bg-bad-soft border-bad-line",
  neutral: "text-muted bg-raised border-line",
  accent: "text-accent-text bg-accent-soft border-accent-line",
};

/** Text colour only. */
export const toneText: Record<Tone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
  neutral: "text-muted",
  accent: "text-accent-text",
};

/** Solid bar / dot colour. */
export const toneFill: Record<Tone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  neutral: "bg-subtle",
  accent: "bg-accent",
};
