import type { Channel } from "../types.ts";

/**
 * Per-channel content limits enforced by the linter.
 * Re-verify against platform docs quarterly (see docs/research/).
 * `verified` marks values confirmed in official docs during the last research pass.
 */
export interface PlatformLimits {
  /** Max caption/body length. */
  maxChars: number;
  /** How length is measured: UTF-16 code units or user-perceived graphemes. */
  countBy: "chars" | "graphemes";
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
  threads: { maxChars: 500, countBy: "chars", maxHashtags: 1, maxLinks: 5, linksClickable: true, formats: ["text", "image", "carousel", "video"], verified: false, notes: "5 links/post verified Dec 2025; char limit unverified." },
  bluesky: { maxChars: 300, countBy: "graphemes", maxHashtags: 30, linksClickable: true, formats: ["text", "image", "video"], verified: false },
  x: { maxChars: 280, countBy: "chars", maxHashtags: 30, linksClickable: true, formats: ["text", "image", "video"], verified: false, notes: "Pay-per-use API: posts with URLs cost $0.20 (verified Feb 2026 pricing)." },
  pinterest: { maxChars: 500, countBy: "chars", maxHashtags: 20, linksClickable: true, formats: ["image", "video"], verified: false },
  tiktok: { maxChars: 2200, countBy: "chars", maxHashtags: 30, linksClickable: false, formats: ["video", "image", "video_script"], verified: false },
  youtube: { maxChars: 5000, countBy: "chars", maxHashtags: 15, linksClickable: true, formats: ["video", "video_script"], verified: false },
  google_business_profile: { maxChars: 1500, countBy: "chars", maxHashtags: 0, linksClickable: true, formats: ["text", "image"], verified: false },
  wordpress: { maxChars: Number.MAX_SAFE_INTEGER, countBy: "chars", maxHashtags: 0, linksClickable: true, formats: ["article"], verified: true },
};

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

export function measureLength(text: string, countBy: PlatformLimits["countBy"]): number {
  if (countBy === "chars") return text.length;
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}
