import type { ClaudeClient, MessageRequest, MessageResponse } from "@jat/ai";

/**
 * OFFLINE SAMPLE MODEL for the local demo and tests — not used in production.
 * It recognises which skill is running from the system prompt and returns a plausible,
 * schema-valid answer built from the request (dates, channels, pillar ids), so the whole
 * flow can be explored without an API key. It never claims facts beyond its inputs.
 */
export function sampleClaude(brandWire: unknown): ClaudeClient {
  return {
    async createMessage(req: MessageRequest): Promise<MessageResponse> {
      const system = (req.system ?? []).map((b) => b.text).join("\n");
      const user = req.messages.map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text).join("\n"))).join("\n");
      let out: unknown;
      if (system.includes("# Skill: campaign-planning")) out = samplePlan(system, user);
      else if (system.includes("# Skill: social-post-drafting")) out = samplePost(user);
      else if (system.includes("# Skill: compliance-review")) out = sampleReview(user);
      else out = brandWire;
      return { id: "sample", model: req.model, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(out) }], usage: { input_tokens: 4000, output_tokens: 900 } };
    },
  };
}

function brandIds(system: string): { pillars: string[]; personas: string[] } {
  const m = /<approved_brand_dna>\n([\s\S]*?)\n<\/approved_brand_dna>/.exec(system);
  const dna = m ? (JSON.parse(m[1]!) as { strategy?: { pillars?: Array<{ id: string }>; personas?: Array<{ id: string }> } }) : {};
  return { pillars: (dna.strategy?.pillars ?? []).map((p) => p.id), personas: (dna.strategy?.personas ?? []).map((p) => p.id) };
}

const TOPICS: Record<string, string[]> = {
  default: ["Three checks before the first hard freeze", "What a furnace tune-up actually includes", "Meet the technician behind your service call", "How to find your main water shut-off", "Signs your water heater is near the end", "Why a dripping tap costs more than you think", "Winter pipe insulation, step by step", "Questions to ask before hiring a contractor"],
};

function samplePlan(system: string, user: string) {
  const start = /starting (\d{4}-\d{2}-\d{2})/.exec(user)?.[1] ?? "2026-11-02";
  const days = Number(/Plan (\d+) days/.exec(user)?.[1] ?? 30);
  const channels = [...(/maximum posts per week: ([^\n]+)\./.exec(user)?.[1] ?? "facebook=2").matchAll(/([a-z_]+)=(\d+)/g)].map((m) => ({ channel: m[1]!, perWeek: Number(m[2]) }));
  const formats = Object.fromEntries([...(/Allowed formats per channel: ([^\n]+)\./.exec(user)?.[1] ?? "").matchAll(/([a-z_]+): ([a-z_/]+)/g)].map((m) => [m[1]!, m[2]!.split("/")]));
  const { pillars, personas } = brandIds(system);
  const add = (d: string, n: number) => {
    const x = new Date(`${d}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };
  const end = add(start, days - 1);
  const slots: unknown[] = [];
  let t = 0;
  for (let week = 0; week * 7 < days; week++) {
    for (const c of channels) {
      const n = Math.min(c.perWeek, 2);
      for (let i = 0; i < n; i++) {
        const date = add(start, week * 7 + 1 + i * 3);
        if (date > end) continue;
        const fmts = formats[c.channel] ?? ["text"];
        slots.push({
          campaign_key: "main",
          date,
          time: i % 2 ? "12:15" : "09:30",
          channel: c.channel,
          // Mix text and image posts so both publishing paths show up in the demo.
          format: fmts.includes("image") && !(fmts.includes("text") && t % 2 === 1) ? "image" : fmts.includes("text") ? "text" : fmts[0],
          pillar_id: pillars[t % Math.max(1, pillars.length)] ?? "general",
          persona_id: personas[t % Math.max(1, personas.length)] ?? "general",
          objective: t % 3 === 2 ? "leads" : "engagement",
          topic: TOPICS.default![t % TOPICS.default!.length],
          notes: "",
          offer_claim_id: "",
        });
        t++;
      }
    }
  }
  return {
    campaigns: [{ key: "main", name: "Winter readiness", objective: "leads", description: "Practical winter prep advice that leads to booked tune-ups.", starts_on: start, ends_on: end }],
    slots,
    assumptions: ["The owner can supply real photos of technicians at work.", "Sample plan generated offline (no API key)."],
    risks: ["Cold snaps may shift demand earlier than planned."],
  };
}

function samplePost(user: string) {
  const topic = /Topic: ([^\n]+)/.exec(user)?.[1] ?? "Seasonal home care";
  const channel = /Write one ([a-z_]+) post/.exec(user)?.[1] ?? "facebook";
  const format = /\(format: ([a-z_]+)\)/.exec(user)?.[1] ?? "image";
  const visual = ["image", "carousel", "video", "story"].includes(format);
  return {
    hook: topic.endsWith("?") ? topic : `${topic}.`,
    body: channel === "google_business_profile" ? "A quick seasonal check now can save an emergency call later. Here's what we look at on every visit." : "Small checks now prevent big problems later. Here's what we'd look at first, and what you can safely do yourself before calling anyone.",
    cta: channel === "instagram" ? "Tap the link in our profile to book" : "Book a visit",
    hashtags: channel === "instagram" ? ["HomeCare", "WinterReady"] : [],
    creative_brief: visual ? { template: "tip-card", headline: topic.slice(0, 60), supporting_text: "", image_subject: "Technician at work in a customer's basement" } : null,
    alt_text: visual ? "Technician checking pipes in a basement with a flashlight" : null,
    claim_ids_used: [],
    external_sources: [],
    verification_status: "no_factual_claims",
    expected_kpi: { metric: channel === "google_business_profile" ? "website_clicks" : "engagement", target: "", rationale: "Educational posts drive saves and shares." },
    notes: "Sample draft generated offline (no API key).",
  };
}

function sampleReview(user: string) {
  const longBody = /"body": "([^"]{180,})"/.test(user);
  if (/guarantee/i.test(user)) {
    return { findings: [{ code: "claims.unsupported_guarantee", severity: "blocker", span: "guaranteed", explanation: "A guarantee is a factual promise and no registered claim supports it.", suggested_fix: "Remove the guarantee." }], risk_class: "high", summary: "Unsupported guarantee." };
  }
  return {
    findings: longBody ? [{ code: "tone.length", severity: "info", span: "", explanation: "The body is on the long side for this channel.", suggested_fix: "Trim to two short sentences." }] : [],
    risk_class: "low",
    summary: "No unsupported claims or disclosure issues found (sample review).",
  };
}
