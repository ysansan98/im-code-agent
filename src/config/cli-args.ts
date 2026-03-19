import { resolve } from "node:path";

type ParseResult = {
  configPath?: string;
};

export function parseCliArgs(argv: string[]): ParseResult {
  let configPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config" || arg === "-c") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${arg} 需要一个配置文件路径参数`);
      }
      configPath = resolve(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`未知参数: ${arg}`);
    }
  }

  return { configPath };
}

export function applyCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): void {
  const { configPath } = parseCliArgs(argv);
  if (configPath) {
    env.BRIDGE_ENV_PATH = configPath;
  }
}
