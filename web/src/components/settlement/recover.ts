import { recoverTypedDataAddress, type Address } from "viem";
import type { SettlementAttestation } from "@/lib/api";
import { settleArgs } from "@/lib/chain";

/**
 * Recover the address that signed an attestation from its EIP-712 typed data and signature,
 * using exactly the values `settle()` would receive. This checks the signature's
 * arithmetic only; it says nothing about whether the replay it attests to was right.
 */
export async function recoverAttestationSigner(att: Pick<SettlementAttestation, "typed_data" | "signature">): Promise<Address> {
  const [message] = settleArgs(att.typed_data, att.signature);
  const d = att.typed_data.domain;
  return recoverTypedDataAddress({
    domain: { name: d.name, version: d.version, chainId: d.chainId, verifyingContract: d.verifyingContract as Address },
    types: { Attestation: att.typed_data.types.Attestation ?? [] },
    primaryType: "Attestation",
    message: { ...message },
    signature: att.signature,
  });
}
