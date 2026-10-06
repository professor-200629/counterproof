"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Optional count / badge after the label. */
  badge?: ReactNode;
  content: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  /** Accessible name of the tab list. */
  label: string;
  /** Controlled selected id. */
  value?: string;
  /** Uncontrolled initial id (defaults to the first enabled tab). */
  defaultValue?: string;
  onChange?: (id: string) => void;
  /** Keep inactive panels mounted (hidden). Default false: only the active panel renders. */
  keepMounted?: boolean;
  className?: string;
}

/**
 * WAI-ARIA tabs: roving tabindex, Left/Right (and Up/Down) move, Home/End jump,
 * selection follows focus. Panels are focusable so keyboard users land on content.
 */
export function Tabs({ items, label, value, defaultValue, onChange, keepMounted = false, className }: TabsProps) {
  const baseId = useId();
  const firstEnabled = items.find((t) => !t.disabled)?.id ?? items[0]?.id ?? "";
  const [inner, setInner] = useState(defaultValue ?? firstEnabled);
  const selectedRaw = value ?? inner;
  const selected = items.some((t) => t.id === selectedRaw) ? selectedRaw : firstEnabled;
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const select = (id: string) => {
    if (value === undefined) setInner(id);
    onChange?.(id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const enabled = items.filter((t) => !t.disabled);
    const idx = enabled.findIndex((t) => t.id === selected);
    let next: TabItem | undefined;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = enabled[(idx + 1) % enabled.length];
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = enabled[(idx - 1 + enabled.length) % enabled.length];
    else if (e.key === "Home") next = enabled[0];
    else if (e.key === "End") next = enabled[enabled.length - 1];
    if (!next) return;
    e.preventDefault();
    select(next.id);
    tabRefs.current[next.id]?.focus();
  };

  const tabId = (id: string) => `${baseId}-tab-${id}`;
  const panelId = (id: string) => `${baseId}-panel-${id}`;

  return (
    <div className={cn("min-w-0", className)}>
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="flex max-w-full gap-1 overflow-x-auto border-b border-line"
      >
        {items.map((t) => {
          const active = t.id === selected;
          return (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={tabId(t.id)}
              aria-selected={active}
              aria-controls={panelId(t.id)}
              tabIndex={active ? 0 : -1}
              disabled={t.disabled}
              onClick={() => select(t.id)}
              className={cn(
                // Inset focus ring: the scrolling tablist clips anything drawn outside the tab.
                "-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-offset-[-2px]",
                active ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg",
                t.disabled && "cursor-not-allowed opacity-50",
              )}
            >
              {t.label}
              {t.badge !== undefined && t.badge !== null ? (
                <span className="rounded-full bg-raised px-1.5 py-0.5 text-[11px] tabular text-muted">{t.badge}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {items.map((t) => {
        const active = t.id === selected;
        if (!active && !keepMounted) {
          return <div key={t.id} role="tabpanel" id={panelId(t.id)} aria-labelledby={tabId(t.id)} hidden />;
        }
        return (
          <div
            key={t.id}
            role="tabpanel"
            id={panelId(t.id)}
            aria-labelledby={tabId(t.id)}
            hidden={!active}
            tabIndex={0}
            className="pt-4 focus-visible:outline-offset-4"
          >
            {t.content}
          </div>
        );
      })}
    </div>
  );
}
