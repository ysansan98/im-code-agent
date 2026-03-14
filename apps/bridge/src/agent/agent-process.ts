import { access } from "node:fs/promises";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  AgentFailureCode,
  AgentHealthCheck,
  AgentInitialization,
  AgentType,
  BridgeConfig,
  InitializeParams,
  InitializeResult,
  LoadSessionParams,
  LoadSessionResult,
  NewSessionParams,
  NewSessionResult,
  PromptParams,
  PromptResult,
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcSuccess,
  SessionUpdateNotification,
} from "@im-code-agent/shared";

import { resolveAgentCommand } from "./agent-adapter.ts";
import type { Logger } from "../utils/logger.ts";

export type AgentRunOptions = {
  taskId: string;
  agent: AgentType;
  cwd: string;
  resumeSessionId?: string;
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  timeoutMs: number;
};

type AgentChild = {
  child: ChildProcessWithoutNullStreams;
  nextRequestId: number;
  pendingRequests: Map<JsonRpcId, PendingRequest>;
  stdoutBuffer: string;
  stderrChunks: string[];
  initialization?: AgentInitialization;
  sessionId?: string;
};

export type AgentEvent =
  | {
      type: "agent.output";
      taskId: string;
      text: string;
    }
  | {
      type: "agent.available_commands";
      taskId: string;
      commands: SessionUpdateNotification["update"]["availableCommands"];
    }
  | {
      type: "agent.usage";
      taskId: string;
      used?: number;
      size?: number;
    };

export class AgentProcessError extends Error {
  constructor(
    readonly code: AgentFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentProcessError";
  }
}

