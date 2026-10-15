import { z } from "zod/v4";

export const CHANNELS = [
  "facebook",
  "instagram",
  "linkedin",
  "threads",
  "bluesky",
  "x",
  "pinterest",
  "tiktok",
  "youtube",
  "google_business_profile",
  "wordpress",
] as const;
export const ChannelSchema = z.enum(CHANNELS);
export type Channel = z.infer<typeof ChannelSchema>;

export const AUTOMATION_MODES = ["manual", "assisted", "autonomous"] as const;
export const AutomationModeSchema = z.enum(AUTOMATION_MODES);
export type AutomationMode = z.infer<typeof AutomationModeSchema>;

export const RISK_CLASSES = ["low", "medium", "high"] as const;
export const RiskClassSchema = z.enum(RISK_CLASSES);
export type RiskClass = z.infer<typeof RiskClassSchema>;

export const ROLES = [
  "platform_admin",
  "agency_operator",
  "client_owner",
  "client_editor",
  "reviewer",
] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

export const OBJECTIVES = ["awareness", "engagement", "traffic", "leads", "retention"] as const;
export const ObjectiveSchema = z.enum(OBJECTIVES);
export type Objective = z.infer<typeof ObjectiveSchema>;

export type Severity = "blocker" | "warning" | "info";

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
  /** Exact text span the finding refers to, when applicable. */
  span?: string;
  field?: string;
}

export const hasBlockers = (findings: readonly Finding[]): boolean =>
  findings.some((f) => f.severity === "blocker");
