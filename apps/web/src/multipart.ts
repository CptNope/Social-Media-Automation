import { createWriteStream, type WriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

/**
 * Streaming multipart/form-data parser for file uploads (no dependencies). Files are written to
 * a private temp directory as they arrive, never held in memory; text fields are small and capped.
 * Callers must `cleanup()` when done.
 */
export interface UploadedFile {
  field: string;
  /** Untrusted; only used for display. */
  filename: string;
  path: string;
  bytes: number;
}

export interface MultipartResult {
  fields: URLSearchParams;
  files: UploadedFile[];
  cleanup: () => Promise<void>;
}

export class MultipartError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface MultipartLimits {
  maxFileBytes: number;
  maxFiles?: number;
  maxFields?: number;
  maxFieldBytes?: number;
}

const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");

export function boundaryFrom(contentType: string | undefined): string | null {
  const m = /^multipart\/form-data;.*\bboundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))/i.exec(contentType ?? "");
  return m ? (m[1] ?? m[2]!) : null;
}

export async function parseMultipart(stream: Readable, boundary: string, limits: MultipartLimits): Promise<MultipartResult> {
  const maxFiles = limits.maxFiles ?? 1;
  const maxFields = limits.maxFields ?? 20;
  const maxFieldBytes = limits.maxFieldBytes ?? 4096;
  const dir = await mkdtemp(join(tmpdir(), "jat-upload-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const fields = new URLSearchParams();
  const files: UploadedFile[] = [];
  const delimiter = Buffer.from(`\r\n--${boundary}`);

  let buf: Buffer = Buffer.alloc(0);
  // Prepend CRLF so the very first boundary matches the same "\r\n--boundary" delimiter.
  let started = false;
  type State = "preamble" | "headers" | "body" | "done";
  type Part = { name: string; filename: string | null; out: WriteStream | null; field: Buffer[]; size: number; path: string | null };
  // Asserted (not narrowed): both change inside the helpers below.
  let state = "preamble" as State;
  let part = null as Part | null;
  let fieldCount = 0;
  // A disk error (full disk, I/O) must fail this upload, never crash the process.
  let writeError: Error | null = null;
  const watch = (out: WriteStream) => {
    out.on("error", (e) => {
      writeError ??= e;
    });
    return out;
  };

  const finishPart = async () => {
    if (!part) return;
    if (part.out) {
      const out = part.out;
      await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err || writeError ? rej(new MultipartError(507, "The server couldn't store the upload. Try again later.")) : res())));
      files.push({ field: part.name, filename: part.filename ?? "", path: part.path!, bytes: part.size });
    } else {
      fields.append(part.name, Buffer.concat(part.field).toString("utf8"));
    }
    part = null;
  };

  const writeBody = async (chunk: Buffer) => {
    if (!part || !chunk.length) return;
    part.size += chunk.length;
    if (part.out) {
      if (part.size > limits.maxFileBytes) throw new MultipartError(413, `The file is larger than ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB.`);
      if (writeError) throw new MultipartError(507, "The server couldn't store the upload. Try again later.");
      const out = part.out;
      if (!out.write(chunk)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            out.off("drain", done);
            out.off("error", done);
            resolve();
          };
          out.once("drain", done).once("error", done);
        });
        if (writeError) throw new MultipartError(507, "The server couldn't store the upload. Try again later.");
      }
    } else {
      if (part.size > maxFieldBytes) throw new MultipartError(413, "A form field is too large.");
      part.field.push(chunk);
    }
  };

  const process = async (final: boolean) => {
    for (;;) {
      if (state === "preamble") {
        const i = buf.indexOf(delimiter);
        if (i < 0) {
          if (buf.length > 4096) throw new MultipartError(400, "Malformed upload.");
          return;
        }
        buf = buf.subarray(i + delimiter.length);
        state = "headers";
      } else if (state === "headers") {
        if (buf.length < 2) return;
        if (buf.subarray(0, 2).toString() === "--") {
          state = "done";
          return;
        }
        const end = buf.indexOf(HEADER_END);
        if (end < 0) {
          if (buf.length > 8192) throw new MultipartError(400, "Malformed upload.");
          return;
        }
        const head = buf.subarray(CRLF.length, end).toString("utf8");
        buf = buf.subarray(end + HEADER_END.length);
        const disp = /^content-disposition:\s*form-data;(.*)$/im.exec(head)?.[1] ?? "";
        const name = /\bname="([^"]{1,100})"/.exec(disp)?.[1];
        const filename = /\bfilename="([^"]{0,255})"/.exec(disp)?.[1] ?? null;
        if (!name) throw new MultipartError(400, "Malformed upload.");
        if (filename !== null) {
          if (files.length >= maxFiles) throw new MultipartError(400, "Too many files.");
          const path = join(dir, `f${files.length}`);
          part = { name, filename, out: watch(createWriteStream(path, { flags: "wx", mode: 0o600 })), field: [], size: 0, path };
        } else {
          if (++fieldCount > maxFields) throw new MultipartError(400, "Too many form fields.");
          part = { name, filename: null, out: null, field: [], size: 0, path: null };
        }
        state = "body";
      } else if (state === "body") {
        const i = buf.indexOf(delimiter);
        if (i >= 0) {
          await writeBody(buf.subarray(0, i));
          buf = buf.subarray(i + delimiter.length);
          await finishPart();
          state = "headers";
          continue;
        }
        // Keep enough bytes to recognise a delimiter split across chunks.
        const keep = final ? 0 : delimiter.length;
        if (buf.length > keep) {
          await writeBody(buf.subarray(0, buf.length - keep));
          buf = buf.subarray(buf.length - keep);
        }
        return;
      } else return;
    }
  };

  try {
    // Don't destroy the request if we stop early: the caller may still need to drain it and reply.
    for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
      const c = chunk as Buffer;
      buf = buf.length ? Buffer.concat([buf, c]) : started ? c : Buffer.concat([CRLF, c]);
      started = true;
      await process(false);
      if (state === "done") break;
    }
    if (state !== "done") throw new MultipartError(400, "The upload was cut off. Try again.");
    return { fields, files, cleanup };
  } catch (err) {
    if (part?.out) part.out.destroy();
    await cleanup();
    throw err;
  }
}
