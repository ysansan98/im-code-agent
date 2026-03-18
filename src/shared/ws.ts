import type { ApprovalDecision } from "./approval.ts";
import type { AgentType } from "./agent.ts";
import type { BridgeEvent } from "./events.ts";
import type { WorkspaceConfig } from "./config.ts";

type EnvelopeBase = {
  type: string;
};

export type BridgeRegisterMessage = EnvelopeBase & {
  type: "bridge.register";
  deviceId: string;
  workspaces: WorkspaceConfig[];
  supportedAgents: AgentType[];
};

export type BridgeReadyMessage = EnvelopeBase & {
  type: "bridge.ready";
  deviceId: string;
  timestamp: string;
};

export type TaskCreateMessage = EnvelopeBase & {
  type: "task.create";
  requestId: string;
  workspaceId: string;
  agent: AgentType;
  prompt: string;
};

export type TaskCancelMessage = EnvelopeBase & {
  type: "task.cancel";
  taskId: string;
  reason?: string;
};

export type ApprovalDecisionMessage = EnvelopeBase & {
  type: "approval.decision";
  decision: ApprovalDecision;
};

export type PingMessage = EnvelopeBase & {
  type: "ping";
  timestamp: string;
};

export type PongMessage = EnvelopeBase & {
  type: "pong";
  timestamp: string;
};

export type BridgeEventMessage = EnvelopeBase & {
  type: "bridge.event";
  event: BridgeEvent;
};

export type BridgeInboundMessage =
  | TaskCreateMessage
  | TaskCancelMessage
  | ApprovalDecisionMessage
  | PingMessage;

export type BridgeOutboundMessage =
  | BridgeRegisterMessage
  | BridgeReadyMessage
  | BridgeEventMessage
  | PongMessage;
