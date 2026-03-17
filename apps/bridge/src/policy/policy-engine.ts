import type { ApprovalKind } from "@im-code-agent/shared";
import type { WorkspaceConfig } from "@im-code-agent/shared";
import { isAbsolute, resolve } from "node:path";

export type PolicyDecision =
  | { type: "allow" }
  | { type: "deny"; reason: string }
  | { type: "ask"; reason: string };

type EvaluatePolicyInput = {
  kind: ApprovalKind;
  workspace: WorkspaceConfig;
  hasSessionAllowAll: boolean;
  targetPath?: string;
};

function isBlockedPath(targetPath: string, workspace: WorkspaceConfig): boolean {
  if (!workspace.blockedPaths || workspace.blockedPaths.length === 0) {
    return false;
  }

  const absoluteTarget = isAbsolute(targetPath) ? targetPath : resolve(workspace.cwd, targetPath);
  return workspace.blockedPaths.some((blocked) => {
    const absoluteBlocked = isAbsolute(blocked) ? blocked : resolve(workspace.cwd, blocked);
    return absoluteTarget === absoluteBlocked || absoluteTarget.startsWith(`${absoluteBlocked}/`);
  });
}

export function evaluatePolicy(input: EvaluatePolicyInput): PolicyDecision {
  const { kind, workspace, hasSessionAllowAll, targetPath } = input;
  if (targetPath && isBlockedPath(targetPath, workspace)) {
    return {
      type: "deny",
      reason: `Path is blocked by workspace policy: ${targetPath}`,
    };
  }

  if (hasSessionAllowAll) {
    return { type: "allow" };
  }

  if (kind === "read") {
    if (workspace.approvalMode === "ask") {
      return { type: "ask", reason: "Approval required for read in ask mode" };
    }
    return { type: "allow" };
  }

  if (kind === "write" && workspace.approvalMode === "read-write-auto") {
    return { type: "allow" };
  }

  return {
    type: "ask",
    reason: `Approval required for ${kind}`,
  };
}
