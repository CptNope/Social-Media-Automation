import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withTenant, type QueryClient } from "../src/index.ts";

class RecordingClient implements QueryClient {
  calls: Array<{ text: string; params?: unknown[] }> = [];
  constructor(private failOn?: string) {}
  async query<R>(text: string, params?: unknown[]) {
    this.calls.push({ text, ...(params ? { params } : {}) });
    if (this.failOn && text.includes(this.failOn)) throw new Error("boom");
    return { rows: [] as R[] };
  }
}

const T = "11111111-1111-4111-8111-111111111111";

describe("withTenant", () => {
  it("sets transaction-local tenant and user, then commits", async () => {
    const c = new RecordingClient();
    await withTenant(c, { tenantId: T }, async (tx) => {
      await tx.query("SELECT 1 FROM brands");
    });
    assert.deepEqual(
      c.calls.map((x) => x.text),
      ["BEGIN", "SELECT set_config('app.tenant_id', $1, true)", "SELECT set_config('app.user_id', $1, true)", "SELECT 1 FROM brands", "COMMIT"],
    );
    assert.deepEqual(c.calls[1]?.params, [T]);
  });

  it("rolls back on error and rethrows", async () => {
    const c = new RecordingClient("brands");
    await assert.rejects(withTenant(c, { tenantId: T }, (tx) => tx.query("SELECT * FROM brands")), /boom/);
    assert.equal(c.calls.at(-1)?.text, "ROLLBACK");
  });

  it("rejects non-UUID tenant ids before touching the database", async () => {
    const c = new RecordingClient();
    await assert.rejects(withTenant(c, { tenantId: "1; DROP TABLE brands" }, async () => undefined), /UUID/);
    assert.equal(c.calls.length, 0);
  });
});
