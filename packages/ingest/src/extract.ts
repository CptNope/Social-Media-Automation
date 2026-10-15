/**
 * Lightweight HTML extraction without a DOM dependency. Good enough for evidence
 * gathering (titles, headings, visible text, links, colors, fonts). The SEO crawler
 * in Phase 5 will use a real HTML parser for exact audits.
 */
export interface ExtractedPage {
  title: string;
  metaDescription: string;
  canonical: string | null;
  robotsMeta: string | null;
  h1: string[];
  h2: string[];
  text: string;
  links: string[];
  stylesheets: string[];
  colors: string[];
  fonts: string[];
  imagesMissingAlt: number;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", hellip: "…", copy: "©", reg: "®" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,10});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// All scanning below is linear in the input size: hostile HTML (thousands of unclosed
// tags or comments) must not be able to stall the worker with regex backtracking.

const isNameChar = (c: string | undefined): boolean => !!c && /[a-z0-9-]/i.test(c);

/** Remove tags, keeping text. Text after an unclosed "<" is dropped. */
export function stripTags(s: string): string {
  let out = "";
  let pos = 0;
  for (;;) {
    const lt = s.indexOf("<", pos);
    if (lt < 0) return out + s.slice(pos);
    out += s.slice(pos, lt) + " ";
    const gt = s.indexOf(">", lt + 1);
    if (gt < 0) return out;
    pos = gt + 1;
  }
}

const clean = (s: string): string => decodeEntities(stripTags(s)).replace(/\s+/g, " ").trim();

/** Remove comments and whole <name>…</name> blocks. An unclosed block removes the rest. */
export function stripBlocks(html: string, names: readonly string[]): string {
  const lower = html.toLowerCase();
  let out = "";
  let pos = 0;
  while (pos < html.length) {
    const lt = lower.indexOf("<", pos);
    if (lt < 0) break;
    if (lower.startsWith("<!--", lt)) {
      out += html.slice(pos, lt) + " ";
      const end = lower.indexOf("-->", lt + 4);
      if (end < 0) return out;
      pos = end + 3;
      continue;
    }
    const name = names.find((n) => lower.startsWith(`<${n}`, lt) && !isNameChar(lower[lt + 1 + n.length]));
    if (!name) {
      out += html.slice(pos, lt + 1);
      pos = lt + 1;
      continue;
    }
    out += html.slice(pos, lt) + " ";
    const close = lower.indexOf(`</${name}`, lt + 1);
    if (close < 0) return out;
    const gt = lower.indexOf(">", close);
    if (gt < 0) return out;
    pos = gt + 1;
  }
  return out + html.slice(pos);
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`[\\s<"']${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>"']+))`, "i").exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? "") : null;
}

/** Opening tags named `name` (or every tag when name is "*"). */
function tags(html: string, name: string): string[] {
  const lower = html.toLowerCase();
  const out: string[] = [];
  const needle = name === "*" ? "<" : `<${name}`;
  let pos = 0;
  for (;;) {
    const lt = lower.indexOf(needle, pos);
    if (lt < 0) return out;
    const after = lower[lt + needle.length];
    const ok = name === "*" ? /[a-z]/.test(after ?? "") : !isNameChar(after);
    const gt = lower.indexOf(">", lt + 1);
    if (gt < 0) return out;
    if (ok) out.push(html.slice(lt, gt + 1));
    pos = ok ? gt + 1 : lt + 1;
  }
}

function innerRaw(html: string, name: string): string[] {
  const lower = html.toLowerCase();
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    const lt = lower.indexOf(`<${name}`, pos);
    if (lt < 0) return out;
    if (isNameChar(lower[lt + 1 + name.length])) {
      pos = lt + 1;
      continue;
    }
    const gt = lower.indexOf(">", lt);
    if (gt < 0) return out;
    const close = lower.indexOf(`</${name}`, gt + 1);
    if (close < 0) return out;
    out.push(html.slice(gt + 1, close));
    pos = close + name.length + 2;
  }
}

const inner = (html: string, name: string): string[] => innerRaw(html, name).map(clean).filter(Boolean);

const HEX_RE = /#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi;
const RGB_RE = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/gi;

