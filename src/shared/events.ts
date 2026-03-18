import type { ApprovalDecision, ApprovalRequest } from "./approval.ts";
import type { AgentType } from "./agent.ts";

type BridgeEventBase = {
  taskId: string;
  timestamp: string;
};

export type ToolInvocation = {
  updateType: string;
  toolCallId: string;
  toolName: string;
  toolNameSource: string;
  kind: string;
  status: string;
  title?: string;
  query?: string;
  url?: string;
  command?: string;
  path?: string;
  error?: string;
  fieldPaths: string[];
};

export type TaskStartedEvent = BridgeEventBase & {
  type: "task.started";
  workspaceId: string;
  agent: AgentType;
};

export type TaskOutputEvent = BridgeEventBase & {
  type: "task.output";
  stream: "stdout" | "stderr" | "agent";
  chunk: string;
};

export type TaskApprovalRequestedEvent = BridgeEventBase & {
  type: "task.approval_requested";
  request: ApprovalRequest;
};

export type TaskApprovalResolvedEvent = BridgeEventBase & {
  type: "task.approval_resolved";
  decision: ApprovalDecision;
};

export type TaskToolUpdateEvent = BridgeEventBase & {
  type: "task.tool_update";
  update: ToolInvocation;
};

export type TaskCompletedEvent = BridgeEventBase & {
  type: "task.completed";
  summary?: string;
};

export type TaskFailedEvent = BridgeEventBase & {
  type: "task.failed";
  code?: string;
  error: string;
};

export type TaskCancelledEvent = BridgeEventBase & {
  type: "task.cancelled";
  reason?: string;
};

export type BridgeEvent =
  | TaskStartedEvent
  | TaskOutputEvent
  | TaskApprovalRequestedEvent
  | TaskApprovalResolvedEvent
  | TaskToolUpdateEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | TaskCancelledEvent;
