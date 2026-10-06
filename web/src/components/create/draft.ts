/**
 * Pure state + rules for the create-challenge wizard (no React).
 *
 * The draft is what the publisher edits. `buildPreviewRequest` turns it into the exact
 * POST /api/specs body; the backend's preview of that body is what the publisher reviews,
 * and the same body is what POST /api/specs stores, so the reviewed digest is the funded one.
 */
import type { AppConfig, JsonObject, JsonSchema, RuleTemplate, SpecRequest, Target } from "@/lib/api";
import { parseMon, toChecksumAddress } from "@/lib/chain";

// ---------------------------------------------------------------------------- limits
/** Contract: MIN_SETTLEMENT_WINDOW = 5 minutes, MAX_SETTLEMENT_WINDOW = 30 days. */
export const MIN_WINDOW_MIN = 5;
export const MAX_WINDOW_MIN = 30 * 24 * 60;
/** Contract: MAX_SUBMISSION_PERIOD = 90 days. */
export const MAX_SUBMISSION_PERIOD_S = 90 * 24 * 60 * 60;
/** The submission deadline must leave time for the funding transaction to be mined. */
export const MIN_LEAD_S = 2 * 60;
export const DEFAULT_SUBMISSION_LEAD_S = 30 * 60;
export const DEFAULT_WINDOW_MIN = 30;
export const DEFAULT_REWARD_MON = "0.01";
/** Backend ChallengeSpec: 1..8 rules; title 3..120 chars; publisher name <= 80 chars. */
export const MAX_RULES = 8;
export const TITLE_MIN = 3;
export const TITLE_MAX = 120;
export const PUBLISHER_NAME_MAX = 80;

/**
 * Stand-in publisher used only to preview rule statements and scope before a publisher
 * exists. A preview that used it is never offered for creation (`final` is false).
 */
export const PLACEHOLDER_PUBLISHER = "0x0000000000000000000000000000000000000000";

/** Privileged tools of the synthetic market (backend market/engine.py PRIVILEGED_TOOLS). */
export const PRIVILEGED_TOOLS = ["update_mandate", "add_payee"] as const;
/** Merchants approved in the synthetic world's mandate (used until the preview arrives). */
export const DEFAULT_ALLOWED_MERCHANTS = ["m_acme", "m_bolt", "m_crate"];

/** Defaults for the known rule templates' parameters. */
export const PARAM_DEFAULTS: Record<string, Record<string, ParamValue>> = {
  "spend.cumulative_cap": { budget: 25000 },
  "payee.allowlist": { merchants: DEFAULT_ALLOWED_MERCHANTS },
  "agent.no_privileged_calls": { tools: [...PRIVILEGED_TOOLS] },
};

// ---------------------------------------------------------------------------- draft
export type ParamValue = number | null | string | string[];

export interface RuleDraft {
  enabled: boolean;
  /** Payout eligibility (reward.eligible_rules). */
  eligible: boolean;
  params: Record<string, ParamValue>;
}

export interface Draft {
  targetKey: string | null;
  /** Per template id; missing entries fall back to `defaultRuleDraft`. */
  rules: Record<string, RuleDraft>;
  /** Null until the publisher edits it; then the typed text. */
  title: string | null;
  publisherName: string;
  /** Off-chain only: publisher address typed by hand when no wallet is connected. */
  manualPublisher: string;
  rewardMon: string;
  /** Unix seconds; set when a target is first chosen (an event, never during render). */
  submissionDeadline: number | null;
  windowMinutes: number | null;
  /** The publisher's choice; may be overridden when the backend has no chain. */
  offchainChoice: boolean;
  /** Step 3: the publisher approved scope, limits and evaluator exactly as shown. */
  scopeApproved: boolean;
}

export const initialDraft: Draft = {
  targetKey: null,
  rules: {},
  title: null,
  publisherName: "",
  manualPublisher: "",
  rewardMon: DEFAULT_REWARD_MON,
  submissionDeadline: null,
  windowMinutes: DEFAULT_WINDOW_MIN,
  offchainChoice: false,
  scopeApproved: false,
};

