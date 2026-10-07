import { History } from "lucide-react";
import { SourceLink } from "@/components/snapshot";
import { SNAPSHOT_MANIFEST, snapshotBannerParts, type SnapshotManifest } from "@/lib/snapshot";

/**
 * The standing notice of the hosted read-only build, on every page and without a close
 * button: when and from which network the recording was made, that nothing runs live, how
 * many challenges it holds, and where to run the evaluator for real.
 */
export function SnapshotBanner({ manifest = SNAPSHOT_MANIFEST }: { manifest?: SnapshotManifest | null }) {
  const { lead, rest } = snapshotBannerParts(manifest);
  return (
    <section
      aria-label="Recorded snapshot notice"
      className="border-b border-warn-line bg-warn-soft px-4 py-2.5 text-sm text-fg sm:px-6 lg:px-8"
    >
      <p className="mx-auto flex max-w-7xl items-start gap-2.5">
        <History aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warn" />
        <span className="min-w-0">
          <strong className="font-semibold text-warn">{lead}</strong> {rest}{" "}
          <SourceLink className="font-medium">How to run it yourself</SourceLink>
        </span>
      </p>
    </section>
  );
}
