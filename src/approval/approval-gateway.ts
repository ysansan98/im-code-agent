import type { ApprovalDecision, ApprovalRequest } from "#shared";

import type { Logger } from "../utils/logger.ts";
import {
  ApprovalStore,
  type ApprovalSnapshot,
  type AwaitDecisionResult,
} from "./approval-store.ts";

type ResolutionListener = (snapshot: ApprovalSnapshot) => void;

export class ApprovalGateway {
  readonly #resolutionListeners = new Set<ResolutionListener>();
  readonly #sessionAllowAll = new Set<string>();

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

  async requestAndWait(request: ApprovalRequest, timeoutMs: number): Promise<AwaitDecisionResult> {
    this.request(request);
    const result = await this.store.awaitDecision(request.id, timeoutMs);
    if (result.status === "expired") {
      const snapshot = this.store.get(request.id);
      if (snapshot) {
        this.emitResolution(snapshot);
        this.store.delete(request.id);
      }
    }
    return result;
  }

  resolve(decision: ApprovalDecision): ApprovalSnapshot | undefined {
    const result = this.store.resolve(decision);
    if (!result.snapshot) {
      this.logger.warn("approval request not found", {
        requestId: decision.requestId,
        taskId: decision.taskId,
      });
      return undefined;
    }

    if (!result.accepted) {
      this.logger.info("approval request resolve ignored", {
        requestId: decision.requestId,
        taskId: decision.taskId,
        decision: decision.decision,
        status: result.snapshot.status,
      });
      return result.snapshot;
    }

    if (decision.decision === "approved" && decision.comment === "approved-for-session") {
      this.#sessionAllowAll.add(decision.taskId);
    }

    this.logger.info("approval request resolved", {
      requestId: decision.requestId,
      taskId: decision.taskId,
      decision: decision.decision,
    });
    this.emitResolution(result.snapshot);
    this.store.delete(decision.requestId);
    return result.snapshot;
  }

  isSessionAllowAll(taskId: string): boolean {
    return this.#sessionAllowAll.has(taskId);
  }

  onResolved(listener: ResolutionListener): () => void {
    this.#resolutionListeners.add(listener);
    return () => {
      this.#resolutionListeners.delete(listener);
    };
  }

  private emitResolution(snapshot: ApprovalSnapshot): void {
    for (const listener of this.#resolutionListeners) {
      listener(snapshot);
    }
  }
}
