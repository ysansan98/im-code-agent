import { access, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BridgeConfig } from "#shared";

const CODEX_ACP_BIN = fileURLToPath(
  import.meta.resolve("@zed-industries/codex-acp/bin/codex-acp.js"),
);

type EnvMap = Record<string, string>;
const DEFAULT_CONFIG_ENV_PATH = resolve(homedir(), ".im-code-agent", "config.env");

const DEFAULT_CONFIG_ENV_CONTENT = `# Bridge 基础配置

# 飞书应用凭据
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx

# 可选：true 时默认 Full Access
YOLO_MODE=false

# 可选：默认工作目录，不填则使用 bridge 启动目录
WORKSPACE_DEFAULT_CWD=
`;

function parseEnvFile(content: string): EnvMap {
  const result: EnvMap = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const equalIndex = line.indexOf("=");
    if (equalIndex <= 0) {
      continue;
    }

    const key = line.slice(0, equalIndex).trim();
    let value = line.slice(equalIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

async function resolveNodeCommand(): Promise<string> {
  if (await fileExists(process.execPath)) {
    return process.execPath;
  }
  return "node";
}

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    const directoryStat = await stat(dirPath);
    return directoryStat.isDirectory();
  } catch {
    return false;
  }
}

async function loadBridgeEnvFile(): Promise<EnvMap> {
  const configuredPath = process.env.BRIDGE_ENV_PATH;
  const envPath = configuredPath ? resolve(configuredPath) : DEFAULT_CONFIG_ENV_PATH;
  await ensureDefaultConfigEnvFile(envPath);
  const envPaths = configuredPath
    ? [resolve(configuredPath)]
    : [
        DEFAULT_CONFIG_ENV_PATH,
        resolve(process.cwd(), "bridge.env"),
        resolve(process.cwd(), ".env"),
      ];

  for (const envPath of envPaths) {
    try {
      const raw = await readFile(envPath, "utf8");
      return parseEnvFile(raw);
    } catch {
      continue;
    }
  }
  return {};
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureDefaultConfigEnvFile(configEnvPath: string): Promise<void> {
  await createConfigEnvIfMissing(configEnvPath, process.cwd());
}

async function createConfigEnvIfMissing(targetPath: string, baseDir: string): Promise<void> {
  if (await fileExists(targetPath)) {
    return;
  }

  await mkdir(dirname(targetPath), { recursive: true });

  const configTemplatePath = resolve(baseDir, "config.env.example");
  if (await fileExists(configTemplatePath)) {
    await copyFile(configTemplatePath, targetPath);
    return;
  }

  await writeFile(targetPath, DEFAULT_CONFIG_ENV_CONTENT, "utf8");
}

export async function loadConfig(): Promise<BridgeConfig> {
  const nodeCommand = await resolveNodeCommand();
  const fileEnv = await loadBridgeEnvFile();
  const getValue = (key: string): string | undefined => process.env[key] ?? fileEnv[key];

  const appId = getValue("FEISHU_APP_ID");
  const appSecret = getValue("FEISHU_APP_SECRET");
  const yoloMode = getValue("YOLO_MODE")?.trim().toLowerCase() === "true";
  const workspaceDefaultCwd = getValue("WORKSPACE_DEFAULT_CWD")?.trim();
  const resolvedDefaultCwd = workspaceDefaultCwd ? resolve(workspaceDefaultCwd) : process.cwd();
  const defaultCwd = (await isDirectory(resolvedDefaultCwd)) ? resolvedDefaultCwd : process.cwd();

  return {
    feishu:
      appId && appSecret
        ? {
            appId,
            appSecret,
          }
        : undefined,
    yoloMode,
    agents: {
      codex: {
        command: nodeCommand,
        args: [CODEX_ACP_BIN],
      },
    },
    workspaces: [
      {
        id: "local-default",
        name: "Local Default",
        cwd: defaultCwd,
      },
    ],
  };
}
