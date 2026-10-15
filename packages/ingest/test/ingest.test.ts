import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertPublicUrl, crawlSite, createSafeFetch, extractColors, extractFonts, extractPage, isAllowed, isPrivateAddress, parseRobots, pinnedLookup, UnsafeUrlError, v6Bytes } from "../src/index.ts";

describe("robots.txt (RFC 9309)", () => {
  const txt = `
# comment
User-agent: *
Disallow: /private
Allow: /private/press
Disallow: /*.pdf$
Crawl-delay: 2

User-agent: JATMarketingOS-Bot
User-agent: OtherBot
Disallow: /no-jat

Sitemap: https://acme.example/sitemap.xml
`;
  it("picks the most specific user-agent group", () => {
    const r = parseRobots(txt, "JATMarketingOS-Bot");
    assert.equal(isAllowed(r, "/no-jat/page"), false);
    assert.equal(isAllowed(r, "/private"), true, "specific group replaces *");
    assert.deepEqual(r.sitemaps, ["https://acme.example/sitemap.xml"]);
  });

  it("longest match wins, Allow wins ties, wildcards and $ work", () => {
    const r = parseRobots(txt, "SomeOtherCrawler");
    assert.equal(isAllowed(r, "/private/x"), false);
    assert.equal(isAllowed(r, "/private/press/2026"), true);
    assert.equal(isAllowed(r, "/files/menu.pdf"), false);
    assert.equal(isAllowed(r, "/files/menu.pdf?x=1"), true);
    assert.equal(r.crawlDelaySeconds, 2);
    assert.equal(isAllowed(parseRobots("User-agent: *\nDisallow:\n", "x"), "/anything"), true);
  });

  it("matches the product token exactly, not by substring", () => {
    const r = parseRobots("User-agent: bot\nDisallow: /\n\nUser-agent: *\nAllow: /\n", "JATMarketingOS-Bot");
    assert.equal(isAllowed(r, "/page"), true);
  });
});

describe("SSRF guard", () => {
  const pub = async () => ["93.184.216.34"];
  it("classifies private and reserved addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) assert.equal(isPrivateAddress(ip), true, ip);
    for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) assert.equal(isPrivateAddress(ip), false, ip);
  });

  it("catches IPv4 embedded in IPv6 in every notation", () => {
    for (const ip of ["::ffff:7f00:1", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:a00:1", "::127.0.0.1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::1", "2001:0:4136:e378::1", "fec0::1", "100::1"]) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
    assert.equal(isPrivateAddress("::ffff:5db8:d822"), false, "mapped public IPv4 is fine");
    assert.deepEqual(v6Bytes("::ffff:127.0.0.1")?.slice(10), [0xff, 0xff, 127, 0, 0, 1]);
    assert.equal(v6Bytes("1::2::3"), null);
  });

  it("URL-parser-normalized mapped literals are rejected", async () => {
    await assert.rejects(assertPublicUrl("http://[::ffff:127.0.0.1]/", async () => []), UnsafeUrlError);
    await assert.rejects(assertPublicUrl("http://[::ffff:169.254.169.254]/latest", async () => []), UnsafeUrlError);
  });

  it("pinned lookup refuses hosts that resolve (even partly) to private addresses", async () => {
    const look = (addrs: string[]) =>
      new Promise<{ err: Error | null; address?: unknown }>((resolve) =>
        pinnedLookup(async () => addrs)("h.example", { all: true }, ((err: Error | null, address?: unknown) => resolve({ err, address })) as never),
      );
    assert.ok((await look(["93.184.216.34", "127.0.0.1"])).err instanceof UnsafeUrlError);
    const ok = await look(["93.184.216.34"]);
    assert.equal(ok.err, null);
    assert.deepEqual(ok.address, [{ address: "93.184.216.34", family: 4 }]);
  });
  it("rejects non-public URLs and accepts public ones", async () => {
    await assert.rejects(assertPublicUrl("http://169.254.169.254/latest/meta-data", pub), UnsafeUrlError);
    await assert.rejects(assertPublicUrl("http://localhost:3000", pub), UnsafeUrlError);
    await assert.rejects(assertPublicUrl("file:///etc/passwd", pub), UnsafeUrlError);
    await assert.rejects(assertPublicUrl("https://user:pw@acme.example", pub), UnsafeUrlError);
    await assert.rejects(assertPublicUrl("https://acme.example:8443", pub), UnsafeUrlError);
    await assert.rejects(assertPublicUrl("https://rebind.example", async () => ["10.0.0.5"]), /non-public/);
    assert.equal((await assertPublicUrl("https://acme.example/about", pub)).hostname, "acme.example");
  });
});

