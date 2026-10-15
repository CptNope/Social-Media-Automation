import { z } from "zod/v4";
import { OBJECTIVES, PLATFORM_LIMITS, addDays, brandPersonaIds, brandPillarIds, isCalendarDate, zonedToUtc, type BrandDna, type Channel, type Finding } from "@jat/core";
import { runStructured, type StructuredDeps } from "../structured.ts";
import { loadSkill, skillInstructions, REPO_SKILLS_ROOT } from "../skills.ts";
import { brandContext, type ClaimForPrompt } from "./context.ts";

/**
 * Marketing Strategy agent: approved Brand DNA + channel cadence → campaigns + calendar slots.
 * Every slot is validated in code (dates, channels, formats, pillars, personas, cadence caps,
 * offers); violations go back to the model as a repair turn.
 */
export interface ChannelPlanInput {
  channel: Channel;
  postsPerWeek: number;
}

export interface PlanRequest {
  tenantId: string;
  budgetCents: number;
  dna: BrandDna;
  claims: readonly ClaimForPrompt[];
  channels: readonly ChannelPlanInput[];
  startDate: string;
  days: 30 | 60 | 90;
  timezone: string;
  goals: string;
  events?: string;
  model?: string;
  instructions?: string;
}

export interface PlannedSlot {
  campaignKey: string;
  date: string;
  time: string;
  publishAt: string;
  channel: Channel;
  format: string;
  pillarId: string;
  personaId: string;
  objective: (typeof OBJECTIVES)[number];
  topic: string;
  notes: string;
  offerClaimId: string | null;
}

export interface Plan {
  campaigns: Array<{ key: string; name: string; objective: (typeof OBJECTIVES)[number]; description: string; startsOn: string; endsOn: string }>;
  slots: PlannedSlot[];
  assumptions: string[];
  risks: string[];
}

const FORMATS = ["text", "image", "carousel", "video", "story", "video_script"] as const;

export function planWireSchema(channels: readonly Channel[]) {
  return z.object({
    campaigns: z.array(z.object({ key: z.string(), name: z.string(), objective: z.enum(OBJECTIVES), description: z.string(), starts_on: z.string(), ends_on: z.string() })),
    slots: z.array(
      z.object({
        campaign_key: z.string(),
        date: z.string().describe("YYYY-MM-DD, local to the business"),
        time: z.string().describe("HH:MM 24-hour, local to the business"),
        channel: z.enum(channels as [Channel, ...Channel[]]),
        format: z.enum(FORMATS),
        pillar_id: z.string(),
        persona_id: z.string(),
        objective: z.enum(OBJECTIVES),
        topic: z.string().describe("One-line topic for the post"),
        notes: z.string().describe("Guidance for the writer; empty if none"),
        offer_claim_id: z.string().describe("Id of a registered offer claim for promotional slots, else empty"),
      }),
    ),
    assumptions: z.array(z.string()),
    risks: z.array(z.string()),
  });
}
type PlanWire = z.infer<ReturnType<typeof planWireSchema>>;

export class PlanValidationError extends Error {
  override name = "PlanValidationError";
}

