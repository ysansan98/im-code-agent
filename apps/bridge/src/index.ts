import { ApprovalGateway } from "./approval/approval-gateway.ts";
import { ApprovalStore } from "./approval/approval-store.ts";
import { loadConfig } from "./config/load-config.ts";
import { AgentProcess } from "./agent/agent-process.ts";
import type { BridgeEvent, BridgeInboundMessage, WorkspaceConfig } from "@im-code-agent/shared";
import { FeishuGateway } from "./feishu/feishu-gateway.ts";
import { evaluatePolicy } from "./policy/policy-engine.ts";
import { DebugHttpServer } from "./server/debug-http-server.ts";
import { WsClient } from "./server/ws-client.ts";
import { SessionManager } from "./session/session-manager.ts";
import { TaskRunner } from "./session/task-runner.ts";
import { createLogger } from "./utils/logger.ts";

export async function startBridge(): Promise<void> {
  const config = await loadConfig();
  const logger = createLogger();
  const approvalStore = new ApprovalStore();
  const approvalGateway = new ApprovalGateway(approvalStore, logger);
  const sessionManager = new SessionManager();
  let taskRunner: TaskRunner;
  let wsClient: WsClient | undefined;
  const agentProcess = new AgentProcess(config, logger, (event) => {
    const bridgeEvent = taskRunner.handleAgentEvent(event);
    if (bridgeEvent) {
      logger.info("bridge event emitted", bridgeEvent);
      if (wsClient) {
        void wsClient.send({
          type: "bridge.event",
          event: bridgeEvent,
        });
      }
    }
  });
  taskRunner = new TaskRunner(sessionManager, agentProcess, logger);
  if (config.wsUrl) {
    wsClient = new WsClient(config, logger, async (message) => {
      await handleInboundMessage(message, config.workspaces, taskRunner, approvalGateway, wsClient);
    });
  }
  const debugHttpServer = new DebugHttpServer(logger, config, taskRunner);
  const feishuGateway = config.feishu
    ? new FeishuGateway(config.feishu, config.workspaces, taskRunner, logger)
    : undefined;

  void evaluatePolicy;

  if (wsClient) {
    await wsClient.connect();
    await wsClient.send(wsClient.buildRegisterMessage());
    await wsClient.send(wsClient.buildReadyMessage());
  }

  if (config.debugPort) {
    await debugHttpServer.start(config.debugPort);
  }
  if (feishuGateway) {
    await feishuGateway.start();
  }

  logger.info("bridge started", {
    deviceId: config.deviceId,
    workspaceCount: config.workspaces.length,
    wsEnabled: Boolean(wsClient),
    feishuEnabled: Boolean(feishuGateway),
  });
}

void startBridge();

async function handleInboundMessage(
  message: BridgeInboundMessage,
  workspaces: WorkspaceConfig[],
  taskRunner: TaskRunner,
  approvalGateway: ApprovalGateway,
  wsClient: WsClient | undefined,
): Promise<void> {
  if (!wsClient) {
    return;
  }

  if (message.type === "ping") {
    await wsClient.send({
      type: "pong",
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (message.type === "task.create") {
    const workspace = workspaces.find((item) => item.id === message.workspaceId);
    if (!workspace) {
      const failed: BridgeEvent = {
        type: "task.failed",
        taskId: message.requestId,
        code: "workspace_not_found",
        error: `Workspace not found: ${message.workspaceId}`,
        timestamp: new Date().toISOString(),
      };
      await wsClient.send({
        type: "bridge.event",
        event: failed,
      });
      return;
    }

    const result = await taskRunner.startTask(
      {
        workspaceId: workspace.id,
        agent: message.agent,
        prompt: message.prompt,
      },
      workspace,
    );

    for (const event of result.events) {
      await wsClient.send({
        type: "bridge.event",
        event,
      });
    }
    return;
  }

  if (message.type === "approval.decision") {
    approvalGateway.resolve(message.decision);
    return;
  }

  if (message.type === "task.cancel") {
    return;
  }
}
