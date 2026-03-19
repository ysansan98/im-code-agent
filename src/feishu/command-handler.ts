import type { WorkspaceConfig } from "#shared";

import type { TaskRunner } from "../session/task-runner.ts";
import type { FeishuCardActionHandler } from "./feishu-card-action-handler.ts";
import type { FeishuMessageClient } from "./feishu-message-client.ts";
import type { FeishuSessionController } from "./session-controller.ts";
import type { UserCommand } from "./command-router.ts";

type HandleCommandResult =
  | {
      type: "handled";
    }
  | {
      type: "prompt";
      prompt: string;
    };

type FeishuCommandHandlerDeps = {
  sessionController: FeishuSessionController;
  cardActionHandler: FeishuCardActionHandler;
  messageClient: FeishuMessageClient;
  taskRunner: TaskRunner;
};

export class FeishuCommandHandler {
  constructor(private readonly deps: FeishuCommandHandlerDeps) {}

  async handle(params: {
    chatId: string;
    workspace: WorkspaceConfig;
    command: UserCommand;
  }): Promise<HandleCommandResult> {
    const { chatId, workspace, command } = params;

    if (command.type === "prompt") {
      return {
        type: "prompt",
        prompt: command.prompt,
      };
    }

    if (command.type === "help") {
      await this.deps.messageClient.sendText(
        chatId,
        [
          "支持指令：",
          "/help - 展示指令说明",
          "/new [path] - 新建会话，可选切换工作目录",
          "/model - 查看并切换当前模型",
          "/model <name> - 直接切换到指定模型",
          "/status - 查看当前会话状态",
          "/stop - 打断当前执行中的任务",
          "/perm - 查看并切换权限模式",
        ].join("\n"),
      );
      return { type: "handled" };
    }

    if (command.type === "new") {
      const next = await this.deps.sessionController.startNewConversation(
        {
          chatId,
          workspace,
          agent: "codex",
          cwd: command.cwd,
        },
        this.deps.taskRunner,
      );

      await this.deps.messageClient.sendText(
        chatId,
        `已切换到新会话，session_id: ${next.sessionId}\n工作目录：${next.workspace.cwd}`,
      );
      return { type: "handled" };
    }

    if (command.type === "status") {
      await this.deps.messageClient.sendText(
        chatId,
        [
          `session_id: ${this.deps.sessionController.getBridgeSessionId(chatId) ?? "未创建"}`,
          `codex_session_id: ${this.deps.sessionController.getResumeSessionId(chatId) ?? "未创建"}`,
          `工具目录（cwd）: ${workspace.cwd}`,
          `当前模型: ${this.deps.sessionController.getModel(chatId) ?? "未设置"}`,
          `权限模式: ${this.deps.sessionController.getAccessMode(chatId)}`,
        ].join("\n"),
      );
      return { type: "handled" };
    }

    if (command.type === "stop") {
      const interrupted = await this.deps.sessionController.interrupt(chatId, this.deps.taskRunner);
      await this.deps.messageClient.sendText(
        chatId,
        interrupted ? "已打断当前任务。" : "当前没有执行中的任务。",
      );
      return { type: "handled" };
    }

    if (command.type === "show-access") {
      await this.deps.cardActionHandler.sendPermissionCard(chatId);
      return { type: "handled" };
    }

    if (command.type === "model") {
      if (!command.model) {
        if (this.deps.sessionController.getAvailableModels(chatId).length === 0) {
          await this.deps.sessionController.startNewConversation(
            {
              chatId,
              workspace,
              agent: "codex",
            },
            this.deps.taskRunner,
          );
        }
        await this.deps.cardActionHandler.sendModelCard(chatId);
        return { type: "handled" };
      }

      const availableModels = this.deps.sessionController.getAvailableModels(chatId);
      if (availableModels.length === 0) {
        await this.deps.sessionController.startNewConversation(
          {
            chatId,
            workspace,
            agent: "codex",
          },
          this.deps.taskRunner,
        );
      }
      const resolvedModels = this.deps.sessionController.getAvailableModels(chatId);
      if (!resolvedModels.some((item) => item.id === command.model)) {
        await this.deps.messageClient.sendText(
          chatId,
          `不支持的模型：${command.model}\n可用模型：${resolvedModels.map((item) => item.id).join(", ")}`,
        );
        return { type: "handled" };
      }

      const changed = await this.deps.sessionController.setModel(
        chatId,
        command.model,
        this.deps.taskRunner,
      );
      await this.deps.messageClient.sendText(
        chatId,
        changed
          ? `已切换模型：${this.deps.sessionController.getModel(chatId)}`
          : `当前模型已是：${this.deps.sessionController.getModel(chatId)}`,
      );
      return { type: "handled" };
    }

    return { type: "handled" };
  }
}
