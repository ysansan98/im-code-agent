import lark from "@larksuiteoapi/node-sdk";
import { randomUUID } from "node:crypto";
import type {
  ApprovalDecision,
  ApprovalRequest,
  BridgeEvent,
  FeishuConfig,
  WorkspaceConfig,
} from "#shared";

import type { ApprovalSnapshot } from "../approval/approval-store.ts";
import { ApprovalGateway } from "../approval/approval-gateway.ts";
import type { TaskRunner } from "../session/task-runner.ts";
import type { Logger } from "../utils/logger.ts";
import { shouldPatchApprovalSummary } from "./approval-card-policy.ts";
import {
  isInterruptCommand,
  parseCardActionValue,
  parseContent,
  parseUserCommand,
} from "./command-router.ts";
import { FeishuCardRenderer, TaskCardStreamer } from "./card-renderer.ts";
import { MessageEntryQueue } from "./message-entry-queue.ts";
import { FeishuSessionController, type ChatAccessMode } from "./session-controller.ts";

type IncomingMessage = {
  sender: { sender_type: string };
  message: {
    message_id: string;
    chat_id: string;
    message_type: string;
    content: string;
  };
};

type ApprovalCardBinding = {
  chatId: string;
  messageId: string;
  taskId: string;
};

function buildCodexRuntimeArgs(mode: ChatAccessMode): string[] {
  if (mode !== "full-access") {
    return [];
  }
  return ["-c", 'approval_policy="never"', "-c", 'sandbox_mode="danger-full-access"'];
}

export class FeishuGateway {
  readonly #client: lark.Client;
  readonly #wsClient: lark.WSClient;
  readonly #eventDispatcher: lark.EventDispatcher;
  readonly #messageQueue = new MessageEntryQueue();
  readonly #sessionController: FeishuSessionController;
  readonly #cardRenderer = new FeishuCardRenderer();
  readonly #approvalCards = new Map<string, ApprovalCardBinding>();
  readonly #permissionCardMessages = new Map<string, string>();
  readonly #permissionCardRevisions = new Map<string, number>();
  readonly #handledPermissionCardIds = new Map<string, number>();
  readonly #handledCardActionEventIds = new Map<string, number>();
  readonly #patchMinIntervalMs = 280;

  constructor(
    config: FeishuConfig,
    workspaces: WorkspaceConfig[],
    private readonly taskRunner: TaskRunner,
    private readonly approvalGateway: ApprovalGateway,
    private readonly logger: Logger,
    yoloMode = false,
  ) {
    this.#sessionController = new FeishuSessionController(
      workspaces,
      yoloMode ? "full-access" : "standard",
    );

