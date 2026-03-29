import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import type { WorkspaceConfig } from "#shared";

import { ApprovalGateway } from "../approval/approval-gateway.ts";
import { ApprovalStore } from "../approval/approval-store.ts";
import { FeishuGateway } from "./feishu-gateway.ts";
import { FeishuMessageClient } from "./feishu-message-client.ts";
import { FeishuSessionController } from "./session-controller.ts";

const workspace: WorkspaceConfig = {
  id: "local-default",
  name: "Local Default",
  cwd: "/tmp",
};

const logger = {
  info: () => {
    return;
  },
  warn: () => {
    return;
  },
  error: () => {
    return;
  },
};

function createGateway(imageTextMergeWindowMs = 10_000): FeishuGateway {
  return new FeishuGateway(
    {
      appId: "app_id_test",
      appSecret: "app_secret_test",
    },
    [workspace],
    {} as never,
    new ApprovalGateway(new ApprovalStore(), logger),
    logger,
    false,
    imageTextMergeWindowMs,
  );
}

function createIncomingMessage(params: {
  messageId: string;
  chatId?: string;
  type: string;
  content: string;
}) {
  return {
    sender: {
      sender_type: "user",
    },
    message: {
      message_id: params.messageId,
      chat_id: params.chatId ?? "chat-1",
      message_type: params.type,
      content: params.content,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("FeishuGateway", () => {
  test("image then text merges pending image references into promptBlocks", async () => {
    const gateway = createGateway();
    vi.spyOn(FeishuSessionController.prototype, "resolveValidatedWorkspace").mockResolvedValue(
      workspace,
    );
    const sendTextSpy = vi
      .spyOn(FeishuMessageClient.prototype, "sendText")
      .mockResolvedValue(undefined);
    const mergedBlocks = [
      {
        type: "text" as const,
        text: "merged payload",
      },
    ];
    const gatewayForTest = gateway as any;
    const buildPromptBlocksSpy = vi
      .spyOn(gatewayForTest, "buildPromptBlocksFromImageRefs")
      .mockResolvedValue(mergedBlocks);
    const runConversationTaskSpy = vi
      .spyOn(gatewayForTest, "runConversationTask")
      .mockResolvedValue(undefined);

    await gatewayForTest.processMessage(
      createIncomingMessage({
        messageId: "img-1",
        type: "image",
        content: JSON.stringify({ image_key: "img_key_1" }),
      }),
    );
    await gatewayForTest.processMessage(
      createIncomingMessage({
        messageId: "txt-1",
        type: "text",
        content: JSON.stringify({ text: "请帮我分析这张图" }),
      }),
    );

    expect(sendTextSpy).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("已收到图片。请在 10 秒内补充文字"),
    );
    expect(buildPromptBlocksSpy).toHaveBeenCalledWith(
      [
        {
          messageId: "img-1",
          imageKey: "img_key_1",
        },
      ],
      "请帮我分析这张图",
      workspace,
    );
    expect(runConversationTaskSpy).toHaveBeenCalledWith({
      chatId: "chat-1",
      messageId: "txt-1",
      workspace,
      prompt: "请帮我分析这张图",
      promptBlocks: mergedBlocks,
    });
  });

  test("image timeout auto flushes pending images with fallback prompt", async () => {
    vi.useFakeTimers();
    const gateway = createGateway(50);
    vi.spyOn(FeishuSessionController.prototype, "resolveValidatedWorkspace").mockResolvedValue(
      workspace,
    );
    const sendTextSpy = vi
      .spyOn(FeishuMessageClient.prototype, "sendText")
      .mockResolvedValue(undefined);
    const mergedBlocks = [
      {
        type: "text" as const,
        text: "timeout payload",
      },
    ];
    const gatewayForTest = gateway as any;
    const buildPromptBlocksSpy = vi
      .spyOn(gatewayForTest, "buildPromptBlocksFromImageRefs")
      .mockResolvedValue(mergedBlocks);
    const runConversationTaskSpy = vi
      .spyOn(gatewayForTest, "runConversationTask")
      .mockResolvedValue(undefined);

    await gatewayForTest.processMessage(
      createIncomingMessage({
        messageId: "img-timeout-1",
        type: "image",
        content: JSON.stringify({ image_key: "img_timeout_key_1" }),
      }),
    );
    await vi.advanceTimersByTimeAsync(55);

    expect(sendTextSpy).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("已收到图片。请在 0 秒内补充文字"),
    );
    expect(buildPromptBlocksSpy).toHaveBeenCalledWith(
      [
        {
          messageId: "img-timeout-1",
          imageKey: "img_timeout_key_1",
        },
      ],
      "请先识别并总结这些图片里的关键信息，然后给出可执行建议。",
      workspace,
    );
    expect(runConversationTaskSpy).toHaveBeenCalledWith({
      chatId: "chat-1",
      messageId: "img-timeout-1",
      workspace,
      prompt: "请先识别并总结这些图片里的关键信息，然后给出可执行建议。",
      promptBlocks: mergedBlocks,
    });
  });
});