/** Validate the model's plan against the brand and cadence rules. Throws (repair) on hard errors. */
export function validatePlan(wire: PlanWire, req: Pick<PlanRequest, "dna" | "claims" | "channels" | "startDate" | "days" | "timezone">): { plan: Plan; warnings: Finding[] } {
  const errors: string[] = [];
  const warnings: Finding[] = [];
  const pillars = brandPillarIds(req.dna);
  const personas = brandPersonaIds(req.dna);
  const offers = new Set(req.claims.filter((c) => c.category === "offer").map((c) => c.id));
  const cadence = new Map(req.channels.map((c) => [c.channel, c.postsPerWeek]));
  const end = addDays(req.startDate, req.days);

  const keys = new Set<string>();
  const campaigns: Plan["campaigns"] = [];
  for (const c of wire.campaigns) {
    if (keys.has(c.key)) errors.push(`campaign key "${c.key}" is used twice`);
    keys.add(c.key);
    if (!isCalendarDate(c.starts_on) || !isCalendarDate(c.ends_on) || c.ends_on < c.starts_on) errors.push(`campaign "${c.key}" has invalid dates`);
    else if (c.starts_on < req.startDate || c.ends_on >= end) errors.push(`campaign "${c.key}" must fall within ${req.startDate}..${addDays(end, -1)}`);
    campaigns.push({ key: c.key, name: c.name.trim().slice(0, 120), objective: c.objective, description: c.description.trim().slice(0, 1000), startsOn: c.starts_on, endsOn: c.ends_on });
  }
  if (!campaigns.length) errors.push("plan has no campaigns");

  const slots: PlannedSlot[] = [];
  const weekCounts = new Map<string, number>();
  wire.slots.forEach((s, i) => {
    const where = `slot ${i + 1} (${s.date} ${s.channel})`;
    if (!keys.has(s.campaign_key)) errors.push(`${where}: unknown campaign_key "${s.campaign_key}"`);
    if (!isCalendarDate(s.date) || s.date < req.startDate || s.date >= end) errors.push(`${where}: date must be within ${req.startDate}..${addDays(end, -1)}`);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) errors.push(`${where}: time must be HH:MM`);
    if (!cadence.has(s.channel)) errors.push(`${where}: channel not enabled`);
    if (!(PLATFORM_LIMITS[s.channel].formats as readonly string[]).includes(s.format)) errors.push(`${where}: ${s.channel} can't publish format "${s.format}"`);
    if (!pillars.has(s.pillar_id)) errors.push(`${where}: unknown pillar_id "${s.pillar_id}" (use one of: ${[...pillars].join(", ")})`);
    if (!personas.has(s.persona_id)) errors.push(`${where}: unknown persona_id "${s.persona_id}" (use one of: ${[...personas].join(", ")})`);
    if (s.offer_claim_id && !offers.has(s.offer_claim_id)) errors.push(`${where}: offer_claim_id "${s.offer_claim_id}" is not a registered offer; leave it empty`);
    if (isCalendarDate(s.date) && s.date >= req.startDate) {
      const week = Math.floor((Date.parse(s.date) - Date.parse(req.startDate)) / (7 * 86_400_000));
      const k = `${s.channel}#${week}`;
      weekCounts.set(k, (weekCounts.get(k) ?? 0) + 1);
    }
    let publishAt = "";
    try {
      publishAt = zonedToUtc(s.date, s.time, req.timezone).toISOString();
    } catch {
      /* reported above */
    }
    slots.push({
      campaignKey: s.campaign_key,
      date: s.date,
      time: s.time,
      publishAt,
      channel: s.channel,
      format: s.format,
      pillarId: s.pillar_id,
      personaId: s.persona_id,
      objective: s.objective,
      topic: s.topic.trim().slice(0, 300),
      notes: s.notes.trim().slice(0, 1000),
      offerClaimId: s.offer_claim_id || null,
    });
  });
  for (const [k, n] of weekCounts) {
    const [channel, week] = k.split("#") as [Channel, string];
    const cap = cadence.get(channel) ?? 0;
    if (n > cap) errors.push(`${channel} has ${n} posts in week ${Number(week) + 1}; the cap is ${cap}`);
  }
  if (!slots.length) errors.push("plan has no slots");
  if (errors.length) throw new PlanValidationError(errors.slice(0, 40).join("\n"));

  // Soft rules → warnings for the operator.
  const byPillar = new Map<string, number>();
  for (const s of slots) byPillar.set(s.pillarId, (byPillar.get(s.pillarId) ?? 0) + 1);
  for (const [p, n] of byPillar) {
    if (pillars.size >= 3 && n / slots.length > 0.4) warnings.push({ code: "plan.pillar_heavy", severity: "warning", message: `Pillar "${p}" has ${Math.round((100 * n) / slots.length)}% of posts (guideline: at most 40%).` });
  }
  const promos = slots.filter((s) => s.offerClaimId).length;
  if (promos / slots.length > 0.25) warnings.push({ code: "plan.promo_heavy", severity: "warning", message: `${promos} of ${slots.length} posts are promotional (guideline: at most 25%).` });

  return { plan: { campaigns, slots: slots.sort((a, b) => a.publishAt.localeCompare(b.publishAt)), assumptions: wire.assumptions.slice(0, 10), risks: wire.risks.slice(0, 10) }, warnings };
}

export async function runPlanning(deps: StructuredDeps, req: PlanRequest): Promise<{ plan: Plan; warnings: Finding[]; costMicros: number }> {
  if (brandPillarIds(req.dna).size === 0 || brandPersonaIds(req.dna).size === 0) {
    throw new PlanValidationError("Brand DNA needs at least one messaging pillar and one persona before planning.");
  }
  if (!req.channels.length) throw new PlanValidationError("Turn on at least one channel before planning.");
  const instructions = req.instructions ?? skillInstructions(await loadSkill(REPO_SKILLS_ROOT, "campaign-planning"));
  const wire = planWireSchema(req.channels.map((c) => c.channel));
  let warnings: Finding[] = [];
  const res = await runStructured(deps, {
    agent: "campaign-planning",
    tenantId: req.tenantId,
    budgetCents: req.budgetCents,
    model: req.model ?? "claude-opus-5-5",
    maxTokens: 24_000,
    instructions,
    stableContext: brandContext(req.dna, req.claims),
    userContent: [
      `Plan ${req.days} days starting ${req.startDate} (time zone ${req.timezone}).`,
      `Channels and maximum posts per week: ${req.channels.map((c) => `${c.channel}=${c.postsPerWeek}`).join(", ")}.`,
      `Allowed formats per channel: ${req.channels.map((c) => `${c.channel}: ${PLATFORM_LIMITS[c.channel].formats.filter((f) => f !== "article").join("/")}`).join("; ")}.`,
      `Goals from the operator: ${req.goals || "(none given)"}`,
      req.events ? `Known events and promotions: ${req.events}` : "No events supplied: do not invent events or promotions.",
      "Use only pillar_id and persona_id values from the approved Brand DNA. Leave offer_claim_id empty unless a registered offer claim applies.",
    ].join("\n"),
    schema: z.custom<{ plan: Plan; warnings: Finding[] }>((v) => typeof v === "object" && v !== null && "plan" in v),
    wire: {
      schema: wire,
      fromWire: (w) => {
        const r = validatePlan(w as PlanWire, req);
        warnings = r.warnings;
        return r;
      },
    },
  });
  return { plan: res.output.plan, warnings, costMicros: res.costMicros };
}
