import lark from "@larksuiteoapi/node-sdk";
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
import { FeishuSessionController } from "./session-controller.ts";

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

export class FeishuGateway {
  readonly #client: lark.Client;
  readonly #wsClient: lark.WSClient;
  readonly #eventDispatcher: lark.EventDispatcher;
  readonly #messageQueue = new MessageEntryQueue();
  readonly #sessionController: FeishuSessionController;
  readonly #cardRenderer = new FeishuCardRenderer();
  readonly #approvalCards = new Map<string, ApprovalCardBinding>();
  readonly #patchMinIntervalMs = 280;

  constructor(
    config: FeishuConfig,
    workspaces: WorkspaceConfig[],
    private readonly taskRunner: TaskRunner,
    private readonly approvalGateway: ApprovalGateway,
    private readonly logger: Logger,
  ) {
    this.#sessionController = new FeishuSessionController(workspaces);

    this.#client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
    });

    this.#wsClient = new lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: lark.LoggerLevel.info,
    });

    this.#eventDispatcher = new lark.EventDispatcher({
      encryptKey: config.encryptKey,
      verificationToken: config.verificationToken,
    })
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
        await this.handleCardAction((data ?? {}) as Record<string, unknown>);
        return {};
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

  private async handleCardAction(data: Record<string, unknown>): Promise<void> {
    const action = parseCardActionValue(data);
    if (!action) {
      this.logger.warn("card action ignored: invalid payload");
      return;
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
