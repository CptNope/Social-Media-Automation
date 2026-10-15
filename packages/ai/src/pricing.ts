/**
 * Per-token prices in USD micros (1e-6 USD) per token, from Anthropic's published
 * pricing on 2026-10-15 (docs/research/2026-10-api-research.md). Update when prices change.
 *
 * $X per million tokens == X micros per token.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1 },
  // Haiku 5.5 pricing for prompts up to 100K tokens; larger prompts are priced higher (see below).
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01 },
};

const HAIKU_LONG: ModelPrice = { input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05 };

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export function priceFor(model: string, promptTokens: number): ModelPrice {
  const p = MODEL_PRICES[model];
  if (!p) throw new Error(`No price configured for model ${model}`);
  if (model === "claude-haiku-5-5" && promptTokens > 100_000) return HAIKU_LONG;
  return p;
}

/** Cost of one call in USD micros. Cache writes are assumed to use the 5-minute TTL unless stated. */
export function costMicros(model: string, usage: Usage, cacheTtl: "5m" | "1h" = "5m"): number {
  const cacheW = usage.cache_creation_input_tokens ?? 0;
  const cacheR = usage.cache_read_input_tokens ?? 0;
  const prompt = usage.input_tokens + cacheW + cacheR;
  const p = priceFor(model, prompt);
  const writePrice = cacheTtl === "1h" ? p.cacheWrite1h : p.cacheWrite5m;
  return Math.ceil(usage.input_tokens * p.input + usage.output_tokens * p.output + cacheW * writePrice + cacheR * p.cacheRead);
}

/** Worst-case cost estimate used by the budget guard before a call is made. */
export function projectedCostMicros(model: string, estimatedInputTokens: number, maxOutputTokens: number): number {
  const p = priceFor(model, estimatedInputTokens);
  // Assume no cache hits and a full-length response (conservative).
  return Math.ceil(estimatedInputTokens * p.input + maxOutputTokens * p.output);
}

/** Rough token estimate for budgeting only (~4 chars/token, padded 30% for newer tokenizers). */
export const estimateTokens = (text: string): number => Math.ceil((text.length / 4) * 1.3);
