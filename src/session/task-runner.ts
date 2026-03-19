import type {
  AgentType,
  BridgeEvent,
  CreateTaskInput,
  SessionModelState,
  Task,
  WorkspaceConfig,
} from "#shared";

import { AgentProcess, AgentProcessError, type AgentEvent } from "../agent/agent-process.ts";
import type { Logger } from "../utils/logger.ts";
import { SessionManager } from "./session-manager.ts";

type StartTaskOptions = {
  onEvent?: (event: BridgeEvent) => void | Promise<void>;
  resumeSessionId?: string;
  runtimeArgs?: string[];
};

type EnsureConversationOptions = {
  resumeSessionId?: string;
  runtimeArgs?: string[];
};

type ConversationState = {
  taskId: string;
  workspaceId: string;
  agent: AgentType;
  cwd: string;
  sessionId: string;
  runtimeArgs: string[];
  models?: SessionModelState;
};

function sameRuntimeArgs(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

export class TaskRunner {
  readonly #eventLog = new Map<string, BridgeEvent[]>();
  readonly #eventListeners = new Map<string, StartTaskOptions["onEvent"]>();
  readonly #conversations = new Map<string, ConversationState>();
  readonly #runningConversations = new Set<string>();
  readonly #taskRuntimeArgs = new Map<string, string[]>();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly agentProcess: AgentProcess,
    private readonly logger: Logger,
  ) {}

  async startTask(
    input: CreateTaskInput,
    workspace: WorkspaceConfig,
    options?: StartTaskOptions,
  ): Promise<{ taskId: string; events: BridgeEvent[] }> {
    const task = this.sessionManager.createTask(input, workspace);
    this.#taskRuntimeArgs.set(task.id, options?.runtimeArgs ?? []);
    this.#eventLog.set(task.id, []);
    if (options?.onEvent) {
      this.#eventListeners.set(task.id, options.onEvent);
    }
    this.sessionManager.updateTaskStatus(task.id, "running");

    try {
      const { initialization, sessionId } = await this.agentProcess.start({
        taskId: task.id,
        agent: task.agent,
        cwd: task.cwd,
        runtimeArgs: options?.runtimeArgs,
      });
      this.recordEvent(task.id, {
        type: "task.started",
        taskId: task.id,
        workspaceId: task.workspaceId,
        agent: task.agent,
        timestamp: new Date().toISOString(),
      });

      const promptResult = await this.agentProcess.prompt(task.id, task.prompt);

      this.logger.info("task started", {
        taskId: task.id,
        workspaceId: task.workspaceId,
        agent: task.agent,
        protocolVersion: initialization.protocolVersion,
        sessionId,
        stopReason: promptResult.stopReason,
      });

      this.recordEvent(task.id, {
        type: "task.completed",
        taskId: task.id,
        summary: promptResult.stopReason,
        timestamp: new Date().toISOString(),
      });

      return {
        taskId: task.id,
        events: this.flushEvents(task.id),
      };
    } catch (error) {
      const taskError =
        error instanceof AgentProcessError
          ? error
          : new AgentProcessError(
              "agent_session_start_failed",
              error instanceof Error ? error.message : String(error),
            );

      this.sessionManager.updateTaskStatus(task.id, "failed");
      this.logger.error("task failed before prompt completed", {
        taskId: task.id,
        code: taskError.code,
        error: taskError.message,
      });

      this.recordEvent(task.id, {
        type: "task.failed",
        taskId: task.id,
        code: taskError.code,
        error: taskError.message,
        timestamp: new Date().toISOString(),
      });

      return {
        taskId: task.id,
        events: this.flushEvents(task.id),
      };
    }
  }

  async startConversationTask(
    conversationId: string,
    input: CreateTaskInput,
    workspace: WorkspaceConfig,
    options?: StartTaskOptions,
  ): Promise<{
    taskId: string;
    events: BridgeEvent[];
    sessionId?: string;
    models?: SessionModelState;
  }> {
    const state = await this.ensureConversation(
      conversationId,
      workspace,
      input.agent,
      {
        resumeSessionId: options?.resumeSessionId,
        runtimeArgs: options?.runtimeArgs,
      },
      input.prompt,
    );
    return this.runConversationPrompt(conversationId, state, input.prompt, options);
  }

  async ensureConversation(
    conversationId: string,
    workspace: WorkspaceConfig,
    agent: AgentType,
    options?: EnsureConversationOptions,
    promptForTask?: string,
  ): Promise<ConversationState> {
    let state = this.#conversations.get(conversationId);
    if (
      state &&
      (state.workspaceId !== workspace.id ||
        state.agent !== agent ||
        state.cwd !== workspace.cwd ||
        !sameRuntimeArgs(state.runtimeArgs, options?.runtimeArgs ?? []))
    ) {
      await this.resetConversation(conversationId);
      state = undefined;
    }

    if (state) {
      return state;
    }

    const task = this.sessionManager.createTask(
      {
        workspaceId: workspace.id,
        agent,
        prompt: promptForTask ?? "",
      },
      workspace,
    );
    const started = await this.agentProcess.start({
      taskId: task.id,
      agent,
      cwd: workspace.cwd,
      resumeSessionId: options?.resumeSessionId,
      runtimeArgs: options?.runtimeArgs,
    });
    state = {
      taskId: task.id,
      workspaceId: workspace.id,
      agent,
      cwd: workspace.cwd,
      sessionId: started.sessionId,
      runtimeArgs: options?.runtimeArgs ?? [],
      models: started.models,
    };
    this.#taskRuntimeArgs.set(task.id, state.runtimeArgs);
    this.#conversations.set(conversationId, state);
    this.logger.info("conversation created", {
      conversationId,
      taskId: state.taskId,
      workspaceId: state.workspaceId,
      agent: state.agent,
      sessionId: started.sessionId,
      resumed: Boolean(options?.resumeSessionId && started.sessionId === options.resumeSessionId),
    });
    return state;
  }

  private async runConversationPrompt(
    conversationId: string,
    state: ConversationState,
    prompt: string,
    options?: StartTaskOptions,
  ): Promise<{
    taskId: string;
    events: BridgeEvent[];
    sessionId?: string;
    models?: SessionModelState;
  }> {
    this.#runningConversations.add(conversationId);
    const result = await this.runPrompt(
      state.taskId,
      state.workspaceId,
      state.agent,
      prompt,
      options,
    ).finally(() => {
      this.#runningConversations.delete(conversationId);
    });
    const failed = result.events.some((event) => event.type === "task.failed");
    if (failed) {
      await this.resetConversation(conversationId);
    }
    return {
      ...result,
      sessionId: state.sessionId,
      models: state.models,
    };
  }

  async resetConversation(conversationId: string): Promise<boolean> {
    const state = this.#conversations.get(conversationId);
    if (!state) {
      return false;
    }

    this.#conversations.delete(conversationId);
    this.#taskRuntimeArgs.delete(state.taskId);
    this.sessionManager.updateTaskStatus(state.taskId, "cancelled");
    await this.agentProcess.stop(state.taskId);
    this.logger.info("conversation reset", {
      conversationId,
      taskId: state.taskId,
    });
    return true;
  }

  isConversationRunning(conversationId: string): boolean {
    return this.#runningConversations.has(conversationId);
  }

  hasConversation(conversationId: string): boolean {
    return this.#conversations.has(conversationId);
  }

  async setConversationModel(conversationId: string, modelId: string): Promise<boolean> {
    const state = this.#conversations.get(conversationId);
    if (!state) {
      return false;
    }
    await this.agentProcess.setSessionModel(state.taskId, modelId);
    if (state.models) {
      state.models = {
        ...state.models,
        currentModelId: modelId,
      };
    }
    return true;
  }

  getConversationModels(conversationId: string): SessionModelState | undefined {
    return this.#conversations.get(conversationId)?.models;
  }

  getTask(taskId: string): Task | undefined {
    return this.sessionManager.getTask(taskId);
  }

  isTaskFullAccess(taskId: string): boolean {
    const args = this.#taskRuntimeArgs.get(taskId) ?? [];
    return this.hasApprovalPolicyNever(args);
  }

  handleAgentEvent(event: AgentEvent): BridgeEvent | undefined {
    if (event.type === "agent.output") {
      const bridgeEvent: BridgeEvent = {
        type: "task.output",
        taskId: event.taskId,
        stream: "agent",
        chunk: event.text,
        timestamp: new Date().toISOString(),
      };
      this.recordEvent(event.taskId, bridgeEvent);
      return bridgeEvent;
    }

    if (event.type === "agent.approval_requested") {
      const bridgeEvent: BridgeEvent = {
        type: "task.approval_requested",
        taskId: event.taskId,
        request: event.request,
        timestamp: new Date().toISOString(),
      };
      this.recordEvent(event.taskId, bridgeEvent);
      return bridgeEvent;
    }

    if (event.type === "agent.approval_resolved") {
      const bridgeEvent: BridgeEvent = {
        type: "task.approval_resolved",
        taskId: event.taskId,
        decision: event.decision,
        timestamp: new Date().toISOString(),
      };
      this.recordEvent(event.taskId, bridgeEvent);
      return bridgeEvent;
    }

    if (event.type === "agent.tool_update") {
      const bridgeEvent: BridgeEvent = {
        type: "task.tool_update",
        taskId: event.taskId,
        update: event.update,
        timestamp: new Date().toISOString(),
      };
      this.recordEvent(event.taskId, bridgeEvent);
      return bridgeEvent;
    }

    return undefined;
  }

  private recordEvent(taskId: string, event: BridgeEvent): void {
    const events = this.#eventLog.get(taskId);
    if (!events) {
      this.#eventLog.set(taskId, [event]);
    } else {
      events.push(event);
    }

    const listener = this.#eventListeners.get(taskId);
    if (listener) {
      void listener(event);
    }
  }

  private async runPrompt(
    taskId: string,
    workspaceId: string,
    agent: AgentType,
    prompt: string,
    options?: StartTaskOptions,
  ): Promise<{ taskId: string; events: BridgeEvent[] }> {
    this.#eventLog.set(taskId, []);
    if (options?.onEvent) {
      this.#eventListeners.set(taskId, options.onEvent);
    }
    this.sessionManager.updateTaskStatus(taskId, "running");
    this.recordEvent(taskId, {
      type: "task.started",
      taskId,
      workspaceId,
      agent,
      timestamp: new Date().toISOString(),
    });

    try {
      const promptResult = await this.agentProcess.prompt(taskId, prompt);
      this.recordEvent(taskId, {
        type: "task.completed",
        taskId,
        summary: promptResult.stopReason,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      const taskError =
        error instanceof AgentProcessError
          ? error
          : new AgentProcessError(
              "agent_session_start_failed",
              error instanceof Error ? error.message : String(error),
            );
      this.sessionManager.updateTaskStatus(taskId, "failed");
      this.logger.error("task failed before prompt completed", {
        taskId,
        code: taskError.code,
        error: taskError.message,
      });
      this.recordEvent(taskId, {
        type: "task.failed",
        taskId,
        code: taskError.code,
        error: taskError.message,
        timestamp: new Date().toISOString(),
      });
    }
    return {
      taskId,
      events: this.flushEvents(taskId),
    };
  }

  private flushEvents(taskId: string): BridgeEvent[] {
    const events = this.#eventLog.get(taskId) ?? [];
    this.#eventLog.delete(taskId);
    this.#eventListeners.delete(taskId);
    return events;
  }

  private hasApprovalPolicyNever(args: string[]): boolean {
    for (let index = 0; index < args.length - 1; index += 1) {
      if (args[index] === "-c" && args[index + 1] === 'approval_policy="never"') {
        return true;
      }
    }
    return false;
  }
}
