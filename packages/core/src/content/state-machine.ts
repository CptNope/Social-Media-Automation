import type { Finding } from "../types.ts";
import { hasBlockers } from "../types.ts";

export const CONTENT_STATES = [
  "draft",
  "in_review",
  "approved",
  "scheduled",
  "publishing",
  "published",
  "exported",
  "failed",
  "paused",
  "archived",
] as const;
export type ContentState = (typeof CONTENT_STATES)[number];

export type ContentEvent =
  | { type: "submit"; findings: readonly Finding[] }
  | { type: "approve"; contentHash: string }
  /** System approval permitted by the approval policy (required: false). Assisted mode carries a veto deadline. */
  | { type: "auto_approve"; contentHash: string; policyReason: string; vetoUntil: string | null }
  | { type: "reject"; reason: string }
  | { type: "request_changes"; reason: string }
  | { type: "edit"; newContentHash: string }
  | { type: "schedule"; at: string }
  | { type: "start_publish" }
  | { type: "publish_succeeded"; externalId: string }
  | { type: "mark_exported" }
  | { type: "publish_failed"; error: string; permanent: boolean }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "archive" };

export interface ContentItemState {
  state: ContentState;
  /** Hash of the current revision. */
  contentHash: string;
  /** Hash that was approved, if any. Approval is valid only while it equals contentHash. */
  approvedHash: string | null;
  /** State to return to on resume. */
  pausedFrom: ContentState | null;
}

export interface Actor {
  type: "user" | "agent" | "system";
  id: string;
}

export interface AuditEvent {
  action: string;
  actor: Actor;
  before: Pick<ContentItemState, "state" | "approvedHash">;
  after: Pick<ContentItemState, "state" | "approvedHash">;
  detail?: Record<string, unknown>;
}

export class TransitionError extends Error {
  constructor(
    public readonly from: ContentState,
    public readonly event: ContentEvent["type"],
    reason: string,
  ) {
    super(`Cannot ${event} from ${from}: ${reason}`);
    this.name = "TransitionError";
  }
}

const EDITABLE: ReadonlySet<ContentState> = new Set(["draft", "in_review", "approved", "scheduled", "failed"]);

/**
 * Pure transition function. Returns the next state plus the audit event that must be
 * written in the same database transaction as the state change.
 */
export function transition(current: ContentItemState, event: ContentEvent, actor: Actor): { next: ContentItemState; audit: AuditEvent } {
  const s = current.state;
  const fail = (why: string): never => {
    throw new TransitionError(s, event.type, why);
  };
  let next: ContentItemState = { ...current };
  let detail: Record<string, unknown> | undefined;

  switch (event.type) {
    case "submit":
      if (s !== "draft") fail("only drafts can be submitted");
      if (hasBlockers(event.findings)) fail("draft has blocker findings");
      next.state = "in_review";
      break;

    case "approve":
      if (s !== "in_review") fail("only items in review can be approved");
      if (actor.type !== "user") fail("only a human can approve");
      if (event.contentHash !== current.contentHash) fail("approval is for a different revision");
      next.state = "approved";
      next.approvedHash = event.contentHash;
      break;

    case "auto_approve":
      if (s !== "in_review") fail("only items in review can be auto-approved");
      if (actor.type !== "system") fail("only the policy engine can auto-approve");
      if (!event.policyReason) fail("auto-approval requires the policy decision that allowed it");
      if (event.contentHash !== current.contentHash) fail("approval is for a different revision");
      next.state = "approved";
      next.approvedHash = event.contentHash;
      detail = { policyReason: event.policyReason, vetoUntil: event.vetoUntil };
      break;

    case "reject":
    case "request_changes":
      if (s !== "in_review" && s !== "approved" && s !== "scheduled") fail("nothing to reject");
      if (actor.type !== "user") fail("only a human can reject");
      next.state = "draft";
      next.approvedHash = null;
      detail = { reason: event.reason };
      break;

    case "edit":
      if (!EDITABLE.has(s)) fail("item is not editable in this state");
      next.contentHash = event.newContentHash;
      if (event.newContentHash !== current.contentHash) {
        // Any change to content invalidates prior approval and returns the item to draft.
        next.approvedHash = null;
        next.state = "draft";
      }
      break;

    case "schedule":
      if (s !== "approved") fail("only approved items can be scheduled");
      if (current.approvedHash !== current.contentHash) fail("approval does not match current content");
      next.state = "scheduled";
      detail = { at: event.at };
      break;

    case "start_publish":
      if (s !== "scheduled" && s !== "approved") fail("item is not ready to publish");
      if (current.approvedHash !== current.contentHash) fail("approval does not match current content");
      next.state = "publishing";
      break;

    case "publish_succeeded":
      if (s !== "publishing") fail("item is not publishing");
      next.state = "published";
      detail = { externalId: event.externalId };
      break;

    case "mark_exported":
      if (s !== "approved" && s !== "scheduled") fail("only approved items can be exported");
      next.state = "exported";
      break;

    case "publish_failed":
      if (s !== "publishing") fail("item is not publishing");
      next.state = event.permanent ? "failed" : "scheduled";
      detail = { error: event.error, permanent: event.permanent };
      break;

    case "pause":
      // An in-flight publish must finish (and be recorded) first; the publish gate blocks new sends.
      if (s === "publishing") fail("publish already in flight; pause the channel to stop further sends");
      if (s === "published" || s === "archived" || s === "paused" || s === "exported") fail("item cannot be paused");
      next.pausedFrom = s;
      next.state = "paused";
      break;

    case "resume":
      if (s !== "paused" || !current.pausedFrom) fail("item is not paused");
      next.state = current.pausedFrom!;
      next.pausedFrom = null;
      break;

    case "archive":
      if (s === "publishing") fail("cannot archive while publishing");
      next.state = "archived";
      break;
  }

  return {
    next,
    audit: {
      action: `content.${event.type}`,
      actor,
      before: { state: current.state, approvedHash: current.approvedHash },
      after: { state: next.state, approvedHash: next.approvedHash },
      ...(detail ? { detail } : {}),
    },
  };
}
