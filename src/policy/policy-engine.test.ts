import { describe, expect, test } from "vite-plus/test";

import type { WorkspaceConfig } from "#shared";

import { evaluatePolicy } from "./policy-engine.ts";

const workspace: WorkspaceConfig = {
  id: "w1",
  name: "w1",
  cwd: "/repo",
  blockedPaths: ["/repo/secret"],
  allowedAgents: ["codex"],
};

describe("evaluatePolicy", () => {
  test("read asks for approval by default", () => {
    const result = evaluatePolicy({
      kind: "read",
      workspace,
      hasSessionAllowAll: false,
    });
    expect(result.type).toBe("ask");
  });

  test("write asks for approval by default", () => {
    const result = evaluatePolicy({
      kind: "write",
      workspace,
      hasSessionAllowAll: false,
    });
    expect(result.type).toBe("ask");
  });

  test("blocked path is denied", () => {
    const result = evaluatePolicy({
      kind: "read",
      workspace,
      hasSessionAllowAll: false,
      targetPath: "/repo/secret/config.env",
    });
    expect(result.type).toBe("deny");
  });

  test("session allow-all overrides default ask", () => {
    const result = evaluatePolicy({
      kind: "exec",
      workspace,
      hasSessionAllowAll: true,
    });
    expect(result).toEqual({ type: "allow" });
  });
});
