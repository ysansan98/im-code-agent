import { AgentProcess } from "./agent/agent-process.ts";
import { ApprovalGateway } from "./approval/approval-gateway.ts";
import { ApprovalStore } from "./approval/approval-store.ts";
import { createPermissionRequestHandler } from "./approval/permission-handler.ts";
import { loadConfig } from "./config/load-config.ts";
import { FeishuGateway } from "./feishu/feishu-gateway.ts";
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
    },
    permissionRequestHandler,
  );

  taskRunner = new TaskRunner(sessionManager, agentProcess, logger);
  const feishuGateway = config.feishu
    ? new FeishuGateway(
        config.feishu,
        config.workspaces,
        taskRunner,
        approvalGateway,
        logger,
        config.yoloMode,
      )
    : undefined;

  if (feishuGateway) {
    await feishuGateway.start();
  }

  logger.info("bridge started", {
    workspaceCount: config.workspaces.length,
    feishuEnabled: Boolean(feishuGateway),
    yoloMode: config.yoloMode,
  });
}
