import { describe, expect, test } from "vite-plus/test";

import type {
  ApprovalDecision,
  ApprovalRequest,
  AgentInitialization,
  PromptResult,
  RequestPermissionParams,
  WorkspaceConfig,
} from "#shared";

import { ApprovalGateway } from "./approval-gateway.ts";
import { ApprovalStore } from "./approval-store.ts";
import { createPermissionRequestHandler } from "./permission-handler.ts";
import { SessionManager } from "../session/session-manager.ts";
import { TaskRunner } from "../session/task-runner.ts";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const workspace: WorkspaceConfig = {
  id: "w1",
  name: "w1",
  cwd: "/repo",
  allowedAgents: ["codex"],
};

function createPermissionParams(
  overrides?: Partial<RequestPermissionParams>,
): RequestPermissionParams {
  const base: RequestPermissionParams = {
    sessionId: "session-1",
    toolCall: {
      id: "tool-1",
      kind: "exec",
      title: "Run command",
      rawInput: "npx create-next-app@latest . --yes",
    },
    options: [
      { id: "approved", name: "Approve", kind: "allow_once" },
      { id: "approved-for-session", name: "Always", kind: "allow_session" },
      { id: "rejected", name: "Reject", kind: "reject" },
    ],
  };
  return {
    ...base,
    ...overrides,
    toolCall: {
      ...base.toolCall,
      ...overrides?.toolCall,
    },
    options: overrides?.options ?? base.options,
  };
}

function createHarness(): {
  taskRunner: TaskRunner;
  permissionHandler: ReturnType<typeof createPermissionRequestHandler>;
  approvalGateway: ApprovalGateway;
  startCalls: Array<{ runtimeArgs?: string[] }>;
} {
  const startCalls: Array<{ runtimeArgs?: string[] }> = [];
  const fakeAgentProcess = {
    start: async (options: {
      runtimeArgs?: string[];
    }): Promise<{ initialization: AgentInitialization; sessionId: string }> => {
      startCalls.push({ runtimeArgs: options.runtimeArgs });
      return {
        initialization: {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: {
            name: "codex",
            version: "test",
          },
        },
        sessionId: "session-1",
      };
    },
    prompt: async (): Promise<PromptResult> => {
      return { stopReason: "completed" };
    },
    stop: async (): Promise<void> => {
      return;
    },
  };

  const taskRunner = new TaskRunner(
    new SessionManager(),
    fakeAgentProcess as unknown as ConstructorParameters<typeof TaskRunner>[1],
    logger,
  );
  const approvalGateway = new ApprovalGateway(new ApprovalStore(), logger);
  const permissionHandler = createPermissionRequestHandler({
    workspaces: [workspace],
    approvalGateway,
    getTaskRunner: () => taskRunner,
  });

  return {
    taskRunner,
    permissionHandler,
    approvalGateway,
    startCalls,
  };
}

function fakeApprovedResult(request: ApprovalRequest): {
  status: "approved";
  request: ApprovalRequest;
  decision: ApprovalDecision;
} {
  return {
    status: "approved",
    request,
    decision: {
      requestId: request.id,
      taskId: request.taskId,
      decision: "approved",
      decidedAt: new Date().toISOString(),
      decidedBy: "test",
    },
  };
}

describe("full-access integration", () => {
  test("task started with full-access runtimeArgs bypasses approval wait", async () => {
    const { taskRunner, permissionHandler, approvalGateway, startCalls } = createHarness();
    let requestAndWaitCalled = 0;
    approvalGateway.requestAndWait = (async (request) => {
      requestAndWaitCalled += 1;
      return fakeApprovedResult(request);
    }) as ApprovalGateway["requestAndWait"];

    const started = await taskRunner.startConversationTask(
      "chat-1",
      {
        workspaceId: workspace.id,
        agent: "codex",
        prompt: "hello",
      },
      workspace,
      {
        runtimeArgs: ["-c", 'approval_policy="never"', "-c", 'sandbox_mode="danger-full-access"'],
      },
    );

    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]?.runtimeArgs).toEqual([
      "-c",
      'approval_policy="never"',
      "-c",
      'sandbox_mode="danger-full-access"',
    ]);

    let approvalRequested = 0;
    const outcome = await permissionHandler({
      taskId: started.taskId,
      params: createPermissionParams(),
      emitApprovalRequested: () => {
        approvalRequested += 1;
      },
    });

    expect(outcome.status).toBe("approved");
    expect(outcome.optionId).toBe("approved-for-session");
    expect(requestAndWaitCalled).toBe(0);
    expect(approvalRequested).toBe(0);
  });

  test("standard mode should ask approval", async () => {
    const { taskRunner, permissionHandler, approvalGateway } = createHarness();
    let requestAndWaitCalled = 0;
    approvalGateway.requestAndWait = (async (request) => {
      requestAndWaitCalled += 1;
      return fakeApprovedResult(request);
    }) as ApprovalGateway["requestAndWait"];

    const started = await taskRunner.startConversationTask(
      "chat-1",
      {
        workspaceId: workspace.id,
        agent: "codex",
        prompt: "hello",
      },
      workspace,
      {
        runtimeArgs: [],
      },
    );

    let approvalRequested = 0;
    const outcome = await permissionHandler({
      taskId: started.taskId,
      params: createPermissionParams(),
      emitApprovalRequested: () => {
        approvalRequested += 1;
      },
    });

    expect(outcome.status).toBe("approved");
    expect(requestAndWaitCalled).toBe(1);
    expect(approvalRequested).toBe(1);
  });

  test("mode switch creates new task and full-access task bypasses approval", async () => {
    const { taskRunner, permissionHandler, approvalGateway, startCalls } = createHarness();
    let requestAndWaitCalled = 0;
    approvalGateway.requestAndWait = (async (request) => {
      requestAndWaitCalled += 1;
      return fakeApprovedResult(request);
    }) as ApprovalGateway["requestAndWait"];

    const standard = await taskRunner.startConversationTask(
      "chat-1",
      {
        workspaceId: workspace.id,
        agent: "codex",
        prompt: "first",
      },
      workspace,
      {
        runtimeArgs: [],
      },
    );
    let standardApprovalRequested = 0;
    const standardOutcome = await permissionHandler({
      taskId: standard.taskId,
      params: createPermissionParams(),
      emitApprovalRequested: () => {
        standardApprovalRequested += 1;
      },
    });

    const fullAccess = await taskRunner.startConversationTask(
      "chat-1",
      {
        workspaceId: workspace.id,
        agent: "codex",
        prompt: "second",
      },
      workspace,
      {
        runtimeArgs: ["-c", 'approval_policy="never"', "-c", 'sandbox_mode="danger-full-access"'],
      },
    );
    let fullAccessApprovalRequested = 0;
    const fullAccessOutcome = await permissionHandler({
      taskId: fullAccess.taskId,
      params: createPermissionParams(),
      emitApprovalRequested: () => {
        fullAccessApprovalRequested += 1;
      },
    });

    expect(startCalls).toHaveLength(2);
    expect(standard.taskId).not.toBe(fullAccess.taskId);
    expect(standardOutcome.status).toBe("approved");
    expect(standardApprovalRequested).toBe(1);
    expect(fullAccessOutcome.status).toBe("approved");
    expect(fullAccessOutcome.optionId).toBe("approved-for-session");
    expect(fullAccessApprovalRequested).toBe(0);
    expect(requestAndWaitCalled).toBe(1);
  });
});