export function defaultRuleDraft(template: RuleTemplate): RuleDraft {
  const params: Record<string, ParamValue> = {};
  for (const [name, schema] of Object.entries(template.params_schema.properties ?? {})) {
    const known = PARAM_DEFAULTS[template.id]?.[name];
    if (known !== undefined) params[name] = Array.isArray(known) ? [...known] : known;
    else params[name] = paramKind(schema) === "string-list" ? [] : paramKind(schema) === "string" ? "" : null;
  }
  return { enabled: true, eligible: true, params };
}

export function ruleDraft(draft: Draft, template: RuleTemplate): RuleDraft {
  return draft.rules[template.id] ?? defaultRuleDraft(template);
}

export function selectedTemplates(draft: Draft, templates: RuleTemplate[]): RuleTemplate[] {
  return templates.filter((t) => ruleDraft(draft, t).enabled);
}

/** The id the backend will give each selected rule: R1..Rn in selection order. */
export function ruleIdFor(draft: Draft, templates: RuleTemplate[], templateId: string): string | null {
  const i = selectedTemplates(draft, templates).findIndex((t) => t.id === templateId);
  return i < 0 ? null : `R${i + 1}`;
}

export function defaultTitle(target: Target | undefined): string {
  return target ? `${target.title} keeps its promises` : "";
}

export function effectiveTitle(draft: Draft, target: Target | undefined): string {
  return draft.title ?? defaultTitle(target);
}

// ---------------------------------------------------------------------------- params
export type ParamKind = "integer" | "number" | "string" | "string-list" | "unsupported";

export function paramKind(schema: JsonSchema): ParamKind {
  if (schema.type === "integer") return "integer";
  if (schema.type === "number") return "number";
  if (schema.type === "string") return "string";
  if (schema.type === "array" && schema.items?.type === "string") return "string-list";
  return "unsupported";
}

/** Same checks the backend's pydantic model makes, so the preview is not sent invalid. */
export function validateParam(name: string, schema: JsonSchema, value: ParamValue, required: boolean): string | null {
  const title = typeof schema.title === "string" ? schema.title : name;
  switch (paramKind(schema)) {
    case "integer":
    case "number": {
      if (value === null || value === "" || value === undefined) return required ? `${title} is required.` : null;
      if (typeof value !== "number" || !Number.isFinite(value)) return `${title} must be a number.`;
      if (paramKind(schema) === "integer" && !Number.isInteger(value)) return `${title} must be a whole number.`;
      if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum)
        return `${title} must be greater than ${schema.exclusiveMinimum}.`;
      if (typeof schema.minimum === "number" && value < schema.minimum) return `${title} must be at least ${schema.minimum}.`;
      if (typeof schema.maximum === "number" && value > schema.maximum) return `${title} must be at most ${schema.maximum}.`;
      return null;
    }
    case "string-list": {
      const list = Array.isArray(value) ? value : [];
      if (list.some((v) => v.trim() === "")) return `${title} cannot contain empty entries.`;
      if (typeof schema.minItems === "number" && list.length < schema.minItems)
        return schema.minItems === 1 ? `Choose at least one ${title.toLowerCase().replace(/s$/, "")}.` : `Choose at least ${schema.minItems}.`;
      if (typeof schema.maxItems === "number" && list.length > schema.maxItems) return `Choose at most ${schema.maxItems}.`;
      return null;
    }
    case "string": {
      const s = typeof value === "string" ? value.trim() : "";
      if (!s && required) return `${title} is required.`;
      return null;
    }
    default:
      return `${title}: this parameter type cannot be edited here.`;
  }
}

export function paramErrors(template: RuleTemplate, rule: RuleDraft): Record<string, string> {
  const out: Record<string, string> = {};
  const required = new Set(template.params_schema.required ?? []);
  for (const [name, schema] of Object.entries(template.params_schema.properties ?? {})) {
    const err = validateParam(name, schema, rule.params[name] ?? null, required.has(name));
    if (err) out[name] = err;
  }
  return out;
}

function ruleParams(template: RuleTemplate, rule: RuleDraft): JsonObject {
  const out: JsonObject = {};
  for (const [name, schema] of Object.entries(template.params_schema.properties ?? {})) {
    const v = rule.params[name];
    const kind = paramKind(schema);
    if (kind === "string-list") out[name] = Array.isArray(v) ? v.map((s) => s.trim()) : [];
    else if ((kind === "integer" || kind === "number") && typeof v === "number") out[name] = v;
    else if (kind === "string" && typeof v === "string" && v.trim()) out[name] = v.trim();
  }
  return out;
}

