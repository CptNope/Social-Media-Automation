import { z } from "zod/v4";
import { ChannelSchema, ObjectiveSchema } from "../types.ts";

/**
 * PostDraft — the contract between the Social Content agent and the rest of the system.
 * Mirrors the required fields in §5 of the product brief.
 */
export const PostFormatSchema = z.enum(["text", "image", "carousel", "video", "story", "video_script", "article"]);
export type PostFormat = z.infer<typeof PostFormatSchema>;

export const VerificationStatusSchema = z.enum(["verified", "needs_verification", "no_factual_claims"]);

/**
 * An image or video attached to a post. It lives in the post body, so the content hash — and
 * therefore every approval — covers exactly this file (by its SHA-256). Replacing it is an edit.
 */
export const PostMediaSchema = z.object({
  asset_id: z.string().uuid(),
  kind: z.enum(["image", "video"]),
  mime: z.string().min(3),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  duration_ms: z.number().int().nonnegative().nullable(),
  origin: z.enum(["uploaded", "rendered"]),
});
export type PostMedia = z.infer<typeof PostMediaSchema>;

export const PostDraftSchema = z.object({
  channel: ChannelSchema,
  format: PostFormatSchema,
  persona_id: z.string().min(1),
  objective: ObjectiveSchema,
  pillar_id: z.string().min(1),
  hook: z.string().min(1),
  body: z.string(),
  cta: z.string(),
  hashtags: z.array(z.string().regex(/^#?[\p{L}\p{N}_]+$/u, "Hashtags may contain letters, numbers and underscores only")),
  creative_brief: z
    .object({
      template: z.string().min(1),
      headline: z.string().max(80),
      supporting_text: z.string().optional(),
      image_subject: z.string().optional(),
      slides: z.array(z.object({ headline: z.string(), text: z.string().optional() })).optional(),
    })
    .nullable(),
  alt_text: z.string().nullable(),
  /** One image or video for now (carousels later). Absent on text posts and posts drafted before media existed. */
  media: z.array(PostMediaSchema).max(1).optional(),
  publish_window: z.object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }) }),
  link: z.object({ url: z.string().url() }).nullable(),
  expected_kpi: z.object({ metric: z.string().min(1), target: z.string().optional(), rationale: z.string().optional() }),
  claim_ids_used: z.array(z.string()),
  external_sources: z.array(z.object({ title: z.string(), url: z.string().url() })),
  verification_status: VerificationStatusSchema,
  disclosure: z
    .object({ type: z.enum(["sponsored", "affiliate", "gifted", "employee", "partnership"]), text: z.string().min(1) })
    .nullable()
    .default(null),
  notes: z.string().optional(),
});
export type PostDraft = z.infer<typeof PostDraftSchema>;

const VISUAL_FORMATS: ReadonlySet<PostFormat> = new Set(["image", "carousel", "video", "story"]);
export const isVisualFormat = (f: PostFormat): boolean => VISUAL_FORMATS.has(f);

const normalizeTag = (t: string): string => (t.startsWith("#") ? t : `#${t}`);

/** The exact caption text as it would be published. */
export function composeCaption(post: Pick<PostDraft, "hook" | "body" | "cta" | "hashtags" | "disclosure">): string {
  const parts: string[] = [];
  if (post.disclosure) parts.push(post.disclosure.text);
  parts.push(post.hook.trim());
  if (post.body.trim()) parts.push(post.body.trim());
  if (post.cta.trim()) parts.push(post.cta.trim());
  if (post.hashtags.length) parts.push(post.hashtags.map(normalizeTag).join(" "));
  return parts.join("\n\n");
}
