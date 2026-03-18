import { ApprovalGateway } from "../approval/approval-gateway.ts";
import { TaskRunner } from "../session/task-runner.ts";
import { WsClient } from "./ws-client.ts";
import type { BridgeEvent, BridgeInboundMessage, WorkspaceConfig } from "@im-code-agent/shared";

export async function handleInboundMessage(
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
