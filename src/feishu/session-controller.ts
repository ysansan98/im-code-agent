import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";

import type { SessionModelInfo, SessionModelState, WorkspaceConfig } from "#shared";

import { FileSessionStateStore, type SessionStateStore } from "../session/session-state-store.ts";
import { TaskRunner } from "../session/task-runner.ts";

type StartOptions = {
  chatId: string;
  workspace: WorkspaceConfig;
  agent: "codex";
  cwd?: string;
};

export type ChatAccessMode = "standard" | "full-access";

export class FeishuSessionController {
  readonly #chatCwds = new Map<string, string>();
  readonly #chatBridgeSessionIds = new Map<string, string>();
  readonly #chatSessionIds = new Map<string, string>();
  readonly #chatAccessModes = new Map<string, ChatAccessMode>();
  readonly #chatCurrentModelIds = new Map<string, string>();
  readonly #chatAvailableModels = new Map<string, SessionModelInfo[]>();
  readonly #defaultAccessMode: ChatAccessMode;

  constructor(
    private readonly workspaces: WorkspaceConfig[],
    defaultAccessMode: ChatAccessMode,
    private readonly stateStore: SessionStateStore = new FileSessionStateStore(),
  ) {
    this.#defaultAccessMode = defaultAccessMode;
  }

  async restore(): Promise<{ persistedChats: number; persistedSessions: number }> {
    const persisted = await this.stateStore.loadState();
    let sanitized = false;
    const fallbackCwd = this.workspaces[0]?.cwd;

    for (const [chatId, cwd] of persisted.chatCwds.entries()) {
      if (await this.isDirectory(cwd)) {
        this.#chatCwds.set(chatId, cwd);
      } else if (fallbackCwd) {
        this.#chatCwds.set(chatId, fallbackCwd);
        sanitized = true;
      }
    }
    for (const [chatId, bridgeSessionId] of persisted.chatBridgeSessionIds.entries()) {
      this.#chatBridgeSessionIds.set(chatId, bridgeSessionId);
    }
    for (const [chatId, sessionId] of persisted.chatSessionIds.entries()) {
      this.#chatSessionIds.set(chatId, sessionId);
    }
    if (sanitized) {
      await this.persist();
    }

    return {
      persistedChats: this.#chatCwds.size,
      persistedSessions: this.#chatSessionIds.size,
    };
  }

  async resolveValidatedWorkspace(chatId: string): Promise<WorkspaceConfig | undefined> {
    const workspace = this.resolveWorkspace(chatId);
    if (!workspace) {
      return undefined;
    }
    if (await this.isDirectory(workspace.cwd)) {
      return workspace;
    }

    const fallback = this.workspaces[0];
    if (!fallback) {
      return workspace;
    }
    await this.setChatCwd(chatId, fallback.cwd);
    await this.clearSession(chatId);
    return {
      ...fallback,
      cwd: fallback.cwd,
    };
  }

  getResumeSessionId(chatId: string): string | undefined {
    return this.#chatSessionIds.get(chatId);
  }

  getBridgeSessionId(chatId: string): string | undefined {
    return this.#chatBridgeSessionIds.get(chatId);
  }

  async setSessionId(chatId: string, sessionId: string | undefined): Promise<void> {
    if (!sessionId) {
      this.#chatBridgeSessionIds.delete(chatId);
      this.#chatSessionIds.delete(chatId);
    } else {
      this.#chatBridgeSessionIds.set(chatId, randomUUID());
      this.#chatSessionIds.set(chatId, sessionId);
    }
    await this.persist();
  }

  async clearSession(chatId: string): Promise<void> {
    this.#chatBridgeSessionIds.delete(chatId);
    this.#chatSessionIds.delete(chatId);
    this.#chatCurrentModelIds.delete(chatId);
    this.#chatAvailableModels.delete(chatId);
    await this.persist();
  }

  getAccessMode(chatId: string): ChatAccessMode {
    return this.#chatAccessModes.get(chatId) ?? this.#defaultAccessMode;
  }

  getDefaultAccessMode(): ChatAccessMode {
    return this.#defaultAccessMode;
  }

  getAccessOverride(chatId: string): ChatAccessMode | undefined {
    return this.#chatAccessModes.get(chatId);
  }

  getModel(chatId: string): string | undefined {
    return this.#chatCurrentModelIds.get(chatId);
  }

