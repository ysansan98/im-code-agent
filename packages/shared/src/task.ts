import type { AgentType } from "./agent.ts";

export const TASK_STATUSES = [
  "pending",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export type Task = {
  id: string;
  workspaceId: string;
  agent: AgentType;
  prompt: string;
  cwd: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
};

export type CreateTaskInput = {
  workspaceId: string;
  agent: AgentType;
  prompt: string;
};

export type AgentHealthStatus = "ready" | "degraded" | "unavailable";

export type AgentHealthCheck = {
  agent: AgentType;
  status: AgentHealthStatus;
  commandAvailable: boolean;
  cliVersion?: string;
  hasStoredAuth: boolean;
  notes: string[];
  checkedAt: string;
};

export type AgentFailureCode =
  | "agent_command_unavailable"
  | "agent_auth_missing"
  | "agent_session_timeout"
  | "agent_session_start_failed"
  | "agent_protocol_error";
