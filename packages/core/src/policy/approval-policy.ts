import type { AutomationMode, Finding, RiskClass, Role } from "../types.ts";
import { hasBlockers } from "../types.ts";

/**
 * Approval policy — code, not prompts. Agents cannot override these decisions.
 * See docs/I-testing-security.md §1 for the human-readable table.
 */
export const ACTIONS = [
  "generate_draft",
  "publish_post",
  "wp_create_draft",
  "wp_publish_or_update_live",
  "wp_update_seo_live",
  "activate_brand_dna",
  "verify_claim",
  // Always require separate owner authorization, in every mode:
  "paid_ads",
  "financial_commitment",
  "irreversible_delete",
  "major_brand_change",
] as const;
export type Action = (typeof ACTIONS)[number];

const ALWAYS_OWNER: ReadonlySet<Action> = new Set(["paid_ads", "financial_commitment", "irreversible_delete", "major_brand_change"]);

export interface PolicyInput {
  mode: AutomationMode;
  action: Action;
  risk?: RiskClass;
  /** Post uses a template + pillar combination the client pre-approved for routine use. */
  preapprovedPattern?: boolean;
  /** Content makes sensitive or regulated claims (health, finance, legal, results). Owner-only, every mode. */
  sensitiveClaims?: boolean;
  /** Tenant passed the autonomous-mode gate (history, rollback tested, signed policy). */
  autonomousEligible?: boolean;
}

export interface ApprovalRequirement {
  required: boolean;
  approverRoles: Role[];
  /** When approval is not required, hours before publish during which reviewers may veto. */
  vetoWindowHours?: number;
  reason: string;
}

const REVIEWERS: Role[] = ["client_owner", "reviewer"];

export function approvalRequirement(input: PolicyInput): ApprovalRequirement {
  const { action } = input;
  // An ineligible tenant in autonomous mode is treated as assisted (fail safe).
  const mode: AutomationMode = input.mode === "autonomous" && !input.autonomousEligible ? "assisted" : input.mode;

  if (ALWAYS_OWNER.has(action)) {
    return { required: true, approverRoles: ["client_owner"], reason: `${action} always requires separate owner authorization.` };
  }
  switch (action) {
    case "generate_draft":
    case "wp_create_draft":
      return { required: false, approverRoles: [], reason: "Drafts are never visible to the public." };
    case "activate_brand_dna":
      return { required: true, approverRoles: ["client_owner"], reason: "Brand DNA changes affect all generated content." };
    case "verify_claim":
      return { required: true, approverRoles: ["client_owner"], reason: "Claims are statements the business makes; the owner verifies them against evidence." };
    case "wp_publish_or_update_live":
    case "wp_update_seo_live":
      return { required: true, approverRoles: REVIEWERS, reason: "Changes to a live website require approval." };
    case "publish_post": {
      if (input.sensitiveClaims) return { required: true, approverRoles: ["client_owner"], reason: "Sensitive or regulated claims require owner authorization." };
      const risk = input.risk ?? "high";
      if (risk !== "low") return { required: true, approverRoles: REVIEWERS, reason: `${risk}-risk content always requires approval.` };
      if (mode === "manual") return { required: true, approverRoles: REVIEWERS, reason: "Manual mode: every publish requires approval." };
      if (input.preapprovedPattern) {
        // Assisted: auto-scheduled, but reviewers are notified and can veto before it goes out.
        // Autonomous (eligible tenants only): publishes without a veto window.
        return mode === "assisted"
          ? { required: false, approverRoles: [], vetoWindowHours: 24, reason: "Assisted mode: pre-approved low-risk pattern, auto-scheduled with a 24h veto window." }
          : { required: false, approverRoles: [], vetoWindowHours: 0, reason: "Autonomous mode: pre-approved low-risk pattern." };
      }
      return { required: true, approverRoles: REVIEWERS, reason: `${mode} mode: low-risk post without a pre-approved pattern.` };
    }
    default:
      // Anything not explicitly listed fails safe: require owner approval.
      return { required: true, approverRoles: ["client_owner"], reason: `${action} requires owner approval.` };
  }
}

export const canApprove = (role: Role, req: ApprovalRequirement): boolean =>
  role === "platform_admin" ? false : req.approverRoles.includes(role);

/** Inputs to the final publish gate, evaluated immediately before calling a platform API. */
export interface PublishGateInput {
  globalPaused: boolean;
  tenantPaused: boolean;
  channelPaused: boolean;
  publishModeEnv: "live" | "dry_run";
  tenantPublishingEnabled: boolean;
  approvalRequired: boolean;
  approvedHash: string | null;
  /** Must be recomputed from the revision body by the caller (contentHash(body)), never read from a column. */
  currentContentHash: string;
  finalLintFindings: readonly Finding[];
  integrationStatus: "connected" | "needs_reauth" | "revoked" | "error";
  capabilityPresent: boolean;
  tokenExpiresAt: Date | null;
  idempotencyKeyUsed: boolean;
  now: Date;
}

const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000;

export interface PublishGateResult {
  decision: "live" | "dry_run" | "blocked";
  reasons: string[];
}

export function evaluatePublishGate(g: PublishGateInput): PublishGateResult {
  const reasons: string[] = [];
  if (g.globalPaused) reasons.push("Platform-wide pause is active.");
  if (g.tenantPaused) reasons.push("Client workspace is paused.");
  if (g.channelPaused) reasons.push("Channel is paused for this client.");
  if (g.approvalRequired && g.approvedHash === null) reasons.push("Approval required but missing.");
  if (g.approvedHash !== null && g.approvedHash !== g.currentContentHash) reasons.push("Content changed after approval.");
  if (hasBlockers(g.finalLintFindings)) reasons.push("Final lint has blocker findings.");
  if (g.integrationStatus !== "connected") reasons.push(`Integration status is ${g.integrationStatus}.`);
  if (!g.capabilityPresent) reasons.push("Connection lacks the capability for this post type.");
  if (g.tokenExpiresAt && g.tokenExpiresAt.getTime() - g.now.getTime() < TOKEN_REFRESH_MARGIN_MS) {
    reasons.push("Access token expired or expires within 10 minutes; refresh before publishing.");
  }
  if (g.idempotencyKeyUsed) reasons.push("This publication was already sent (idempotency key used).");

  if (reasons.length) return { decision: "blocked", reasons };
  if (g.publishModeEnv !== "live") return { decision: "dry_run", reasons: ["PUBLISH_MODE is dry_run."] };
  if (!g.tenantPublishingEnabled) return { decision: "dry_run", reasons: ["Publishing not enabled for this client by a platform admin."] };
  return { decision: "live", reasons: [] };
}
