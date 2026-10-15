import type { Usage } from "./pricing.ts";

/**
 * Minimal Anthropic Messages API client over fetch (no SDK dependency).
 * Request shape verified against platform.claude.com docs on 2026-10-15:
 *   POST https://api.anthropic.com/v1/messages
 *   headers: x-api-key, anthropic-version: 2023-06-01
 *   structured output: output_config.format = { type: "json_schema", schema }
 */

export interface TextBlockParam {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" };
}

export interface MessageParam {
  role: "user" | "assistant";
  content: string | TextBlockParam[];
}

export interface MessageRequest {
  model: string;
  max_tokens: number;
  system?: TextBlockParam[];
  messages: MessageParam[];
  output_config?: { format: { type: "json_schema"; schema: Record<string, unknown> } };
  temperature?: number;
  metadata?: { user_id?: string };
}

export interface ContentBlock {
  type: string;
  text?: string;
}

export interface MessageResponse {
  id: string;
  model: string;
  content: ContentBlock[];
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "refusal" | "pause_turn" | string | null;
  usage: Usage;
}

export interface ClaudeClient {
  createMessage(req: MessageRequest, opts?: { signal?: AbortSignal }): Promise<MessageResponse>;
}

export class ClaudeApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorType: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(`Claude API ${status} ${errorType}: ${message}`);
    this.name = "ClaudeApiError";
  }
}

export interface HttpClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  /** Base delay for exponential backoff, ms. */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export class HttpClaudeClient implements ClaudeClient {
  readonly #apiKey: string;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #maxRetries: number;
  readonly #baseDelay: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #timeoutMs: number;

  constructor(opts: HttpClientOptions) {
    if (!opts.apiKey) throw new Error("ANTHROPIC_API_KEY is required");
    this.#apiKey = opts.apiKey;
    this.#base = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#maxRetries = opts.maxRetries ?? 3;
    this.#baseDelay = opts.baseDelayMs ?? 1000;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  }

  async createMessage(req: MessageRequest, opts: { signal?: AbortSignal } = {}): Promise<MessageResponse> {
    let attempt = 0;
    for (;;) {
      const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(this.#timeoutMs)]) : AbortSignal.timeout(this.#timeoutMs);
      let res: Response;
      try {
        res = await this.#fetch(`${this.#base}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": this.#apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify(req),
          signal,
        });
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        // A timed-out request may already have been processed and billed: surface it instead
        // of silently retrying. Connection failures before any response are safe to retry.
        if ((err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError") throw err;
        if (attempt >= this.#maxRetries) throw err;
        await this.#sleep(this.#backoff(attempt++));
        continue;
      }
      if (res.ok) return (await res.json()) as MessageResponse;

      let errorType = "unknown_error";
      let message = res.statusText;
      try {
        const body = (await res.json()) as { error?: { type?: string; message?: string } };
        errorType = body.error?.type ?? errorType;
        message = body.error?.message ?? message;
      } catch {
        /* non-JSON error body */
      }
      const retryable = RETRYABLE_STATUS.has(res.status);
      if (!retryable || attempt >= this.#maxRetries) throw new ClaudeApiError(res.status, errorType, message, retryable);
      const retryAfter = Number(res.headers.get("retry-after"));
      await this.#sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60_000) : this.#backoff(attempt));
      attempt++;
    }
  }

  #backoff(attempt: number): number {
    const exp = this.#baseDelay * 2 ** attempt;
    return Math.min(exp + Math.random() * this.#baseDelay, 30_000);
  }
}

/** The structured JSON lives in the first text block (not necessarily content[0]). */
export function firstText(res: MessageResponse): string | undefined {
  return res.content.find((b) => b.type === "text" && typeof b.text === "string")?.text;
}
