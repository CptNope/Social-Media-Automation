import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod/v4";
import {
  AgentOutputError,
  BudgetExceededError,
  ClaudeApiError,
  HttpClaudeClient,
  MemoryLedger,
  WireSchemaError,
  costMicros,
  runStructured,
  toWireSchema,
  type ClaudeClient,
  type MessageRequest,
  type MessageResponse,
} from "../src/index.ts";

class FakeClient implements ClaudeClient {
  requests: MessageRequest[] = [];
  constructor(private replies: Array<Partial<MessageResponse> & { text?: string }>) {}
  async createMessage(req: MessageRequest): Promise<MessageResponse> {
    this.requests.push(structuredClone(req));
    const r = this.replies.shift();
    if (!r) throw new Error("no more fake replies");
    return {
      id: "msg_x",
      model: req.model,
      stop_reason: r.stop_reason ?? "end_turn",
      content: r.content ?? (r.text !== undefined ? [{ type: "text", text: r.text }] : []),
      usage: r.usage ?? { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
  }
}

const Out = z.object({ title: z.string().max(10), tags: z.array(z.string()) });
const base = { agent: "test", tenantId: "t1", budgetCents: 1500, model: "claude-sonnet-5-5", maxTokens: 1000, instructions: "Do the thing.", userContent: "input", schema: Out };

describe("pricing", () => {
  it("computes cost in micros including cache reads and writes", () => {
    // Sonnet 5.5: $2 in, $10 out, $2.50 cache write (5m), $0.10 cache read per MTok
    assert.equal(costMicros("claude-sonnet-5-5", { input_tokens: 1000, output_tokens: 800, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000 }), 2000 + 8000 + 500);
    assert.equal(costMicros("claude-sonnet-5-5", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000 }), 2500);
  });

  it("applies Haiku long-prompt pricing above 100K tokens", () => {
    assert.equal(costMicros("claude-haiku-5-5", { input_tokens: 100_000, output_tokens: 0 }), 10_000);
    assert.equal(costMicros("claude-haiku-5-5", { input_tokens: 100_001, output_tokens: 0 }), Math.ceil(100_001 * 0.5));
  });

  it("refuses unknown models rather than guessing a price", () => {
    assert.throws(() => costMicros("some-new-model", { input_tokens: 1, output_tokens: 1 }), /No price/);
  });
});

describe("wire schema", () => {
  it("strips unsupported keywords and closes objects", () => {
    const { schema } = toWireSchema(z.object({ a: z.string().min(2).max(5).regex(/^(?<=x)a/), n: z.number().int().min(1).max(9), list: z.array(z.string()).min(3).max(4) }));
    const s = JSON.stringify(schema);
    for (const k of ["minLength", "maxLength", "minimum", "maximum", "pattern", "maxItems", "$schema"]) assert.ok(!s.includes(k), k);
    assert.ok(!s.includes('"minItems":3'));
    assert.equal((schema as { additionalProperties: boolean }).additionalProperties, false);
  });

  it("rejects maps/records, which structured outputs cannot express", () => {
    assert.throws(() => toWireSchema(z.object({ m: z.record(z.string(), z.string()) })), WireSchemaError);
  });

  it("enforces the documented 16 union-property limit", () => {
    const shape: Record<string, z.ZodType> = {};
    for (let i = 0; i < 17; i++) shape[`f${i}`] = z.string().nullable();
    assert.throws(() => toWireSchema(z.object(shape)), /16/);
  });

  it("enforces the documented 24 optional-property limit", () => {
    const shape: Record<string, z.ZodType> = {};
    for (let i = 0; i < 25; i++) shape[`f${i}`] = z.string().optional();
    assert.throws(() => toWireSchema(z.object(shape)), /24/);
  });
});

describe("runStructured", () => {
  it("sends cached system blocks + output_config and returns validated output", async () => {
    const client = new FakeClient([{ text: '{"title":"Hi","tags":["a"]}' }]);
    const ledger = new MemoryLedger();
    const res = await runStructured({ client, ledger }, { ...base, stableContext: "Brand DNA here" });
    assert.deepEqual(res.output, { title: "Hi", tags: ["a"] });
    const req = client.requests[0]!;
    assert.equal(req.system?.length, 2);
    assert.deepEqual(req.system?.[0]?.cache_control, { type: "ephemeral" });
    assert.equal(req.output_config?.format.type, "json_schema");
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.runs[0]?.status, "succeeded");
    assert.equal(ledger.runs[0]?.costMicros, 1000 * 2 + 200 * 10);
  });

  it("repairs once when zod rejects a constraint the wire schema could not express", async () => {
    const client = new FakeClient([{ text: '{"title":"Way too long title","tags":[]}' }, { text: '{"title":"Short","tags":[]}' }]);
    const ledger = new MemoryLedger();
    const res = await runStructured({ client, ledger }, base);
    assert.equal(res.attempts, 2);
    const repair = client.requests[1]!.messages;
    assert.equal(repair.length, 3);
    assert.match(String(repair[2]!.content), /title/);
    assert.deepEqual(ledger.runs.map((r) => r.status), ["failed", "succeeded"]);
  });

  it("gives up after the repair attempt", async () => {
    const client = new FakeClient([{ text: "not json" }, { text: "still not json" }]);
    await assert.rejects(runStructured({ client, ledger: new MemoryLedger() }, base), (e: unknown) => e instanceof AgentOutputError && e.kind === "invalid_json");
  });

  it("does not retry refusals or truncation", async () => {
    await assert.rejects(runStructured({ client: new FakeClient([{ stop_reason: "refusal", text: "I can't" }]), ledger: new MemoryLedger() }, base), (e: unknown) => e instanceof AgentOutputError && e.kind === "refusal");
    await assert.rejects(runStructured({ client: new FakeClient([{ stop_reason: "max_tokens", text: '{"ti' }]), ledger: new MemoryLedger() }, base), (e: unknown) => e instanceof AgentOutputError && e.kind === "max_tokens");
  });

  it("blocks the call before spending when the monthly budget would be exceeded", async () => {
    const client = new FakeClient([{ text: '{"title":"x","tags":[]}' }]);
    const ledger = new MemoryLedger({ t1: 14_999_000 }); // $14.999 of $15 spent
    await assert.rejects(runStructured({ client, ledger }, base), BudgetExceededError);
    assert.equal(client.requests.length, 0);
    assert.equal(ledger.runs[0]?.status, "rejected_budget");
  });

  it("parallel calls for one tenant cannot all pass the same budget reading", async () => {
    // Each call costs $0.012 (1000 in, 1000 out on Sonnet); budget leaves room for about two.
    let inFlight = 0;
    let maxInFlight = 0;
    const client: ClaudeClient = {
      async createMessage(req) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { id: "m", model: req.model, stop_reason: "end_turn", content: [{ type: "text", text: '{"title":"x","tags":[]}' }], usage: { input_tokens: 1000, output_tokens: 1000 } };
      },
    };
    const ledger = new MemoryLedger({ t1: 15_000_000 - 30_000 });
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => runStructured({ client, ledger }, { ...base, maxTokens: 1000 })));
    assert.equal(maxInFlight, 1, "calls for one tenant are serialized");
    const ok = results.filter((r) => r.status === "fulfilled").length;
    assert.ok(ok >= 1 && ok <= 2, `${ok} calls succeeded`);
    assert.ok((await ledger.monthToDateMicros("t1")) <= 15_000_000, "never exceeds the budget");
  });

  it("reads JSON from the first text block even if it is not content[0]", async () => {
    const client = new FakeClient([{ content: [{ type: "thinking" }, { type: "text", text: '{"title":"ok","tags":[]}' }] }]);
    assert.equal((await runStructured({ client, ledger: new MemoryLedger() }, base)).output.title, "ok");
  });
});

