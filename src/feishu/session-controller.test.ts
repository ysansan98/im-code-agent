import { describe, expect, test } from "vite-plus/test";

import type { SessionModelState, WorkspaceConfig } from "#shared";

import { FeishuSessionController } from "./session-controller.ts";

const workspace: WorkspaceConfig = {
  id: "local-default",
  name: "Local Default",
  cwd: "/tmp",
  allowedAgents: ["codex"],
};

function createStore() {
  let state = {
    chatCwds: new Map<string, string>(),
    chatBridgeSessionIds: new Map<string, string>(),
    chatSessionIds: new Map<string, string>(),
  };
  return {
    loadState: async () => state,
    saveState: async (nextState: typeof state) => {
      state = {
        chatCwds: new Map(nextState.chatCwds),
        chatBridgeSessionIds: new Map(nextState.chatBridgeSessionIds),
        chatSessionIds: new Map(nextState.chatSessionIds),
      };
    },
  };
}

describe("FeishuSessionController", () => {
  test("setModel updates current ACP session model", async () => {
    const store = createStore();
    const controller = new FeishuSessionController([workspace], "standard", store);
    let setModelCalls = 0;
    const models: SessionModelState = {
      currentModelId: "gpt-5",
      availableModels: [
        { id: "gpt-5", name: "GPT-5" },
        { id: "gpt-5-mini", name: "GPT-5 Mini" },
      ],
    };
    const taskRunner = {
      hasConversation: () => true,
      setConversationModel: async () => {
        setModelCalls += 1;
        return true;
      },
      getConversationModels: () => ({
        ...models,
        currentModelId: "gpt-5-mini",
      }),
      ensureConversation: async () => ({
        taskId: "task-1",
        workspaceId: workspace.id,
        agent: "codex" as const,
        cwd: workspace.cwd,
        sessionId: "codex-session-1",
        runtimeArgs: [],
      }),
    };
    controller.updateModelState("chat-1", models);

    const changed = await controller.setModel("chat-1", "gpt-5-mini", taskRunner as never);

    expect(changed).toBe(true);
    expect(setModelCalls).toBe(1);
    expect(controller.getModel("chat-1")).toBe("gpt-5-mini");
  });

  test("startNewConversation creates bridge session and loads ACP model state", async () => {
    const store = createStore();
    const controller = new FeishuSessionController([workspace], "standard", store);
    const models: SessionModelState = {
      currentModelId: "gpt-5-mini",
      availableModels: [
        {
          id: "gpt-5-mini",
          name: "GPT-5 Mini",
        },
      ],
    };
    const taskRunner = {
      resetConversation: async () => true,
      hasConversation: () => false,
      setConversationModel: async () => true,
      ensureConversation: async () => ({
        taskId: "task-1",
        workspaceId: workspace.id,
        agent: "codex" as const,
        cwd: workspace.cwd,
        sessionId: "codex-session-1",
        runtimeArgs: [],
        models,
      }),
    };
    const result = await controller.startNewConversation(
      {
        chatId: "chat-1",
        workspace,
        agent: "codex",
      },
      taskRunner as never,
    );

    expect(result.sessionId).toBe("codex-session-1");
    expect(controller.getResumeSessionId("chat-1")).toBe("codex-session-1");
    expect(controller.getBridgeSessionId("chat-1")).toBeTruthy();
    expect(controller.getModel("chat-1")).toBe("gpt-5-mini");
    expect(controller.getAvailableModels("chat-1")).toEqual(models.availableModels);
  });

  test("interrupt clears model state with session", async () => {
    const store = createStore();
    const controller = new FeishuSessionController([workspace], "standard", store);
    const models: SessionModelState = {
      currentModelId: "gpt-5-mini",
      availableModels: [{ id: "gpt-5-mini", name: "GPT-5 Mini" }],
    };
    const taskRunner = {
      hasConversation: () => true,
      isConversationRunning: () => true,
      setConversationModel: async () => true,
      getConversationModels: () => models,
      resetConversation: async () => true,
      ensureConversation: async () => ({
        taskId: "task-1",
        workspaceId: workspace.id,
        agent: "codex" as const,
        cwd: workspace.cwd,
        sessionId: "codex-session-1",
        runtimeArgs: [],
      }),
    };

    controller.updateModelState("chat-1", models);
    const interrupted = await controller.interrupt("chat-1", taskRunner as never);

    expect(interrupted).toBe(true);
    expect(controller.getModel("chat-1")).toBeUndefined();
    expect(controller.getAvailableModels("chat-1")).toEqual([]);
  });
});
