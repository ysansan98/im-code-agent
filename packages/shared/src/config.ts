import type { AgentCommandConfig, AgentType } from "./agent.ts";

export const APPROVAL_MODES = ["ask", "read-auto", "read-write-auto"] as const;

export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export type WorkspaceConfig = {
  id: string;
  name: string;
  cwd: string;
  approvalMode: ApprovalMode;
  blockedPaths?: string[];
  allowedAgents: AgentType[];
};

export type FeishuConfig = {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
};

export type BridgeConfig = {
  deviceId: string;
  wsUrl?: string;
  debugPort?: number;
  feishu?: FeishuConfig;
  agents: Partial<Record<AgentType, AgentCommandConfig>>;
  workspaces: WorkspaceConfig[];
};
