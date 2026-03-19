import { describe, expect, test } from "vite-plus/test";

import type { WorkspaceConfig } from "#shared";

import { FeishuCommandHandler } from "./command-handler.ts";

const workspace: WorkspaceConfig = {
  id: "local-default",
  name: "Local Default",
  cwd: "/tmp",
  allowedAgents: ["codex"],
};

describe("FeishuCommandHandler", () => {
  test("/model without session auto creates session then shows model card", async () => {
    let startNewConversationCalls = 0;
    let sendModelCardCalls = 0;

    const handler = new FeishuCommandHandler({
      sessionController: {
        getAvailableModels: () =>
          startNewConversationCalls > 0 ? [{ id: "gpt-5", name: "GPT-5" }] : [],
        startNewConversation: async () => {
          startNewConversationCalls += 1;
          return {
            sessionId: "session-1",
            workspace,
          };
        },
      } as never,
      cardActionHandler: {
        sendModelCard: async () => {
          sendModelCardCalls += 1;
        },
      } as never,
      messageClient: {
        sendText: async () => {
          return;
        },
      } as never,
      taskRunner: {} as never,
    });

    const result = await handler.handle({
      chatId: "chat-1",
      workspace,
      command: { type: "model" },
    });

    expect(result).toEqual({ type: "handled" });
    expect(startNewConversationCalls).toBe(1);
    expect(sendModelCardCalls).toBe(1);
  });
});
