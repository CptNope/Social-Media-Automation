/**
 * Branded graphics from a post's creative brief: a pure HTML template (brand colours and
 * fonts, escaped text, readable contrast) and a Chromium renderer that turns it into a JPEG.
 * The renderer blocks all network access, so a brief can never make it fetch anything.
 */
export interface GraphicTokens {
  brandName: string;
  colors: Array<{ hex: string; role: "primary" | "secondary" | "accent" | "neutral" | "background" | "text" }>;
  fonts: Array<{ family: string; role: "heading" | "body" | "accent" }>;
}

export interface GraphicContent {
  headline: string;
  supportingText?: string;
}

/** Pixel sizes per channel (JPEG). */
export const GRAPHIC_SIZES: Record<string, { width: number; height: number }> = {
  instagram: { width: 1080, height: 1350 }, // 4:5, the tallest feed shape Instagram accepts
  pinterest: { width: 1000, height: 1500 }, // 2:3
  facebook: { width: 1080, height: 1080 },
  bluesky: { width: 1200, height: 1200 },
  default: { width: 1080, height: 1080 },
};

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);
const HEX = /^#[0-9a-fA-F]{6}$/;
/** Font names go into CSS: letters, digits, spaces and hyphens only. */
const safeFont = (f: string | undefined) => (f && /^[A-Za-z0-9 -]{1,60}$/.test(f) ? `"${f}", ` : "");

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

/** The most readable of the brand's text colour, near-black and white on this background. */
export function readableOn(bg: string, preferred?: string): string {
  const candidates = [preferred, "#111111", "#FFFFFF"].filter((c): c is string => !!c && HEX.test(c));
  return candidates.find((c) => contrast(c, bg) >= 4.5) ?? candidates.sort((a, b) => contrast(b, bg) - contrast(a, bg))[0]!;
}

export function graphicHtml(t: GraphicTokens, c: GraphicContent, size: { width: number; height: number }): string {
  const pick = (role: string) => t.colors.find((x) => x.role === role && HEX.test(x.hex))?.hex;
  const bg = pick("primary") ?? pick("background") ?? "#1F2937";
  const accent = pick("accent") ?? pick("secondary") ?? "#F59E0B";
  const fg = readableOn(bg, pick("text"));
  const heading = safeFont(t.fonts.find((f) => f.role === "heading")?.family ?? t.fonts[0]?.family);
  const body = safeFont(t.fonts.find((f) => f.role === "body")?.family ?? t.fonts[0]?.family);
  const unit = Math.min(size.width, size.height) / 100;
  const headline = c.headline.trim().slice(0, 140);
  const hSize = headline.length > 60 ? 7 : headline.length > 30 ? 8.5 : 10;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${size.width}px;height:${size.height}px;overflow:hidden}
body{background:${bg};color:${fg};display:flex;flex-direction:column;justify-content:space-between;box-sizing:border-box;padding:${8 * unit}px;font-family:${body}system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
main{flex:1;display:flex;flex-direction:column;justify-content:center;position:relative;z-index:1}
.shape{position:absolute;right:${-14 * unit}px;bottom:${-14 * unit}px;width:${62 * unit}px;height:${62 * unit}px;border-radius:50%;background:${accent};opacity:.16}
.bar{width:${18 * unit}px;height:${1.6 * unit}px;background:${accent};border-radius:${unit}px}
h1{font-family:${heading}system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:${hSize * unit}px;line-height:1.08;margin:${4 * unit}px 0 0;font-weight:800;letter-spacing:-0.01em;overflow-wrap:anywhere}
p{font-size:${4.2 * unit}px;line-height:1.35;margin:${3.5 * unit}px 0 0;opacity:.92;overflow-wrap:anywhere}
footer{position:relative;z-index:1;display:flex;align-items:center;gap:${2 * unit}px;font-size:${3.4 * unit}px;font-weight:700;letter-spacing:.02em}
footer i{display:inline-block;width:${2.4 * unit}px;height:${2.4 * unit}px;border-radius:50%;background:${accent}}
</style></head><body><div class="shape"></div><main><div class="bar"></div><h1>${esc(headline)}</h1>${c.supportingText?.trim() ? `<p>${esc(c.supportingText.trim().slice(0, 220))}</p>` : ""}</main><footer><i></i>${esc(t.brandName.slice(0, 60))}</footer></body></html>`;
}

/** Renders HTML to JPEG. Implementations: Chromium (production), or a stub in tests. */
export interface GraphicRenderer {
  renderJpeg(html: string, size: { width: number; height: number }): Promise<Buffer>;
  close?(): Promise<void>;
}

type PlaywrightLike = { chromium: { launch(o?: { executablePath?: string }): Promise<BrowserLike> } };
type BrowserLike = { newContext(o: unknown): Promise<{ newPage(): Promise<PageLike>; close(): Promise<void> }>; close(): Promise<void> };
type PageLike = {
  route(url: string, handler: (route: { abort(): Promise<void> }) => unknown): Promise<void>;
  setContent(html: string, o: { waitUntil: string }): Promise<void>;
  screenshot(o: { type: "jpeg"; quality: number; fullPage: boolean }): Promise<Buffer>;
};

/**
 * Headless Chromium through Playwright, loaded on first use (`PLAYWRIGHT_MODULE` or "playwright").
 * Scripts are disabled and every network request is aborted.
 */
export class ChromiumGraphicRenderer implements GraphicRenderer {
  #browser: Promise<BrowserLike> | null = null;
  constructor(private readonly opts: { module?: string; executablePath?: string } = {}) {}

  async #launch(): Promise<BrowserLike> {
    const mod = (await import(this.opts.module ?? process.env.PLAYWRIGHT_MODULE ?? "playwright")) as PlaywrightLike;
    return mod.chromium.launch(this.opts.executablePath ? { executablePath: this.opts.executablePath } : {});
  }

  async renderJpeg(html: string, size: { width: number; height: number }): Promise<Buffer> {
    // A failed launch or a crashed browser is forgotten so the next render starts a fresh one.
    this.#browser ??= this.#launch().then(
      (b) => {
        (b as { on?: (e: string, f: () => void) => void }).on?.("disconnected", () => {
          this.#browser = null;
        });
        return b;
      },
      (err: unknown) => {
        this.#browser = null;
        throw err;
      },
    );
    const browser = await this.#browser;
    const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 1, javaScriptEnabled: false });
    try {
      const page = await ctx.newPage();
      await page.route("**/*", (r) => r.abort());
      await page.setContent(html, { waitUntil: "load" });
      return await page.screenshot({ type: "jpeg", quality: 88, fullPage: false });
    } finally {
      await ctx.close();
    }
  }

  async close(): Promise<void> {
    if (this.#browser) await (await this.#browser).close();
    this.#browser = null;
  }
}