describe("HttpClaudeClient", () => {
  const okBody = { id: "m", model: "claude-sonnet-5-5", content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };

  it("sends the documented headers and retries 529/429 with backoff", async () => {
    const calls: RequestInit[] = [];
    const statuses = [529, 429, 200];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(init);
      const status = statuses.shift()!;
      return new Response(JSON.stringify(status === 200 ? okBody : { error: { type: "overloaded_error", message: "busy" } }), { status, headers: status === 429 ? { "retry-after": "2" } : {} });
    }) as typeof fetch;
    const sleeps: number[] = [];
    const c = new HttpClaudeClient({ apiKey: "sk-test", fetchImpl, sleep: async (ms) => void sleeps.push(ms), baseDelayMs: 10 });
    const res = await c.createMessage({ model: "claude-sonnet-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.id, "m");
    assert.equal(calls.length, 3);
    const h = calls[0]!.headers as Record<string, string>;
    assert.equal(h["x-api-key"], "sk-test");
    assert.equal(h["anthropic-version"], "2023-06-01");
    assert.equal(sleeps[1], 2000, "honours retry-after");
  });

  it("does not retry a timed-out request (it may already be billed)", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    const c = new HttpClaudeClient({ apiKey: "k", fetchImpl, sleep: async () => {} });
    await assert.rejects(c.createMessage({ model: "m", max_tokens: 1, messages: [] }), /timeout/);
    assert.equal(n, 1);
  });

  it("does not retry client errors", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "bad schema" } }), { status: 400 });
    }) as unknown as typeof fetch;
    const c = new HttpClaudeClient({ apiKey: "k", fetchImpl, sleep: async () => {} });
    await assert.rejects(c.createMessage({ model: "m", max_tokens: 1, messages: [] }), (e: unknown) => e instanceof ClaudeApiError && e.status === 400 && !e.retryable);
    assert.equal(n, 1);
  });
});
