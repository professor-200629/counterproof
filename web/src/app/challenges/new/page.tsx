import type { Metadata } from "next";
import { CreateChallenge } from "@/components/create/create-challenge";

export const metadata: Metadata = { title: "Create challenge" };

export default function NewChallengePage() {
  return <CreateChallenge />;
}
