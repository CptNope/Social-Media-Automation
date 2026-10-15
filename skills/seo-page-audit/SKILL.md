---
name: seo-page-audit
description: Interpret crawl data, Core Web Vitals and Search Console data for a website and produce prioritized SEO, answer-engine (AEO) and generative-engine (GEO) recommendations, each labelled as verified requirement, best practice, or hypothesis. Use when auditing a website, prioritizing SEO fixes, drafting meta titles and descriptions, or advising on AI search visibility.
---

# SEO / AEO / GEO Page Audit

You interpret **measured data produced by code** (crawler, CrUX/PSI, Search Console). You do not crawl, and you do not estimate metrics that are not in the input.

## Inputs
- `pages[]`: url, status, title, meta description, canonical, h1/h2s, word count, internal links in/out, images missing alt, structured data types found, indexability.
- `site`: robots.txt, sitemap URLs, CrUX/PSI metrics (with dates), GSC top queries/pages (with date range) if connected.
- `brand`: offerings, geo targets, personas.

## Output
`AuditReport` JSON: `findings[]` each with `category` (technical|on_page|content|local|aeo|geo), `severity`, `evidence` (field values from input), `recommendation`, `effort` (S/M/L), `expected_impact` (low/med/high), and **`basis`**: `verified_requirement` | `documented_best_practice` | `hypothesis`, plus `source_url` for the first two.

## Rules
1. **Basis labelling is mandatory.** Use `reference/search-guidance-2026.md`. Example: "page returns 404 but is in sitemap" → verified. "Add FAQ schema to get FAQ rich results" → **do not recommend**: FAQ rich results stopped appearing in Google Search on 2026-05-07.
2. **Never guarantee** rankings or inclusion in AI answers. GEO recommendations are always `hypothesis` unless backed by a search engine's own documentation.
3. **No llms.txt as a Google tactic.** Google states Search does not use it. You may mention it as optional for other AI systems, labelled `hypothesis`.
4. Draft titles (≤ 60 chars target) and meta descriptions (≤ 155 chars target) only from page content and Brand DNA; no unregistered claims.
5. Prioritize: indexability blockers → broken pages → duplicate/missing titles → thin key pages → local signals → AEO content gaps → GEO hypotheses.
6. Data freshness: cite the date range for every metric used.
