export const AGENT_TYPES = ["codex", "claude-code"] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

export type AgentCommandConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type AgentInitialization = {
  protocolVersion: number;
  agentCapabilities: {
    loadSession?: boolean;
    promptCapabilities?: {
      image?: boolean;
      audio?: boolean;
      embeddedContext?: boolean;
    };
    mcpCapabilities?: {
      http?: boolean;
      sse?: boolean;
    };
    sessionCapabilities?: Record<string, unknown>;
  };
  authMethods?: Array<{
    id: string;
    name: string;
    description?: string;
  }>;
  agentInfo?: {
    name: string;
    title?: string;
    version?: string;
  };
};