  async setModel(chatId: string, model: string, taskRunner: TaskRunner): Promise<boolean> {
    if (!taskRunner.hasConversation(chatId)) {
      return false;
    }
    if (this.getModel(chatId) === model) {
      return false;
    }
    const updated = await taskRunner.setConversationModel(chatId, model);
    if (!updated) {
      return false;
    }
    const models = taskRunner.getConversationModels(chatId);
    this.updateModelState(chatId, models);
    return true;
  }

  getAvailableModels(chatId: string): SessionModelInfo[] {
    return this.#chatAvailableModels.get(chatId) ?? [];
  }

  updateModelState(chatId: string, state?: SessionModelState): void {
    if (!state) {
      return;
    }
    this.#chatCurrentModelIds.set(chatId, state.currentModelId);
    this.#chatAvailableModels.set(chatId, state.availableModels);
  }

  async setAccessMode(
    chatId: string,
    mode: ChatAccessMode,
    taskRunner: TaskRunner,
  ): Promise<boolean> {
    const currentEffectiveMode = this.getAccessMode(chatId);
    if (currentEffectiveMode === mode) {
      return false;
    }
    if (mode === this.#defaultAccessMode) {
      this.#chatAccessModes.delete(chatId);
    } else {
      this.#chatAccessModes.set(chatId, mode);
    }
    await this.resetConversation(chatId, taskRunner, { keepAccessOverride: true });
    return true;
  }

  async clearAccessOverride(chatId: string, taskRunner: TaskRunner): Promise<boolean> {
    if (!this.#chatAccessModes.has(chatId)) {
      return false;
    }
    this.#chatAccessModes.delete(chatId);
    await this.resetConversation(chatId, taskRunner);
    return true;
  }

  async interrupt(chatId: string, taskRunner: TaskRunner): Promise<boolean> {
    if (!taskRunner.isConversationRunning(chatId)) {
      return false;
    }
    await this.resetConversation(chatId, taskRunner, {
      keepAccessOverride: true,
    });
    return true;
  }

  async resetConversation(
    chatId: string,
    taskRunner: TaskRunner,
    options?: { keepAccessOverride?: boolean },
  ): Promise<void> {
    await taskRunner.resetConversation(chatId);
    this.#chatBridgeSessionIds.delete(chatId);
    this.#chatSessionIds.delete(chatId);
    this.#chatCurrentModelIds.delete(chatId);
    this.#chatAvailableModels.delete(chatId);
    if (!options?.keepAccessOverride) {
      this.#chatAccessModes.delete(chatId);
    }
    await this.persist();
  }

  async startNewConversation(
    options: StartOptions,
    taskRunner: TaskRunner,
  ): Promise<{ sessionId: string; workspace: WorkspaceConfig }> {
    await this.resetConversation(options.chatId, taskRunner);
    if (options.cwd) {
      await this.setChatCwd(options.chatId, options.cwd);
    } else {
      await this.setChatCwd(options.chatId, options.workspace.cwd);
    }

    const nextWorkspace = {
      ...options.workspace,
      cwd: options.cwd ?? options.workspace.cwd,
    };
    const conversation = await taskRunner.ensureConversation(
      options.chatId,
      nextWorkspace,
      options.agent,
    );
    this.updateModelState(options.chatId, conversation.models);

    this.#chatBridgeSessionIds.set(options.chatId, randomUUID());
    this.#chatSessionIds.set(options.chatId, conversation.sessionId);
    await this.persist();

    return {
      sessionId: conversation.sessionId,
      workspace: nextWorkspace,
    };
  }

  private resolveWorkspace(chatId: string): WorkspaceConfig | undefined {
    const baseWorkspace = this.workspaces[0];
    if (!baseWorkspace) {
      return undefined;
    }
    const cwd = this.#chatCwds.get(chatId) ?? baseWorkspace.cwd;
    return {
      ...baseWorkspace,
      cwd,
    };
  }

  private async setChatCwd(chatId: string, cwd: string): Promise<void> {
    this.#chatCwds.set(chatId, cwd);
    await this.persist();
  }

  private async isDirectory(path: string): Promise<boolean> {
    const dirStat = await stat(path).catch(() => undefined);
    return Boolean(dirStat?.isDirectory());
  }

  private async persist(): Promise<void> {
    await this.stateStore.saveState({
      chatCwds: this.#chatCwds,
      chatBridgeSessionIds: this.#chatBridgeSessionIds,
      chatSessionIds: this.#chatSessionIds,
    });
  }
}
