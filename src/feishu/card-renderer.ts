import type { ApprovalDecision, ApprovalRequest } from "#shared";

import type { Logger } from "../utils/logger.ts";

export type ToolView = {
  id: string;
  name?: string;
  status?: string;
  cmd?: string;
  query?: string;
  url?: string;
  path?: string;
  error?: string;
};

export type ContentSegment =
  | {
      type: "text";
      content: string;
    }
  | {
      type: "tool";
      id: string;
    };

type TaskCardStatus = "running" | "completed" | "failed";

type BuildTaskCardInput = {
  status: TaskCardStatus;
  segments: ContentSegment[];
  tools: Map<string, ToolView>;
  summary: string;
};

type StreamerDeps = {
  chatId: string;
  logger: Logger;
  renderer: FeishuCardRenderer;
  sendCard: (chatId: string, card: Record<string, unknown>) => Promise<string>;
  patchCard: (messageId: string, card: Record<string, unknown>) => Promise<void>;
  patchMinIntervalMs: number;
};

type ToolUpdatePayload = {
  toolCallId?: string;
  toolName?: string;
  status?: string;
  title?: string;
  query?: string;
  url?: string;
  command?: string;
  path?: string;
  error?: string;
};

export class TaskCardStreamer {
  readonly #segments: ContentSegment[] = [];
  readonly #tools = new Map<string, ToolView>();
  #status: TaskCardStatus = "running";
  #summary = "执行中";
  #lastPatchedAt = 0;
  #pendingPatchTimer: NodeJS.Timeout | undefined;
  readonly #pendingPatchResolvers: Array<() => void> = [];
  #patchQueue = Promise.resolve();
  #cardMessageId: string | undefined;

  constructor(private readonly deps: StreamerDeps) {}

