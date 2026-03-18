import { AgentProcess } from "./agent/agent-process.ts";
import { ApprovalGateway } from "./approval/approval-gateway.ts";
import { ApprovalStore } from "./approval/approval-store.ts";
import { createPermissionRequestHandler } from "./approval/permission-handler.ts";
import { loadConfig } from "./config/load-config.ts";
import { FeishuGateway } from "./feishu/feishu-gateway.ts";
import { DebugHttpServer } from "./server/debug-http-server.ts";
import { handleInboundMessage } from "./server/inbound-message-handler.ts";
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
  let taskRunner!: TaskRunner;
  let wsClient: WsClient | undefined;
  const permissionRequestHandler = createPermissionRequestHandler({
    workspaces: config.workspaces,
    approvalGateway,
    getTaskRunner: () => taskRunner,
  });

  const agentProcess = new AgentProcess(
    config,
    logger,
    (event) => {
      const bridgeEvent = taskRunner.handleAgentEvent(event);
      if (!bridgeEvent) {
        return;
      }
      logger.info("bridge event emitted", bridgeEvent);
      if (wsClient) {
        void wsClient.send({
          type: "bridge.event",
          event: bridgeEvent,
        });
      }
    },
    permissionRequestHandler,
  );

  taskRunner = new TaskRunner(sessionManager, agentProcess, logger);
  if (config.wsUrl) {
    wsClient = new WsClient(config, logger, async (message) => {
      await handleInboundMessage(message, config.workspaces, taskRunner, approvalGateway, wsClient);
    });
  }
  const debugHttpServer = new DebugHttpServer(logger, config, taskRunner);
  const feishuGateway = config.feishu
    ? new FeishuGateway(config.feishu, config.workspaces, taskRunner, approvalGateway, logger)
    : undefined;

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
