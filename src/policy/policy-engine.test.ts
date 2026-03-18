import { describe, expect, test } from "vite-plus/test";

import type { WorkspaceConfig } from "#shared";

import { evaluatePolicy } from "./policy-engine.ts";

const workspace: WorkspaceConfig = {
  id: "w1",
  name: "w1",
  cwd: "/repo",
  approvalMode: "ask",
  blockedPaths: ["/repo/secret"],
  allowedAgents: ["codex"],
};

describe("evaluatePolicy", () => {
  test("ask mode blocks read by default", () => {
    const result = evaluatePolicy({
      kind: "read",
      workspace,
      hasSessionAllowAll: false,
    });
    expect(result.type).toBe("ask");
  });

  test("read-auto allows read", () => {
    const result = evaluatePolicy({
      kind: "read",
      workspace: {
        ...workspace,
        approvalMode: "read-auto",
      },
      hasSessionAllowAll: false,
    });
    expect(result).toEqual({ type: "allow" });
  });

  test("read-write-auto allows write", () => {
    const result = evaluatePolicy({
      kind: "write",
      workspace: {
        ...workspace,
        approvalMode: "read-write-auto",
      },
      hasSessionAllowAll: false,
    });
    expect(result).toEqual({ type: "allow" });
  });

  test("blocked path is denied", () => {
    const result = evaluatePolicy({
      kind: "read",
      workspace: {
        ...workspace,
        approvalMode: "read-auto",
      },
      hasSessionAllowAll: false,
      targetPath: "/repo/secret/config.env",
    });
    expect(result.type).toBe("deny");
  });

  test("session allow-all overrides ask", () => {
    const result = evaluatePolicy({
      kind: "exec",
      workspace,
      hasSessionAllowAll: true,
    });
    expect(result).toEqual({ type: "allow" });
  });
});