    this.#client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
    });

    this.#wsClient = new lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: lark.LoggerLevel.info,
    });

    this.#eventDispatcher = new lark.EventDispatcher({})
      .register({
        "im.message.receive_v1": async (data) => {
          await this.handleIncomingMessage(data as IncomingMessage);
        },
      })
      .register({});

    (
      this.#eventDispatcher as unknown as {
        register: (handles: Record<string, (data: unknown) => Promise<unknown>>) => void;
      }
    ).register({
      "card.action.trigger": async (data: unknown) => {
        const response = await this.handleCardAction((data ?? {}) as Record<string, unknown>);
        return response ?? {};
      },
    });

    this.approvalGateway.onResolved((snapshot) => {
      void this.patchApprovalCard(snapshot);
    });
  }

  async start(): Promise<void> {
    const restored = await this.#sessionController.restore();

    await this.#wsClient.start({
      eventDispatcher: this.#eventDispatcher,
    });
    this.logger.info("feishu gateway started", restored);
  }

  private async handleIncomingMessage(data: IncomingMessage): Promise<void> {
    this.#messageQueue.gcHandledMessageIds();

    const messageId = data.message.message_id;
    if (data.message.message_type === "text") {
      const text = (parseContent(data.message.content).text ?? "").trim();
      if (isInterruptCommand(text)) {
        if (!this.#messageQueue.tryBegin(messageId)) {
          this.logger.info("feishu duplicate message ignored", { messageId });
          return;
        }
        void this.processInterruptCommand(data.message.chat_id)
          .catch((error) => {
            this.logger.error("feishu interrupt failed", {
              messageId,
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            this.#messageQueue.complete(messageId);
          });
        return;
      }
    }

    const queue = this.#messageQueue.runInChatQueue(data.message.chat_id, messageId, async () => {
      await this.processMessage(data);
    });

    if (!queue) {
      this.logger.info("feishu duplicate message ignored", { messageId });
      return;
    }

    void queue.catch((error) => {
      this.logger.error("feishu message process failed", {
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async processMessage(data: IncomingMessage): Promise<void> {
    if (data.sender.sender_type !== "user") {
      return;
    }

    const chatId = data.message.chat_id;
    if (data.message.message_type !== "text") {
      await this.sendText(chatId, "只支持文本消息。");
      return;
    }

    const workspace = await this.#sessionController.resolveValidatedWorkspace(chatId);
    if (!workspace) {
      await this.sendText(chatId, "未配置可用工作区。");
      return;
    }

    const rawPrompt = (parseContent(data.message.content).text ?? "").trim();
    if (!rawPrompt) {
      await this.sendText(chatId, "消息内容为空。");
      return;
    }

    let command;
    try {
      command = await parseUserCommand(rawPrompt, workspace.cwd);
    } catch (error) {
      await this.sendText(
        chatId,
        `命令解析失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    if (command.type === "new") {
      const next = await this.#sessionController.startNewConversation(
        {
          chatId,
          workspace,
          agent: "codex",
          cwd: command.cwd,
        },
        this.taskRunner,
      );

      await this.sendText(
        chatId,
        `已切换到新会话，session_id: ${next.sessionId}\n工作目录：${next.workspace.cwd}`,
      );
      return;
    }

    if (command.type === "show-access") {
      await this.sendPermissionCard(chatId);
      return;
    }

    await this.runConversationTask({
      chatId,
      messageId: data.message.message_id,
      workspace,
      prompt: command.prompt,
    });
  }

  private async runConversationTask(params: {
    chatId: string;
    messageId: string;
    workspace: WorkspaceConfig;
    prompt: string;
  }): Promise<void> {
    const streamer = new TaskCardStreamer({
      chatId: params.chatId,
      logger: this.logger,
      renderer: this.#cardRenderer,
      sendCard: async (chatId, card) => this.sendCard(chatId, card),
      patchCard: async (messageId, card) => this.patchCard(messageId, card),
      patchMinIntervalMs: this.#patchMinIntervalMs,
    });

    let typingReactionId: string | undefined = await this.addTypingReaction(params.messageId);

    const result = await this.taskRunner.startConversationTask(
      params.chatId,
      {
        workspaceId: params.workspace.id,
        agent: "codex",
        prompt: params.prompt,
      },
      params.workspace,
      {
        runtimeArgs: buildCodexRuntimeArgs(this.#sessionController.getAccessMode(params.chatId)),
        resumeSessionId: this.#sessionController.getResumeSessionId(params.chatId),
        onEvent: (event) => {
          this.onTaskEvent(params.chatId, event, streamer);
        },
      },
    );

    if (
      result.sessionId &&
      this.#sessionController.getResumeSessionId(params.chatId) !== result.sessionId
    ) {
      await this.#sessionController.setSessionId(params.chatId, result.sessionId);
    }

    const failed = result.events.find(
      (event): event is Extract<BridgeEvent, { type: "task.failed" }> =>
        event.type === "task.failed",
    );
    const completed = result.events.find(
      (event): event is Extract<BridgeEvent, { type: "task.completed" }> =>
        event.type === "task.completed",
    );

    if (failed) {
      streamer.markFailed(failed.error);
    } else if (completed) {
      streamer.markCompleted(completed.summary);
    }

    await streamer.finalize();

    if (typingReactionId) {
      await this.removeTypingReaction(params.messageId, typingReactionId).catch(() => {
        return;
      });
      typingReactionId = undefined;
    }
  }

  private onTaskEvent(chatId: string, event: BridgeEvent, streamer: TaskCardStreamer): void {
    if (event.type === "task.output") {
      streamer.handleOutputChunk(event.chunk);
      return;
    }

    if (event.type === "task.tool_update") {
      streamer.handleToolUpdate(event.update);
      return;
    }

    if (event.type === "task.approval_requested") {
      void this.sendApprovalCard(chatId, event.request).catch((error) => {
        this.logger.error("send approval card failed", {
          taskId: event.taskId,
          requestId: event.request.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }

    if (event.type === "task.approval_resolved") {
      if (shouldPatchApprovalSummary(event.decision)) {
        void this.patchApprovalCardByDecision(event.decision);
      }
      return;
    }

    if (event.type === "task.failed") {
      streamer.markFailed(event.error);
      return;
    }

    if (event.type === "task.completed") {
      streamer.markCompleted(event.summary);
    }
  }

  private async processInterruptCommand(chatId: string): Promise<void> {
    const interrupted = await this.#sessionController.interrupt(chatId, this.taskRunner);
    if (!interrupted) {
      await this.sendText(chatId, "当前没有执行中的任务。");
      return;
    }
    await this.sendText(chatId, "已打断当前任务。");
  }

  private async handleCardAction(
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    this.logger.info("card action received", {
      topLevelKeys: Object.keys(data),
      eventId: this.extractCardActionEventId(data),
      actionMessageId: this.extractActionMessageId(data),
    });

    this.gcHandledCardActionEventIds();
    const eventId = this.extractCardActionEventId(data);
    if (eventId && this.#handledCardActionEventIds.has(eventId)) {
      this.logger.info("card action ignored: duplicated event", { eventId });
      return undefined;
    }
    if (eventId) {
      this.#handledCardActionEventIds.set(eventId, Date.now());
    }

    const action = parseCardActionValue(data);
    if (!action) {
      this.logger.warn("card action ignored: invalid payload");
      return undefined;
    }

    if (action.type === "access") {
      this.gcHandledPermissionCardIds();
      const chatId = action.chatId;
      const actionMessageId = this.extractActionMessageId(data);
      this.logger.info("permission card action parsed", {
        chatId,
        cardId: action.cardId,
        action: action.action,
        mode: action.action === "set" ? action.mode : undefined,
        actionMessageId,
      });
      if (this.#handledPermissionCardIds.has(action.cardId)) {
        this.logger.info("permission card action ignored: card already locked", {
          chatId,
          messageId: actionMessageId,
          cardId: action.cardId,
        });
        return undefined;
      }
      this.#handledPermissionCardIds.set(action.cardId, Date.now());
      try {
        if (action.action === "clear") {
          await this.#sessionController.clearAccessOverride(chatId, this.taskRunner);
        } else {
          await this.#sessionController.setAccessMode(chatId, action.mode, this.taskRunner);
        }
        this.logger.info("permission card action applied", {
          chatId,
          cardId: action.cardId,
          effectiveMode: this.#sessionController.getAccessMode(chatId),
        });
      } catch (error) {
        this.#handledPermissionCardIds.delete(action.cardId);
        this.logger.warn("permission card action failed, unlock card", {
          chatId,
          cardId: action.cardId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      const card = await this.updatePermissionCard(
        chatId,
        actionMessageId,
        action.cardId,
        true,
        undefined,
        false,
      );
      if (!card) {
        this.logger.warn("permission card action applied but card update skipped", {
          chatId,
          cardId: action.cardId,
          actionMessageId,
        });
        return undefined;
      }
      return {
        card: {
          type: "raw",
          data: card,
        },
      };
    }

    const decidedBy =
      (data.operator as { operator_id?: { open_id?: string; user_id?: string } } | undefined)
        ?.operator_id?.open_id ??
      (data.operator as { operator_id?: { open_id?: string; user_id?: string } } | undefined)
        ?.operator_id?.user_id ??
      "feishu-user";

    const decision: ApprovalDecision = {
      requestId: action.requestId,
      taskId: action.taskId,
      decision: action.decision,
      comment: action.comment,
      decidedAt: new Date().toISOString(),
      decidedBy,
    };

    this.approvalGateway.resolve(decision);
    void this.patchApprovalCardByDecision(decision);
    return undefined;
  }

  private async sendPermissionCard(chatId: string): Promise<void> {
    const cardId = randomUUID();
    const version = 1;
    this.#permissionCardRevisions.set(cardId, version);
    const card = this.#cardRenderer.buildAccessModeCard({
      cardId,
      chatId,
      defaultMode: this.#sessionController.getDefaultAccessMode(),
      overrideMode: this.#sessionController.getAccessOverride(chatId),
      readonly: false,
    });
    const messageId = await this.sendCard(chatId, card);
    this.#permissionCardMessages.set(cardId, messageId);
    this.logger.info("permission card sent", {
      chatId,
      cardId,
      version,
      messageId,
      defaultMode: this.#sessionController.getDefaultAccessMode(),
      overrideMode: this.#sessionController.getAccessOverride(chatId),
      effectiveMode: this.#sessionController.getAccessMode(chatId),
    });
  }

  private async updatePermissionCard(
    chatId: string,
    messageId?: string,
    cardId?: string,
    lockAfterPatch = false,
    readonlyReason?: string,
    patch = true,
  ): Promise<Record<string, unknown> | undefined> {
    const resolvedCardId = cardId ?? randomUUID();
    const nextRevision = (this.#permissionCardRevisions.get(resolvedCardId) ?? 1) + 1;
    this.#permissionCardRevisions.set(resolvedCardId, nextRevision);
    const card = this.#cardRenderer.buildAccessModeCard({
      cardId: resolvedCardId,
      chatId,
      defaultMode: this.#sessionController.getDefaultAccessMode(),
      overrideMode: this.#sessionController.getAccessOverride(chatId),
      readonly: lockAfterPatch,
      readonlyReason,
    });
    const fromActionMessageId = messageId;
    const fromCardMap = this.#permissionCardMessages.get(resolvedCardId);
    const targetMessageId = fromActionMessageId ?? fromCardMap;
    if (!targetMessageId) {
      this.logger.warn("permission card update skipped: message id not found", {
        chatId,
        cardId: resolvedCardId,
      });
      return undefined;
    }
    this.logger.info("permission card patch start", {
      chatId,
      cardId: resolvedCardId,
      version: nextRevision,
      targetMessageId,
      targetSource: fromActionMessageId ? "action-message-id" : "card-id-map",
      lockAfterPatch,
      overrideMode: this.#sessionController.getAccessOverride(chatId),
      effectiveMode: this.#sessionController.getAccessMode(chatId),
    });
    try {
      this.#permissionCardMessages.set(resolvedCardId, targetMessageId);
      if (patch) {
        await this.patchCard(targetMessageId, card);
        this.logger.info("permission card patch done", {
          chatId,
          cardId: resolvedCardId,
          version: nextRevision,
          targetMessageId,
          lockAfterPatch,
        });
      } else {
        this.logger.info("permission card patch skipped: callback response mode", {
          chatId,
          cardId: resolvedCardId,
          version: nextRevision,
          targetMessageId,
          lockAfterPatch,
        });
      }
      return card;
    } catch (error) {
      this.logger.warn("patch permission card failed", {
        chatId,
        messageId: targetMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private extractActionMessageId(data: Record<string, unknown>): string | undefined {
    const topLevel = typeof data.open_message_id === "string" ? data.open_message_id : undefined;
    if (topLevel) {
      return topLevel;
    }

    const eventObj =
      data.event && typeof data.event === "object"
        ? (data.event as Record<string, unknown>)
        : undefined;
    if (eventObj) {
      if (typeof eventObj.open_message_id === "string") {
        return eventObj.open_message_id;
      }
      const contextObj =
        eventObj.context && typeof eventObj.context === "object"
          ? (eventObj.context as Record<string, unknown>)
          : undefined;
      if (contextObj && typeof contextObj.open_message_id === "string") {
        return contextObj.open_message_id;
      }
      const messageObj =
        eventObj.message && typeof eventObj.message === "object"
          ? (eventObj.message as Record<string, unknown>)
          : undefined;
      if (messageObj && typeof messageObj.message_id === "string") {
        return messageObj.message_id;
      }
    }

    const messageObj =
      data.message && typeof data.message === "object"
        ? (data.message as Record<string, unknown>)
        : undefined;
    if (messageObj && typeof messageObj.message_id === "string") {
      return messageObj.message_id;
    }
    return undefined;
  }

  private extractCardActionEventId(data: Record<string, unknown>): string | undefined {
    if (typeof data.event_id === "string") {
      return data.event_id;
    }
    const headerObj =
      data.header && typeof data.header === "object"
        ? (data.header as Record<string, unknown>)
        : undefined;
    if (headerObj && typeof headerObj.event_id === "string") {
      return headerObj.event_id;
    }
    const eventObj =
      data.event && typeof data.event === "object"
        ? (data.event as Record<string, unknown>)
        : undefined;
    if (eventObj && typeof eventObj.event_id === "string") {
      return eventObj.event_id;
    }
    return undefined;
  }

  private gcHandledCardActionEventIds(): void {
    const expireMs = 60_000;
    const now = Date.now();
    for (const [eventId, ts] of this.#handledCardActionEventIds.entries()) {
      if (now - ts > expireMs) {
        this.#handledCardActionEventIds.delete(eventId);
      }
    }
  }

  private gcHandledPermissionCardIds(): void {
    const expireMs = 10 * 60_000;
    const now = Date.now();
    for (const [cardId, ts] of this.#handledPermissionCardIds.entries()) {
      if (now - ts > expireMs) {
        this.#handledPermissionCardIds.delete(cardId);
      }
    }
  }

  private async sendApprovalCard(chatId: string, request: ApprovalRequest): Promise<void> {
    const messageId = await this.sendCard(
      chatId,
      this.#cardRenderer.buildApprovalCard(request, "pending"),
    );
    this.#approvalCards.set(request.id, {
      chatId,
      messageId,
      taskId: request.taskId,
    });
  }

  private async patchApprovalCard(snapshot: ApprovalSnapshot): Promise<void> {
    const binding = this.#approvalCards.get(snapshot.request.id);
    if (!binding) {
      return;
    }
    await this.patchCard(
      binding.messageId,
      this.#cardRenderer.buildApprovalCard(snapshot.request, snapshot.status, snapshot.decision),
    ).catch((error) => {
      this.logger.warn("patch approval card failed", {
        requestId: snapshot.request.id,
        messageId: binding.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async patchApprovalCardByDecision(decision: ApprovalDecision): Promise<void> {
    const binding = this.#approvalCards.get(decision.requestId);
    if (!binding) {
      return;
    }
    const title = decision.decision === "approved" ? "已批准" : "已拒绝";
    await this.patchCard(
      binding.messageId,
      this.#cardRenderer.buildApprovalSummaryCard(title, decision),
    ).catch((error) => {
      this.logger.warn("patch approval card failed", {
        requestId: decision.requestId,
        messageId: binding.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async sendText(chatId: string, text: string): Promise<void> {
    await this.#client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
  }

  private async addTypingReaction(messageId: string): Promise<string | undefined> {
    try {
      const res = await this.#client.im.v1.messageReaction.create({
        path: {
          message_id: messageId,
        },
        data: {
          reaction_type: {
            emoji_type: "Typing",
          },
        },
      });
      return res.data?.reaction_id;
    } catch (error) {
      this.logger.warn("add typing reaction failed", {
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async removeTypingReaction(messageId: string, reactionId: string): Promise<void> {
    await this.#client.im.v1.messageReaction.delete({
      path: {
        message_id: messageId,
        reaction_id: reactionId,
      },
    });
  }

  private async sendCard(chatId: string, card: Record<string, unknown>): Promise<string> {
    const res = await this.#client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });

    const messageId = res.data?.message_id;
    if (!messageId) {
      throw new Error("failed to create card message: missing message_id");
    }
    return messageId;
  }

  private async patchCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    await this.#client.im.v1.message.patch({
      path: {
        message_id: messageId,
      },
      data: {
        content: JSON.stringify(card),
      },
    });
  }
}
