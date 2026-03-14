import type {
  AgentType,
  BridgeEvent,
  CreateTaskInput,
  WorkspaceConfig,
} from "@im-code-agent/shared";

import { AgentProcess, AgentProcessError, type AgentEvent } from "../agent/agent-process.ts";
import type { Logger } from "../utils/logger.ts";
import { SessionManager } from "./session-manager.ts";

type StartTaskOptions = {
  onEvent?: (event: BridgeEvent) => void | Promise<void>;
  resumeSessionId?: string;
};

type EnsureConversationOptions = {
  resumeSessionId?: string;
};

type ConversationState = {
  taskId: string;
  workspaceId: string;
  agent: AgentType;
  cwd: string;
  sessionId: string;
};

export class TaskRunner {
  readonly #eventLog = new Map<string, BridgeEvent[]>();
  readonly #eventListeners = new Map<string, StartTaskOptions["onEvent"]>();
  readonly #conversations = new Map<string, ConversationState>();
  readonly #runningConversations = new Set<string>();

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
  ): Promise<{ taskId: string; events: BridgeEvent[]; sessionId?: string }> {
    const state = await this.ensureConversation(
      conversationId,
      workspace,
      input.agent,
      {
        resumeSessionId: options?.resumeSessionId,
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
      (state.workspaceId !== workspace.id || state.agent !== agent || state.cwd !== workspace.cwd)
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
    });
    state = {
      taskId: task.id,
      workspaceId: workspace.id,
      agent,
      cwd: workspace.cwd,
      sessionId: started.sessionId,
    };
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
  ): Promise<{ taskId: string; events: BridgeEvent[]; sessionId?: string }> {
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
    };
  }

  async resetConversation(conversationId: string): Promise<boolean> {
    const state = this.#conversations.get(conversationId);
    if (!state) {
      return false;
    }

    this.#conversations.delete(conversationId);
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
}
