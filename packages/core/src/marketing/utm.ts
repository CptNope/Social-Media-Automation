export interface UtmParams {
  source: string;
  medium: string;
  campaign: string;
  content?: string;
  term?: string;
}

/** Lowercase, hyphenated, ASCII-safe slug for UTM values. */
export function utmSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

/**
 * Add UTM parameters to a URL. Existing non-UTM query params and fragments are preserved;
 * existing utm_* params are replaced so a link is never double-tagged.
 */
export function buildUtmUrl(url: string, params: UtmParams): string {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`Unsupported URL protocol: ${u.protocol}`);
  for (const key of [...u.searchParams.keys()]) if (key.startsWith("utm_")) u.searchParams.delete(key);
  const entries: Array<[string, string | undefined]> = [
    ["utm_source", params.source],
    ["utm_medium", params.medium],
    ["utm_campaign", params.campaign],
    ["utm_content", params.content],
    ["utm_term", params.term],
  ];
  for (const [k, v] of entries) {
    if (v === undefined) continue;
    const slug = utmSlug(v);
    if (!slug) throw new Error(`${k} is empty after normalization`);
    u.searchParams.set(k, slug);
  }
  return u.toString();
}

export interface UtmValidation {
  ok: boolean;
  problems: string[];
}

export function validateTrackedUrl(url: string, opts: { requireHttps?: boolean } = {}): UtmValidation {
  const problems: string[] = [];
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, problems: ["URL is not valid"] };
  }
  if ((opts.requireHttps ?? true) && u.protocol !== "https:") problems.push("URL must use https");
  for (const req of ["utm_source", "utm_medium", "utm_campaign"]) {
    if (!u.searchParams.get(req)) problems.push(`Missing ${req}`);
  }
  return { ok: problems.length === 0, problems };
}