export class AgentProcess {
  readonly #children = new Map<string, AgentChild>();
  readonly #defaultRequestTimeoutMs = 30_000;
  readonly #promptIdleTimeoutMs = 120_000;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
    private readonly onEvent?: (event: AgentEvent) => void,
  ) {}

  async checkHealth(agent: AgentType): Promise<AgentHealthCheck> {
    const command = resolveAgentCommand(this.config, agent);
    const checkedAt = new Date().toISOString();
    const notes: string[] = [];
    let commandAvailable = true;

    try {
      await access(command.command);
    } catch {
      commandAvailable = false;
      notes.push(`Command is not accessible: ${command.command}`);
    }

    let cliVersion: string | undefined;
    if (agent === "codex") {
      const result = spawnSync("codex", ["--version"], {
        encoding: "utf8",
      });
      if (result.status === 0) {
        cliVersion = result.stdout.trim();
      } else {
        notes.push("codex CLI is installed but `codex --version` did not exit cleanly");
      }
    }

    const authCheck = spawnSync("test", ["-f", `${process.env.HOME}/.codex/auth.json`], {
      stdio: "ignore",
    });
    const hasStoredAuth = authCheck.status === 0;
    if (!hasStoredAuth) {
      notes.push("No ~/.codex/auth.json detected");
    }

    let status: AgentHealthCheck["status"] = "ready";
    if (!commandAvailable) {
      status = "unavailable";
    } else if (!hasStoredAuth) {
      status = "degraded";
    }

    return {
      agent,
      status,
      commandAvailable,
      cliVersion,
      hasStoredAuth,
      notes,
      checkedAt,
    };
  }

  async start(
    options: AgentRunOptions,
  ): Promise<{ initialization: AgentInitialization; sessionId: string }> {
    if (this.#children.has(options.taskId)) {
      throw new Error(`Task is already running: ${options.taskId}`);
    }

    const command = resolveAgentCommand(this.config, options.agent);
    const health = await this.checkHealth(options.agent);
    if (!health.commandAvailable) {
      throw new AgentProcessError("agent_command_unavailable", health.notes.join("; "));
    }

    const child = spawn(command.command, command.args ?? [], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...command.env,
      },
      stdio: "pipe",
    });

    const agentChild: AgentChild = {
      child,
      nextRequestId: 1,
      pendingRequests: new Map(),
      stdoutBuffer: "",
      stderrChunks: [],
    };

    this.#children.set(options.taskId, agentChild);

    child.stdout.on("data", (chunk: Buffer) => {
      this.handleStdout(options.taskId, chunk.toString());
    });

    child.stderr.on("data", (chunk: Buffer) => {
      agentChild.stderrChunks.push(chunk.toString());
      this.logger.warn("agent stderr", {
        taskId: options.taskId,
        chunk: chunk.toString(),
      });
    });

    child.on("spawn", () => {
      this.logger.info("agent process spawned", {
        taskId: options.taskId,
        agent: options.agent,
        command: command.command,
        args: command.args ?? [],
        cwd: options.cwd,
      });
    });

    child.on("error", (error) => {
      this.logger.error("agent process error", {
        taskId: options.taskId,
        error: error.message,
      });
    });

    child.on("exit", (code, signal) => {
      this.rejectAllPendingRequests(options.taskId, "agent process exited");
      this.#children.delete(options.taskId);
      this.logger.info("agent process exited", {
        taskId: options.taskId,
        code,
        signal,
      });
    });

    const initialization = await this.initialize(options.taskId);
    agentChild.initialization = initialization;
    let sessionId: string;
    if (options.resumeSessionId) {
      try {
        await this.loadSession(options.taskId, options.resumeSessionId, options.cwd);
        sessionId = options.resumeSessionId;
        this.logger.info("agent session resumed", {
          taskId: options.taskId,
          sessionId,
          cwd: options.cwd,
        });
      } catch (error) {
        this.logger.warn("agent session resume failed, fallback to new session", {
          taskId: options.taskId,
          resumeSessionId: options.resumeSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        const session = await this.newSession(options.taskId, options.cwd);
        sessionId = session.sessionId;
      }
    } else {
      const session = await this.newSession(options.taskId, options.cwd);
      sessionId = session.sessionId;
    }
    agentChild.sessionId = sessionId;

    this.logger.info("agent initialized", {
      taskId: options.taskId,
      protocolVersion: initialization.protocolVersion,
      agentName: initialization.agentInfo?.name,
      agentVersion: initialization.agentInfo?.version,
      sessionId,
    });

    return {
      initialization,
      sessionId,
    };
  }

  async stop(taskId: string): Promise<void> {
    const agentChild = this.#children.get(taskId);
    if (!agentChild) {
      return;
    }

    this.rejectAllPendingRequests(taskId, "agent process stopped");
    agentChild.child.kill("SIGTERM");
    this.#children.delete(taskId);
  }

  private async initialize(taskId: string): Promise<InitializeResult> {
    const params: InitializeParams = {
      protocolVersion: 1,
      clientCapabilities: {},
    };

    return this.sendRequest<InitializeParams, InitializeResult>(taskId, "initialize", params);
  }

  async prompt(taskId: string, promptText: string): Promise<PromptResult> {
    const agentChild = this.getChild(taskId);
    if (!agentChild.sessionId) {
      throw new Error(`Agent session not initialized for task: ${taskId}`);
    }

    const params: PromptParams = {
      sessionId: agentChild.sessionId,
      prompt: [
        {
          type: "text",
          text: promptText,
        },
      ],
    };

    return this.sendRequest<PromptParams, PromptResult>(taskId, "session/prompt", params);
  }

  private async newSession(taskId: string, cwd: string): Promise<NewSessionResult> {
    const params: NewSessionParams = {
      cwd,
      mcpServers: [],
    };

    try {
      return await this.sendRequest<NewSessionParams, NewSessionResult>(
        taskId,
        "session/new",
        params,
      );
    } catch (error) {
      throw this.mapRequestError(taskId, "session/new", error);
    }
  }

  private async loadSession(
    taskId: string,
    sessionId: string,
    cwd: string,
  ): Promise<LoadSessionResult> {
    const params: LoadSessionParams = {
      sessionId,
      cwd,
      mcpServers: [],
    };

    try {
      return await this.sendRequest<LoadSessionParams, LoadSessionResult>(
        taskId,
        "session/load",
        params,
      );
    } catch (error) {
      throw this.mapRequestError(taskId, "session/load", error);
    }
  }

  private async sendRequest<TParams, TResult>(
    taskId: string,
    method: string,
    params?: TParams,
  ): Promise<TResult> {
    const agentChild = this.getChild(taskId);
    const id = agentChild.nextRequestId++;
    const payload: JsonRpcRequest<TParams> = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };

    return new Promise<TResult>((resolve, reject) => {
      const timeoutMs =
        method === "session/prompt" ? this.#promptIdleTimeoutMs : this.#defaultRequestTimeoutMs;
      const timer = this.createRequestTimer(taskId, id, method, timeoutMs);

      agentChild.pendingRequests.set(id, {
        method,
        timer,
        timeoutMs,
        resolve: (value) => resolve(value as TResult),
        reject,
      });

      this.writeMessage(taskId, payload);
    });
  }

  private writeMessage(taskId: string, message: JsonRpcRequest | JsonRpcNotification): void {
    const agentChild = this.getChild(taskId);
    agentChild.child.stdin.write(`${JSON.stringify(message)}\n`);
    this.logger.info("agent request sent", {
      taskId,
      method: message.method,
      hasId: "id" in message,
    });
  }

  private handleStdout(taskId: string, chunk: string): void {
    const agentChild = this.getChild(taskId);
    agentChild.stdoutBuffer += chunk;

    const lines = agentChild.stdoutBuffer.split("\n");
    agentChild.stdoutBuffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      this.handleMessage(taskId, line);
    }
  }

  private handleMessage(taskId: string, line: string): void {
    let message: JsonRpcMessage;

    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (error) {
      this.logger.warn("agent emitted non-json stdout", {
        taskId,
        line,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if ("id" in message && "result" in message) {
      this.handleSuccess(taskId, message);
      return;
    }

    if ("id" in message && "error" in message) {
      this.handleFailure(taskId, message);
      return;
    }

    if ("method" in message && message.method === "session/update") {
      this.handleSessionUpdate(taskId, message as JsonRpcNotification<SessionUpdateNotification>);
      return;
    }

    this.logger.info("agent notification received", {
      taskId,
      method: message.method,
    });
  }

  private handleSuccess(taskId: string, message: JsonRpcSuccess): void {
    const agentChild = this.getChild(taskId);
    const pending = agentChild.pendingRequests.get(message.id);
    if (!pending) {
      this.logger.warn("agent response without pending request", {
        taskId,
        id: message.id,
      });
      return;
    }

    agentChild.pendingRequests.delete(message.id);
    clearTimeout(pending.timer);
    pending.resolve(message.result);
  }

  private handleFailure(taskId: string, message: JsonRpcFailure): void {
    const agentChild = this.getChild(taskId);
    if (message.id === null) {
      this.logger.error("agent emitted rpc error without request id", {
        taskId,
        code: message.error.code,
        message: message.error.message,
      });
      return;
    }

    const pending = agentChild.pendingRequests.get(message.id);
    if (!pending) {
      this.logger.warn("agent error without pending request", {
        taskId,
        id: message.id,
        code: message.error.code,
        message: message.error.message,
      });
      return;
    }

    agentChild.pendingRequests.delete(message.id);
    clearTimeout(pending.timer);
    pending.reject(
      new AgentProcessError(
        "agent_protocol_error",
        `ACP request failed for ${pending.method}: ${message.error.message} (${message.error.code})`,
      ),
    );
  }

  private handleSessionUpdate(
    taskId: string,
    message: JsonRpcNotification<SessionUpdateNotification>,
  ): void {
    this.refreshPromptTimeout(taskId);
    const update = message.params?.update;

    if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      this.onEvent?.({
        type: "agent.output",
        taskId,
        text: update.content.text,
      });
    }

    if (update?.sessionUpdate === "available_commands_update") {
      this.onEvent?.({
        type: "agent.available_commands",
        taskId,
        commands: update.availableCommands,
      });
    }

    if (update?.sessionUpdate === "usage_update") {
      this.onEvent?.({
        type: "agent.usage",
        taskId,
        used: update.used,
        size: update.size,
      });
    }

    const processText = this.formatProcessUpdate(update);
    if (processText) {
      this.onEvent?.({
        type: "agent.output",
        taskId,
        text: processText,
      });
    }

    this.logger.info("agent session update received", {
      taskId,
      sessionId: message.params?.sessionId,
      updateType: update?.sessionUpdate,
      contentType: update?.content?.type,
      text: update?.content?.type === "text" ? update.content.text : undefined,
    });
  }

  private formatProcessUpdate(
    update: SessionUpdateNotification["update"] | undefined,
  ): string | undefined {
    if (!update) {
      return undefined;
    }
    if (update.sessionUpdate === "agent_message_chunk") {
      return undefined;
    }
    if (update.sessionUpdate === "usage_update") {
      return undefined;
    }
    if (update.sessionUpdate === "available_commands_update") {
      return undefined;
    }

    if (update.sessionUpdate.includes("tool")) {
      return this.formatToolUpdate(update);
    }

    const summary = this.summarizeUpdate(update);
    return `\n[${update.sessionUpdate}]${summary ? ` ${summary}` : ""}\n`;
  }

  private formatToolUpdate(update: SessionUpdateNotification["update"]): string {
    const toolName = this.extractToolName(update) ?? "工具调用";
    const status = this.readStringField(update, ["status", "state", "phase"]);
    const command =
      this.readStringField(update, ["command", "cmd", "shellCommand"]) ??
      this.findStringByKeyPattern(update as Record<string, unknown>, /(cmd|command|shell)/i);
    const path =
      this.readStringField(update, ["path", "cwd", "targetPath"]) ??
      this.findStringByKeyPattern(update as Record<string, unknown>, /(cwd|path|target)/i);
    const error = this.readStringField(update, ["error", "message"]);

    const lines = [`\n[tool] ${toolName}${status ? ` (${status})` : ""}`];
    if (command) {
      lines.push(`cmd: ${this.truncate(command, 160)}`);
    }
    if (path) {
      lines.push(`path: ${this.truncate(path, 120)}`);
    }
    if (error) {
      lines.push(`error: ${this.truncate(error, 160)}`);
    }
    lines.push("");
    return lines.join("\n");
  }

  private extractToolName(update: SessionUpdateNotification["update"]): string | undefined {
    const direct =
      this.readStringField(update, ["toolName", "tool_name", "tool", "name"]) ??
      this.findStringByKeyPattern(
        update as Record<string, unknown>,
        /(tool.*name|name|tool|action)/i,
      );
    if (direct && !this.isGenericToolValue(direct)) {
      return direct;
    }

    const command =
      this.readStringField(update, ["command", "cmd", "shellCommand"]) ??
      this.findStringByKeyPattern(update as Record<string, unknown>, /(cmd|command|shell)/i);
    if (command) {
      return command.split(/\s+/)[0];
    }
    return undefined;
  }

  private summarizeUpdate(update: SessionUpdateNotification["update"]): string {
    const content = update.content;
    if (content?.type === "text") {
      return content.text;
    }
    if (content?.type === "image") {
      return `[image:${content.mimeType}]`;
    }

    const {
      sessionUpdate: _sessionUpdate,
      content: _content,
      availableCommands: _availableCommands,
      used: _used,
      size: _size,
      ...compact
    } = update;

    const text = JSON.stringify(compact);
    if (!text || text === "{}") {
      return "";
    }
    return text.length > 300 ? `${text.slice(0, 300)}...` : text;
  }

  private readStringField(
    update: SessionUpdateNotification["update"],
    keys: string[],
  ): string | undefined {
    const dict = update as Record<string, unknown>;
    for (const key of keys) {
      const value = dict[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
      if (value && typeof value === "object") {
        const nested = value as Record<string, unknown>;
        for (const nestedKey of ["name", "text", "command", "path", "message"]) {
          const nestedValue = nested[nestedKey];
          if (typeof nestedValue === "string" && nestedValue.trim()) {
            return nestedValue.trim();
          }
        }
      }
    }
    return undefined;
  }

  private findStringByKeyPattern(
    value: Record<string, unknown>,
    pattern: RegExp,
    depth = 0,
  ): string | undefined {
    if (depth > 6) {
      return undefined;
    }
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && item.trim() && pattern.test(key)) {
        return item.trim();
      }
      if (item && typeof item === "object") {
        if (Array.isArray(item)) {
          for (const entry of item) {
            if (entry && typeof entry === "object") {
              const nested = this.findStringByKeyPattern(
                entry as Record<string, unknown>,
                pattern,
                depth + 1,
              );
              if (nested) {
                return nested;
              }
            }
          }
          continue;
        }
        const nested = this.findStringByKeyPattern(
          item as Record<string, unknown>,
          pattern,
          depth + 1,
        );
        if (nested) {
          return nested;
        }
      }
    }
    return undefined;
  }

  private isGenericToolValue(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    return (
      normalized === "tool" ||
      normalized === "tools" ||
      normalized === "in_progress" ||
      normalized === "completed" ||
      normalized === "running" ||
      normalized === "status"
    );
  }

  private truncate(text: string, maxLen: number): string {
    return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
  }

  private getChild(taskId: string): AgentChild {
    const agentChild = this.#children.get(taskId);
    if (!agentChild) {
      throw new Error(`Agent process not found for task: ${taskId}`);
    }

    return agentChild;
  }

  private createRequestTimer(
    taskId: string,
    requestId: JsonRpcId,
    method: string,
    timeoutMs: number,
  ): NodeJS.Timeout {
    return setTimeout(() => {
      const agentChild = this.#children.get(taskId);
      const pending = agentChild?.pendingRequests.get(requestId);
      if (!pending) {
        return;
      }
      agentChild?.pendingRequests.delete(requestId);
      pending.reject(
        new AgentProcessError(
          "agent_session_timeout",
          `ACP request timed out for ${method} after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
  }

  private refreshPromptTimeout(taskId: string): void {
    const agentChild = this.#children.get(taskId);
    if (!agentChild) {
      return;
    }
    for (const [requestId, pending] of agentChild.pendingRequests.entries()) {
      if (pending.method !== "session/prompt") {
        continue;
      }
      clearTimeout(pending.timer);
      pending.timer = this.createRequestTimer(taskId, requestId, pending.method, pending.timeoutMs);
    }
  }

  private rejectAllPendingRequests(taskId: string, reason: string): void {
    const agentChild = this.#children.get(taskId);
    if (!agentChild) {
      return;
    }
    for (const [id, pending] of agentChild.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(
        new AgentProcessError(
          "agent_session_start_failed",
          `ACP request interrupted for ${pending.method}: ${reason}`,
        ),
      );
      agentChild.pendingRequests.delete(id);
    }
  }

  private mapRequestError(taskId: string, method: string, error: unknown): Error {
    if (error instanceof AgentProcessError) {
      if (error.code === "agent_session_timeout") {
        const stderr = this.getChild(taskId).stderrChunks.join("\n");
        const hasAuthFile =
          spawnSync("test", ["-f", `${process.env.HOME}/.codex/auth.json`], {
            stdio: "ignore",
          }).status === 0;

        if (!hasAuthFile) {
          return new AgentProcessError(
            "agent_auth_missing",
            "Codex authentication is missing. Please complete local Codex login first.",
          );
        }

        return new AgentProcessError(
          "agent_session_timeout",
          stderr
            ? `codex-acp did not finish ${method} within timeout. stderr: ${stderr}`
            : `codex-acp did not finish ${method} within timeout`,
        );
      }

      return error;
    }

    return new AgentProcessError(
      "agent_session_start_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}
