import type { AgentCommandConfig, AgentType } from "./agent.ts";

export type ApprovalMode = "ask" | "read-auto" | "read-write-auto";

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
