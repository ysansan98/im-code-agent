import { stat } from "node:fs/promises";

import type { WorkspaceConfig } from "@im-code-agent/shared";

import { TaskRunner } from "../session/task-runner.ts";
import { ChatStateStore } from "./chat-state-store.ts";

type StartOptions = {
  chatId: string;
  workspace: WorkspaceConfig;
  agent: "codex";
  cwd?: string;
};

export class FeishuSessionController {
  readonly #chatCwds = new Map<string, string>();
  readonly #chatSessionIds = new Map<string, string>();
  readonly #chatStateStore = new ChatStateStore();

  constructor(private readonly workspaces: WorkspaceConfig[]) {}

  async restore(): Promise<{ persistedChats: number; persistedSessions: number }> {
    const persisted = await this.#chatStateStore.loadState();
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

  async setSessionId(chatId: string, sessionId: string | undefined): Promise<void> {
    if (!sessionId) {
      this.#chatSessionIds.delete(chatId);
    } else {
      this.#chatSessionIds.set(chatId, sessionId);
    }
    await this.persist();
  }

  async clearSession(chatId: string): Promise<void> {
    this.#chatSessionIds.delete(chatId);
    await this.persist();
  }

  async interrupt(chatId: string, taskRunner: TaskRunner): Promise<boolean> {
    if (!taskRunner.isConversationRunning(chatId)) {
      return false;
    }
    await this.resetConversation(chatId, taskRunner);
    return true;
  }

  async resetConversation(chatId: string, taskRunner: TaskRunner): Promise<void> {
    await taskRunner.resetConversation(chatId);
    this.#chatSessionIds.delete(chatId);
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
    await this.#chatStateStore.saveState({
      chatCwds: this.#chatCwds,
      chatSessionIds: this.#chatSessionIds,
    });
  }
}
