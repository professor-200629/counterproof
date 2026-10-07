import { readFileSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

/** FastAPI backend; the browser only ever calls same-origin /api/*. */
const BACKEND_URL = (process.env.BACKEND_URL ?? "http://127.0.0.1:8010").replace(/\/+$/, "");

/**
 * Read-only recorded snapshot (NEXT_PUBLIC_SNAPSHOT=1, e.g. the hosted Vercel build): no
 * backend, no /api proxy. The console reads public/snapshot/ (written by
 * scripts/export_snapshot.py) and its manifest is inlined so every page can say when and
 * where the recording was made. See FRONTEND_NOTES.md "Snapshot mode".
 */
const SNAPSHOT = process.env.NEXT_PUBLIC_SNAPSHOT === "1";

/** public/snapshot/manifest.json as JSON text; a snapshot build without one fails here. */
function snapshotManifest(): string {
  const file = path.join(process.cwd(), "public", "snapshot", "manifest.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(
      `NEXT_PUBLIC_SNAPSHOT=1 but ${file} does not exist. Run scripts/export_snapshot.py against the evaluator first.`,
    );
  }
  const manifest = JSON.parse(text) as { taken_at?: unknown; network?: unknown; network_label?: unknown };
  if (typeof manifest.taken_at !== "number" || typeof manifest.network !== "string" || typeof manifest.network_label !== "string") {
    throw new Error(`${file} is not a CounterProof snapshot manifest (needs taken_at, network, network_label).`);
  }
  return JSON.stringify(manifest);
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  ...(SNAPSHOT
    ? { env: { NEXT_PUBLIC_SNAPSHOT_MANIFEST: snapshotManifest() } }
    : {
        async rewrites() {
          return [
            {
              source: "/api/:path*",
              destination: `${BACKEND_URL}/api/:path*`,
            },
          ];
        },
      }),
};

export default nextConfig;
