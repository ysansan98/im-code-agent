import type { AgentCommandConfig, AgentType, BridgeConfig } from "#shared";

export function resolveAgentCommand(
  config: BridgeConfig,
  agentType: AgentType,
): AgentCommandConfig {
  const command = config.agents[agentType];
  if (!command) {
    throw new Error(`Agent not configured: ${agentType}`);
  }

  return command;
}
