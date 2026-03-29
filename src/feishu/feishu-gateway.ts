import lark from "@larksuiteoapi/node-sdk";
import { resolve } from "node:path";
import type {
  ApprovalDecision,
  ApprovalRequest,
  BridgeEvent,
  ContentBlock,
  FeishuConfig,
  WorkspaceConfig,
} from "#shared";

import type { ApprovalSnapshot } from "../approval/approval-store.ts";
import { ApprovalGateway } from "../approval/approval-gateway.ts";
import type { TaskRunner } from "../session/task-runner.ts";
import type { Logger } from "../utils/logger.ts";
import { shouldPatchApprovalSummary } from "./approval-card-policy.ts";
import { extractPromptFromMessage, parseContent, parseUserCommand } from "./command-router.ts";
import { FeishuCardRenderer, TaskCardStreamer } from "./card-renderer.ts";
import { FeishuCommandHandler } from "./command-handler.ts";
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

type PendingImageReference = {
  messageId: string;
  imageKey: string;
};

type PendingImageState = {
  workspace: WorkspaceConfig;
  items: PendingImageReference[];
  timer: NodeJS.Timeout;
};

function buildCodexRuntimeArgs(mode: ChatAccessMode): string[] {
  const args: string[] = [];
  if (mode === "full-access") {
    args.push("-c", 'approval_policy="never"', "-c", 'sandbox_mode="danger-full-access"');
  }
  return args;
}

export class FeishuGateway {
  readonly #wsClient: lark.WSClient;
  readonly #eventDispatcher: lark.EventDispatcher;
  readonly #messageQueue = new MessageEntryQueue();
  readonly #sessionController: FeishuSessionController;
  readonly #cardRenderer = new FeishuCardRenderer();
  readonly #messageClient: FeishuMessageClient;
  readonly #cardActionHandler: FeishuCardActionHandler;
  readonly #commandHandler: FeishuCommandHandler;
  readonly #approvalCards = new Map<string, ApprovalCardBinding>();
  readonly #pendingImages = new Map<string, PendingImageState>();
  readonly #patchMinIntervalMs = 280;
  readonly #imageTextMergeWindowMs: number;

