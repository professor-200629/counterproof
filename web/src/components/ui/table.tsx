import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export interface TableProps extends HTMLAttributes<HTMLTableElement> {
  /** Accessible caption. Visually hidden unless `showCaption`. */
  caption?: ReactNode;
  showCaption?: boolean;
  /** Smaller row padding for dense ledgers. */
  dense?: boolean;
}

/** Horizontally scrollable table wrapper (never scrolls the page sideways). */
export function Table({ caption, showCaption, dense, className, children, ...rest }: TableProps) {
  return (
    <div className="relative w-full min-w-0 overflow-x-auto rounded-lg border border-line bg-surface">
      <table
        className={cn("w-full border-collapse text-left text-sm", dense && "[&_td]:py-1.5 [&_th]:py-1.5", className)}
        {...rest}
      >
        {caption ? (
          <caption className={cn(showCaption ? "px-4 py-2 text-left text-sm text-muted" : "sr-only")}>{caption}</caption>
        ) : null}
        {children}
      </table>
    </div>
  );
}

export function THead({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("border-b border-line bg-raised/60 text-xs text-muted", className)} {...rest} />;
}

export function TBody({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("divide-y divide-line", className)} {...rest} />;
}

export interface TRProps extends HTMLAttributes<HTMLTableRowElement> {
  /** Highlight the row (e.g. a witness ledger event). */
  highlighted?: boolean;
}

export function TR({ className, highlighted, ...rest }: TRProps) {
  return <tr className={cn("align-top", highlighted && "bg-bad-soft", className)} {...rest} />;
}

export function TH({ className, scope = "col", ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope={scope} className={cn("whitespace-nowrap px-4 py-2 font-medium", className)} {...rest} />;
}

export interface TDProps extends TdHTMLAttributes<HTMLTableCellElement> {
  mono?: boolean;
  numeric?: boolean;
}

export function TD({ className, mono, numeric, ...rest }: TDProps) {
  return (
    <td
      className={cn("px-4 py-2.5 text-fg", mono && "font-mono text-xs", numeric && "text-right tabular", className)}
      {...rest}
    />
  );
}
