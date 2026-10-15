/**
 * Minimal server-side templating: every interpolated value is HTML-escaped unless it is
 * an `Html` value produced by this module. There is no way to inject raw strings except
 * through `unsafeRaw`, which is only used for trusted, static markup.
 */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]!);

type Value = Html | string | number | boolean | null | undefined | readonly Value[];

function render(v: Value): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  return escapeHtml(String(v));
}

export function html(strings: TemplateStringsArray, ...values: Value[]): Html {
  let out = strings[0]!;
  for (let i = 0; i < values.length; i++) out += render(values[i]!) + strings[i + 1]!;
  return new Html(out);
}

/** Trusted static markup only. Never pass user or model content. */
export const unsafeRaw = (s: string): Html => new Html(s);

export const when = (cond: unknown, v: () => Html): Html => (cond ? v() : new Html(""));
