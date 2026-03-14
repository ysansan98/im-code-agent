import type { ApprovalRequest } from "@im-code-agent/shared";

export class ApprovalStore {
  readonly #requests = new Map<string, ApprovalRequest>();

  set(request: ApprovalRequest): void {
    this.#requests.set(request.id, request);
  }

  get(requestId: string): ApprovalRequest | undefined {
    return this.#requests.get(requestId);
  }

  delete(requestId: string): void {
    this.#requests.delete(requestId);
  }
}
