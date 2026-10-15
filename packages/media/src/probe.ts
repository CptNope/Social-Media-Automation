import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";

/**
 * Identify an uploaded file from its own bytes (never the filename or the browser's claimed
 * type) and read the facts the platforms check: dimensions, and duration for video.
 * Pure parsing; nothing is decoded or executed.
 */
export interface MediaInfo {
  kind: "image" | "video";
  mime: "image/jpeg" | "image/png" | "image/webp" | "video/mp4" | "video/quicktime" | "video/webm";
  bytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  sha256: string;
}

export class UnsupportedMediaError extends Error {
  override name = "UnsupportedMediaError";
}

const HEAD_BYTES = 64 * 1024;

export async function probeFile(path: string): Promise<MediaInfo> {
  try {
    return await probe(path);
  } catch (err) {
    if (err instanceof RangeError) throw new UnsupportedMediaError("The file looks damaged or incomplete.");
    throw err;
  }
}

async function probe(path: string): Promise<MediaInfo> {
  const size = (await stat(path)).size;
  if (size === 0) throw new UnsupportedMediaError("The file is empty.");
  const fh = await open(path, "r");
  try {
    const head = Buffer.alloc(Math.min(HEAD_BYTES, size));
    await fh.read(head, 0, head.length, 0);
    const read = async (pos: number, len: number) => {
      const b = Buffer.alloc(Math.max(0, Math.min(len, size - pos)));
      if (b.length) await fh.read(b, 0, b.length, pos);
      return b;
    };
    const sha256 = await hashFile(path);
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: "image", mime: "image/jpeg", bytes: size, ...(await jpegSize(read, size)), durationMs: null, sha256 };
    if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { kind: "image", mime: "image/png", bytes: size, width: head.length >= 24 ? head.readUInt32BE(16) : null, height: head.length >= 24 ? head.readUInt32BE(20) : null, durationMs: null, sha256 };
    }
    if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return { kind: "image", mime: "image/webp", bytes: size, ...webpSize(head), durationMs: null, sha256 };
    if (head.toString("latin1", 4, 8) === "ftyp") {
      const brand = head.toString("latin1", 8, 12);
      // HEIC/AVIF photos, M4A audio and other ISO files also start with "ftyp": only video brands pass.
      if (!VIDEO_BRANDS.has(brand)) throw new UnsupportedMediaError("Use a JPEG, PNG or WebP image, or an MP4, MOV or WebM video. (HEIC/AVIF photos and audio files aren't supported.)");
      const v = await mp4Info(read, size);
      if (!v.width || !v.height) throw new UnsupportedMediaError("This file has no video track.");
      return { kind: "video", mime: brand === "qt  " ? "video/quicktime" : "video/mp4", bytes: size, ...v, sha256 };
    }
    if (head.readUInt32BE(0) === 0x1a45dfa3) return { kind: "video", mime: "video/webm", bytes: size, width: null, height: null, durationMs: null, sha256 };
    throw new UnsupportedMediaError("Use a JPEG, PNG or WebP image, or an MP4, MOV or WebM video.");
  } finally {
    await fh.close();
  }
}

const VIDEO_BRANDS = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "M4V ", "M4VH", "M4VP", "qt  ", "MSNV", "XAVC", "3gp4", "3gp5", "3gp6"]);
/** The moov box (metadata) is read into memory, capped; anything bigger isn't a sane upload. */
const MAX_MOOV_BYTES = 16 * 1024 * 1024;
/** One box budget for the whole parse (all levels), so crafted files can't force millions of reads. */
const MAX_BOXES = 20_000;

export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

type Reader = (pos: number, len: number) => Promise<Buffer>;

