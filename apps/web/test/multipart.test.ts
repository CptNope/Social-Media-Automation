import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { MultipartError, boundaryFrom, parseMultipart } from "../src/multipart.ts";

const B = "----jatBoundary7MA4YWxkTrZu0gW";
function body(parts: Array<{ name: string; filename?: string; type?: string; data: Buffer | string }>, b = B): Buffer {
  const out: Buffer[] = [];
  for (const p of parts) {
    out.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename !== undefined ? `; filename="${p.filename}"` : ""}\r\n${p.type ? `Content-Type: ${p.type}\r\n` : ""}\r\n`));
    out.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data));
    out.push(Buffer.from("\r\n"));
  }
  out.push(Buffer.from(`--${b}--\r\n`));
  return Buffer.concat(out);
}
/** Feeds the body in awkward chunk sizes so delimiters straddle chunk edges. */
const chunked = (buf: Buffer, size: number) => Readable.from((function* () {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
})());

describe("multipart parser", () => {
  it("parses the boundary from Content-Type", () => {
    assert.equal(boundaryFrom(`multipart/form-data; boundary=${B}`), B);
    assert.equal(boundaryFrom(`multipart/form-data; boundary="${B}"`), B);
    assert.equal(boundaryFrom("application/x-www-form-urlencoded"), null);
  });

  it("streams a binary file to disk and reads fields, across any chunking", async () => {
    // Binary data that contains CRLFs and partial boundary text.
    const file = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0x0d, 0x0a, 0x2d, 0x2d]), Buffer.from(`--${B.slice(0, 10)}`), Buffer.alloc(70_000, 7), Buffer.from("\r\n--")]);
    const raw = body([{ name: "_csrf", data: "tok123" }, { name: "file", filename: "photo.jpg", type: "image/jpeg", data: file }]);
    for (const size of [1, 7, 64, 1000, raw.length]) {
      const r = await parseMultipart(chunked(raw, size), B, { maxFileBytes: 1_000_000 });
      assert.equal(r.fields.get("_csrf"), "tok123");
      assert.equal(r.files.length, 1);
      assert.equal(r.files[0]!.filename, "photo.jpg");
      assert.ok((await readFile(r.files[0]!.path)).equals(file), `chunk size ${size}`);
      await r.cleanup();
    }
  });

  it("enforces limits and rejects truncated or malformed bodies", async () => {
    const big = body([{ name: "file", filename: "v.mp4", data: Buffer.alloc(5000) }]);
    await assert.rejects(parseMultipart(chunked(big, 512), B, { maxFileBytes: 1000 }), (e: unknown) => e instanceof MultipartError && e.status === 413);
    const two = body([{ name: "a", filename: "1.jpg", data: "x" }, { name: "b", filename: "2.jpg", data: "y" }]);
    await assert.rejects(parseMultipart(chunked(two, 50), B, { maxFileBytes: 1000 }), /Too many files/);
    const cut = big.subarray(0, 300);
    await assert.rejects(parseMultipart(chunked(cut, 50), B, { maxFileBytes: 100_000 }), /cut off/);
    await assert.rejects(parseMultipart(chunked(Buffer.alloc(9000, 65), 100), B, { maxFileBytes: 100 }), /Malformed/);
    const field = body([{ name: "x", data: "a".repeat(5000) }]);
    await assert.rejects(parseMultipart(chunked(field, 100), B, { maxFileBytes: 100 }), /too large/);
  });
});
