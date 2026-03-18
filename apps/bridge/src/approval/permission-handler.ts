import { randomUUID } from "node:crypto";

import type { PermissionRequestOutcome } from "../agent/agent-process.ts";
import { ApprovalGateway } from "./approval-gateway.ts";
import { evaluatePolicy } from "../policy/policy-engine.ts";
import type { TaskRunner } from "../session/task-runner.ts";
import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalRequest,
  PermissionOption,
  RequestPermissionParams,
  WorkspaceConfig,
} from "@im-code-agent/shared";

const APPROVAL_TIMEOUT_MS = 120_000;

function findWorkspaceByTask(
  taskId: string,
  taskRunner: TaskRunner,
  workspaces: WorkspaceConfig[],
): WorkspaceConfig | undefined {
  const task = taskRunner.getTask(taskId);
  if (!task) {
    return workspaces[0];
  }
  return workspaces.find((item) => item.id === task.workspaceId) ?? workspaces[0];
}

function extractTargetPath(params: RequestPermissionParams): string | undefined {
  const fromLocation = params.toolCall.locations?.[0]?.path;
  if (fromLocation) {
    return fromLocation;
  }
  const rawInput = params.toolCall.rawInput;
  if (rawInput && typeof rawInput === "object") {
    const candidate = (rawInput as Record<string, unknown>).path;
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }
  return undefined;
}

