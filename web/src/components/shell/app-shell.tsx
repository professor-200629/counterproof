"use client";

import { FilePlus2, History, LayoutDashboard, ListChecks, Menu, Scale, X, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Address } from "@/components/ui/address";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { useConfig } from "@/lib/queries";
import { SNAPSHOT_MODE } from "@/lib/snapshot";
import { NetworkBadge } from "./network-badge";
import { SnapshotBanner } from "./snapshot-banner";
import { WalletButton, WalletNotices } from "./wallet-button";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  isActive: (path: string) => boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Overview", icon: LayoutDashboard, isActive: (p) => p === "/" },
  {
    href: "/challenges/new",
    label: SNAPSHOT_MODE ? "How to create" : "Create challenge",
    icon: FilePlus2,
    isActive: (p) => p === "/challenges/new",
  },
  {
    href: "/challenges",
    label: "Challenges",
    icon: ListChecks,
    isActive: (p) => p === "/challenges" || (p.startsWith("/challenges/") && p !== "/challenges/new") || p.startsWith("/evaluations/"),
  },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname() ?? "/";
  return (
    <ul className="space-y-0.5">
      {NAV_ITEMS.map((item) => {
        const active = item.isActive(pathname);
        const Icon = item.icon;
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                active ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg",
              )}
            >
              <Icon aria-hidden="true" className={cn("size-4", active ? "text-accent-text" : "text-subtle")} />
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="block rounded-md">
      <span className="block text-sm font-semibold tracking-tight text-fg">CounterProof</span>
      <span className={cn("text-xs text-muted", compact ? "hidden sm:block" : "block")}>Put AI promises to the test.</span>
    </Link>
  );
}

/** Standing statement of the trust model, shown in the sidebar on every page. */
function TrustNote() {
  const { data: config, isError } = useConfig();
  return (
    <div className="rounded-md border border-line bg-raised/50 p-3 text-xs text-muted">
      <p className="flex items-center gap-1.5 font-medium text-fg">
        <Scale aria-hidden="true" className="size-3.5 text-subtle" />
        Trust model
      </p>
      <p className="mt-1.5">
        A declared trusted evaluator replays each candidate and signs an attestation. The signature is not a
        zero-knowledge proof, and the contract cannot re-check the replay. A deterministic checker decides; model
        output never decides payouts.
      </p>
      <p className="mt-2">
        <span className="block text-subtle">Evaluator</span>
        {config ? (
          <Address value={config.evaluator_address} label="evaluator address" emptyText="not configured" />
        ) : (
          <span className="text-subtle">{isError ? (SNAPSHOT_MODE ? "unknown (recorded configuration not loaded)" : "unknown (backend unreachable)") : "loading"}</span>
        )}
      </p>
    </div>
  );
}

/**
 * Left nav (desktop) / disclosure menu (mobile) + top bar with network badge and wallet.
 * Snapshot mode: the recorded-snapshot banner above everything, a "read-only" badge in the
 * sticky top bar, and no wallet controls.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <>
      {SNAPSHOT_MODE ? <SnapshotBanner /> : null}
      <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="sticky top-0 hidden h-dvh flex-col gap-6 overflow-y-auto border-r border-line bg-surface px-3 py-5 lg:flex">
          <div className="px-2.5">
            <Brand />
          </div>
          <nav aria-label="Primary">
            <NavLinks />
          </nav>
          <div className="mt-auto">
            <TrustNote />
          </div>
        </aside>

        <div className="flex min-w-0 flex-col">
          <header className="sticky top-0 z-20 border-b border-line bg-canvas/95 backdrop-blur supports-[backdrop-filter]:bg-canvas/80">
            <div className="flex min-h-14 items-center gap-3 px-4 py-2 sm:px-6 lg:px-8">
              <button
                type="button"
                className="inline-flex size-9 items-center justify-center rounded-md border border-line text-muted hover:text-fg lg:hidden"
                aria-expanded={menuOpen}
                aria-controls="mobile-nav"
                aria-label={menuOpen ? "Close navigation" : "Open navigation"}
                onClick={() => setMenuOpen((o) => !o)}
              >
                {menuOpen ? <X aria-hidden="true" className="size-4" /> : <Menu aria-hidden="true" className="size-4" />}
              </button>
              <div className="min-w-0 lg:hidden">
                <Brand compact />
              </div>
              <div className="ml-auto flex min-w-0 items-center justify-end gap-2">
                <div className="hidden sm:block">
                  <NetworkBadge />
                </div>
                {SNAPSHOT_MODE ? (
                  <Badge tone="warn" icon={<History />} title="Recorded snapshot: nothing on this site runs live, and nothing can be started, signed or sent.">
                    <span className="sm:hidden">Read-only snapshot</span>
                    <span className="hidden sm:inline">Recorded snapshot - read-only</span>
                  </Badge>
                ) : (
                  <WalletButton notices="separate" />
                )}
              </div>
            </div>
            <div className="border-t border-line px-4 py-1.5 sm:hidden">
              <NetworkBadge />
            </div>
            {SNAPSHOT_MODE ? null : <WalletNotices className="border-t border-line px-4 py-1.5 sm:px-6 lg:px-8" />}
            {menuOpen ? (
              <nav id="mobile-nav" aria-label="Primary" className="border-t border-line px-4 py-3 lg:hidden">
                <NavLinks onNavigate={() => setMenuOpen(false)} />
                <div className="mt-3">
                  <TrustNote />
                </div>
              </nav>
            ) : null}
          </header>

          <main id="main" tabIndex={-1} className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 focus:outline-none sm:px-6 lg:px-8">
            {children}
          </main>
        </div>
      </div>
    </>
  );
}
