import { createHash } from "node:crypto";
import type { z } from "zod/v4";
import { firstText, type ClaudeClient, type MessageParam, type MessageRequest, type TextBlockParam } from "./client.ts";
import { assertWithinBudget, BudgetExceededError, type SpendLedger } from "./budget.ts";
import { costMicros, estimateTokens, projectedCostMicros } from "./pricing.ts";
import { toWireSchema } from "./wire-schema.ts";

export interface StructuredCallInput<T> {
  agent: string;
  tenantId: string;
  budgetCents: number;
  model: string;
  maxTokens: number;
  /** Stable instructions (skill text). Cached across calls. */
  instructions: string;
  /** Tenant context that is stable across many calls (e.g. Brand DNA). Cached. */
  stableContext?: string;
  /** Per-call user content. */
  userContent: string;
  /** Zod schema for validation (full constraints). */
  schema: z.ZodType<T>;
  /** Optional separate wire schema (flatter shape sent to the API), parsed into T by `fromWire`. */
  wire?: { schema: z.ZodType; fromWire: (wire: unknown) => T };
  /** Max repair attempts when the output fails validation. Default 1. */
  repairAttempts?: number;
}

export interface StructuredCallResult<T> {
  output: T;
  attempts: number;
  costMicros: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export class AgentOutputError extends Error {
  override name = "AgentOutputError";
  constructor(
    message: string,
    readonly kind: "refusal" | "max_tokens" | "no_text" | "invalid_json" | "schema_invalid",
    readonly detail?: string,
  ) {
    super(message);
  }
}

export interface StructuredDeps {
  client: ClaudeClient;
  ledger: SpendLedger;
  now?: () => Date;
}

const hashInput = (parts: string[]): string => createHash("sha256").update(parts.join("\u0000")).digest("hex");

/**
 * Run one agent call that must return JSON matching a schema.
 *
 * - Budget is checked before every API call (including repairs).
 * - Instructions and stable tenant context go in cached system blocks.
 * - Output is parsed and validated with zod; on failure, one repair turn is attempted
 *   with the validation errors. Every call is written to the ledger.
 */
export async function runStructured<T>(deps: StructuredDeps, input: StructuredCallInput<T>): Promise<StructuredCallResult<T>> {
  const now = deps.now ?? (() => new Date());
  const wireZod = input.wire?.schema ?? input.schema;
  const { schema: wireJson } = toWireSchema(wireZod);
  const system: TextBlockParam[] = [{ type: "text", text: input.instructions, cache_control: { type: "ephemeral" } }];
  if (input.stableContext) system.push({ type: "text", text: input.stableContext, cache_control: { type: "ephemeral" } });
  // The (possibly large) user content is cached too, so a repair turn re-reads it cheaply.
  const messages: MessageParam[] = [{ role: "user", content: [{ type: "text", text: input.userContent, cache_control: { type: "ephemeral" } }] }];
  const inputHash = hashInput([input.agent, input.model, input.instructions, input.stableContext ?? "", input.userContent]);
  const maxAttempts = 1 + (input.repairAttempts ?? 1);

  const totals = { cost: 0, in: 0, out: 0, cached: 0 };
  let lastError: AgentOutputError | undefined;

  const base = { tenantId: input.tenantId, agent: input.agent, model: input.model, inputHash };

  type Attempt = { kind: "ok"; output: T } | { kind: "repair"; text: string; problem: string };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const req: MessageRequest = {
      model: input.model,
      max_tokens: input.maxTokens,
      system,
      messages,
      output_config: { format: { type: "json_schema", schema: wireJson } },
    };

    // Budget check, API call and ledger write happen under one per-tenant lock, so a
    // concurrent job always sees this call's cost before it checks the budget.
    const result: Attempt = await deps.ledger.withTenantLock(input.tenantId, async () => {
      const promptChars = input.instructions + (input.stableContext ?? "") + messages.map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text).join(""))).join("");
      const projected = projectedCostMicros(input.model, estimateTokens(promptChars), input.maxTokens);
      try {
        await assertWithinBudget(deps.ledger, { tenantId: input.tenantId, budgetCents: input.budgetCents, projectedMicros: projected, now: now() });
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          await deps.ledger.record({ ...base, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costMicros: 0, latencyMs: 0, status: "rejected_budget", error: err.message });
        }
        throw err;
      }

      const started = Date.now();
      let res;
      try {
        res = await deps.client.createMessage(req);
      } catch (err) {
        // Cost unknown (the request may or may not have been billed); recorded for reconciliation.
        await deps.ledger.record({ ...base, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costMicros: 0, latencyMs: Date.now() - started, status: "failed", error: `api_error (cost unknown): ${String(err)}` });
        throw err;
      }
      const latencyMs = Date.now() - started;
      const cost = costMicros(input.model, res.usage);
      const cached = (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
      totals.cost += cost;
      totals.in += res.usage.input_tokens;
      totals.out += res.usage.output_tokens;
      totals.cached += cached;
      const record = (status: "succeeded" | "failed", extra: { output?: unknown; error?: string }) =>
        deps.ledger.record({ ...base, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens, cachedTokens: cached, costMicros: cost, latencyMs, status, ...extra });

      // Non-retryable outcomes.
      if (res.stop_reason === "refusal") {
        await record("failed", { error: "refusal" });
        throw new AgentOutputError("Model declined the request", "refusal", firstText(res));
      }
      if (res.stop_reason === "max_tokens") {
        await record("failed", { error: "max_tokens" });
        throw new AgentOutputError(`Output truncated at max_tokens=${input.maxTokens}`, "max_tokens");
      }
      const text = firstText(res);
      if (text === undefined) {
        await record("failed", { error: "no_text" });
        throw new AgentOutputError("Response had no text block", "no_text");
      }

      // Parse + validate; on failure, ask for a corrected object.
      let problem: string;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
        const candidate = input.wire ? input.wire.fromWire(input.wire.schema.parse(parsed)) : parsed;
        const v = input.schema.safeParse(candidate);
        if (v.success) {
          await record("succeeded", { output: v.data });
          return { kind: "ok", output: v.data };
        }
        problem = v.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
        lastError = new AgentOutputError("Output failed schema validation", "schema_invalid", problem);
      } catch (err) {
        problem = err instanceof Error ? err.message : String(err);
        lastError = new AgentOutputError("Output was not valid JSON for the schema", parsed === undefined ? "invalid_json" : "schema_invalid", problem);
      }
      await record("failed", { error: `${lastError.kind}: ${problem.slice(0, 2000)}` });
      return { kind: "repair", text, problem };
    });

    if (result.kind === "ok") {
      return { output: result.output, attempts: attempt, costMicros: totals.cost, inputTokens: totals.in, outputTokens: totals.out, cachedTokens: totals.cached };
    }
    messages.push({ role: "assistant", content: result.text });
    messages.push({ role: "user", content: `Your previous JSON did not pass validation:\n${result.problem.slice(0, 4000)}\n\nReturn the complete corrected JSON object. Do not add facts that are not in the evidence.` });
  }
  throw lastError ?? new AgentOutputError("Structured call failed", "schema_invalid");
}