// ---------------------------------------------------------------------------- network / publisher
export interface NetworkPlan {
  /** True when the challenge will be evidence only (no reward, no settlement). */
  offchain: boolean;
  /** True when the backend cannot do on-chain at all (offchain network or no contract). */
  forced: boolean;
  reason: string | null;
}

export function networkPlan(config: AppConfig | undefined, draft: Draft): NetworkPlan {
  if (!config) return { offchain: true, forced: true, reason: "Backend configuration has not loaded." };
  if (config.network === "offchain")
    return { offchain: true, forced: true, reason: "This backend runs off-chain only (no chain configured)." };
  if (!config.chain.contract)
    return { offchain: true, forced: true, reason: "No CounterProof contract is configured on this backend." };
  return { offchain: draft.offchainChoice, forced: false, reason: null };
}

export interface PublisherPlan {
  /** Real publisher address, or null when none is known yet. */
  address: string | null;
  source: "wallet" | "manual" | null;
  error: string | null;
}

export function publisherPlan(draft: Draft, offchain: boolean, connectedAddress: string | undefined): PublisherPlan {
  if (connectedAddress) return { address: connectedAddress, source: "wallet", error: null };
  if (!offchain) return { address: null, source: null, error: "Connect the wallet that will fund the reward; it becomes the publisher." };
  const typed = draft.manualPublisher.trim();
  if (!typed) return { address: null, source: null, error: "Enter your address or connect a wallet; it is recorded as the publisher." };
  const checksummed = toChecksumAddress(typed);
  if (!checksummed) return { address: null, source: null, error: "Not a valid EVM address (0x followed by 40 hex characters)." };
  return { address: checksummed, source: "manual", error: null };
}

// ---------------------------------------------------------------------------- terms
export interface TermsErrors {
  title?: string;
  publisherName?: string;
  reward?: string;
  submissionDeadline?: string;
  window?: string;
  eligible?: string;
  publisher?: string;
}

export function rewardWei(draft: Draft): bigint | null {
  return parseMon(draft.rewardMon);
}

export function settlementDeadline(draft: Draft): number | null {
  if (draft.submissionDeadline === null || draft.windowMinutes === null) return null;
  return draft.submissionDeadline + draft.windowMinutes * 60;
}

export function termsErrors(
  draft: Draft,
  ctx: { target: Target | undefined; templates: RuleTemplate[]; offchain: boolean; publisher: PublisherPlan; nowSec: number | null },
): TermsErrors {
  const e: TermsErrors = {};
  const title = effectiveTitle(draft, ctx.target).trim();
  if (title.length < TITLE_MIN) e.title = `Title needs at least ${TITLE_MIN} characters.`;
  else if (title.length > TITLE_MAX) e.title = `Title can have at most ${TITLE_MAX} characters.`;
  if (draft.publisherName.trim().length > PUBLISHER_NAME_MAX) e.publisherName = `At most ${PUBLISHER_NAME_MAX} characters.`;

  if (!ctx.offchain) {
    const wei = rewardWei(draft);
    if (draft.rewardMon.trim() === "") e.reward = "Enter a reward amount.";
    else if (wei === null) e.reward = "Enter a positive amount with at most 18 decimals, e.g. 0.01.";
    else if (wei <= BigInt(0)) e.reward = "The contract refuses a zero reward (ZeroReward). Use the off-chain mode for evidence only.";
  }

  const sub = draft.submissionDeadline;
  if (sub === null) e.submissionDeadline = "Choose a submission deadline.";
  else if (ctx.nowSec !== null && sub < ctx.nowSec + MIN_LEAD_S)
    e.submissionDeadline =
      sub <= ctx.nowSec
        ? "This time has passed. Choose a later submission deadline."
        : "Leave at least 2 minutes so the funding transaction can be mined before the deadline.";
  else if (!ctx.offchain && ctx.nowSec !== null && sub - ctx.nowSec > MAX_SUBMISSION_PERIOD_S)
    e.submissionDeadline = "The contract allows a submission period of at most 90 days (SubmissionPeriodTooLong).";

  const w = draft.windowMinutes;
  if (w === null) e.window = `Enter a window between ${MIN_WINDOW_MIN} minutes and 30 days.`;
  else if (w < MIN_WINDOW_MIN) e.window = "The contract requires at least 5 minutes (SettlementWindowTooShort).";
  else if (w > MAX_WINDOW_MIN) e.window = "The contract allows at most 30 days (SettlementWindowTooLong).";

  const selected = selectedTemplates(draft, ctx.templates);
  if (selected.length && !selected.some((t) => ruleDraft(draft, t).eligible))
    e.eligible = "At least one rule must be eligible for the reward.";

  if (ctx.publisher.error) e.publisher = ctx.publisher.error;
  return e;
}

