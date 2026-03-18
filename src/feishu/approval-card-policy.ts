import type { ApprovalDecision } from "#shared";

export function shouldPatchApprovalSummary(decision: ApprovalDecision): boolean {
  return decision.comment !== "approval_timeout";
}
