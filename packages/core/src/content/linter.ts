import type { Finding, RiskClass } from "../types.ts";
import { hasBlockers } from "../types.ts";
import { PLATFORM_LIMITS, measureLength, publishedText } from "./platform-limits.ts";
import { composeCaption, isVisualFormat, type PostDraft } from "./post.ts";
import { validateTrackedUrl } from "../marketing/utm.ts";

/**
 * Deterministic content linter. Runs before AI QA and again on the final payload
 * immediately before publishing. Rules here are cheap, explainable and never
 * depend on a model.
 */
export interface LintContext {
  forbiddenPhrases: readonly string[];
  usableClaimIds: ReadonlySet<string>;
  /** Brand hashtag policy (stricter than platform caps). */
  brandMaxHashtags?: number | undefined;
  /** Set when the brief marks the post as sponsored/affiliate/material connection. */
  requiresDisclosure?: boolean;
  /** Hooks used recently by this brand, for repetition checks. */
  recentHooks?: readonly string[];
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Case-insensitive whole-phrase match (letters/digits on either side break the match). */
export function findPhrase(text: string, phrase: string): string | undefined {
  const p = phrase.trim();
  if (!p) return undefined;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(p)}(?![\\p{L}\\p{N}])`, "iu");
  return re.exec(text)?.[0];
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;

const UNSUPPORTED_SUPERLATIVES = [
  "best",
  "#1",
  "number one",
  "guaranteed",
  "guarantee",
  "cheapest",
  "lowest price",
  "top-rated",
  "award-winning",
  "risk-free",
];

const ENGAGEMENT_BAIT: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\bcomment\s+["“']?\w+["”']?\s+(if|to|below)\b/i, label: "comment-keyword bait" },
  { re: /\btag\s+(a|\d+|two|three|your)\s+(friends?|people)\b/i, label: "tag-a-friend bait" },
  { re: /\blike\s+(and|&)\s+share\b/i, label: "like-and-share bait" },
  { re: /\bshare\s+(this\s+)?if\s+you\s+agree\b/i, label: "share-if-you-agree bait" },
  { re: /\byou\s+won['’]t\s+believe\b/i, label: "curiosity-gap clickbait" },
];

const OFFER_RE = /(\$\s?\d|\d+\s?%\s?off|\bdiscount\b|\bcoupon\b|\bpromo\s?code\b|\bfree\b)/i;

const normalizeForSimilarity = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

/** Jaccard similarity of word trigrams (cheap near-duplicate signal for short hooks). */
export function trigramSimilarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const w = normalizeForSimilarity(s).split(" ").filter(Boolean);
    const out = new Set<string>();
    if (w.length < 3) {
      if (w.length) out.add(w.join(" "));
      return out;
    }
    for (let i = 0; i + 3 <= w.length; i++) out.add(w.slice(i, i + 3).join(" "));
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

export function lintPost(post: PostDraft, ctx: LintContext): Finding[] {
  const f: Finding[] = [];
  const limits = PLATFORM_LIMITS[post.channel];
  const caption = composeCaption(post);

  // Format support
  if (!limits.formats.includes(post.format)) {
    f.push({ code: "format.unsupported", severity: "blocker", field: "format", message: `${post.channel} does not support format "${post.format}".` });
  }

  // Length
  const len = measureLength(publishedText(post), limits.countBy);
  if (len > limits.maxChars) {
    const unit = limits.countBy === "x_weighted" ? "characters (X counts links as 23 and emoji as 2)" : limits.countBy;
    f.push({ code: "length.exceeded", severity: "blocker", field: "body", message: `${limits.linkInText && post.link ? "Text with link" : "Caption"} is ${len} ${unit}; ${post.channel} allows ${limits.maxChars}.` });
  }

  // Forbidden phrases (brand hard rule)
  for (const phrase of ctx.forbiddenPhrases) {
    const hit = findPhrase(caption, phrase);
    if (hit) f.push({ code: "brand.forbidden_phrase", severity: "blocker", span: hit, message: `Forbidden brand phrase: "${phrase}".` });
  }

  // Claims must be registered, verified and unexpired
  for (const id of post.claim_ids_used) {
    if (!ctx.usableClaimIds.has(id)) {
      f.push({ code: "claims.unregistered", severity: "blocker", field: "claim_ids_used", span: id, message: `Claim "${id}" is not a verified, unexpired registered claim.` });
    }
  }

  // Superlatives / guarantees with no supporting claim
  if (post.claim_ids_used.length === 0) {
    for (const word of UNSUPPORTED_SUPERLATIVES) {
      const hit = findPhrase(caption, word);
      if (hit) f.push({ code: "claims.unsupported_superlative", severity: "warning", span: hit, message: `"${hit}" reads as a factual claim; link a registered claim or rephrase.` });
    }
  }

  if (post.verification_status === "needs_verification") {
    f.push({ code: "claims.needs_verification", severity: "warning", field: "verification_status", message: "Draft contains statements that need fact-checking before approval." });
  }

  // Accessibility
  if (isVisualFormat(post.format)) {
    const alt = post.alt_text?.trim() ?? "";
    if (!alt) {
      f.push({ code: "a11y.alt_text_missing", severity: "blocker", field: "alt_text", message: "Visual posts require alt text." });
    } else {
      if (/^(image|picture|photo|graphic)\s+of\b/i.test(alt)) f.push({ code: "a11y.alt_text_redundant_prefix", severity: "info", field: "alt_text", message: 'Alt text should not start with "image of".' });
      if (alt.length > 250) f.push({ code: "a11y.alt_text_long", severity: "warning", field: "alt_text", message: "Alt text over 250 characters; keep it concise." });
    }
    if (!post.creative_brief) f.push({ code: "creative.brief_missing", severity: "blocker", field: "creative_brief", message: "Visual posts require a creative brief." });
  }

  // Hashtags
  const brandMax = ctx.brandMaxHashtags;
  const cap = Math.min(limits.maxHashtags, brandMax ?? limits.maxHashtags);
  if (post.hashtags.length > cap) {
    f.push({ code: "hashtags.too_many", severity: limits.maxHashtags < post.hashtags.length ? "blocker" : "warning", field: "hashtags", message: `${post.hashtags.length} hashtags; limit is ${cap}.` });
  }
  const seen = new Set<string>();
  for (const h of post.hashtags) {
    const k = h.replace(/^#/, "").toLowerCase();
    if (seen.has(k)) f.push({ code: "hashtags.duplicate", severity: "info", span: h, message: `Duplicate hashtag ${h}.` });
    seen.add(k);
  }

  // Disclosures
  if (ctx.requiresDisclosure && !post.disclosure) {
    f.push({ code: "compliance.disclosure_missing", severity: "blocker", field: "disclosure", message: "Sponsored/affiliate/material-connection content requires a clear disclosure at the start." });
  }

  // Links
  const inlineUrls = caption.match(URL_RE) ?? [];
  if (limits.maxLinks !== undefined && inlineUrls.length > limits.maxLinks) {
    f.push({ code: "links.too_many", severity: "blocker", message: `${inlineUrls.length} links; ${post.channel} allows ${limits.maxLinks}.` });
  }
  if (!limits.linksClickable && inlineUrls.length > 0) {
    f.push({ code: "links.not_clickable", severity: "warning", span: inlineUrls[0], message: `Links in ${post.channel} captions are not clickable; use a profile link or link sticker.` });
  }
  if (post.link) {
    const v = validateTrackedUrl(post.link.url);
    for (const p of v.problems) f.push({ code: "links.utm_invalid", severity: "blocker", field: "link.url", message: p });
  }

  // Engagement bait
  for (const { re, label } of ENGAGEMENT_BAIT) {
    const m = re.exec(caption);
    if (m) f.push({ code: "quality.engagement_bait", severity: "warning", span: m[0], message: `Avoid ${label}.` });
  }

  // Repetition
  for (const prev of ctx.recentHooks ?? []) {
    const sim = trigramSimilarity(post.hook, prev);
    if (sim >= 0.6 || normalizeForSimilarity(post.hook) === normalizeForSimilarity(prev)) {
      f.push({ code: "quality.repeated_hook", severity: "warning", span: post.hook, message: "Hook is very similar to one used recently." });
      break;
    }
  }

  return f;
}

/**
 * Risk class used by the approval policy. Industry-restricted topics are always high.
 */
export function deriveRiskClass(post: PostDraft, findings: readonly Finding[], opts: { industryRestricted?: boolean } = {}): RiskClass {
  if (opts.industryRestricted || hasBlockers(findings)) return "high";
  if (post.disclosure) return "high";
  const caption = composeCaption(post);
  if (findings.some((x) => x.severity === "warning") || OFFER_RE.test(caption) || post.claim_ids_used.length > 0) return "medium";
  return "low";
}