describe("SSRF-safe fetch (used for customer WordPress sites and Bluesky PDS hosts)", () => {
  it("refuses private IP literals (which skip DNS) and private DNS answers, before connecting", async () => {
    const f = createSafeFetch(async () => ["10.0.0.5"]);
    for (const u of ["https://127.0.0.1/", "https://[::1]/", "http://169.254.169.254/latest/meta-data/", "https://[::ffff:7f00:1]/"]) {
      await assert.rejects(f(u, { method: "POST", body: "{}" }), (e: unknown) => e instanceof UnsafeUrlError, u);
    }
    await assert.rejects(f("https://wp.example/", { method: "POST", body: "{}" }), /non-public/);
    await assert.rejects(f("file:///etc/passwd"), UnsafeUrlError);
  });
});

describe("HTML extraction", () => {
  const html = `<!doctype html><html><head><title>Acme Plumbing &amp; Heating</title>
    <meta name="description" content="Plumbing in Worcester">
    <link rel="canonical" href="/">
    <link rel="stylesheet" href="/css/site.css">
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=Merriweather">
    <style>body{color:#1a4c8b;font-family:"Inter",sans-serif} .x{background:rgb(245,245,245)} h1{color:#1A4C8B}</style>
    <script>var secret="ignore me";</script></head>
    <body><h1>Warm homes, <em>dry</em> basements</h1><h2>Services</h2>
    <p>Licensed in Massachusetts.&nbsp;Call us.</p>
    <a href="/services#top">Services</a><a href="https://other.example/x">Out</a><a href="mailto:a@b.c">Mail</a>
    <img src="a.jpg"><img src="b.jpg" alt=""></body></html>`;
  const p = extractPage(html, "https://acme.example/");

  it("pulls title, meta, canonical, headings and visible text", () => {
    assert.equal(p.title, "Acme Plumbing & Heating");
    assert.equal(p.metaDescription, "Plumbing in Worcester");
    assert.equal(p.canonical, "https://acme.example/");
    assert.deepEqual(p.h1, ["Warm homes, dry basements"]);
    assert.ok(p.text.includes("Licensed in Massachusetts. Call us."));
    assert.ok(!p.text.includes("secret"), "scripts are dropped");
  });

  it("collects links, stylesheets, alt-text gaps, colors and fonts", () => {
    assert.deepEqual(p.links, ["https://acme.example/services", "https://other.example/x"]);
    assert.equal(p.stylesheets.length, 2);
    assert.equal(p.imagesMissingAlt, 1, "empty alt is valid (decorative); missing alt is not");
    assert.deepEqual(p.colors, ["#1A4C8B", "#F5F5F5"]);
    assert.deepEqual(extractFonts(p.stylesheets.join("\n") + '\nbody{font-family:"Inter",sans-serif}').slice(0, 2), ["Inter", "Merriweather"]);
    assert.deepEqual(extractColors("a{color:#abc}"), ["#AABBCC"]);
  });
});

describe("extraction is linear-time on hostile HTML", () => {
  it("handles thousands of unclosed tags and comments quickly", () => {
    for (const unit of ["<!--", "<style>", "<title>", "<a href='x", "<script>", "&aaaaaaaaaaaaaaaaaaaa", "<"]) {
      const html = unit.repeat(400_000 / unit.length);
      const t = performance.now();
      extractPage(html, "https://acme.example/");
      const ms = performance.now() - t;
      assert.ok(ms < 1500, `${unit}: ${ms.toFixed(0)}ms`);
    }
  });
});

