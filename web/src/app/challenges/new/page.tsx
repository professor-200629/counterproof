import type { Metadata } from "next";
import { CreateChallenge } from "@/components/create/create-challenge";
import { SnapshotCreateExplainer } from "@/components/create/snapshot-create";
import { SNAPSHOT_MODE } from "@/lib/snapshot";

export const metadata: Metadata = { title: "Create challenge" };

/** The create wizard; in the read-only snapshot, an explanation of its steps instead. */
export default function NewChallengePage() {
  return SNAPSHOT_MODE ? <SnapshotCreateExplainer /> : <CreateChallenge />;
}
