import { z } from "zod/v4";

/**
 * Convert a zod schema into a JSON Schema the Messages API accepts for structured outputs.
 *
 * Documented constraints (platform.claude.com, verified 2026-10-15):
 * - unsupported: minLength, maxLength, minimum, maximum, multipleOf, minItems > 1, maxItems,
 *   additionalProperties other than false, recursive schemas, complex regex
 * - limits per request: ≤ 24 optional properties, ≤ 16 properties using anyOf / type arrays
 *
 * Constraints that are stripped here are still enforced afterwards by zod validation,
 * which is why every structured call re-validates the parsed output.
 */
const STRIP_KEYS = new Set([
  "$schema",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "maxItems",
  "uniqueItems",
  "propertyNames",
  // Regexes from zod may use lookbehind/\b etc. that the grammar compiler rejects.
  "pattern",
]);
const ALLOWED_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);

export const WIRE_LIMITS = { optionalProperties: 24, unionProperties: 16 } as const;

export interface WireSchemaStats {
  optionalProperties: number;
  unionProperties: number;
}

export class WireSchemaError extends Error {
  override name = "WireSchemaError";
}

export function toWireSchema(schema: z.ZodType): { schema: Record<string, unknown>; stats: WireSchemaStats } {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "throw", io: "output" }) as Record<string, unknown>;
  const stats: WireSchemaStats = { optionalProperties: 0, unionProperties: 0 };
  const out = sanitize(json, stats, "$") as Record<string, unknown>;
  if (stats.optionalProperties > WIRE_LIMITS.optionalProperties) {
    throw new WireSchemaError(`Schema has ${stats.optionalProperties} optional properties; limit is ${WIRE_LIMITS.optionalProperties}. Make fields required (use nullable or empty values).`);
  }
  if (stats.unionProperties > WIRE_LIMITS.unionProperties) {
    throw new WireSchemaError(`Schema has ${stats.unionProperties} union/nullable properties; limit is ${WIRE_LIMITS.unionProperties}. Flatten the schema.`);
  }
  return { schema: out, stats };
}

function sanitize(node: unknown, stats: WireSchemaStats, path: string): unknown {
  if (Array.isArray(node)) return node.map((n, i) => sanitize(n, stats, `${path}[${i}]`));
  if (!node || typeof node !== "object") return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (STRIP_KEYS.has(k)) continue;
    if (k === "format" && (typeof v !== "string" || !ALLOWED_FORMATS.has(v))) continue;
    if (k === "minItems") {
      if (typeof v === "number" && v <= 1) out[k] = v;
      continue;
    }
    if (k === "additionalProperties") {
      if (v !== false) throw new WireSchemaError(`${path}: maps/records (additionalProperties) are not supported in structured outputs; use an array of {key, value}.`);
      continue; // re-added below for every object
    }
    if (k === "properties" && v && typeof v === "object") {
      const props: Record<string, unknown> = {};
      const required = new Set(Array.isArray(src.required) ? (src.required as string[]) : []);
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        if (!required.has(pk)) stats.optionalProperties++;
        const pvo = pv as Record<string, unknown>;
        if (pvo && (Array.isArray(pvo.anyOf) || Array.isArray(pvo.type))) stats.unionProperties++;
        props[pk] = sanitize(pv, stats, `${path}.${pk}`);
      }
      out[k] = props;
      continue;
    }
    out[k] = sanitize(v, stats, `${path}.${k}`);
  }
  if (out.type === "object") out.additionalProperties = false;
  return out;
}
