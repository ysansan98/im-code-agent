import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import lark from "@larksuiteoapi/node-sdk";
import type { BridgeEvent, FeishuConfig, WorkspaceConfig } from "@im-code-agent/shared";

import { ChatStateStore } from "./chat-state-store.ts";
import { TaskRunner } from "../session/task-runner.ts";
import type { Logger } from "../utils/logger.ts";

type FeishuMessageContent = {
  text?: string;
};

type ToolView = {
  id: string;
  status?: string;
  cmd?: string;
  path?: string;
  error?: string;
};

type ContentSegment =
  | {
      type: "text";
      content: string;
    }
  | {
      type: "tool";
      id: string;
    };

function isInterruptCommand(text: string): boolean {
  return text === "/stop" || text === "/interrupt";
}

export class FeishuGateway {
  readonly #client: lark.Client;
  readonly #wsClient: lark.WSClient;
  readonly #eventDispatcher: lark.EventDispatcher;
  readonly #processingMessageIds = new Set<string>();
  readonly #handledMessageIds = new Map<string, number>();
  readonly #dedupeTtlMs = 10 * 60 * 1000;
  readonly #patchMinIntervalMs = 280;
  readonly #chatQueues = new Map<string, Promise<void>>();
  readonly #chatCwds = new Map<string, string>();
  readonly #chatSessionIds = new Map<string, string>();
  readonly #chatStateStore = new ChatStateStore();

