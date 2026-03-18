import { describe, expect, test } from "vite-plus/test";

import type { ApprovalDecision, ApprovalRequest } from "#shared";

import { ApprovalGateway } from "./approval-gateway.ts";
import { ApprovalStore } from "./approval-store.ts";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function createRequest(id: string): ApprovalRequest {
  return {
    id,
    taskId: "t1",
    kind: "exec",
    title: "exec approval",
    cwd: "/repo",
    riskLevel: "high",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function createDecision(requestId: string, decision: "approved" | "rejected"): ApprovalDecision {
  return {
    requestId,
    taskId: "t1",
    decision,
    decidedAt: new Date().toISOString(),
    decidedBy: "tester",
  };
}

describe("ApprovalGateway", () => {
  test("awaitDecision resolves when approved", async () => {
    const gateway = new ApprovalGateway(new ApprovalStore(), logger);
    const request = createRequest("r1");

    const pending = gateway.requestAndWait(request, 500);
    gateway.resolve(createDecision("r1", "approved"));

    const result = await pending;
    expect(result.status).toBe("approved");
  });

  test("awaitDecision expires on timeout", async () => {
    const store = new ApprovalStore();
    const gateway = new ApprovalGateway(store, logger);
    const request = createRequest("r2");

    const result = await gateway.requestAndWait(request, 10);
    expect(result.status).toBe("expired");
    expect(store.get("r2")).toBeUndefined();
  });

  test("resolve is idempotent", async () => {
    const gateway = new ApprovalGateway(new ApprovalStore(), logger);
    const request = createRequest("r3");

    const pending = gateway.requestAndWait(request, 500);
    gateway.resolve(createDecision("r3", "rejected"));
    gateway.resolve(createDecision("r3", "approved"));

    const result = await pending;
    expect(result.status).toBe("rejected");
  });

  test("resolved request is removed from store", () => {
    const store = new ApprovalStore();
    const gateway = new ApprovalGateway(store, logger);
    const request = createRequest("r5");

    gateway.request(request);
    gateway.resolve(createDecision("r5", "approved"));

    expect(store.get("r5")).toBeUndefined();
  });

  test("approved-for-session marks task scope", () => {
    const store = new ApprovalStore();
    const gateway = new ApprovalGateway(store, logger);
    const request = createRequest("r4");
    gateway.request(request);
    gateway.resolve({
      ...createDecision("r4", "approved"),
      comment: "approved-for-session",
    });

    expect(gateway.isSessionAllowAll("t1")).toBe(true);
    expect(store.get("r4")).toBeUndefined();
  });
});
