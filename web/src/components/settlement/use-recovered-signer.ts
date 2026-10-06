"use client";

import { useQuery } from "@tanstack/react-query";
import type { SettlementAttestation } from "@/lib/api";
import { sameHex } from "@/lib/format";
import { recoverAttestationSigner } from "./recover";

type SignedParts = Pick<SettlementAttestation, "typed_data" | "signature">;

/**
 * Re-derive the signer from the EIP-712 typed data and signature in this browser. This is
 * a check of the signature's arithmetic, not of the replay it attests to. Disabled when
 * there is no attestation.
 */
export function useRecoveredSigner(att: SignedParts | null | undefined) {
  return useQuery({
    queryKey: ["attestation-recovered-signer", att?.signature ?? null, att?.typed_data.message.expiry ?? null, att?.typed_data.domain.chainId ?? null],
    queryFn: () => recoverAttestationSigner(att as SignedParts),
    enabled: !!att,
    staleTime: Infinity,
    retry: false,
  });
}

/** What binds an evidence bundle to the evaluator's key, as checked on this page. */
export type SignatureBinding =
  /** No attestation exists: nothing cryptographic ties the bundle to the evaluator. */
  | { state: "unsigned" }
  | { state: "checking" }
  | { state: "unrecoverable"; message: string }
  /** `matches`: the recovered address is the expected (declared) evaluator. */
  | { state: "recovered"; address: string; matches: boolean };

/** Recover the attestation's signer and compare it with the declared evaluator address. */
export function useSignatureBinding(att: SignedParts | null | undefined, expected: string | null | undefined): SignatureBinding {
  const recovered = useRecoveredSigner(att);
  if (!att) return { state: "unsigned" };
  if (recovered.isPending) return { state: "checking" };
  if (recovered.isError) {
    return {
      state: "unrecoverable",
      message: recovered.error instanceof Error ? recovered.error.message.split("\n")[0] : "unknown error",
    };
  }
  return { state: "recovered", address: recovered.data, matches: sameHex(recovered.data, expected) === true };
}
