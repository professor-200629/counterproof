"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

export interface CopyButtonProps {
  value: string;
  /** What is being copied, for the accessible name: "Copy <label>". */
  label?: string;
  className?: string;
  /** Show the word "Copy" next to the icon. */
  showText?: boolean;
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Icon button that copies `value`; announces "Copied" politely. */
export function CopyButton({ value, label = "value", className, showText = false }: CopyButtonProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onClick = async () => {
    const ok = await writeClipboard(value);
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1600);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded px-1 text-subtle transition-colors hover:bg-raised hover:text-fg",
        state === "copied" && "text-ok hover:text-ok",
        className,
      )}
    >
      {state === "copied" ? <Check aria-hidden="true" className="size-3.5" /> : <Copy aria-hidden="true" className="size-3.5" />}
      {showText ? <span className="text-xs">{state === "copied" ? "Copied" : "Copy"}</span> : null}
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : ""}
      </span>
    </button>
  );
}
