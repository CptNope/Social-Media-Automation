import { extractColors, extractFonts, extractPage, type ExtractedPage } from "./extract.ts";
import { ALLOW_ALL, DISALLOW_ALL, isAllowed, parseRobots, type RobotsRules } from "./robots.ts";
import { assertPublicUrl, createSafeFetch, defaultResolver, UnsafeUrlError, type Resolver } from "./safety.ts";

export interface CrawlOptions {
  startUrl: string;
  maxPages?: number;
  /** Hard cap on HTTP requests of any kind (default 3 × maxPages + 10). */
  maxRequests?: number;
  /** Minimum delay between requests, ms (robots.txt Crawl-delay can raise it, capped at 10 s). */
  delayMs?: number;
  userAgent?: string;
  /** Token matched against robots.txt user-agent groups. */
  robotsToken?: string;
  maxBytesPerPage?: number;
  maxStylesheets?: number;
  fetchImpl?: typeof fetch;
  resolve?: Resolver;
  sleep?: (ms: number) => Promise<void>;
}

export interface CrawledPage {
  url: string;
  status: number;
  page: ExtractedPage;
}

/** Same shape as @jat/ai EvidenceChunk (kept structural to avoid a package dependency). */
export interface Evidence {
  id: string;
  kind: "web" | "css";
  text: string;
}

export interface CrawlResult {
  pages: CrawledPage[];
  skipped: Array<{ url: string; reason: string }>;
  /** robots.txt outcome for the start origin. */
  robots: { status: "ok" | "absent" | "unreachable"; crawlDelaySeconds?: number; sitemaps: string[] };
  requests: number;
  siteColors: string[];
  siteFonts: string[];
  evidence: Evidence[];
}

const SKIP_EXT = /\.(?:jpe?g|png|gif|webp|avif|svg|ico|pdf|zip|gz|mp4|mov|webm|mp3|wav|css|js|json|xml|txt|woff2?|ttf|eot|docx?|xlsx?|pptx?)$/i;
const siteKey = (host: string): string => host.toLowerCase().replace(/^www\./, "");

function normalize(u: string): string {
  const url = new URL(u);
  url.hash = "";
  for (const k of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_)/i.test(k)) url.searchParams.delete(k);
  if (url.pathname !== "/" && url.pathname.endsWith("/")) url.pathname = url.pathname.replace(/\/+$/, "/");
  return url.toString();
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
}

