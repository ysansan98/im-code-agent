import type { ApprovalKind } from "#shared";
import type { WorkspaceConfig } from "#shared";

export type PolicyDecision =
  | { type: "allow" }
  | { type: "deny"; reason: string }
  | { type: "ask"; reason: string };

type EvaluatePolicyInput = {
  kind: ApprovalKind;
  workspace: WorkspaceConfig;
  hasSessionAllowAll: boolean;
};

export function evaluatePolicy(input: EvaluatePolicyInput): PolicyDecision {
  const { kind, hasSessionAllowAll } = input;

  if (hasSessionAllowAll) {
    return { type: "allow" };
  }

  return {
    type: "ask",
    reason: `Approval required for ${kind}`,
  };
}
