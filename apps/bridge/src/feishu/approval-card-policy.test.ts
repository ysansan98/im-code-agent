import { describe, expect, test } from "vite-plus/test";

import type { ApprovalDecision } from "@im-code-agent/shared";

import { shouldPatchApprovalSummary } from "./approval-card-policy.ts";

function createDecision(comment?: string): ApprovalDecision {
  return {
    requestId: "r1",
    taskId: "t1",
    decision: "rejected",
    comment,
    decidedAt: new Date().toISOString(),
    decidedBy: "tester",
  };
}

describe("shouldPatchApprovalSummary", () => {
  test("returns false for timeout decision", () => {
    expect(shouldPatchApprovalSummary(createDecision("approval_timeout"))).toBe(false);
  });

  test("returns true for non-timeout decision", () => {
    expect(shouldPatchApprovalSummary(createDecision("manual_reject"))).toBe(true);
  });
});