function extractCommand(params: RequestPermissionParams): string | undefined {
  const rawInput = params.toolCall.rawInput;
  if (typeof rawInput === "string" && rawInput.trim()) {
    return rawInput.trim();
  }
  if (rawInput && typeof rawInput === "object") {
    for (const key of ["command", "cmd", "shellCommand", "input", "prompt"]) {
      const value = (rawInput as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  const content = params.toolCall.content;
  if (content && content.length > 0) {
    for (const item of content) {
      if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
        return item.text.trim();
      }
    }
  }
  return undefined;
}

function inferApprovalKind(params: RequestPermissionParams): ApprovalKind {
  const kind = (params.toolCall.kind ?? "").toLowerCase();
  const title = (params.toolCall.title ?? "").toLowerCase();
  const cmd = (extractCommand(params) ?? "").toLowerCase();

  if (
    /network|http|https|curl|wget/.test(kind) ||
    /network|http|https|curl|wget/.test(title) ||
    /curl|wget/.test(cmd)
  ) {
    return "network";
  }
  if (/edit|patch|write|file/.test(kind) || /edit|patch|write|apply/.test(title)) {
    return "write";
  }
  if (/read|view|list/.test(kind) || /read|view|list/.test(title)) {
    return "read";
  }
  if (/cat\s|ls\s|find\s|rg\s/.test(cmd)) {
    return "read";
  }
  return "exec";
}

function chooseAllowOption(
  options: PermissionOption[],
  preferSession: boolean,
): string | undefined {
  if (options.length === 0) {
    return undefined;
  }
  if (preferSession) {
    const sessionOption = options.find((item) => {
      const id = item.id.toLowerCase();
      return id === "approved-for-session" || id === "approve-for-session" || id === "always";
    });
    if (sessionOption) {
      return sessionOption.id;
    }
  }
  const explicitApproved = options.find((item) => {
    const id = item.id.toLowerCase();
    return id === "approved" || id === "approve" || id === "allow" || id === "yes";
  });
  if (explicitApproved) {
    return explicitApproved.id;
  }
  const allow = options.find((item) => item.kind.toLowerCase().startsWith("allow"));
  if (allow) {
    return allow.id;
  }
  return options[0]?.id;
}

function chooseRejectOption(options: PermissionOption[]): string | undefined {
  for (const candidate of ["abort", "rejected", "reject", "cancel"]) {
    const hit = options.find((item) => item.id === candidate);
    if (hit) {
      return hit.id;
    }
  }
  return options.find((item) => item.kind.startsWith("reject"))?.id;
}

function buildApprovalRequest(
  taskId: string,
  kind: ApprovalKind,
  workspace: WorkspaceConfig,
  params: RequestPermissionParams,
): ApprovalRequest {
  const now = new Date();
  const command = extractCommand(params);
  const target = extractTargetPath(params);
  const title = params.toolCall.title ?? `Permission required: ${kind}`;
  return {
    id: randomUUID(),
    taskId,
    kind,
    title,
    cwd: workspace.cwd,
    target,
    command,
    reason: title,
    riskLevel: kind === "read" ? "low" : kind === "write" ? "medium" : "high",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + APPROVAL_TIMEOUT_MS).toISOString(),
  };
}

function buildDeniedWorkspaceOutcome(
  taskId: string,
  params: RequestPermissionParams,
): PermissionRequestOutcome {
  const fallbackRequest: ApprovalRequest = {
    id: randomUUID(),
    taskId,
    kind: "exec",
    title: "Permission denied: workspace not found",
    cwd: process.cwd(),
    reason: "workspace_not_found",
    riskLevel: "high",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString(),
  };
  return {
    status: "denied",
    optionId: chooseRejectOption(params.options),
    approvalRequest: fallbackRequest,
    decision: {
      requestId: fallbackRequest.id,
      taskId,
      decision: "rejected",
      comment: "workspace_not_found",
      decidedAt: new Date().toISOString(),
      decidedBy: "policy-engine",
    },
  };
}

export function createPermissionRequestHandler(args: {
  workspaces: WorkspaceConfig[];
  approvalGateway: ApprovalGateway;
  getTaskRunner: () => TaskRunner;
}): (params: {
  taskId: string;
  params: RequestPermissionParams;
  emitApprovalRequested: (request: ApprovalRequest) => void;
}) => Promise<PermissionRequestOutcome> {
  const { workspaces, approvalGateway, getTaskRunner } = args;

  return async ({ taskId, params, emitApprovalRequested }) => {
    const taskRunner = getTaskRunner();
    const workspace = findWorkspaceByTask(taskId, taskRunner, workspaces);
    if (!workspace) {
      return buildDeniedWorkspaceOutcome(taskId, params);
    }

    const kind = inferApprovalKind(params);
    const request = buildApprovalRequest(taskId, kind, workspace, params);
    const policy = evaluatePolicy({
      kind,
      workspace,
      hasSessionAllowAll: approvalGateway.isSessionAllowAll(taskId),
      targetPath: request.target,
    });

    if (policy.type === "allow") {
      const optionId = chooseAllowOption(params.options, true);
      if (!optionId) {
        return {
          status: "denied",
          optionId: chooseRejectOption(params.options),
          approvalRequest: request,
          decision: {
            requestId: request.id,
            taskId,
            decision: "rejected",
            comment: "allow_option_not_found",
            decidedAt: new Date().toISOString(),
            decidedBy: "policy-engine",
          },
        };
      }

      const decision: ApprovalDecision = {
        requestId: request.id,
        taskId,
        decision: "approved",
        decidedAt: new Date().toISOString(),
        decidedBy: "policy-engine",
        comment: optionId === "approved-for-session" ? "approved-for-session" : "auto-allow",
      };
      return {
        status: "approved",
        optionId,
        approvalRequest: request,
        decision,
      };
    }

    if (policy.type === "deny") {
      return {
        status: "denied",
        optionId: chooseRejectOption(params.options),
        approvalRequest: request,
        decision: {
          requestId: request.id,
          taskId,
          decision: "rejected",
          comment: policy.reason,
          decidedAt: new Date().toISOString(),
          decidedBy: "policy-engine",
        },
      };
    }

    emitApprovalRequested(request);
    const awaited = await approvalGateway.requestAndWait(request, APPROVAL_TIMEOUT_MS);
    if (awaited.status === "approved") {
      const optionId = chooseAllowOption(
        params.options,
        awaited.decision.comment === "approved-for-session",
      );
      if (!optionId) {
        return {
          status: "denied",
          optionId: chooseRejectOption(params.options),
          approvalRequest: request,
          decision: {
            requestId: request.id,
            taskId,
            decision: "rejected",
            comment: "allow_option_not_found",
            decidedAt: new Date().toISOString(),
            decidedBy: "bridge",
          },
        };
      }
      return {
        status: "approved",
        optionId,
        approvalRequest: request,
        decision: awaited.decision,
      };
    }

    if (awaited.status === "rejected") {
      return {
        status: "rejected",
        optionId: chooseRejectOption(params.options),
        approvalRequest: request,
        decision: awaited.decision,
      };
    }

    return {
      status: "expired",
      optionId: chooseRejectOption(params.options),
      approvalRequest: request,
      decision: {
        requestId: request.id,
        taskId,
        decision: "rejected",
        comment: "approval_timeout",
        decidedAt: new Date().toISOString(),
        decidedBy: "system-timeout",
      },
    };
  };
}
