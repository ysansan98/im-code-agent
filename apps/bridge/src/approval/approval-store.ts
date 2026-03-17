import type { ApprovalDecision, ApprovalRequest } from "@im-code-agent/shared";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type ApprovalSnapshot = {
  request: ApprovalRequest;
  status: ApprovalStatus;
  decision?: ApprovalDecision;
  resolvedAt?: string;
};

export type AwaitDecisionResult =
  | {
      status: "approved";
      request: ApprovalRequest;
      decision: ApprovalDecision;
    }
  | {
      status: "rejected" | "expired";
      request: ApprovalRequest;
      decision?: ApprovalDecision;
    };

type PendingWaiter = {
  resolve: (value: AwaitDecisionResult) => void;
  timer: NodeJS.Timeout;
};

export class ApprovalStore {
  readonly #snapshots = new Map<string, ApprovalSnapshot>();
  readonly #waiters = new Map<string, PendingWaiter>();

  set(request: ApprovalRequest): void {
    this.#snapshots.set(request.id, {
      request,
      status: "pending",
    });
  }

  get(requestId: string): ApprovalSnapshot | undefined {
    return this.#snapshots.get(requestId);
  }

  delete(requestId: string): void {
    const waiter = this.#waiters.get(requestId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.#waiters.delete(requestId);
    }
    this.#snapshots.delete(requestId);
  }

  awaitDecision(requestId: string, timeoutMs: number): Promise<AwaitDecisionResult> {
    const snapshot = this.#snapshots.get(requestId);
    if (!snapshot) {
      return Promise.reject(new Error(`Approval request not found: ${requestId}`));
    }

    if (snapshot.status === "approved" && snapshot.decision) {
      return Promise.resolve({
        status: "approved",
        request: snapshot.request,
        decision: snapshot.decision,
      });
    }
    if (snapshot.status === "rejected") {
      return Promise.resolve({
        status: "rejected",
        request: snapshot.request,
        decision: snapshot.decision,
      });
    }
    if (snapshot.status === "expired") {
      return Promise.resolve({
        status: "expired",
        request: snapshot.request,
      });
    }

    return new Promise<AwaitDecisionResult>((resolve) => {
      const timer = setTimeout(() => {
        const current = this.#snapshots.get(requestId);
        if (!current || current.status !== "pending") {
          return;
        }
        current.status = "expired";
        current.resolvedAt = new Date().toISOString();
        this.#snapshots.set(requestId, current);
        this.#waiters.delete(requestId);
        resolve({
          status: "expired",
          request: current.request,
        });
      }, timeoutMs);

      this.#waiters.set(requestId, {
        resolve,
        timer,
      });
    });
  }

  resolve(decision: ApprovalDecision): { accepted: boolean; snapshot?: ApprovalSnapshot } {
    const snapshot = this.#snapshots.get(decision.requestId);
    if (!snapshot) {
      return { accepted: false };
    }

    if (snapshot.status !== "pending") {
      return { accepted: false, snapshot };
    }

    snapshot.status = decision.decision === "approved" ? "approved" : "rejected";
    snapshot.decision = decision;
    snapshot.resolvedAt = new Date().toISOString();
    this.#snapshots.set(decision.requestId, snapshot);

    const waiter = this.#waiters.get(decision.requestId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.#waiters.delete(decision.requestId);
      waiter.resolve(
        snapshot.status === "approved"
          ? {
              status: "approved",
              request: snapshot.request,
              decision,
            }
          : {
              status: "rejected",
              request: snapshot.request,
              decision,
            },
      );
    }

    return {
      accepted: true,
      snapshot,
    };
  }
}
