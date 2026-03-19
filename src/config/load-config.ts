import { access, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import type { BridgeConfig } from "#shared";

const CODEX_ACP_BIN = fileURLToPath(
  import.meta.resolve("@zed-industries/codex-acp/bin/codex-acp.js"),
);

type EnvMap = Record<string, string>;
const DEFAULT_CONFIG_ENV_PATH = resolve(homedir(), ".im-code-agent", "config.env");

const DEFAULT_CONFIG_ENV_CONTENT = `# Bridge 基础配置

# 飞书应用凭据
FEISHU_APP_ID=
FEISHU_APP_SECRET=

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

function stringifyEnvValue(value: string): string {
  return /[\s#"'`]/.test(value) ? JSON.stringify(value) : value;
}

function upsertEnvValue(content: string, key: string, value: string): string {
  const lines = content.split("\n");
  const rendered = `${key}=${stringifyEnvValue(value)}`;
  const lineIndex = lines.findIndex((line) => line.trimStart().startsWith(`${key}=`));

  if (lineIndex >= 0) {
    lines[lineIndex] = rendered;
  } else {
    if (lines.length > 0 && lines.at(-1) !== "") {
      lines.push("");
    }
    lines.push(rendered);
  }

  return lines.join("\n");
}

function normalizeCredential(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "cli_xxx" || trimmed === "xxx") {
    return undefined;
  }
  return trimmed;
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
  const envPath = resolveBridgeEnvPath();
  await ensureDefaultConfigEnvFile(envPath);
  const configuredPath = process.env.BRIDGE_ENV_PATH;
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

export function resolveBridgeEnvPath(): string {
  const configuredPath = process.env.BRIDGE_ENV_PATH;
  return configuredPath ? resolve(configuredPath) : DEFAULT_CONFIG_ENV_PATH;
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

async function promptForFeishuCredentials(envPath: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `未检测到飞书配置，请在 ${envPath} 中填写 FEISHU_APP_ID 和 FEISHU_APP_SECRET，或通过环境变量注入后再启动。`,
    );
  }

  console.warn(
    [
      "未检测到有效的飞书配置。",
      `将引导你写入 ${envPath}。`,
      "直接回车可跳过，但当前启动会直接退出。",
    ].join(" "),
  );

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const appId = normalizeCredential(await readline.question("请输入飞书 App ID: "));
    const appSecret = normalizeCredential(await readline.question("请输入飞书 App Secret: "));

    if (!appId || !appSecret) {
      throw new Error(
        "缺少飞书配置，启动已取消。请填写 FEISHU_APP_ID 和 FEISHU_APP_SECRET 后重试。",
      );
    }

    const existingContent = await readFile(envPath, "utf8").catch(() => DEFAULT_CONFIG_ENV_CONTENT);
    const nextContent = upsertEnvValue(
      upsertEnvValue(existingContent, "FEISHU_APP_ID", appId),
      "FEISHU_APP_SECRET",
      appSecret,
    );
    const writtenContent = nextContent.endsWith("\n") ? nextContent : `${nextContent}\n`;

    await writeFile(envPath, writtenContent, "utf8");
    process.env.FEISHU_APP_ID = appId;
    process.env.FEISHU_APP_SECRET = appSecret;
    console.warn(`飞书配置已写入 ${envPath}。`);
  } finally {
    readline.close();
  }
}

export async function loadConfig(): Promise<BridgeConfig> {
  const nodeCommand = await resolveNodeCommand();
  const envPath = resolveBridgeEnvPath();
  let fileEnv = await loadBridgeEnvFile();
  const getValue = (key: string): string | undefined => process.env[key] ?? fileEnv[key];

  let appId = normalizeCredential(getValue("FEISHU_APP_ID"));
  let appSecret = normalizeCredential(getValue("FEISHU_APP_SECRET"));

  if (!appId || !appSecret) {
    await promptForFeishuCredentials(envPath);
    fileEnv = await loadBridgeEnvFile();
    appId = normalizeCredential(process.env.FEISHU_APP_ID ?? fileEnv.FEISHU_APP_ID);
    appSecret = normalizeCredential(process.env.FEISHU_APP_SECRET ?? fileEnv.FEISHU_APP_SECRET);
  }

  if (!appId || !appSecret) {
    throw new Error(
      `缺少飞书配置，请在 ${envPath} 中填写 FEISHU_APP_ID 和 FEISHU_APP_SECRET 后重试。`,
    );
  }

  const yoloMode = getValue("YOLO_MODE")?.trim().toLowerCase() === "true";
  const workspaceDefaultCwd = getValue("WORKSPACE_DEFAULT_CWD")?.trim();
  const resolvedDefaultCwd = workspaceDefaultCwd ? resolve(workspaceDefaultCwd) : process.cwd();
  const defaultCwd = (await isDirectory(resolvedDefaultCwd)) ? resolvedDefaultCwd : process.cwd();

  return {
    feishu: {
      appId,
      appSecret,
    },
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
