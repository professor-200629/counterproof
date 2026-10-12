/**
 * Display words for target labels. The stored values (spec.target.label, target_info.label)
 * never change; only what the console shows does. Every agent adapter in this repository was
 * written by the CounterProof team: a "live-model" agent's decisions come from a third-party
 * hosted model, but the agent itself is not independently developed, so the console never
 * calls it "independent".
 */
import type { TargetLabel } from "./api";

export const TARGET_LABEL_TEXT: Record<TargetLabel, string> = {
  "intentionally-vulnerable-fixture": "Intentionally vulnerable fixture - planted defects",
  "repaired-fixture": "Repaired fixture",
  "independent-implementation": "Live-model agent (team-written, no planted defects)",
  "repaired-live-model": "Repaired live-model agent (team-written)",
};

/** Tooltips: where each kind of target comes from and how to read a result against it. */
export const TARGET_LABEL_TITLE: Record<TargetLabel, string> = {
  "intentionally-vulnerable-fixture":
    "Written with planted defects so the full loop can be demonstrated. Findings against it are demonstrations, not discoveries.",
  "repaired-fixture": "The fixture with its planted defects repaired by the CounterProof team.",
  "independent-implementation":
    "Agent code written by the CounterProof team with no planted defects; its decisions come from a third-party hosted language model. Results are statistical and depend on provider, model and date.",
  "repaired-live-model":
    "A later version of a team-written live-model agent, changed by the CounterProof team after a finding. Its decisions still come from a hosted language model, so results are statistical.",
};

/** Wording for a label value this console does not know (shown as the raw value). */
function isKnown(label: string): label is TargetLabel {
  return Object.prototype.hasOwnProperty.call(TARGET_LABEL_TEXT, label);
}

/**
 * The display text of a target label. `requiresModel === false` on an
 * "independent-implementation" target means no model drives it, so "live-model" would be
 * wrong: it then reads as a team-written agent without planted defects.
 */
export function targetLabelText(label: TargetLabel | string | null | undefined, requiresModel?: boolean): string {
  if (!label) return "Unknown provenance";
  if (label === "independent-implementation" && requiresModel === false) return "Team-written agent (no planted defects, no model)";
  return isKnown(label) ? TARGET_LABEL_TEXT[label] : label;
}

export function targetLabelTitle(label: TargetLabel | string | null | undefined): string | undefined {
  return label && isKnown(label) ? TARGET_LABEL_TITLE[label] : undefined;
}

/** Targets whose decisions come from a hosted language model (by label). */
export function isLiveModelLabel(label: string | null | undefined): boolean {
  return label === "independent-implementation" || label === "repaired-live-model";
}

/** A target written with planted defects on purpose. */
export function isPlantedFixtureLabel(label: string | null | undefined): boolean {
  return label === "intentionally-vulnerable-fixture";
}

/** A repaired version of something (fixture or live-model agent). */
export function isRepairedLabel(label: string | null | undefined): boolean {
  return label === "repaired-fixture" || label === "repaired-live-model";
}

/** The adapter (agent family) of a target key `adapter@version`. */
export function adapterOfKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : key;
}

/** The version part of a target key `adapter@version`. */
export function versionOfKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(at + 1) : null;
}

/** Compare dotted versions numerically where possible ("1.10.0" > "1.9.2"); text otherwise. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
