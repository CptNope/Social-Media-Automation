import type { Channel } from "../types.ts";
import { composeCaption, type PostDraft } from "./post.ts";

/**
 * Per-channel content limits enforced by the linter.
 * Re-verify against platform docs quarterly (see docs/research/).
 * `verified` marks values confirmed in official docs during the last research pass.
 */
export interface PlatformLimits {
  /** Max caption/body length. */
  maxChars: number;
  /** How length is measured: UTF-16 code units, user-perceived graphemes, or X's weighted count. */
  countBy: "chars" | "graphemes" | "x_weighted";
  /** The link is sent inside the post text (X has no separate link field), so it counts toward the limit. */
  linkInText?: boolean;
  /** Platform hard cap on hashtags (brand policy may be stricter). */
  maxHashtags: number;
  /** Max number of URLs in the text, if the platform caps it. */
  maxLinks?: number;
  /** Are links in the caption clickable? (Instagram: no — use "link in bio".) */
  linksClickable: boolean;
  /** Formats the channel supports for organic posts. */
  formats: ReadonlyArray<"text" | "image" | "carousel" | "video" | "story" | "video_script" | "article">;
  verified: boolean;
  notes?: string;
}

export const PLATFORM_LIMITS: Record<Channel, PlatformLimits> = {
  facebook: { maxChars: 63206, countBy: "chars", maxHashtags: 30, linksClickable: true, formats: ["text", "image", "carousel", "video", "story", "video_script"], verified: false },
  instagram: { maxChars: 2200, countBy: "chars", maxHashtags: 30, linksClickable: false, formats: ["image", "carousel", "video", "story", "video_script"], verified: false, notes: "Carousel up to 10 items (verified); JPEG images only via API." },
  linkedin: { maxChars: 3000, countBy: "chars", maxHashtags: 30, linksClickable: true, formats: ["text", "image", "video", "article"], verified: false, notes: "Organic carousels not supported via Posts API (verified)." },
  threads: { maxChars: 500, countBy: "chars", maxHashtags: 1, maxLinks: 5, linksClickable: true, formats: ["text", "image", "carousel", "video"], verified: true, notes: "500 characters and 5 links/post verified 2026-10; Threads counts emoji by UTF-8 bytes (not modelled)." },
  bluesky: { maxChars: 300, countBy: "graphemes", maxHashtags: 30, linksClickable: true, formats: ["text", "image", "video"], verified: false },
  x: { maxChars: 280, countBy: "x_weighted", linkInText: true, maxHashtags: 30, linksClickable: true, formats: ["text", "image", "video"], verified: true, notes: "280 weighted characters, URLs count 23 (verified 2026-10). Pay-per-use: $0.015 per post, $0.20 with a URL." },
  pinterest: { maxChars: 500, countBy: "chars", maxHashtags: 20, linksClickable: true, formats: ["image", "video"], verified: false },
  tiktok: { maxChars: 2200, countBy: "chars", maxHashtags: 30, linksClickable: false, formats: ["video", "image", "video_script"], verified: false },
  youtube: { maxChars: 5000, countBy: "chars", maxHashtags: 15, linksClickable: true, formats: ["video", "video_script"], verified: false },
  google_business_profile: { maxChars: 1500, countBy: "chars", maxHashtags: 0, linksClickable: true, formats: ["text", "image"], verified: false },
  wordpress: { maxChars: Number.MAX_SAFE_INTEGER, countBy: "chars", maxHashtags: 0, linksClickable: true, formats: ["article"], verified: true },
};

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * X's weighted length (docs.x.com "counting characters", twitter-text v3 configuration):
 * NFC-normalized; a URL counts 23; emoji count 2; code points in the light ranges count 1,
 * everything else (e.g. CJK) counts 2. Trailing punctuation isn't part of a URL, and bare
 * domains (example.com) count as URLs too; to stay on the safe side a bare domain counts
 * as the larger of 23 and its own length, and every emoji grapheme counts 2.
 */
const X_LIGHT_RANGES: ReadonlyArray<[number, number]> = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]];
const X_URL = /https?:\/\/[^\s]+|\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}\b(?:\/[^\s]*)?/giu;
const TRAILING = /[.,!?;:'"\]]+$/u;

function trimUrl(raw: string): string {
  let u = raw.replace(TRAILING, "");
  // A closing parenthesis belongs to the URL only if it opened one.
  while (u.endsWith(")") && (u.match(/\(/g) ?? []).length < (u.match(/\)/g) ?? []).length) u = u.slice(0, -1).replace(TRAILING, "");
  return u;
}

function plainWeight(text: string): number {
  let n = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (/\p{Extended_Pictographic}/u.test(segment)) {
      n += 2;
      continue;
    }
    for (const ch of segment) {
      const cp = ch.codePointAt(0)!;
      n += X_LIGHT_RANGES.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
    }
  }
  return n;
}

export function xWeightedLength(text: string): number {
  const t = text.normalize("NFC");
  let n = 0;
  let last = 0;
  for (const m of t.matchAll(X_URL)) {
    const url = trimUrl(m[0]);
    if (!url) continue;
    n += plainWeight(t.slice(last, m.index));
    n += /^https?:\/\//i.test(url) ? 23 : Math.max(23, plainWeight(url));
    last = m.index + url.length;
  }
  return n + plainWeight(t.slice(last));
}

export function measureLength(text: string, countBy: PlatformLimits["countBy"]): number {
  if (countBy === "x_weighted") return xWeightedLength(text);
  if (countBy === "chars") return text.length;
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

/** The exact text a platform receives: the caption, plus the link where the link travels inside the text (X). */
export function publishedText(post: Pick<PostDraft, "channel" | "hook" | "body" | "cta" | "hashtags" | "disclosure" | "link">): string {
  const caption = composeCaption(post);
  return PLATFORM_LIMITS[post.channel].linkInText && post.link ? `${caption}\n\n${post.link.url}` : caption;
}
