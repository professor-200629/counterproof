import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { JsonObject, JsonValue } from "@/lib/api";
import { cn } from "@/lib/cn";
import { humanize } from "@/lib/status";
import { ValueCell, valueText } from "./values";

type Row = Record<string, JsonValue>;

function isRow(v: JsonValue): v is Row {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isRowArray(v: JsonValue): v is Row[] {
  return Array.isArray(v) && v.length > 0 && v.every(isRow);
}

/** `{ "ord-0001": [ {...}, {...} ] }` - rows grouped by a key (order.single_payment). */
function isGroupedRows(v: JsonValue): v is Record<string, Row[]> {
  return isRow(v) && Object.keys(v).length > 0 && Object.values(v).every((x) => isRowArray(x));
}

function columnsOf(rows: Row[]): string[] {
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  // Ledger sequence number first: it is how rows tie back to the ledger timeline.
  return cols.includes("seq") ? ["seq", ...cols.filter((c) => c !== "seq")] : cols;
}

/** "orders" -> "order"; used for the group column header. */
function singular(key: string): string {
  return key.endsWith("s") ? key.slice(0, -1) : key;
}

export interface ObservedViewProps {
  /** verdict.observed (or a local self-check's observed). */
  observed: JsonObject;
  /** Ledger seqs the checker cites; matching rows are marked. */
  witnessSeqs?: number[] | null;
  currency?: string;
  className?: string;
}

/**
 * What the checker observed, as data: scalar facts (total, budget, excess...) as a list,
 * payments / orders / attempts as tables with their ledger sequence numbers.
 */
export function ObservedView({ observed, witnessSeqs, currency = "SYN", className }: ObservedViewProps) {
  const witness = new Set(witnessSeqs ?? []);
  const entries = Object.entries(observed);
  const scalars = entries.filter(([, v]) => v === null || typeof v !== "object");
  const primitiveLists = entries.filter(([, v]) => Array.isArray(v) && !isRowArray(v));
  const tables = entries.filter(([, v]) => isRowArray(v)) as [string, Row[]][];
  const groups = entries.filter(([, v]) => isGroupedRows(v)) as [string, Record<string, Row[]>][];
  const other = entries.filter(([, v]) => isRow(v) && !isGroupedRows(v));

  const seqCell = (row: Row, key: string) => {
    const seq = row.seq;
    const isWitness = typeof seq === "number" && witness.has(seq);
    return (
      <TD key={key} mono numeric className={cn(isWitness && "font-semibold text-bad")}>
        {typeof seq === "number" ? seq : "-"}
        {isWitness ? <span className="sr-only"> (witness event)</span> : null}
      </TD>
    );
  };

  return (
    <div className={cn("space-y-4", className)}>
      {scalars.length > 0 ? (
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2">
          {scalars.map(([k, v]) => (
            <div key={k} className="min-w-0 rounded-md border border-line bg-surface px-3 py-2">
              <dt className="text-xs text-muted">{humanize(k)}</dt>
              <dd className="mt-0.5 break-words font-mono text-sm font-semibold text-fg tabular">{valueText(k, v, currency)}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {tables.map(([key, rows]) => {
        const cols = columnsOf(rows);
        return (
          <Table className="relative" key={key} caption={`Observed ${humanize(key).toLowerCase()} (${rows.length})`} showCaption dense>
            <THead>
              <tr>
                {cols.map((c) => (
                  <TH key={c} className={c === "seq" ? "text-right" : undefined}>
                    {c === "seq" ? "Ledger seq" : c}
                  </TH>
                ))}
              </tr>
            </THead>
            <TBody>
              {rows.map((r, i) => (
                <TR key={i} highlighted={typeof r.seq === "number" && witness.has(r.seq)}>
                  {cols.map((c) =>
                    c === "seq" ? (
                      seqCell(r, c)
                    ) : (
                      <TD key={c}>
                        <ValueCell name={c} value={r[c]} currency={currency} />
                      </TD>
                    ),
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        );
      })}

      {groups.map(([key, grouped]) => {
        const all = Object.values(grouped).flat();
        const cols = columnsOf(all).filter((c) => c !== singular(key) + "_id");
        return (
          <Table className="relative" key={key} caption={`Observed ${humanize(key).toLowerCase()} (${Object.keys(grouped).length})`} showCaption dense>
            <THead>
              <tr>
                <TH>{singular(key)}</TH>
                {cols.map((c) => (
                  <TH key={c} className={c === "seq" ? "text-right" : undefined}>
                    {c === "seq" ? "Ledger seq" : c}
                  </TH>
                ))}
              </tr>
            </THead>
            <TBody>
              {Object.entries(grouped).flatMap(([gid, rows]) =>
                rows.map((r, i) => (
                  <TR key={`${gid}-${i}`} highlighted={typeof r.seq === "number" && witness.has(r.seq)}>
                    <TD mono>{i === 0 ? gid : <span className="text-subtle">{gid}</span>}</TD>
                    {cols.map((c) =>
                      c === "seq" ? (
                        seqCell(r, c)
                      ) : (
                        <TD key={c}>
                          <ValueCell name={c} value={r[c]} currency={currency} />
                        </TD>
                      ),
                    )}
                  </TR>
                )),
              )}
            </TBody>
          </Table>
        );
      })}

      {primitiveLists.length > 0 ? (
        <dl className="space-y-1 text-sm">
          {primitiveLists.map(([k, v]) => (
            <div key={k} className="flex flex-wrap gap-x-2">
              <dt className="text-muted">{humanize(k)}:</dt>
              <dd className="font-mono text-xs text-fg">
                {Array.isArray(v) && v.length > 0 ? v.map((x) => valueText(k, x)).join(", ") : "none"}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {other.map(([k, v]) => (
        <div key={k} className="text-sm">
          <p className="text-muted">{humanize(k)}</p>
          <ValueCell name={k} value={v} currency={currency} />
        </div>
      ))}
    </div>
  );
}
