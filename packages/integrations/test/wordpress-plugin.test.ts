import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { signWordPressRequest } from "../src/index.ts";

const php = spawnSync("php", ["-v"]).status === 0;
const testFile = fileURLToPath(new URL("../../../wordpress-plugin/jat-connector/tests/test-signature.php", import.meta.url));

describe("JAT Connector WordPress plugin (PHP)", { skip: php ? false : "php not installed" }, () => {
  it("passes its own signature tests", () => {
    const r = spawnSync("php", [testFile], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  it("accepts signatures produced by the TypeScript client (and rejects altered ones)", () => {
    const env = { JAT_TS_SECRET: "x".repeat(48), JAT_TS_METHOD: "POST", JAT_TS_ROUTE: "/jat/v1/posts/42/seo", JAT_TS_TIMESTAMP: "1760000000", JAT_TS_NONCE: "0123456789abcdef0123456789abcdef", JAT_TS_BODY: JSON.stringify({ change_id: "chg_12345678", fields: { title: "Café – winter checks" } }) };
    const sig = signWordPressRequest(env.JAT_TS_SECRET, env.JAT_TS_METHOD, env.JAT_TS_ROUTE, env.JAT_TS_BODY, Number(env.JAT_TS_TIMESTAMP), env.JAT_TS_NONCE);
    const ok = spawnSync("php", [testFile], { encoding: "utf8", env: { ...process.env, ...env, JAT_TS_SIGNATURE: sig } });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /ok - signature from the TypeScript client verifies/);
    const bad = spawnSync("php", [testFile], { encoding: "utf8", env: { ...process.env, ...env, JAT_TS_BODY: env.JAT_TS_BODY.replace("winter", "summer"), JAT_TS_SIGNATURE: sig } });
    assert.notEqual(bad.status, 0);
  });

  it("every plugin PHP file passes php -l", () => {
    for (const f of ["jat-connector.php", "includes/class-jat-signature.php", "includes/class-jat-seo.php", "includes/class-jat-rest.php", "includes/class-jat-settings.php"]) {
      const r = spawnSync("php", ["-l", fileURLToPath(new URL(`../../../wordpress-plugin/jat-connector/${f}`, import.meta.url))], { encoding: "utf8" });
      assert.equal(r.status, 0, f + r.stdout);
    }
  });
});
