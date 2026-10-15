# C — Claude Skills & Agent Architecture

## 1. How skills fit (verified against current docs, Oct 2026)

- An **Agent Skill** is a folder with `SKILL.md` (YAML frontmatter `name` ≤ 64 chars, lowercase/digits/hyphens, may not contain "claude" or "anthropic"; `description` ≤ 1024 chars) plus optional reference files and scripts. Claude loads the name/description always, the body when triggered, and other files only when read (progressive disclosure).
- Skills work in **three places**, and they do not sync between them:
  1. **Claude Code** — `.claude/skills/` in this repo; used by engineers and by operators running ad-hoc work.
  2. **Claude API** — uploaded via `POST /v1/skills`; executed in the code-execution container (no network access in the sandbox).
  3. **Agent SDK** — loaded from the filesystem.
- In **production**, JAT Marketing OS calls the Messages API directly with structured outputs. The skill folders are the **single source of truth for agent instructions**: the worker loads `SKILL.md` + reference files into the system prompt at build time. This keeps instructions reviewable in Git, testable with fixtures, and identical between Claude Code and production.

## 2. Agent → skill mapping

The 12 agents in the brief become **12 roles** backed by **8 skills** in the MVP/P1. Agents that don't need an LLM are plain code.

| # | Agent (role) | Implementation | Skill | Phase |
|---|---|---|---|---|
| 1 | Brand Intelligence | LLM, structured output | `brand-dna-extraction` | MVP |
| 2 | Business Research | LLM + web_search/web_fetch (domain-limited) + crawler code | `business-audit` | P1 |
| 3 | Competitor Intelligence | LLM + crawler code | `competitor-analysis` | P1 |
| 4 | Marketing Strategy | LLM, structured output | `campaign-planning` | MVP |
| 5 | Social Content | LLM, structured output | `social-post-drafting` | MVP |
| 6 | Creative Direction | LLM brief → **code** template renderer | `creative-brief` (inside social-post-drafting for MVP) | MVP |
| 7 | SEO/AEO/GEO | **Code** crawler + LLM interpretation | `seo-page-audit` | MVP |
| 8 | WordPress Publishing | **Code only** (adapter + plugin) | — | MVP |
| 9 | Social Publishing | **Code only** (adapters) | — | MVP |
| 10 | Analytics & Attribution | **Code** ingestion + LLM narrative | `performance-report` | P1 |
| 11 | Optimization | Code statistics + LLM recommendations | `performance-report` | P1 |
| 12 | Compliance & QA | **Code** linter (deterministic) + LLM reviewer | `compliance-review` | MVP |

**Publishing agents are deliberately not LLM agents.** No model ever holds a token or decides to publish.

## 3. Per-agent contract

Every agent definition in `packages/ai/src/agents/*.ts` declares:

| Field | Example (Social Content) |
|---|---|
| Responsibility | Draft one platform-specific post for one calendar slot |
| Inputs | `PostBrief` (slot, channel, pillar, objective, persona id), active `BrandDna`, `Claim[]`, recent post fingerprints |
| Output schema | `PostDraft` (zod, `packages/core/src/content/post.ts`) |
| Model | `claude-sonnet-5-5` (drafts); `claude-haiku-5-5` for variants/shortening |
| Tools | none (MVP). Research facts come from the claim registry only |
| Quality standards | passes linter with 0 blockers; uses only registered claims; platform length limits |
| Error handling | schema-invalid output → 1 repair retry with validation errors; then fail job `needs_attention` |
| Logging | `agent_runs` row with tokens, cost, input hash, output, findings |
| Approval boundary | Output is always a *draft*; it enters the approval policy engine |
| Budget | per-run max tokens; per-tenant daily $ cap enforced before call |

## 4. Repository layout for skills

```
skills/
  brand-dna-extraction/
    SKILL.md
    reference/brand-dna-schema.md      # field-by-field definitions + provenance rules
  campaign-planning/
    SKILL.md                           # cadences come from the channel capability registry
  social-post-drafting/
    SKILL.md
    reference/platform-specs.md        # length limits, formats, link behaviour
  compliance-review/
    SKILL.md
    reference/ftc-disclosures.md       # endorsement & material-connection rules
  seo-page-audit/
    SKILL.md
    reference/search-guidance-2026.md  # verified vs. hypothesis, with sources
.claude/skills -> ../skills            # symlink so Claude Code discovers them
```

## 5. Quality loop for skills
- `packages/ai/test/fixtures/<skill>/` holds golden inputs. CI runs **schema tests** (no API) on every PR and a **nightly eval** (with API, low budget) scoring outputs on: schema validity, linter blockers, claim grounding, brand-voice rubric (LLM-as-judge with Haiku), length compliance.
- Any change to a `SKILL.md` must not reduce the eval score by more than 2 points on any metric.