  handleOutputChunk(chunk: string): void {
    const toolUpdate = this.deps.renderer.parseToolChunk(chunk);
    if (toolUpdate) {
      this.upsertTool(toolUpdate);
      this.enqueuePatch(false);
      return;
    }

    const last = this.#segments[this.#segments.length - 1];
    if (last?.type === "text") {
      last.content += chunk;
    } else {
      this.#segments.push({
        type: "text",
        content: chunk,
      });
    }
    this.enqueuePatch(false);
  }

  handleToolUpdate(update: ToolUpdatePayload): void {
    const toolUpdate = this.deps.renderer.toToolView(update);
    if (!toolUpdate) {
      return;
    }
    this.upsertTool(toolUpdate);
    this.enqueuePatch(false);
  }

  markFailed(error: string): void {
    this.#status = "failed";
    this.#summary = error;
    this.enqueuePatch(true);
  }

  markCompleted(summary?: string): void {
    this.#status = "completed";
    this.#summary = summary ?? "执行完成";
    this.enqueuePatch(true);
  }

  async finalize(): Promise<void> {
    this.enqueuePatch(true);
    if (this.#pendingPatchTimer) {
      await new Promise<void>((resolve) => {
        this.#pendingPatchResolvers.push(resolve);
      });
    }
    await this.#patchQueue;
    if (!this.#cardMessageId) {
      await this.ensureCardMessage();
    }
  }

  private upsertTool(toolUpdate: ToolView): void {
    const prev = this.#tools.get(toolUpdate.id) ?? { id: toolUpdate.id };
    this.#tools.set(toolUpdate.id, {
      ...prev,
      ...toolUpdate,
    });
    if (
      !this.#segments.some((segment) => segment.type === "tool" && segment.id === toolUpdate.id)
    ) {
      this.#segments.push({
        type: "tool",
        id: toolUpdate.id,
      });
    }
  }

  private enqueuePatch(force: boolean): void {
    const now = Date.now();
    const wait = force
      ? 0
      : Math.max(0, this.deps.patchMinIntervalMs - (now - this.#lastPatchedAt));
    if (!force && this.#pendingPatchTimer) {
      return;
    }

    if (this.#pendingPatchTimer) {
      clearTimeout(this.#pendingPatchTimer);
      this.#pendingPatchTimer = undefined;
    }

    this.#pendingPatchTimer = setTimeout(() => {
      this.#pendingPatchTimer = undefined;
      this.#lastPatchedAt = Date.now();
      while (this.#pendingPatchResolvers.length > 0) {
        this.#pendingPatchResolvers.shift()?.();
      }
      this.#patchQueue = this.#patchQueue
        .then(async () => {
          const messageId = await this.ensureCardMessage();
          if (!messageId) {
            return;
          }
          await this.deps.patchCard(
            messageId,
            this.deps.renderer.buildTaskCard({
              status: this.#status,
              segments: this.#segments,
              tools: this.#tools,
              summary: this.#summary,
            }),
          );
        })
        .catch((error) => {
          this.deps.logger.warn("feishu patch card failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }, wait);
  }

  private async ensureCardMessage(): Promise<string | undefined> {
    if (this.#cardMessageId) {
      return this.#cardMessageId;
    }
    if (this.#status === "running" && this.#segments.length === 0) {
      return undefined;
    }
    this.#cardMessageId = await this.deps.sendCard(
      this.deps.chatId,
      this.deps.renderer.buildTaskCard({
        status: this.#status,
        segments: this.#segments,
        tools: this.#tools,
        summary: this.#summary,
      }),
    );
    return this.#cardMessageId;
  }
}

export class FeishuCardRenderer {
  buildTaskCard(params: BuildTaskCardInput): Record<string, unknown> {
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

  buildApprovalSummaryCard(title: string, decision: ApprovalDecision): Record<string, unknown> {
    return {
      schema: "2.0",
      config: {
        update_multi: true,
      },
      body: {
        direction: "vertical",
        padding: "10px 12px 10px 12px",
        elements: [
          {
            tag: "markdown",
            content: `**${this.escapeCardMarkdown(title)}**`,
          },
          {
            tag: "markdown",
            content: `request: ${this.escapeCardMarkdown(decision.requestId)}`,
          },
          {
            tag: "markdown",
            content: `时间: ${this.escapeCardMarkdown(decision.decidedAt)}`,
          },
          {
            tag: "markdown",
            content: `操作者: ${this.escapeCardMarkdown(decision.decidedBy)}`,
          },
        ],
      },
    };
  }

  buildAccessModeCard(params: {
    cardId: string;
    chatId: string;
    defaultMode: "standard" | "full-access";
    overrideMode?: "standard" | "full-access";
    readonly?: boolean;
    readonlyReason?: string;
  }): Record<string, unknown> {
    const currentMode = params.overrideMode ?? params.defaultMode;
    const overrideText = params.overrideMode
      ? this.formatAccessMode(params.overrideMode)
      : "继承默认";
    const sourceText = params.overrideMode ? "会话临时覆盖" : "全局默认";
    const fullActive = currentMode === "full-access";
    const standardActive = currentMode === "standard" && Boolean(params.overrideMode);
    const inheritActive = !params.overrideMode;

    return {
      schema: "2.0",
      config: {
        update_multi: true,
        width_mode: "fill",
        style: {
          text_size: {
            "cus-0": {
              default: "notation",
              pc: "notation",
              mobile: "notation",
            },
          },
          color: {
            foot_gray: {
              light_mode: "rgba(100,106,115,1)",
              dark_mode: "rgba(182,188,196,1)",
            },
          },
        },
      },
      body: {
        direction: "vertical",
        padding: "10px 12px 10px 12px",
        elements: [
          {
            tag: "markdown",
            content: "**权限模式**",
          },
          {
            tag: "markdown",
            content: `全局默认: ${this.escapeCardMarkdown(this.formatAccessMode(params.defaultMode))}`,
          },
          {
            tag: "markdown",
            content: `本会话覆盖: ${this.escapeCardMarkdown(overrideText)}${inheritActive ? " ✅" : ""}`,
          },
          {
            tag: "markdown",
            content: `当前生效: ${this.escapeCardMarkdown(this.formatAccessMode(currentMode))}（${this.escapeCardMarkdown(sourceText)}） ✅`,
          },
          ...(params.readonly
            ? [
                {
                  tag: "markdown",
                  content: params.readonlyReason ?? "本卡已应用变更，按钮已锁定。",
                },
              ]
            : [
                {
                  tag: "column_set",
                  columns: [
                    this.buildActionButton(
                      fullActive ? "本会话 Full Access（当前）" : "本会话 Full Access",
                      fullActive ? "primary" : "default",
                      {
                        type: "access",
                        cardId: params.cardId,
                        chatId: params.chatId,
                        action: "set",
                        mode: "full-access",
                      },
                    ),
                    this.buildActionButton(
                      standardActive ? "本会话 Standard（当前）" : "本会话 Standard",
                      standardActive ? "primary" : "default",
                      {
                        type: "access",
                        cardId: params.cardId,
                        chatId: params.chatId,
                        action: "set",
                        mode: "standard",
                      },
                    ),
                    this.buildActionButton(
                      inheritActive ? "恢复默认（当前）" : "恢复默认",
                      inheritActive ? "primary" : "default",
                      {
                        type: "access",
                        cardId: params.cardId,
                        chatId: params.chatId,
                        action: "clear",
                      },
                    ),
                  ],
                },
              ]),
          {
            tag: "div",
            text: {
              tag: "plain_text",
              content: "提示：会话覆盖仅当前会话有效，切换/重置会话后恢复默认。",
              text_size: "cus-0",
            },
          },
        ],
      },
    };
  }

  buildApprovalCard(
    request: ApprovalRequest,
    status: "pending" | "approved" | "rejected" | "expired",
    decision?: ApprovalDecision,
  ): Record<string, unknown> {
    const statusText =
      status === "pending"
        ? "待审批"
        : status === "approved"
          ? "已批准"
          : status === "rejected"
            ? "已拒绝"
            : "已超时";
    const elements: Array<Record<string, unknown>> = [
      {
        tag: "markdown",
        content: `**状态：${this.escapeCardMarkdown(statusText)}**`,
      },
      {
        tag: "markdown",
        content: `类型: ${this.escapeCardMarkdown(request.kind)} | 风险: ${this.escapeCardMarkdown(request.riskLevel)}`,
      },
      {
        tag: "markdown",
        content: `标题: ${this.escapeCardMarkdown(request.title)}`,
      },
      {
        tag: "markdown",
        content: `工作目录: ${this.escapeCardMarkdown(request.cwd)}`,
      },
    ];
    if (request.command) {
      elements.push({
        tag: "markdown",
        content: `命令: \`${this.escapeCardMarkdown(this.shorten(request.command, 140))}\``,
      });
    }
    if (request.target) {
      elements.push({
        tag: "markdown",
        content: `目标: ${this.escapeCardMarkdown(request.target)}`,
      });
    }
    if (status === "pending") {
      elements.push({
        tag: "column_set",
        columns: [
          this.buildApprovalButton("批准", "primary", {
            requestId: request.id,
            taskId: request.taskId,
            decision: "approved",
          }),
          this.buildApprovalButton("本会话允许", "default", {
            requestId: request.id,
            taskId: request.taskId,
            decision: "approved",
            comment: "approved-for-session",
          }),
          this.buildApprovalButton("拒绝", "danger", {
            requestId: request.id,
            taskId: request.taskId,
            decision: "rejected",
          }),
        ],
      });
    } else if (decision) {
      elements.push({
        tag: "markdown",
        content: `操作人: ${this.escapeCardMarkdown(decision.decidedBy)}\\n时间: ${this.escapeCardMarkdown(decision.decidedAt)}`,
      });
    }

    return {
      schema: "2.0",
      config: {
        update_multi: true,
        width_mode: "fill",
      },
      body: {
        direction: "vertical",
        padding: "10px 12px 10px 12px",
        elements,
      },
    };
  }

  parseToolChunk(chunk: string): ToolView | undefined {
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

  toToolView(update: ToolUpdatePayload): ToolView | undefined {
    if (!update.toolCallId) {
      return undefined;
    }
    const cmd = update.command ?? update.query ?? update.url ?? update.title ?? update.toolName;
    return {
      id: update.toolCallId,
      name: update.toolName,
      status: update.status,
      cmd,
      query: update.query,
      url: update.url,
      path: update.path,
      error: update.error,
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
        const title = tool.name ?? this.getToolDisplayTitle(tool.cmd);
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

  private buildApprovalButton(
    label: string,
    type: "primary" | "default" | "danger",
    value: Record<string, string>,
  ): Record<string, unknown> {
    return {
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [
        {
          tag: "button",
          type,
          text: {
            tag: "plain_text",
            content: label,
          },
          behaviors: [
            {
              type: "callback",
              value,
            },
          ],
        },
      ],
    };
  }

  private buildActionButton(
    label: string,
    type: "primary" | "default" | "danger",
    value: Record<string, string>,
  ): Record<string, unknown> {
    return {
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [
        {
          tag: "button",
          type,
          text: {
            tag: "plain_text",
            content: label,
          },
          behaviors: [
            {
              type: "callback",
              value,
            },
          ],
        },
      ],
    };
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

  private formatAccessMode(mode: "standard" | "full-access"): string {
    return mode === "full-access" ? "Full Access" : "Standard";
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
