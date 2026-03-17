import type { ApprovalDecision } from "@im-code-agent/shared";

export function shouldPatchApprovalSummary(decision: ApprovalDecision): boolean {
  return decision.comment !== "approval_timeout";
}