describe("crawlSite", () => {
  type Route = { status?: number; type?: string; body?: string; location?: string };
  const site = (routes: Record<string, Route>) => {
    const hits: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      hits.push(url);
      assert.equal((init.headers as Record<string, string>)["user-agent"]?.startsWith("JATMarketingOS-Bot"), true);
      const r = routes[url] ?? { status: 404, type: "text/html", body: "nope" };
      const headers: Record<string, string> = { "content-type": r.type ?? "text/html; charset=utf-8" };
      if (r.location) headers.location = r.location;
      return new Response(r.body ?? "", { status: r.status ?? 200, headers });
    }) as unknown as typeof fetch;
    return { fetchImpl, hits };
  };
  const common = { resolve: async () => ["93.184.216.34"], sleep: async () => {}, delayMs: 0 };

  it("respects robots.txt, stays on-site, follows safe redirects and builds evidence", async () => {
    const { fetchImpl, hits } = site({
      "https://acme.example/robots.txt": { type: "text/plain", body: "User-agent: *\nDisallow: /admin\n" },
      "https://acme.example/": { body: `<title>Home</title><style>a{color:#1A4C8B}</style><h1>Acme</h1><a href="/about">About</a><a href="/admin">Admin</a><a href="/old">Old</a><a href="https://evil.example/">x</a><a href="/brochure.pdf">pdf</a>` },
      "https://acme.example/about": { body: "<title>About</title><p>Licensed in Massachusetts</p>" },
      "https://acme.example/old": { status: 301, location: "https://www.acme.example/new" },
      "https://www.acme.example/new": { body: "<title>New</title>" },
    });
    const res = await crawlSite({ startUrl: "https://acme.example/", fetchImpl, ...common });
    assert.deepEqual(res.pages.map((p) => p.url).sort(), ["https://acme.example/", "https://acme.example/about", "https://www.acme.example/new"]);
    assert.ok(res.skipped.some((s) => s.url.endsWith("/admin") && /robots/.test(s.reason)));
    assert.ok(!hits.some((h) => h.includes("evil.example") || h.endsWith(".pdf") || h.endsWith("/admin")));
    assert.ok(res.evidence.some((e) => e.id === "web:/about" && e.text.includes("Licensed in Massachusetts")));
    assert.ok(res.evidence.some((e) => e.id === "css:site" && e.text.includes("#1A4C8B")));
    assert.equal(res.robots.status, "ok");
  });

  it("refuses redirects to private addresses or other sites", async () => {
    const { fetchImpl } = site({
      "https://acme.example/robots.txt": { status: 404 },
      "https://acme.example/": { status: 302, location: "http://169.254.169.254/latest" },
    });
    const res = await crawlSite({ startUrl: "https://acme.example/", fetchImpl, ...common });
    assert.equal(res.pages.length, 0);
    assert.match(res.skipped[0]!.reason, /not public|non-public/);
  });

  it("treats an unreachable robots.txt as disallow-all", async () => {
    const { fetchImpl } = site({ "https://acme.example/robots.txt": { status: 503 }, "https://acme.example/": { body: "<title>x</title>" } });
    const res = await crawlSite({ startUrl: "https://acme.example/", fetchImpl, ...common });
    assert.equal(res.robots.status, "unreachable");
    assert.equal(res.pages.length, 0);
  });

  it("caps total requests even when every link fails", async () => {
    const links = Array.from({ length: 500 }, (_, i) => `<a href="/missing${i}">x</a>`).join("");
    const { fetchImpl, hits } = site({ "https://acme.example/robots.txt": { status: 404 }, "https://acme.example/": { body: links } });
    const res = await crawlSite({ startUrl: "https://acme.example/", fetchImpl, ...common, maxPages: 10 });
    assert.equal(res.pages.length, 1);
    assert.ok(hits.length <= 40, `made ${hits.length} requests`);
    assert.equal(res.requests, hits.length);
  });

  it("stores a page reached through several redirects only once", async () => {
    const { fetchImpl } = site({
      "https://acme.example/robots.txt": { status: 404 },
      "https://acme.example/": { body: `<a href="/a">a</a><a href="/b">b</a>` },
      "https://acme.example/a": { status: 301, location: "/c" },
      "https://acme.example/b": { status: 301, location: "/c" },
      "https://acme.example/c": { body: "<title>C</title>" },
    });
    const res = await crawlSite({ startUrl: "https://acme.example/", fetchImpl, ...common });
    assert.equal(res.pages.filter((p) => p.url.endsWith("/c")).length, 1);
    assert.equal(new Set(res.evidence.map((e) => e.id)).size, res.evidence.length, "evidence ids are unique");
  });

  it("applies the robots.txt of the origin a redirect lands on", async () => {
    const { fetchImpl } = site({
      "https://acme.example/robots.txt": { status: 404 },
      "https://acme.example/": { status: 301, location: "https://www.acme.example/" },
      "https://www.acme.example/robots.txt": { type: "text/plain", body: "User-agent: *\nDisallow: /\n" },
      "https://www.acme.example/": { body: "<title>www</title>" },
    });
    const res = await crawlSite({ startUrl: "https://acme.example/", fetchImpl, ...common });
    assert.equal(res.pages.length, 0);
    assert.match(res.skipped[0]!.reason, /robots/);
  });

  it("honours maxPages and Crawl-delay", async () => {
    const links = Array.from({ length: 20 }, (_, i) => `<a href="/p${i}">p</a>`).join("");
    const routes: Record<string, Route> = { "https://acme.example/robots.txt": { type: "text/plain", body: "User-agent: *\nCrawl-delay: 3\n" }, "https://acme.example/": { body: links } };
    for (let i = 0; i < 20; i++) routes[`https://acme.example/p${i}`] = { body: `<title>p${i}</title>` };
    const sleeps: number[] = [];
    const res = await crawlSite({ startUrl: "https://acme.example/", fetchImpl: site(routes).fetchImpl, resolve: common.resolve, sleep: async (ms) => void sleeps.push(ms), delayMs: 500, maxPages: 5 });
    assert.equal(res.pages.length, 5);
    assert.ok(sleeps.every((ms) => ms === 3000));
  });
});
