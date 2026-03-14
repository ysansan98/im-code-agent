import type { AgentInitialization } from "./agent.ts";

export type JsonRpcId = number | string;

export type JsonRpcRequest<TParams = unknown> = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: TParams;
};

export type JsonRpcNotification<TParams = unknown> = {
  jsonrpc: "2.0";
  method: string;
  params?: TParams;
};

export type JsonRpcSuccess<TResult = unknown> = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: TResult;
};

export type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

export type InitializeParams = {
  protocolVersion: number;
  clientCapabilities: Record<string, unknown>;
};

export type ContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      mimeType: string;
      data: string;
    };

export type NewSessionParams = {
  cwd: string;
  mcpServers: unknown[];
};

export type NewSessionResult = {
  sessionId: string;
};

export type LoadSessionParams = {
  sessionId: string;
  cwd: string;
  mcpServers: unknown[];
};

export type LoadSessionResult = {
  modes?: unknown[];
  models?: unknown[];
  configOptions?: unknown[];
};

export type PromptParams = {
  sessionId: string;
  prompt: ContentBlock[];
};

export type PromptResult = {
  stopReason: string;
};

export type SessionUpdateNotification = {
  sessionId: string;
  update: {
    sessionUpdate: string;
    content?: ContentBlock;
    availableCommands?: Array<{
      name: string;
      description: string;
      input?: {
        hint?: string;
      } | null;
    }>;
    used?: number;
    size?: number;
    [key: string]: unknown;
  };
};

export type InitializeResult = AgentInitialization;
