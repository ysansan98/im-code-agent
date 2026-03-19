import { describe, expect, test } from "vite-plus/test";

import { applyCliArgs, parseCliArgs } from "./cli-args.ts";

describe("cli-args", () => {
  test("parses --config path", () => {
    const result = parseCliArgs(["--config", "./tmp/config.env"]);
    expect(result.configPath).toBeDefined();
    expect(result.configPath?.endsWith("/tmp/config.env")).toBe(true);
  });

  test("parses -c path", () => {
    const result = parseCliArgs(["-c", "./tmp/config.env"]);
    expect(result.configPath).toBeDefined();
    expect(result.configPath?.endsWith("/tmp/config.env")).toBe(true);
  });

  test("throws when config path is missing", () => {
    expect(() => parseCliArgs(["--config"])).toThrow(/需要一个配置文件路径参数/);
  });

  test("throws on unknown flag", () => {
    expect(() => parseCliArgs(["--unknown"])).toThrow(/未知参数/);
  });

  test("applies BRIDGE_ENV_PATH", () => {
    const env: NodeJS.ProcessEnv = {};
    applyCliArgs(["--config", "./tmp/config.env"], env);
    expect(env.BRIDGE_ENV_PATH).toBeDefined();
    expect(env.BRIDGE_ENV_PATH?.endsWith("/tmp/config.env")).toBe(true);
  });
});
