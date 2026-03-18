import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { loadConfig } from "./load-config.ts";

const ENV_KEYS = ["BRIDGE_ENV_PATH", "FEISHU_APP_ID", "FEISHU_APP_SECRET", "YOLO_MODE"] as const;

const originalCwd = process.cwd();
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);

  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  await Promise.all(
    tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createTempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "im-code-agent-load-config-"));
  tempDirs.push(dir);
  return dir;
}

describe("loadConfig", () => {
  test("copies config.env.example and keeps codex as the only enabled agent", async () => {
    const projectDir = await createTempProject();
    const envPath = join(projectDir, "config.env");
    const exampleContent = [
      "FEISHU_APP_ID=cli_test",
      "FEISHU_APP_SECRET=secret_test",
      "YOLO_MODE=true",
    ].join("\n");

    await writeFile(join(projectDir, "config.env.example"), `${exampleContent}\n`, "utf8");
    process.chdir(projectDir);
    process.env.BRIDGE_ENV_PATH = envPath;

    const config = await loadConfig();
    const resolvedProjectDir = await realpath(projectDir);

    expect(await readFile(envPath, "utf8")).toBe(`${exampleContent}\n`);
    expect(config.feishu).toEqual({
      appId: "cli_test",
      appSecret: "secret_test",
    });
    expect(config.yoloMode).toBe(true);
    expect(Object.keys(config.agents)).toEqual(["codex"]);
    expect(config.workspaces[0]).toMatchObject({
      id: "local-default",
      name: "Local Default",
      cwd: resolvedProjectDir,
    });
  });

  test("writes built-in template when config.env.example is absent", async () => {
    const projectDir = await createTempProject();
    const envPath = join(projectDir, "config.env");

    process.chdir(projectDir);
    process.env.BRIDGE_ENV_PATH = envPath;

    const config = await loadConfig();
    const written = await readFile(envPath, "utf8");
    const resolvedProjectDir = await realpath(projectDir);

    expect(written).toContain("FEISHU_APP_ID=cli_xxx");
    expect(written).toContain("FEISHU_APP_SECRET=xxx");
    expect(written).toContain("YOLO_MODE=false");
    expect(config.feishu).toEqual({
      appId: "cli_xxx",
      appSecret: "xxx",
    });
    expect(Object.keys(config.agents)).toEqual(["codex"]);
    expect(config.workspaces[0]).toMatchObject({
      id: "local-default",
      name: "Local Default",
      cwd: resolvedProjectDir,
    });
  });
});
