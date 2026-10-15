/**
 * robots.txt parsing and matching per RFC 9309:
 * - group selection by most specific matching user-agent token, falling back to "*"
 * - longest matching rule wins; on a tie, Allow wins
 * - "*" wildcard and "$" end anchor in paths
 * - unreachable robots.txt (4xx) = allow all; 5xx/network error = disallow all
 */
export interface RobotsRules {
  rules: Array<{ allow: boolean; pattern: string }>;
  crawlDelaySeconds?: number;
  sitemaps: string[];
}

export function parseRobots(text: string, userAgentToken: string): RobotsRules {
  const ua = userAgentToken.toLowerCase();
  type Group = { agents: string[]; rules: RobotsRules["rules"]; delay?: number };
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "sitemap") {
      sitemaps.push(value);
      continue;
    }
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      if (value === "" && key === "disallow") continue; // "Disallow:" = allow all
      current.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.delay = n;
    }
  }

  // RFC 9309: match the crawler's product token case-insensitively (not substrings).
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && a === ua));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  const out: RobotsRules = { rules: chosen.flatMap((g) => g.rules), sitemaps };
  const delays = chosen.map((g) => g.delay).filter((d): d is number => d !== undefined);
  if (delays.length) out.crawlDelaySeconds = Math.max(...delays);
  return out;
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** pathWithQuery: URL pathname + search, e.g. "/blog?page=2". */
export function isAllowed(rules: RobotsRules, pathWithQuery: string): boolean {
  let best: { len: number; allow: boolean } | null = null;
  for (const r of rules.rules) {
    if (!patternToRegex(r.pattern).test(pathWithQuery)) continue;
    const len = r.pattern.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}

export const ALLOW_ALL: RobotsRules = { rules: [], sitemaps: [] };
export const DISALLOW_ALL: RobotsRules = { rules: [{ allow: false, pattern: "/" }], sitemaps: [] };
