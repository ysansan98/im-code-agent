import type { ApprovalKind } from "@im-code-agent/shared";

export type PolicyDecision =
  | { type: "allow" }
  | { type: "deny"; reason: string }
  | { type: "ask"; reason: string };

export function evaluatePolicy(kind: ApprovalKind): PolicyDecision {
  if (kind === "read") {
    return { type: "allow" };
  }

  return { type: "ask", reason: `Approval required for ${kind}` };
}
