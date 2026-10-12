/**
 * Read-only "recorded snapshot" mode, for a publicly hosted copy of the console.
 *
 * On when NEXT_PUBLIC_SNAPSHOT=1 at build time. The evaluator (API, worker, signer, chain)
 * runs only on the owner's machine; scripts/export_snapshot.py saves every GET response the
 * console needs under public/snapshot/, and this mode reads those files instead of /api:
 *
 *   GET /api/evidence/sha256:ab12            -> /snapshot/api/evidence/sha256_ab12.json
 *   GET /api/regressions/{id}/export?format=pytest -> /snapshot/api/regressions/{id}/export.pytest.txt
 *
 * Every mutation throws READ_ONLY_DETAIL, nothing polls, the clock is frozen at the moment
 * the snapshot was taken, and the shell says so on every page. next.config.ts inlines
 * public/snapshot/manifest.json as NEXT_PUBLIC_SNAPSHOT_MANIFEST (and refuses to build a
 * snapshot without one), so the banner never needs a request.
 */
import type { NetworkKind, UnixSeconds } from "./api";
import { formatCountdown, formatUnix, plural } from "./format";

/** True in the hosted, read-only build. Read once, at build time. */
export const SNAPSHOT_MODE: boolean = process.env.NEXT_PUBLIC_SNAPSHOT === "1";

/** The public CounterProof repository (README with setup and the evaluator's source). */
export const DEFAULT_SOURCE_URL = "https://github.com/professor-200629/counterproof";

/**
 * The source URL from an override value: an https URL is used as given; anything else
 * (unset, empty, http:, javascript:...) falls back to the public repository.
 */
export function sourceUrlFrom(override: string | null | undefined): string {
  const v = override?.trim();
  return v && v.startsWith("https://") ? v : DEFAULT_SOURCE_URL;
}

/**
 * Where a visitor learns to run the evaluator themselves (the repository README). The
 * repository is public, so this defaults to it; NEXT_PUBLIC_SNAPSHOT_SOURCE_URL at build
 * time overrides it (https only). Typed nullable so callers keep their plain-text fallback.
 */
export const SNAPSHOT_SOURCE_URL: string | null = sourceUrlFrom(process.env.NEXT_PUBLIC_SNAPSHOT_SOURCE_URL);

/**
 * docs/REPRODUCE.md of a GitHub repository URL ("https://github.com/<owner>/<repo>"); for any
 * other source URL, the copy in the public repository.
 */
export function reproduceDocUrl(sourceUrl: string | null | undefined): string {
  const m = /^(https:\/\/github\.com\/[^/\s]+\/[^/\s]+?)\/?$/.exec(sourceUrl ?? "");
  return `${m ? m[1] : DEFAULT_SOURCE_URL}/blob/main/docs/REPRODUCE.md`;
}

/** How to reproduce a recorded finding with your own evaluator (docs/REPRODUCE.md). */
export const REPRODUCE_DOC_URL: string = reproduceDocUrl(SNAPSHOT_SOURCE_URL);

/** Message of the error every mutation throws in snapshot mode. */
export const READ_ONLY_DETAIL = "This is a read-only recorded snapshot; actions need the evaluator backend (see README)";

/** ApiError.kind of that error. */
export const READ_ONLY_KIND = "read_only_snapshot";

/** Wording for a GET whose response was not exported into the snapshot (HTTP 404). */
export const NOT_IN_SNAPSHOT = "not included in this recorded snapshot";

/** public/snapshot/manifest.json, written by scripts/export_snapshot.py. */
export interface SnapshotManifest {
  format: string;
  /** When the export ran (unix seconds). The console's clock is frozen here. */
  taken_at: UnixSeconds;
  network: NetworkKind;
  network_label: string;
  chain_id: number | null;
  contract: string | null;
  explorer_tx_url: string | null;
  challenges_included: number[];
  challenges_on_evaluator: number;
  files: number;
  note: string;
}

