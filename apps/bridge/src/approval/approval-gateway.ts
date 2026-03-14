import type { ApprovalDecision, ApprovalRequest } from "@im-code-agent/shared";

import type { Logger } from "../utils/logger.ts";
import { ApprovalStore } from "./approval-store.ts";

export class ApprovalGateway {
  constructor(
    private readonly store: ApprovalStore,
    private readonly logger: Logger,
  ) {}

  request(request: ApprovalRequest): void {
    this.store.set(request);
    this.logger.info("approval request stored", {
      requestId: request.id,
      taskId: request.taskId,
      kind: request.kind,
    });
  }

  resolve(decision: ApprovalDecision): ApprovalRequest | undefined {
    const request = this.store.get(decision.requestId);
    if (!request) {
      this.logger.warn("approval request not found", {
        requestId: decision.requestId,
        taskId: decision.taskId,
      });
      return undefined;
    }

    this.store.delete(decision.requestId);
    this.logger.info("approval request resolved", {
      requestId: decision.requestId,
      taskId: decision.taskId,
      decision: decision.decision,
    });
    return request;
  }
}
