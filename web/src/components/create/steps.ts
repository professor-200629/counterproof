/** The five steps of the create-challenge wizard (also explained read-only in snapshot mode). */
export const STEPS = [
  { id: "target", label: "Target", description: "Agent and version" },
  { id: "rules", label: "Rules", description: "Explicit, checkable promises" },
  { id: "scope", label: "Scope & evaluator", description: "Fixed terms, read-only" },
  { id: "terms", label: "Reward & deadlines", description: "Title, mode, money, time" },
  { id: "review", label: "Review & publish", description: "Exact spec and digest" },
] as const;

export const STEP_INTRO: Record<(typeof STEPS)[number]["id"], string> = {
  target: "Choose the agent version the promises are about. Its provenance travels with every result.",
  rules: "Choose which promises challengers may try to break, and set their parameters.",
  scope: "What challengers may do, the limits of each replay, and who checks it. Read-only.",
  terms: "Name the challenge, choose on-chain or off-chain, the reward and the deadlines.",
  review: "Check the exact spec that will be published, then store it and, on chain, fund it.",
};