/** The manifest from its JSON text (or object), or null when it is missing or malformed. */
export function parseSnapshotManifest(raw: unknown): SnapshotManifest | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const m = value as Record<string, unknown>;
  if (typeof m.taken_at !== "number" || !Number.isFinite(m.taken_at)) return null;
  if (typeof m.network !== "string" || typeof m.network_label !== "string") return null;
  const included = Array.isArray(m.challenges_included) ? m.challenges_included.filter((x): x is number => typeof x === "number") : [];
  return {
    format: typeof m.format === "string" ? m.format : "",
    taken_at: m.taken_at,
    network: m.network as NetworkKind,
    network_label: m.network_label,
    chain_id: typeof m.chain_id === "number" ? m.chain_id : null,
    contract: typeof m.contract === "string" ? m.contract : null,
    explorer_tx_url: typeof m.explorer_tx_url === "string" ? m.explorer_tx_url : null,
    challenges_included: included,
    challenges_on_evaluator: typeof m.challenges_on_evaluator === "number" ? m.challenges_on_evaluator : included.length,
    files: typeof m.files === "number" ? m.files : 0,
    note: typeof m.note === "string" ? m.note : "",
  };
}

/** The manifest of this build (null outside snapshot mode). */
export const SNAPSHOT_MANIFEST: SnapshotManifest | null = SNAPSHOT_MODE
  ? parseSnapshotManifest(process.env.NEXT_PUBLIC_SNAPSHOT_MANIFEST)
  : null;

/** When the snapshot was taken (unix seconds), or null outside snapshot mode. */
export const SNAPSHOT_TAKEN_AT: UnixSeconds | null = SNAPSHOT_MANIFEST?.taken_at ?? null;

// ---------------------------------------------------------------------------- files
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The static file holding the recorded response of an API path, by the export script's
 * rule: replace every ":" with "_", append ".json" (".pytest.txt" for `?format=pytest`),
 * under /snapshot. Other query parameters (e.g. `download=true`) do not change the file.
 *
 *   snapshotFile("/api/evidence/sha256:ab12") === "/snapshot/api/evidence/sha256_ab12.json"
 */
export function snapshotFile(apiPath: string): string {
  const q = apiPath.indexOf("?");
  const pathname = q >= 0 ? apiPath.slice(0, q) : apiPath;
  const params = new URLSearchParams(q >= 0 ? apiPath.slice(q + 1) : "");
  const mapped = pathname
    .split("/")
    .map((segment) => encodeURIComponent(safeDecode(segment).replace(/:/g, "_")))
    .join("/");
  const suffix = params.get("format") === "pytest" ? ".pytest.txt" : ".json";
  return `/snapshot${mapped.startsWith("/") ? "" : "/"}${mapped}${suffix}`;
}

// ---------------------------------------------------------------------------- wording
/** "1 of 6 challenges included" (counts from the manifest). */
export function includedPhrase(m: SnapshotManifest): string {
  const n = m.challenges_included.length;
  return `${n} of ${m.challenges_on_evaluator} ${plural(m.challenges_on_evaluator, "challenge")} included`;
}

/** The banner on every page, as its lead and the rest (the shell renders the lead in bold). */
export function snapshotBannerParts(m: SnapshotManifest | null): { lead: string; rest: string } {
  const lead = "Recorded snapshot - read-only.";
  if (!m) {
    return {
      lead,
      rest:
        "Nothing on this site runs live: the replays, verdicts, signatures and transactions shown were recorded from the evaluator's run. The snapshot manifest is missing, so when and where it was taken is unknown.",
    };
  }
  return {
    lead,
    rest:
      `Taken ${formatUnix(m.taken_at, { utc: true })} from the CounterProof evaluator on ${m.network_label}. ` +
      "Nothing on this site runs live: the replays, verdicts, signatures and transactions shown were recorded from the evaluator's run. " +
      `${includedPhrase(m)}.`,
  };
}

/** The whole banner sentence. */
export function snapshotBannerText(m: SnapshotManifest | null): string {
  const { lead, rest } = snapshotBannerParts(m);
  return `${lead} ${rest}`;
}

/**
 * A deadline judged at snapshot time instead of counting down: "passed at snapshot time" /
 * "not passed at snapshot time (2 h 05 min 00 s left then)".
 */
export function deadlineAtSnapshot(to: UnixSeconds, takenAt: UnixSeconds | null = SNAPSHOT_TAKEN_AT): string {
  if (takenAt === null) return "recorded deadline; snapshot time unknown";
  const left = to - takenAt;
  return left <= 0 ? "passed at snapshot time" : `not passed at snapshot time (${formatCountdown(left)} left then)`;
}
