import { describe, expect, test } from "vite-plus/test";

import type { RequestPermissionParams, Task, WorkspaceConfig } from "#shared";

import { ApprovalGateway } from "./approval-gateway.ts";
import { ApprovalStore } from "./approval-store.ts";
import { createPermissionRequestHandler } from "./permission-handler.ts";
import type { TaskRunner } from "../session/task-runner.ts";

const workspace: WorkspaceConfig = {
  id: "w1",
  name: "w1",
  cwd: "/repo",
};

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function createTask(id: string): Task {
  return {
    id,
    workspaceId: workspace.id,
    agent: "codex",
    prompt: "",
    cwd: workspace.cwd,
    status: "running",
    createdAt: new Date().toISOString(),
  };
}

function createParams(): RequestPermissionParams {
  return {
    sessionId: "s1",
    toolCall: {
      id: "tool-1",
      kind: "exec",
      title: "Run command",
      rawInput: "echo hi",
    },
    options: [
      { id: "approved", name: "Approve", kind: "allow_once" },
      { id: "rejected", name: "Reject", kind: "reject" },
    ],
  };
}

describe("createPermissionRequestHandler", () => {
  test("full-access task auto allows without waiting approval", async () => {
    const approvalGateway = new ApprovalGateway(new ApprovalStore(), logger);
    let requestAndWaitCalled = 0;
    const original = approvalGateway.requestAndWait.bind(approvalGateway);
    approvalGateway.requestAndWait = (async (...args) => {
      requestAndWaitCalled += 1;
      return original(...args);
    }) as ApprovalGateway["requestAndWait"];

    const taskRunner = {
      getTask: () => createTask("t1"),
      isTaskFullAccess: () => true,
    } as unknown as TaskRunner;

    const handler = createPermissionRequestHandler({
      workspaces: [workspace],
      approvalGateway,
      getTaskRunner: () => taskRunner,
    });

    let emitted = 0;
    const result = await handler({
      taskId: "t1",
      params: createParams(),
      emitApprovalRequested: () => {
        emitted += 1;
      },
    });

    expect(result.status).toBe("approved");
    expect(result.optionId).toBe("approved");
    expect(requestAndWaitCalled).toBe(0);
    expect(emitted).toBe(0);
  });
});
