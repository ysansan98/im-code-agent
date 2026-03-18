import type { AgentCommandConfig, AgentType } from "./agent.ts";

export type WorkspaceConfig = {
  id: string;
  name: string;
  cwd: string;
  blockedPaths?: string[];
  allowedAgents: AgentType[];
};

export type FeishuConfig = {
  appId: string;
  appSecret: string;
};

export type BridgeConfig = {
  feishu?: FeishuConfig;
  yoloMode: boolean;
  agents: Partial<Record<AgentType, AgentCommandConfig>>;
  workspaces: WorkspaceConfig[];
};