export async function crawlSite(opts: CrawlOptions): Promise<CrawlResult> {
  const resolve = opts.resolve ?? defaultResolver;
  // Default transport pins each socket to a validated address (no DNS-rebinding window).
  const fetchImpl = opts.fetchImpl ?? createSafeFetch(resolve);
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxPages = Math.min(opts.maxPages ?? 50, 200);
  const ua = opts.userAgent ?? "JATMarketingOS-Bot/0.1 (+https://jeremyanderson.tech/bot)";
  const token = opts.robotsToken ?? "JATMarketingOS-Bot";
  const maxBytes = opts.maxBytesPerPage ?? 2_000_000;
  const maxRequests = opts.maxRequests ?? maxPages * 3 + 10;
  const MAX_LINKS_PER_PAGE = 200;
  const MAX_QUEUE = 1_000;
  let requests = 0;

  const start = await assertPublicUrl(opts.startUrl, resolve);
  const site = siteKey(start.hostname);
  const sameSite = (u: URL) => siteKey(u.hostname) === site;

  /** Fetch with manual redirects so every hop is re-validated (SSRF) and kept on-site. */
  const get = async (url: string, accept: string): Promise<{ res: Response; finalUrl: string } | { error: string; tooManyRedirects?: true }> => {
    let current = url;
    for (let hop = 0; hop <= 5; hop++) {
      let u: URL;
      try {
        u = await assertPublicUrl(current, resolve);
      } catch (e) {
        return { error: e instanceof UnsafeUrlError ? e.message : String(e) };
      }
      if (!sameSite(u)) return { error: `redirected off-site to ${u.hostname}` };
      if (requests >= maxRequests) return { error: "request budget exhausted" };
      requests++;
      let res: Response;
      try {
        res = await fetchImpl(u.toString(), { redirect: "manual", headers: { "user-agent": ua, accept }, signal: AbortSignal.timeout(20_000) });
      } catch (e) {
        return { error: `network error: ${String(e)}` };
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        const loc = res.headers.get("location");
        if (!loc) return { error: `redirect ${res.status} without location` };
        current = new URL(loc, u).toString();
        continue;
      }
      return { res, finalUrl: u.toString() };
    }
    return { error: "too many redirects", tooManyRedirects: true };
  };

  // robots.txt, fetched and cached per origin (RFC 9309 scopes rules to scheme + host + port).
  const robotsCache = new Map<string, { rules: RobotsRules; status: CrawlResult["robots"]["status"] }>();
  const robotsFor = async (origin: string) => {
    const cached = robotsCache.get(origin);
    if (cached) return cached;
    const r = await get(`${origin}/robots.txt`, "text/plain");
    let entry: { rules: RobotsRules; status: CrawlResult["robots"]["status"] };
    if ("error" in r) {
      // Redirect loops count as "unavailable" (allow); network/unsafe errors as "unreachable" (disallow).
      entry = r.tooManyRedirects ? { rules: ALLOW_ALL, status: "absent" } : { rules: DISALLOW_ALL, status: "unreachable" };
    } else if (r.res.status >= 500) {
      await r.res.body?.cancel();
      entry = { rules: DISALLOW_ALL, status: "unreachable" };
    } else if (r.res.status >= 400) {
      await r.res.body?.cancel();
      entry = { rules: ALLOW_ALL, status: "absent" };
    } else {
      entry = { rules: parseRobots(await readLimited(r.res, 500_000), token), status: "ok" };
    }
    robotsCache.set(origin, entry);
    return entry;
  };

  const startRobots = await robotsFor(start.origin);
  const robots = startRobots.rules;
  const robotsStatus = startRobots.status;
  const delay = Math.max(opts.delayMs ?? 1000, Math.min((robots.crawlDelaySeconds ?? 0) * 1000, 10_000));

  const pages: CrawledPage[] = [];
  const skipped: CrawlResult["skipped"] = [];
  const queue: string[] = [normalize(start.toString())];
  const seen = new Set(queue);
  let first = true;

  while (queue.length && pages.length < maxPages && requests < maxRequests) {
    const url = queue.shift()!;
    const u = new URL(url);
    if (!isAllowed((await robotsFor(u.origin)).rules, u.pathname + u.search)) {
      skipped.push({ url, reason: "disallowed by robots.txt" });
      continue;
    }
    if (!first) await sleep(delay);
    first = false;
    const got = await get(url, "text/html,application/xhtml+xml");
    if ("error" in got) {
      skipped.push({ url, reason: got.error });
      continue;
    }
    const { res, finalUrl } = got;
    const type = res.headers.get("content-type") ?? "";
    const finalKey = normalize(finalUrl);
    if (!res.ok || !/text\/html|application\/xhtml/i.test(type) || (finalKey !== url && pages.some((p) => normalize(p.url) === finalKey))) {
      await res.body?.cancel();
      skipped.push({ url, reason: !res.ok ? `HTTP ${res.status}` : !/text\/html|application\/xhtml/i.test(type) ? `not HTML (${type || "no content-type"})` : "duplicate of an already-crawled page" });
      continue;
    }
    const fu = new URL(finalUrl);
    if (finalKey !== url && !isAllowed((await robotsFor(fu.origin)).rules, fu.pathname + fu.search)) {
      await res.body?.cancel();
      skipped.push({ url, reason: "redirect target disallowed by robots.txt" });
      continue;
    }
    const page = extractPage(await readLimited(res, maxBytes), finalUrl);
    pages.push({ url: finalUrl, status: res.status, page });
    seen.add(finalKey);
    for (const link of page.links.slice(0, MAX_LINKS_PER_PAGE)) {
      if (queue.length >= MAX_QUEUE) break;
      let n: string;
      try {
        n = normalize(link);
      } catch {
        continue;
      }
      const lu = new URL(n);
      if (!sameSite(lu) || SKIP_EXT.test(lu.pathname) || seen.has(n)) continue;
      seen.add(n);
      queue.push(n);
    }
  }

  // Same-site stylesheets for brand colors and fonts.
  const css: string[] = pages.flatMap((p) => p.page.stylesheets).filter((s, i, a) => a.indexOf(s) === i);
  let cssText = pages.map((p) => [...p.page.colors, ...p.page.fonts.map((f) => `font-family: ${f};`)].join(" ")).join("\n");
  cssText += "\n" + css.join("\n"); // stylesheet URLs can carry Google Fonts family names
  for (const href of css.filter((h) => sameSite(new URL(h))).slice(0, opts.maxStylesheets ?? 5)) {
    const hu = new URL(href);
    if (requests >= maxRequests) break;
    if (!isAllowed((await robotsFor(hu.origin)).rules, hu.pathname + hu.search)) continue;
    await sleep(delay);
    const got = await get(href, "text/css");
    if ("error" in got) continue;
    if (got.res.ok) cssText += "\n" + (await readLimited(got.res, 1_000_000));
    else await got.res.body?.cancel();
  }
  const siteColors = extractColors(cssText).slice(0, 12);
  const siteFonts = extractFonts(cssText).slice(0, 6);

  const evidence: Evidence[] = pages.map((p) => {
    const u = new URL(p.url);
    return {
      id: `web:${u.pathname}${u.search}`,
      kind: "web",
      text: [`URL: ${p.url}`, `Title: ${p.page.title}`, p.page.metaDescription && `Meta description: ${p.page.metaDescription}`, p.page.h1.length ? `H1: ${p.page.h1.join(" | ")}` : "", "", p.page.text].filter((l) => l !== "").join("\n"),
    };
  });
  if (siteColors.length || siteFonts.length) {
    evidence.push({ id: "css:site", kind: "css", text: `Colors used on the website (most frequent first): ${siteColors.join(", ")}\nFont families used on the website: ${siteFonts.join(", ")}\nNote: website styles may differ from the official brand palette.` });
  }

  return {
    pages,
    skipped,
    robots: { status: robotsStatus, sitemaps: robots.sitemaps, ...(robots.crawlDelaySeconds !== undefined ? { crawlDelaySeconds: robots.crawlDelaySeconds } : {}) },
    requests,
    siteColors,
    siteFonts,
    evidence,
  };
}
