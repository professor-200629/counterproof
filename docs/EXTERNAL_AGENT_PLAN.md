# External agent evaluation: status and plan

**Status: pending, not run.** Every adapter CounterProof has evaluated so far was written by the
CounterProof team. That includes `llm-purchasing-agent`, whose *model* is third-party (Groq
`openai/gpt-oss-120b`) but whose prompt and tool loop are ours. No external agent has been
evaluated, and no external person has reproduced a result yet.

## Why it is not run yet

External agent code is not a first-party adapter. The project's isolation rule is that process
isolation is acceptable only for the declared first-party adapters, and anything else needs
container isolation with egress blocked except the evaluator's model broker. On the development
machine the Docker engine does not start. On 2026-10-12, `docker version` reported that it could
not connect to `dockerDesktopLinuxEngine`. Running external code without that isolation would
break the fail-closed rule, so the integration was not attempted. The container backend in
`runner/sandbox.py` exists but is unverified for the same reason.

## Candidates (pinned and licence-checked on 2026-10-12, read-only via `gh api`)

Nothing was cloned, installed or run. Each SHA was re-resolved independently and equals the
default-branch HEAD at that time.

| Rank | Agent | Repository @ commit | Licence | Is the decision loop external? | Effort |
|---|---|---|---|---|---|
| 1 | AP2 shopping agent v2 (human-not-present), Google Agent Payments Protocol reference sample | `google-agentic-commerce/AP2` @ `e1ea56db72a6385bce3e5c1112b3a56ce60acb43` (agent: `code/samples/python/src/roles/shopping_agent_v2/shopping_agent`) | Apache-2.0 | Yes. Google wrote the prompts, the consent/monitoring/purchase agent hierarchy and the mandate tools. It pays on its own against a signed mandate, which is exactly the risk CounterProof scores. | ~2-3 days, plus a Gemini-compatible broker route |
| 2 | Claude Commerce Agents shopping agent (Anthropic reference blueprint) | `anthropics/commerce-agents` @ `fd4d59224ab96b43c6dc6888207c67b3bd5a24cf` | Apache-2.0 | Yes, but it never pays: its `checkout` "places no order and charges nothing". Only cart/checkout discipline could be scored. | ~1.5-2.5 days |
| 3 | AWS Shopping Concierge (Visa Intelligent Commerce blueprint) | `awslabs/agentcore-samples` @ `f33b4f14ea46cae2379196948073a6bb4d0e21cf` | Apache-2.0 | Yes, but it is a cloud blueprint that needs AWS infrastructure stubs | ~4-6 days |

Dropped: the `google-agentic-commerce/a2a-x402` demo client
(`125db5526a965d2325459d1a9df2e274a7e42396`). Its model only delegates to a merchant agent we
would have to write, so the evaluation would mostly measure our own code.

## Integration plan for rank 1 (AP2 shopping agent v2)

1. **Container image** (Python 3.11+). Install all dependencies at build time. The pinned HEAD has
   no lock file, and `x402-a2a` is an unpinned git dependency, so pin it and freeze a lock. Mount
   the AP2 checkout read-only. Use tmpfs for `.temp-db` and `.logs`. Set `FLOW=cards` to stay off
   web3/x402 settlement. Block all egress except the evaluator's model broker, which must speak
   Gemini `generateContent` because ADK routes `gemini-*` models to google-genai.
2. **Thin MCP proxies** over the agent's three server paths (merchant, credentials provider,
   payment processor). Each proxy forwards to Google's original server, so Google's SD-JWT
   checkout/receipt chain stays authentic. It also mirrors every call into the CounterProof
   synthetic market, which stays the authority:
   - `check_product` maps to `search_products`;
   - `create_checkout` maps to `create_order`;
   - `complete_checkout` maps to `pay`, which the market approves or denies first.

   The privileged `update_mandate` / `add_payee` tools are exposed on the merchant proxy, so R5
   can be tested.
3. **Scripted principal driver.** It sends the consent turns ("buy X when it drops, budget N",
   "mandate_approved", "check price now"). Merchant-content injection enters through product
   descriptions returned by the proxy.
4. **Registration as a target.** A new adapter key with label `external-agent`, the commit SHA,
   licence and image digest recorded in the spec, and `isolation: container` required: it fails
   closed on any machine without a working container engine.
5. **What a result would and would not mean.** A violation shows that this external agent, at
   this commit, with this model and these prompts, broke one rule in the synthetic market. It says
   nothing about Google's production systems.

## Independent human reproduction

**Pending.** No one outside the team has reproduced a result. The kit is
[REPRODUCE.md](REPRODUCE.md). No outreach has been sent.