export function normalizeHex(h: string): string {
  const v = h.replace("#", "").toUpperCase();
  return `#${v.length === 3 ? v.split("").map((c) => c + c).join("") : v}`;
}

/** Colors ranked by frequency (most used first), as #RRGGBB. */
export function extractColors(css: string): string[] {
  const counts = new Map<string, number>();
  const add = (hex: string) => counts.set(hex, (counts.get(hex) ?? 0) + 1);
  for (const m of css.match(HEX_RE) ?? []) add(normalizeHex(m));
  for (let m; (m = RGB_RE.exec(css)); ) {
    const [r, g, b] = [m[1], m[2], m[3]].map((x) => Math.min(255, Number(x)));
    add(`#${[r, g, b].map((x) => x!.toString(16).padStart(2, "0")).join("").toUpperCase()}`);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

const GENERIC_FONTS = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "inherit", "initial", "unset", "-apple-system", "blinkmacsystemfont"]);

export function extractFonts(css: string): string[] {
  const counts = new Map<string, number>();
  for (const m of css.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) {
    const first = m[1]!.split(",")[0]!.trim().replace(/^['"]|['"]$/g, "").replace(/\s*!important$/i, "");
    if (!first || GENERIC_FONTS.has(first.toLowerCase()) || first.startsWith("var(")) continue;
    counts.set(first, (counts.get(first) ?? 0) + 1);
  }
  for (const m of css.matchAll(/https?:\/\/fonts\.googleapis\.com\/css2?\?[^"'\s(){}<>]+/gi)) {
    let families: string[] = [];
    try {
      families = new URL(decodeEntities(m[0])).searchParams.getAll("family");
    } catch {
      continue;
    }
    for (const fam of families.flatMap((f) => f.split("|"))) {
      const name = fam.split(":")[0]!.replace(/\+/g, " ").trim();
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
}

export function extractPage(html: string, pageUrl: string): ExtractedPage {
  const noScripts = stripBlocks(html, ["script", "noscript", "template", "svg"]);
  const styles = innerRaw(noScripts, "style").join("\n");
  const inlineStyles = tags(noScripts, "*").map((t) => attr(t, "style") ?? "").filter(Boolean).join(";");
  const body = stripBlocks(noScripts, ["style", "head"]);

  const metas = tags(noScripts, "meta");
  const metaContent = (n: string) => metas.find((m) => (attr(m, "name") ?? attr(m, "property") ?? "").toLowerCase() === n);
  const linkTags = tags(noScripts, "link");
  const resolve = (href: string | null): string | null => {
    if (!href) return null;
    try {
      return new URL(href, pageUrl).toString();
    } catch {
      return null;
    }
  };

  const canonicalTag = linkTags.find((l) => (attr(l, "rel") ?? "").toLowerCase().split(/\s+/).includes("canonical"));
  const stylesheets = linkTags
    .filter((l) => (attr(l, "rel") ?? "").toLowerCase().split(/\s+/).includes("stylesheet"))
    .map((l) => resolve(attr(l, "href")))
    .filter((x): x is string => !!x);

  const links = tags(body, "a")
    .map((a) => resolve(attr(a, "href")))
    .filter((x): x is string => !!x && /^https?:/.test(x))
    .map((x) => x.replace(/#.*$/, ""));

  const imgs = tags(body, "img");
  const cssAll = `${styles}\n${inlineStyles}\n${stylesheets.join("\n")}`;
  return {
    title: inner(noScripts, "title")[0] ?? "",
    metaDescription: (metaContent("description") && attr(metaContent("description")!, "content")) ?? "",
    canonical: resolve(canonicalTag ? attr(canonicalTag, "href") : null),
    robotsMeta: metaContent("robots") ? attr(metaContent("robots")!, "content") : null,
    h1: inner(body, "h1"),
    h2: inner(body, "h2"),
    text: clean(body.replace(/<\/(p|div|li|h[1-6]|br|section|article|tr)>/gi, "\n")),
    links: [...new Set(links)],
    stylesheets,
    colors: extractColors(`${styles}\n${inlineStyles}`),
    fonts: extractFonts(cssAll),
    imagesMissingAlt: imgs.filter((i) => attr(i, "alt") === null).length,
  };
}
