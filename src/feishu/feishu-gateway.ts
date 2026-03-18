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
import { isInterruptCommand, parseContent, parseUserCommand } from "./command-router.ts";
import { FeishuCardRenderer, TaskCardStreamer } from "./card-renderer.ts";
import { buildFeishuEventDispatcher } from "./feishu-event-dispatcher.ts";
import { MessageEntryQueue } from "./message-entry-queue.ts";
import { FeishuCardActionHandler } from "./feishu-card-action-handler.ts";
import { FeishuMessageClient } from "./feishu-message-client.ts";
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
  updatedAtMs: number;
};

function buildCodexRuntimeArgs(mode: ChatAccessMode): string[] {
  if (mode !== "full-access") {
    return [];
  }
  return ["-c", 'approval_policy="never"', "-c", 'sandbox_mode="danger-full-access"'];
}

export class FeishuGateway {
  readonly #wsClient: lark.WSClient;
  readonly #eventDispatcher: lark.EventDispatcher;
  readonly #messageQueue = new MessageEntryQueue();
  readonly #sessionController: FeishuSessionController;
  readonly #cardRenderer = new FeishuCardRenderer();
  readonly #messageClient: FeishuMessageClient;
  readonly #cardActionHandler: FeishuCardActionHandler;
  readonly #approvalCards = new Map<string, ApprovalCardBinding>();
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

    const client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
    });
    this.#messageClient = new FeishuMessageClient(client, this.logger);
    this.#cardActionHandler = new FeishuCardActionHandler({
      sessionController: this.#sessionController,
      taskRunner: this.taskRunner,
      approvalGateway: this.approvalGateway,
      messageClient: this.#messageClient,
      cardRenderer: this.#cardRenderer,
      logger: this.logger,
      onApprovalResolved: (decision) => {
        void this.patchApprovalCardByDecision(decision);
      },
    });

    this.#wsClient = new lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: lark.LoggerLevel.info,
    });

    this.#eventDispatcher = buildFeishuEventDispatcher({
      onMessageReceived: async (data: unknown) => {
        await this.handleIncomingMessage(data as IncomingMessage);
      },
      onCardAction: async (data: unknown) => {
        return this.#cardActionHandler.handleCardAction((data ?? {}) as Record<string, unknown>);
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
      await this.#messageClient.sendText(chatId, "只支持文本消息。");
      return;
    }

    const workspace = await this.#sessionController.resolveValidatedWorkspace(chatId);
    if (!workspace) {
      await this.#messageClient.sendText(chatId, "未配置可用工作区。");
      return;
    }

    const rawPrompt = (parseContent(data.message.content).text ?? "").trim();
    if (!rawPrompt) {
      await this.#messageClient.sendText(chatId, "消息内容为空。");
      return;
    }

    let command;
    try {
      command = await parseUserCommand(rawPrompt, workspace.cwd);
    } catch (error) {
      await this.#messageClient.sendText(
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

      await this.#messageClient.sendText(
        chatId,
        `已切换到新会话，session_id: ${next.sessionId}\n工作目录：${next.workspace.cwd}`,
      );
      return;
    }

    if (command.type === "show-access") {
      await this.#cardActionHandler.sendPermissionCard(chatId);
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
      sendCard: async (chatId, card) => this.#messageClient.sendCard(chatId, card),
      patchCard: async (messageId, card) => this.#messageClient.patchCard(messageId, card),
      patchMinIntervalMs: this.#patchMinIntervalMs,
    });

    let typingReactionId: string | undefined;
    try {
      typingReactionId = await this.#messageClient.addTypingReaction(params.messageId);

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
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error("run conversation task failed", {
        chatId: params.chatId,
        messageId: params.messageId,
        error: errorMessage,
      });
      streamer.markFailed(errorMessage);
      await streamer.finalize().catch((finalizeError) => {
        this.logger.error("finalize failed after task error", {
          chatId: params.chatId,
          messageId: params.messageId,
          error: finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
        });
      });
    } finally {
      if (typingReactionId) {
        await this.#messageClient
          .removeTypingReaction(params.messageId, typingReactionId)
          .catch(() => {
            return;
          });
      }
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
      await this.#messageClient.sendText(chatId, "当前没有执行中的任务。");
      return;
    }
    await this.#messageClient.sendText(chatId, "已打断当前任务。");
  }

  private async sendApprovalCard(chatId: string, request: ApprovalRequest): Promise<void> {
    this.gcApprovalCards();
    const messageId = await this.#messageClient.sendCard(
      chatId,
      this.#cardRenderer.buildApprovalCard(request, "pending"),
    );
    this.#approvalCards.set(request.id, {
      chatId,
      messageId,
      updatedAtMs: Date.now(),
    });
  }

  private async patchApprovalCard(snapshot: ApprovalSnapshot): Promise<void> {
    this.gcApprovalCards();
    const binding = this.#approvalCards.get(snapshot.request.id);
    if (!binding) {
      return;
    }
    binding.updatedAtMs = Date.now();
    await this.#messageClient
      .patchCard(
        binding.messageId,
        this.#cardRenderer.buildApprovalCard(snapshot.request, snapshot.status, snapshot.decision),
      )
      .catch((error) => {
        this.logger.warn("patch approval card failed", {
          requestId: snapshot.request.id,
          messageId: binding.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async patchApprovalCardByDecision(decision: ApprovalDecision): Promise<void> {
    this.gcApprovalCards();
    const binding = this.#approvalCards.get(decision.requestId);
    if (!binding) {
      return;
    }
    binding.updatedAtMs = Date.now();
    const title = decision.decision === "approved" ? "已批准" : "已拒绝";
    await this.#messageClient
      .patchCard(binding.messageId, this.#cardRenderer.buildApprovalSummaryCard(title, decision))
      .catch((error) => {
        this.logger.warn("patch approval card failed", {
          requestId: decision.requestId,
          messageId: binding.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private gcApprovalCards(): void {
    const ttlMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const [requestId, binding] of this.#approvalCards.entries()) {
      if (now - binding.updatedAtMs > ttlMs) {
        this.#approvalCards.delete(requestId);
      }
    }
  }
}
