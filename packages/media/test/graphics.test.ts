import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromiumGraphicRenderer, GRAPHIC_SIZES, contrast, graphicHtml, probeFile, readableOn } from "../src/index.ts";

const tokens = { brandName: "Acme Plumbing & Heating", colors: [{ hex: "#1A4C8B", role: "primary" as const }, { hex: "#B8642E", role: "accent" as const }], fonts: [{ family: "Inter", role: "body" as const }] };

describe("graphic template", () => {
  it("uses brand colours, escapes text, and keeps text readable", () => {
    const html = graphicHtml(tokens, { headline: "3 freeze-proof checks <script>alert(1)</script>", supportingText: "Insulate & seal" }, GRAPHIC_SIZES.instagram!);
    assert.match(html, /background:#1A4C8B/);
    assert.match(html, /background:#B8642E/);
    assert.ok(!html.includes("<script>alert"), "headline escaped");
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /Acme Plumbing &amp; Heating/);
    assert.match(html, /width:1080px;height:1350px/);
    assert.ok(contrast(readableOn("#1A4C8B"), "#1A4C8B") >= 4.5);
    assert.equal(readableOn("#FFFFFF", "#FFFF00"), "#111111", "a brand text colour with poor contrast is replaced");
  });

  it("refuses font names that could break out of CSS", () => {
    const html = graphicHtml({ ...tokens, fonts: [{ family: 'X";}body{background:url(http://evil)}', role: "heading" }] }, { headline: "Hi" }, GRAPHIC_SIZES.default!);
    assert.ok(!html.includes("evil"));
  });
});

// Renders with real Chromium when Playwright is available (skipped otherwise, e.g. in CI).
const pwModule = process.env.PLAYWRIGHT_MODULE ?? (existsSync("/opt/npm-tools/node_modules/playwright/index.mjs") ? "/opt/npm-tools/node_modules/playwright/index.mjs" : null);
describe("Chromium renderer", { skip: pwModule ? false : "Playwright not installed" }, () => {
  it("renders a JPEG at the requested size", async () => {
    const r = new ChromiumGraphicRenderer({ module: pwModule! });
    try {
      const jpg = await r.renderJpeg(graphicHtml(tokens, { headline: "Three checks before the first hard freeze", supportingText: "Insulate exposed pipes." }, GRAPHIC_SIZES.instagram!), GRAPHIC_SIZES.instagram!);
      const p = join(mkdtempSync(join(tmpdir(), "jat-gfx-")), "g.jpg");
      writeFileSync(p, jpg);
      const info = await probeFile(p);
      assert.deepEqual([info.mime, info.width, info.height], ["image/jpeg", 1080, 1350]);
      assert.ok(info.bytes < 1_000_000);
    } finally {
      await r.close();
    }
  });
});