/** Walk JPEG markers to the first start-of-frame (SOF0–SOF15 except DHT/JPG/DAC). */
async function jpegSize(read: Reader, size: number): Promise<{ width: number | null; height: number | null }> {
  let pos = 2;
  for (let guard = 0; guard < 10_000 && pos + 4 <= size; guard++) {
    const h = await read(pos, 10);
    if (h[0] !== 0xff) return { width: null, height: null };
    const marker = h[1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      pos += 2;
      continue;
    }
    const len = h.readUInt16BE(2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: h.readUInt16BE(5), width: h.readUInt16BE(7) };
    if (marker === 0xda || len < 2) break;
    pos += 2 + len;
  }
  return { width: null, height: null };
}

function webpSize(b: Buffer): { width: number | null; height: number | null } {
  const chunk = b.toString("latin1", 12, 16);
  if (chunk === "VP8 " && b.length >= 30) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L" && b.length >= 25) {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X" && b.length >= 30) return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  return { width: null, height: null };
}

/** ISO BMFF (MP4/MOV): duration from mvhd, size from the first video track's tkhd. */
async function mp4Info(read: Reader, size: number): Promise<{ width: number | null; height: number | null; durationMs: number | null }> {
  const out = { width: null as number | null, height: null as number | null, durationMs: null as number | null };
  // Find the first top-level moov (few top-level boxes: ftyp, moov, mdat, free…).
  let pos = 0;
  let moov: Buffer | null = null;
  for (let i = 0; i < 64 && pos + 8 <= size; i++) {
    const h = await read(pos, 16);
    let len = h.readUInt32BE(0);
    const type = h.toString("latin1", 4, 8);
    let header = 8;
    if (len === 1) {
      len = Number(h.readBigUInt64BE(8));
      header = 16;
    } else if (len === 0) len = size - pos;
    if (len < header) break;
    if (type === "moov") {
      if (len - header > MAX_MOOV_BYTES) throw new UnsupportedMediaError("The video's metadata is unusually large.");
      moov = await read(pos + header, len - header);
      break;
    }
    pos += len;
  }
  if (!moov) return out;
  let budget = MAX_BOXES;
  const walk = (buf: Buffer, start: number, end: number, visit: (type: string, body: number, bodyEnd: number) => void) => {
    let p = start;
    while (p + 8 <= end && budget-- > 0) {
      let len = buf.readUInt32BE(p);
      const type = buf.toString("latin1", p + 4, p + 8);
      let header = 8;
      if (len === 1) {
        if (p + 16 > end) return;
        len = Number(buf.readBigUInt64BE(p + 8));
        header = 16;
      } else if (len === 0) len = end - p;
      if (len < header || p + len > end) return;
      visit(type, p + header, p + len);
      p += len;
    }
  };
  walk(moov, 0, moov.length, (t, b, be) => {
    if (t === "mvhd" && be - b >= 32) {
      const v = moov!;
      const version = v[b];
      const timescale = version === 1 ? v.readUInt32BE(b + 20) : v.readUInt32BE(b + 12);
      const duration = version === 1 ? Number(v.readBigUInt64BE(b + 24)) : v.readUInt32BE(b + 16);
      if (timescale > 0) out.durationMs = Math.min(2_000_000_000, Math.round((duration / timescale) * 1000));
    } else if (t === "trak" && out.width === null) {
      let w = 0;
      let hgt = 0;
      let isVideo = false;
      walk(moov!, b, be, (tt, bb, bbe) => {
        if (tt === "tkhd") {
          const off = moov![bb] === 1 ? 88 : 76;
          if (bbe - bb >= off + 8) {
            w = moov!.readUInt32BE(bb + off) >>> 16;
            hgt = moov!.readUInt32BE(bb + off + 4) >>> 16;
          }
        } else if (tt === "mdia") {
          walk(moov!, bb, bbe, (m, mb, mbe) => {
            if (m === "hdlr" && mbe - mb >= 12) isVideo = moov!.toString("latin1", mb + 8, mb + 12) === "vide";
          });
        }
      });
      if (isVideo && w && hgt) {
        out.width = w;
        out.height = hgt;
      }
    }
  });
  return out;
}