export function hasErrors(e: object): boolean {
  return Object.values(e).some(Boolean);
}

// ---------------------------------------------------------------------------- request
export interface PreviewRequest {
  body: SpecRequest;
  /**
   * True when every value is the publisher's real choice. When false the body used a
   * stand-in (placeholder publisher or a fallback for an invalid term) so that rule
   * statements and scope can still be previewed; such a preview can never be created.
   */
  final: boolean;
}

/**
 * The exact body for POST /api/specs/preview and /api/specs, or null when the rules or
 * target are not yet valid enough to preview at all.
 */
export function buildPreviewRequest(
  draft: Draft,
  ctx: {
    target: Target | undefined;
    templates: RuleTemplate[];
    offchain: boolean;
    publisher: PublisherPlan;
    termsValid: boolean;
  },
): PreviewRequest | null {
  if (!ctx.target || draft.submissionDeadline === null) return null;
  const selected = selectedTemplates(draft, ctx.templates);
  if (selected.length === 0 || selected.length > MAX_RULES) return null;
  for (const t of selected) if (hasErrors(paramErrors(t, ruleDraft(draft, t)))) return null;

  let final = ctx.termsValid && ctx.publisher.address !== null;

  let title = effectiveTitle(draft, ctx.target).trim();
  if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    title = defaultTitle(ctx.target);
    final = false;
  }
  const window = draft.windowMinutes !== null && draft.windowMinutes >= MIN_WINDOW_MIN && draft.windowMinutes <= MAX_WINDOW_MIN
    ? draft.windowMinutes
    : DEFAULT_WINDOW_MIN;
  if (window !== draft.windowMinutes) final = false;

  let wei = "0";
  if (!ctx.offchain) {
    const parsed = rewardWei(draft);
    if (parsed !== null && parsed > BigInt(0)) wei = parsed.toString();
    else final = false;
  }

  const rules = selected.map((t) => ({ template: t.id, params: ruleParams(t, ruleDraft(draft, t)) }));
  const eligible = selected.map((t, i) => (ruleDraft(draft, t).eligible ? `R${i + 1}` : null)).filter((x): x is string => x !== null);

  const body: SpecRequest = {
    title,
    target: ctx.target.key,
    rules,
    publisher: (ctx.publisher.address ?? PLACEHOLDER_PUBLISHER).toLowerCase(),
    publisher_name: draft.publisherName.trim().slice(0, PUBLISHER_NAME_MAX),
    reward_wei: wei,
    submission_deadline: draft.submissionDeadline,
    settlement_deadline: draft.submissionDeadline + window * 60,
    eligible_rules: eligible.length ? eligible : rules.map((_, i) => `R${i + 1}`),
    offchain: ctx.offchain,
  };
  if (!eligible.length) final = false;
  return { body, final };
}

// ---------------------------------------------------------------------------- time helpers
/** Current unix time in seconds. Call from event handlers only, never during render. */
export function nowSeconds(): number {
  return Date.now() / 1000;
}

/** Rounds unix seconds up to the next whole minute. */
export function ceilToMinute(sec: number): number {
  return Math.ceil(sec / 60) * 60;
}

/** Unix seconds -> value for <input type="datetime-local"> in the viewer's time zone. */
export function toLocalInputValue(sec: number | null): string {
  if (sec === null) return "";
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** <input type="datetime-local"> value (local time) -> unix seconds, or null. */
export function fromLocalInputValue(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** "30 min", "2 h", "1 d 6 h" for a window in minutes. */
export function formatWindow(minutes: number | null): string {
  if (minutes === null) return "n/a";
  if (minutes < 60) return `${minutes} min`;
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return [d ? `${d} d` : "", h ? `${h} h` : "", m ? `${m} min` : ""].filter(Boolean).join(" ");
}
