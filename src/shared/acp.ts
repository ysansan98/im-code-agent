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
  clientCapabilities: ClientCapabilities;
};

export type FileSystemCapability = {
  readTextFile?: boolean;
  writeTextFile?: boolean;
};

export type ClientCapabilities = {
  fs?: FileSystemCapability;
  terminal?: boolean;
  _meta?: Record<string, unknown>;
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

export type SessionModelInfo = {
  id: string;
  name: string;
  description?: string;
};

export type SessionModelState = {
  currentModelId: string;
  availableModels: SessionModelInfo[];
};

export type NewSessionResult = {
  sessionId: string;
  modes?: unknown[];
  models?: SessionModelState;
  configOptions?: unknown[];
};

export type LoadSessionParams = {
  sessionId: string;
  cwd: string;
  mcpServers: unknown[];
};

export type LoadSessionResult = {
  modes?: unknown[];
  models?: SessionModelState;
  configOptions?: unknown[];
};

export type SetSessionModelParams = {
  sessionId: string;
  modelId: string;
};

export type SetSessionModelResult = Record<string, never>;

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

export type PermissionOptionKind = string;

export type PermissionOption = {
  id: string;
  name: string;
  kind: PermissionOptionKind;
};

export type ToolCallLocation = {
  path?: string;
  line?: number;
};

export type ToolCallContent =
  | {
      type: "text";
      text: string;
    }
  | {
      type: string;
      [key: string]: unknown;
    };

export type ToolCallUpdate = {
  id: string;
  kind?: string;
  status?: string;
  title?: string;
  rawInput?: unknown;
  locations?: ToolCallLocation[];
  content?: ToolCallContent[];
  [key: string]: unknown;
};

export type RequestPermissionParams = {
  sessionId: string;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
};

export type InitializeResult = AgentInitialization;