  constructor(
    config: FeishuConfig,
    workspaces: WorkspaceConfig[],
    private readonly taskRunner: TaskRunner,
    private readonly approvalGateway: ApprovalGateway,
    private readonly logger: Logger,
    yoloMode = false,
    imageTextMergeWindowMs = 10000,
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
    this.#commandHandler = new FeishuCommandHandler({
      sessionController: this.#sessionController,
      cardActionHandler: this.#cardActionHandler,
      messageClient: this.#messageClient,
      taskRunner: this.taskRunner,
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
    this.#imageTextMergeWindowMs = Math.max(0, imageTextMergeWindowMs);
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

    const workspace = await this.#sessionController.resolveValidatedWorkspace(chatId);
    if (!workspace) {
      await this.#messageClient.sendText(chatId, "未配置可用工作区。");
      return;
    }

    if (data.message.message_type === "image") {
      await this.handleIncomingImage(chatId, data.message, workspace);
      return;
    }

    const rawPrompt = extractPromptFromMessage(data.message.message_type, data.message.content);
    if (!rawPrompt) {
      this.logger.warn("feishu message unsupported or empty", {
        messageType: data.message.message_type,
        contentPreview: this.shorten(data.message.content, 400),
      });
      await this.#messageClient.sendText(
        chatId,
        "不支持该消息类型或消息内容为空。当前支持 text / post(markdown) / image。",
      );
      return;
    }
    if (rawPrompt === data.message.content.trim() && data.message.message_type !== "text") {
      this.logger.info("feishu message used raw content fallback", {
        messageType: data.message.message_type,
        contentPreview: this.shorten(data.message.content, 400),
      });
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

    const result = await this.#commandHandler.handle({
      chatId,
      workspace,
      command,
    });
    if (result.type === "handled") {
      this.clearPendingImages(chatId);
      return;
    }

    const pendingImages = this.takePendingImages(chatId);
    let promptBlocks: ContentBlock[] | undefined;
    if (pendingImages.length > 0) {
      try {
        promptBlocks = await this.buildPromptBlocksFromImageRefs(
          pendingImages,
          result.prompt,
          workspace,
        );
      } catch (error) {
        this.logger.error("build merged image prompt blocks failed", {
          chatId,
          messageId: data.message.message_id,
          imageCount: pendingImages.length,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.#messageClient.sendText(
          chatId,
          "图片下载失败，已退回文本模式继续处理。请确认机器人有“获取消息中的资源文件”权限。",
        );
      }
    }

    await this.runConversationTask({
      chatId,
      messageId: data.message.message_id,
      workspace,
      prompt: result.prompt,
      promptBlocks,
    });
  }

  private async handleIncomingImage(
    chatId: string,
    message: IncomingMessage["message"],
    workspace: WorkspaceConfig,
  ): Promise<void> {
    const imageKey = this.extractImageKey(message.content);
    if (!imageKey) {
      this.logger.warn("image message missing image key", {
        chatId,
        messageId: message.message_id,
        contentPreview: this.shorten(message.content, 200),
      });
      await this.#messageClient.sendText(chatId, "图片消息缺少 image_key，无法处理。");
      return;
    }

    const previous = this.#pendingImages.get(chatId);
    if (previous) {
      clearTimeout(previous.timer);
      previous.items.push({
        messageId: message.message_id,
        imageKey,
      });
      previous.workspace = workspace;
      previous.timer = this.createPendingImageTimer(chatId, message.message_id);
      return;
    }

    const timer = this.createPendingImageTimer(chatId, message.message_id);
    this.#pendingImages.set(chatId, {
      workspace,
      items: [
        {
          messageId: message.message_id,
          imageKey,
        },
      ],
      timer,
    });

    await this.#messageClient.sendText(
      chatId,
      `已收到图片。请在 ${Math.floor(this.#imageTextMergeWindowMs / 1000)} 秒内补充文字，我会合并后一起处理。`,
    );
  }

  private async runConversationTask(params: {
    chatId: string;
    messageId: string;
    workspace: WorkspaceConfig;
    prompt: string;
    promptBlocks?: ContentBlock[];
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
          promptBlocks: params.promptBlocks,
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
      this.#sessionController.updateModelState(params.chatId, result.models);

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

  private async buildPromptBlocksFromImageRefs(
    imageRefs: PendingImageReference[],
    fallbackPrompt: string,
    workspace: WorkspaceConfig,
  ): Promise<ContentBlock[] | undefined> {
    if (imageRefs.length === 0) {
      return undefined;
    }

    const outputDir = resolve(workspace.cwd, ".im-code-agent", "incoming-images");
    const downloadedList: Array<{
      messageId: string;
      filePath: string;
      mimeType: string;
      dataBase64: string;
    }> = [];

    for (const item of imageRefs) {
      const downloaded = await this.#messageClient.downloadMessageImage({
        messageId: item.messageId,
        imageKey: item.imageKey,
        outputDir,
      });
      downloadedList.push({
        messageId: item.messageId,
        filePath: downloaded.filePath,
        mimeType: downloaded.mimeType,
        dataBase64: downloaded.dataBase64,
      });
    }

    if (downloadedList.length === 0) {
      return undefined;
    }

    const textLines = [
      `用户发送了 ${downloadedList.length} 张飞书图片，并补充了文本说明。`,
      ...downloadedList.map(
        (item, index) => `图片 ${index + 1}（message_id=${item.messageId}）：${item.filePath}`,
      ),
      "请结合图片与文本一起完成任务；如果信息不足，请明确指出缺失项。",
      `用户文本：${fallbackPrompt}`,
    ];

    const blocks: ContentBlock[] = [
      {
        type: "text",
        text: textLines.join("\n"),
      },
    ];

    for (const downloaded of downloadedList) {
      blocks.push({
        type: "image",
        mimeType: downloaded.mimeType,
        data: downloaded.dataBase64,
      });
    }

    return blocks;
  }

  private extractImageKey(content: string): string | undefined {
    const parsed = parseContent(content);
    if (typeof parsed.image_key === "string" && parsed.image_key.trim()) {
      return parsed.image_key.trim();
    }

    const legacyKey = parsed.imave_key;
    if (typeof legacyKey === "string" && legacyKey.trim()) {
      return legacyKey.trim();
    }
    return undefined;
  }

  private createPendingImageTimer(chatId: string, messageId: string): NodeJS.Timeout {
    return setTimeout(() => {
      const queued = this.#messageQueue.runInChatQueue(
        chatId,
        `image-merge-timeout-${messageId}`,
        async () => {
          await this.flushPendingImages(chatId);
        },
      );

      if (!queued) {
        return;
      }
      void queued.catch((error) => {
        this.logger.error("flush pending image failed", {
          chatId,
          messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.#imageTextMergeWindowMs);
  }

  private clearPendingImages(chatId: string): void {
    const state = this.#pendingImages.get(chatId);
    if (!state) {
      return;
    }
    clearTimeout(state.timer);
    this.#pendingImages.delete(chatId);
  }

  private takePendingImages(chatId: string): PendingImageReference[] {
    const state = this.#pendingImages.get(chatId);
    if (!state) {
      return [];
    }
    clearTimeout(state.timer);
    this.#pendingImages.delete(chatId);
    return [...state.items];
  }

  private async flushPendingImages(chatId: string): Promise<void> {
    const state = this.#pendingImages.get(chatId);
    if (!state) {
      return;
    }
    const imageRefs = this.takePendingImages(chatId);
    if (imageRefs.length === 0) {
      return;
    }

    const fallbackPrompt = "请先识别并总结这些图片里的关键信息，然后给出可执行建议。";
    let promptBlocks: ContentBlock[] | undefined;
    try {
      promptBlocks = await this.buildPromptBlocksFromImageRefs(
        imageRefs,
        fallbackPrompt,
        state.workspace,
      );
    } catch (error) {
      this.logger.error("build timeout image prompt blocks failed", {
        chatId,
        imageCount: imageRefs.length,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.#messageClient.sendText(
        chatId,
        "图片下载失败，无法自动处理这组图片。请重试，或补一条文本消息后再发图。",
      );
      return;
    }

    const lastMessageId = imageRefs.at(-1)?.messageId;
    if (!lastMessageId) {
      return;
    }

    await this.runConversationTask({
      chatId,
      messageId: lastMessageId,
      workspace: state.workspace,
      prompt: fallbackPrompt,
      promptBlocks,
    });
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

  private shorten(text: string, maxLen: number): string {
    if (text.length <= maxLen) {
      return text;
    }
    return `${text.slice(0, maxLen)}...`;
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