  constructor(
    private readonly config: FeishuConfig,
    private readonly workspaces: WorkspaceConfig[],
    private readonly taskRunner: TaskRunner,
    private readonly logger: Logger,
  ) {
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
    }).register({
      "im.message.receive_v1": async (data) => {
        await this.handleIncomingMessage(data);
      },
    });
  }

  async start(): Promise<void> {
    const persisted = await this.#chatStateStore.loadState();
    for (const [chatId, cwd] of persisted.chatCwds.entries()) {
      this.#chatCwds.set(chatId, cwd);
    }
    for (const [chatId, sessionId] of persisted.chatSessionIds.entries()) {
      this.#chatSessionIds.set(chatId, sessionId);
    }

    await this.#wsClient.start({
      eventDispatcher: this.#eventDispatcher,
    });
    this.logger.info("feishu gateway started", {
      persistedChats: this.#chatCwds.size,
      persistedSessions: this.#chatSessionIds.size,
    });
  }

  private async handleIncomingMessage(data: {
    sender: { sender_type: string };
    message: {
      message_id: string;
      chat_id: string;
      message_type: string;
      content: string;
    };
  }): Promise<void> {
    this.gcHandledMessageIds();

    const messageId = data.message.message_id;
    if (this.#handledMessageIds.has(messageId) || this.#processingMessageIds.has(messageId)) {
      this.logger.info("feishu duplicate message ignored", { messageId });
      return;
    }

    if (data.message.message_type === "text") {
      const content = this.parseContent(data.message.content);
      const text = (content.text ?? "").trim();
      if (isInterruptCommand(text)) {
        this.#processingMessageIds.add(messageId);
        void this.processInterruptCommand(data.message.chat_id)
          .catch((error) => {
            this.logger.error("feishu interrupt failed", {
              messageId,
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            this.#processingMessageIds.delete(messageId);
            this.#handledMessageIds.set(messageId, Date.now());
          });
        return;
      }
    }

    this.#processingMessageIds.add(messageId);
    const chatId = data.message.chat_id;
    const queue = (this.#chatQueues.get(chatId) ?? Promise.resolve())
      .catch(() => {
        return;
      })
      .then(async () => {
        await this.processMessage(data);
      });

    this.#chatQueues.set(chatId, queue);

    void queue
      .catch((error) => {
        this.logger.error("feishu message process failed", {
          messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.#processingMessageIds.delete(messageId);
        this.#handledMessageIds.set(messageId, Date.now());
        if (this.#chatQueues.get(chatId) === queue) {
          this.#chatQueues.delete(chatId);
        }
      });
  }

  private async processMessage(data: {
    sender: { sender_type: string };
    message: {
      message_id: string;
      chat_id: string;
      message_type: string;
      content: string;
    };
  }): Promise<void> {
    if (data.sender.sender_type !== "user") {
      return;
    }

    if (data.message.message_type !== "text") {
      await this.sendText(data.message.chat_id, "只支持文本消息。");
      return;
    }

    const workspace = this.resolveWorkspace(data.message.chat_id);
    if (!workspace) {
      await this.sendText(data.message.chat_id, "未配置可用工作区。");
      return;
    }

    const content = this.parseContent(data.message.content);
    const rawPrompt = (content.text ?? "").trim();
    if (!rawPrompt) {
      await this.sendText(data.message.chat_id, "消息内容为空。");
      return;
    }

    let command:
      | {
          type: "prompt";
          prompt: string;
        }
      | {
          type: "new";
          cwd?: string;
        };
    try {
      command = await this.parseUserCommand(rawPrompt, workspace.cwd);
    } catch (error) {
      await this.sendText(
        data.message.chat_id,
        `命令解析失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (command.type === "new") {
      await this.taskRunner.resetConversation(data.message.chat_id);
      this.#chatSessionIds.delete(data.message.chat_id);
      let nextWorkspace = workspace;
      if (command.cwd) {
        await this.setChatCwd(data.message.chat_id, command.cwd);
        nextWorkspace = {
          ...workspace,
          cwd: command.cwd,
        };
      } else {
        await this.setChatCwd(data.message.chat_id, workspace.cwd);
      }
      const conversation = await this.taskRunner.ensureConversation(
        data.message.chat_id,
        nextWorkspace,
        "codex",
      );
      this.#chatSessionIds.set(data.message.chat_id, conversation.sessionId);
      await this.persistChatState();
      await this.sendText(
        data.message.chat_id,
        `已切换到新会话，session_id: ${conversation.sessionId}\n工作目录：${nextWorkspace.cwd}`,
      );
      return;
    }

    const prompt = command.prompt;

    const segments: ContentSegment[] = [];
    let status: "running" | "completed" | "failed" = "running";
    let summary = "执行中";
    const tools = new Map<string, ToolView>();
    let lastPatchedAt = 0;
    let pendingPatchTimer: NodeJS.Timeout | undefined;
    let patchQueue = Promise.resolve();
    let cardMessageId: string | undefined;
    let typingReactionId: string | undefined;
    typingReactionId = await this.addTypingReaction(data.message.message_id);

    const ensureCardMessage = async (): Promise<string | undefined> => {
      if (cardMessageId) {
        return cardMessageId;
      }
      if (status === "running" && segments.length === 0) {
        return undefined;
      }
      cardMessageId = await this.sendCard(
        data.message.chat_id,
        this.buildCard({
          status,
          segments,
          tools,
          summary,
        }),
      );
      return cardMessageId;
    };

    const enqueuePatch = (force: boolean): void => {
      const now = Date.now();
      const wait = force ? 0 : Math.max(0, this.#patchMinIntervalMs - (now - lastPatchedAt));
      if (!force && pendingPatchTimer) {
        return;
      }

      if (pendingPatchTimer) {
        clearTimeout(pendingPatchTimer);
        pendingPatchTimer = undefined;
      }

      pendingPatchTimer = setTimeout(() => {
        pendingPatchTimer = undefined;
        lastPatchedAt = Date.now();
        patchQueue = patchQueue
          .then(async () => {
            const messageId = await ensureCardMessage();
            if (!messageId) {
              return;
            }
            await this.patchCard(
              messageId,
              this.buildCard({
                status,
                segments,
                tools,
                summary,
              }),
            );
          })
          .catch((error) => {
            this.logger.warn("feishu patch card failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, wait);
    };

    const result = await this.taskRunner.startConversationTask(
      data.message.chat_id,
      {
        workspaceId: workspace.id,
        agent: "codex",
        prompt,
      },
      workspace,
      {
        resumeSessionId: this.#chatSessionIds.get(data.message.chat_id),
        onEvent: (event) => {
          if (event.type === "task.output") {
            const toolUpdate = this.parseToolChunk(event.chunk);
            if (toolUpdate) {
              const prev = tools.get(toolUpdate.id) ?? { id: toolUpdate.id };
              tools.set(toolUpdate.id, {
                ...prev,
                ...toolUpdate,
              });
              if (
                !segments.some((segment) => segment.type === "tool" && segment.id === toolUpdate.id)
              ) {
                segments.push({
                  type: "tool",
                  id: toolUpdate.id,
                });
              }
            } else {
              const last = segments[segments.length - 1];
              if (last?.type === "text") {
                last.content += event.chunk;
              } else {
                segments.push({
                  type: "text",
                  content: event.chunk,
                });
              }
            }
            enqueuePatch(false);
            return;
          }

          if (event.type === "task.failed") {
            status = "failed";
            summary = event.error;
            enqueuePatch(true);
            return;
          }

          if (event.type === "task.completed") {
            status = "completed";
            summary = event.summary ?? "执行完成";
            enqueuePatch(true);
          }
        },
      },
    );
    if (result.sessionId && this.#chatSessionIds.get(data.message.chat_id) !== result.sessionId) {
      this.#chatSessionIds.set(data.message.chat_id, result.sessionId);
      await this.persistChatState();
    }

    const failed = result.events.find(
      (event): event is Extract<BridgeEvent, { type: "task.failed" }> => {
        return event.type === "task.failed";
      },
    );
    const completed = result.events.find(
      (event): event is Extract<BridgeEvent, { type: "task.completed" }> => {
        return event.type === "task.completed";
      },
    );

    if (failed) {
      status = "failed";
      summary = failed.error;
    } else if (completed) {
      status = "completed";
      summary = completed.summary ?? "执行完成";
    }

    enqueuePatch(true);
    await patchQueue;
    if (!cardMessageId) {
      await ensureCardMessage();
    }
    if (typingReactionId) {
      await this.removeTypingReaction(data.message.message_id, typingReactionId).catch(() => {
        return;
      });
      typingReactionId = undefined;
    }
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
    await this.persistChatState();
  }

  private async persistChatState(): Promise<void> {
    await this.#chatStateStore.saveState({
      chatCwds: this.#chatCwds,
      chatSessionIds: this.#chatSessionIds,
    });
  }

  private async processInterruptCommand(chatId: string): Promise<void> {
    if (!this.taskRunner.isConversationRunning(chatId)) {
      await this.sendText(chatId, "当前没有执行中的任务。");
      return;
    }
    await this.taskRunner.resetConversation(chatId);
    await this.sendText(chatId, "已打断当前任务。");
  }

  private async parseUserCommand(
    rawPrompt: string,
    currentCwd: string,
  ): Promise<
    | {
        type: "prompt";
        prompt: string;
      }
    | {
        type: "new";
        cwd?: string;
      }
  > {
    if (rawPrompt === "/new") {
      return {
        type: "new",
      };
    }

    if (rawPrompt.startsWith("/new ")) {
      const inputPath = rawPrompt.slice(5).trim();
      if (!inputPath) {
        return {
          type: "new",
        };
      }
      const cwd = await this.resolveValidatedCwd(inputPath, currentCwd);
      return {
        type: "new",
        cwd,
      };
    }

    return {
      type: "prompt",
      prompt: rawPrompt,
    };
  }

  private async resolveValidatedCwd(inputPath: string, baseCwd: string): Promise<string> {
    const candidate = isAbsolute(inputPath) ? inputPath : resolve(baseCwd, inputPath);
    const dirStat = await stat(candidate).catch(() => undefined);
    if (!dirStat || !dirStat.isDirectory()) {
      throw new Error(`路径不存在或不是目录：${candidate}`);
    }
    return resolve(candidate);
  }

  private gcHandledMessageIds(): void {
    const now = Date.now();
    for (const [messageId, timestamp] of this.#handledMessageIds.entries()) {
      if (now - timestamp > this.#dedupeTtlMs) {
        this.#handledMessageIds.delete(messageId);
      }
    }
  }

  private parseContent(content: string): FeishuMessageContent {
    try {
      return JSON.parse(content) as FeishuMessageContent;
    } catch {
      return {};
    }
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

  private buildCard(params: {
    status: "running" | "completed" | "failed";
    segments: ContentSegment[];
    tools: Map<string, ToolView>;
    summary: string;
  }): Record<string, unknown> {
    const footerElement =
      params.status === "running"
        ? {
            tag: "markdown",
            content: " ",
            icon: {
              tag: "custom_icon",
              img_key: "img_v3_02vb_496bec09-4b43-4773-ad6b-0cdd103cd2bg",
              size: "16px 16px",
            },
            element_id: "loading_icon",
          }
        : params.status === "completed"
          ? {
              tag: "div",
              text: {
                tag: "plain_text",
                content: "已完成",
                text_size: "cus-0",
              },
            }
          : {
              tag: "div",
              text: {
                tag: "plain_text",
                content: `执行失败：${params.summary}`,
                text_size: "cus-0",
              },
            };

    const elements = this.buildContentElements(params.segments, params.tools);

    if (elements.length === 0) {
      elements.push({
        tag: "markdown",
        content: " ",
      });
    }

    elements.push(footerElement);

    return {
      schema: "2.0",
      config: {
        update_multi: true,
        width_mode: "fill",
        streaming_mode: true,
        style: {
          text_size: {
            "cus-0": {
              default: "notation",
              pc: "notation",
              mobile: "notation",
            },
            "cus-1": {
              default: "small",
              pc: "small",
              mobile: "small",
            },
          },
          color: {
            foot_gray: {
              light_mode: "rgba(100,106,115,1)",
              dark_mode: "rgba(182,188,196,1)",
            },
            tool_meta_gray: {
              light_mode: "rgba(100,106,115,1)",
              dark_mode: "rgba(182,188,196,1)",
            },
          },
        },
        summary: {
          content:
            params.status === "running"
              ? "生成中"
              : params.status === "completed"
                ? "已完成"
                : `执行失败：${params.summary}`,
        },
      },
      body: {
        direction: "vertical",
        vertical_spacing: "6px",
        padding: "10px 12px 10px 12px",
        elements,
      },
    };
  }

  private buildContentElements(
    segments: ContentSegment[],
    tools: Map<string, ToolView>,
  ): Array<Record<string, unknown>> {
    const elements: Array<Record<string, unknown>> = [];
    const maxToolCards = 12;
    let renderedToolCards = 0;
    let hiddenToolCards = 0;
    let lastToolPath: string | undefined;
    let lastToolSignature: string | undefined;
    let index = 0;
    while (index < segments.length) {
      const segment = segments[index];
      if (!segment) {
        break;
      }
      if (segment.type === "text") {
        if (!segment.content) {
          index += 1;
          continue;
        }
        elements.push({
          tag: "markdown",
          content: this.escapeCardMarkdown(segment.content),
        });
        index += 1;
        continue;
      }

      const toolCards: Array<Record<string, unknown>> = [];
      while (index < segments.length && segments[index]?.type === "tool") {
        const current = segments[index] as Extract<ContentSegment, { type: "tool" }>;
        const tool = tools.get(current.id);
        if (!tool) {
          index += 1;
          continue;
        }
        const statusText = this.formatToolStatus(tool.status);
        const statusBadge = this.getToolStatusBadge(tool.status);
        const cmdText = tool.cmd ? this.shorten(tool.cmd, 140) : "（无命令）";
        const pathText = tool.path ? this.shorten(tool.path, 90) : undefined;
        const errorText = tool.error ? this.shorten(tool.error, 160) : undefined;
        const title = this.getToolDisplayTitle(tool.cmd);
        const signature = `${statusText}|${cmdText}|${pathText ?? ""}|${errorText ?? ""}`;
        if (signature === lastToolSignature) {
          index += 1;
          continue;
        }
        lastToolSignature = signature;

        if (renderedToolCards >= maxToolCards) {
          hiddenToolCards += 1;
          index += 1;
          continue;
        }

        const cardElements: Array<Record<string, unknown>> = [
          {
            tag: "div",
            text: {
              tag: "plain_text",
              content: `${statusBadge} ${title}`,
            },
          },
          {
            tag: "div",
            text: {
              tag: "plain_text",
              content: cmdText,
            },
          },
          {
            tag: "markdown",
            content: `<font color='grey'>状态：${this.escapeCardMarkdown(statusText)}</font>`,
          },
        ];
        if (pathText && pathText !== lastToolPath) {
          cardElements.push({
            tag: "markdown",
            content: `<font color='grey'>↳ ${this.escapeCardMarkdown(pathText)}</font>`,
          });
          lastToolPath = pathText;
        }
        if (errorText) {
          cardElements.push({
            tag: "div",
            text: {
              tag: "plain_text",
              content: `❗ ${errorText}`,
              text_size: "cus-1",
            },
          });
        }

        toolCards.push({
          tag: "interactive_container",
          has_border: true,
          corner_radius: "10px",
          padding: "8px 10px 8px 10px",
          margin: "4px 0 4px 0",
          elements: cardElements,
        });
        renderedToolCards += 1;
        index += 1;
      }

      if (toolCards.length > 0) {
        elements.push({
          tag: "collapsible_panel",
          header: {
            title: {
              tag: "plain_text",
              content: `🛠️ 工具调用（${toolCards.length}）`,
            },
          },
          elements: toolCards,
        });
      }
    }
    if (hiddenToolCards > 0) {
      elements.push({
        tag: "markdown",
        content: `…已折叠 ${hiddenToolCards} 条工具调用`,
      });
    }
    return elements;
  }

  private parseToolChunk(chunk: string): ToolView | undefined {
    const lines = chunk
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0 || !lines[0]?.startsWith("[tool]")) {
      return undefined;
    }

    const headMatch = lines[0].match(/^\[tool\]\s+(.+?)(?:\s+\(([^)]+)\))?$/);
    if (!headMatch?.[1]) {
      return undefined;
    }

    const id = headMatch[1].trim();
    const status = headMatch[2]?.trim();
    const tool: ToolView = { id, status };

    for (const line of lines.slice(1)) {
      if (line.startsWith("cmd:")) {
        tool.cmd = line.slice(4).trim();
        continue;
      }
      if (line.startsWith("path:")) {
        tool.path = line.slice(5).trim();
        continue;
      }
      if (line.startsWith("error:")) {
        tool.error = line.slice(6).trim();
      }
    }

    return tool;
  }

  private formatToolStatus(status?: string): string {
    if (!status) {
      return "处理中";
    }
    if (status === "in_progress") {
      return "进行中";
    }
    if (status === "completed") {
      return "已完成";
    }
    if (status === "failed") {
      return "失败";
    }
    return status;
  }

  private getToolStatusBadge(_status?: string): string {
    return "🛠️";
  }

  private getToolDisplayTitle(cmd?: string): string {
    if (!cmd) {
      return "步骤";
    }
    const head = cmd.trim().split(/\s+/, 1)[0]?.toLowerCase();
    if (!head) {
      return "步骤";
    }
    if (head === "cat" || head === "sed" || head === "head" || head === "tail") {
      return "读取";
    }
    if (head === "ls" || head === "find" || head === "rg" || head === "grep") {
      return "检索";
    }
    if (head === "git") {
      return "Git";
    }
    if (head === "npm" || head === "pnpm" || head === "vp") {
      return "命令";
    }
    return "步骤";
  }

  private shorten(text: string, maxLen: number): string {
    if (text.length <= maxLen) {
      return text;
    }
    return `${text.slice(0, maxLen)}...`;
  }

  private escapeCardMarkdown(text: string): string {
    return text.replace(/\r/g, "").replace(/\\/g, "\\\\").replace(/`/g, "\\`");
  }
}
