import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BridgeConfig } from "@im-code-agent/shared";

const CODEX_ACP_BIN = fileURLToPath(
  import.meta.resolve("@zed-industries/codex-acp/bin/codex-acp.js"),
);

type EnvMap = Record<string, string>;

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

async function loadBridgeEnvFile(): Promise<EnvMap> {
  const configuredPath = process.env.BRIDGE_ENV_PATH;
  const envPaths = configuredPath
    ? [resolve(configuredPath)]
    : [resolve(process.cwd(), "bridge.env"), resolve(process.cwd(), ".env")];

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

export async function loadConfig(): Promise<BridgeConfig> {
  const fileEnv = await loadBridgeEnvFile();
  const getValue = (key: string): string | undefined => process.env[key] ?? fileEnv[key];

  const appId = getValue("FEISHU_APP_ID");
  const appSecret = getValue("FEISHU_APP_SECRET");
  const defaultCwd = resolve(getValue("WORKSPACE_DEFAULT_CWD") ?? process.cwd());
  const approvalMode =
    (getValue("WORKSPACE_APPROVAL_MODE") as "ask" | "read-auto" | "read-write-auto" | undefined) ??
    "ask";
  const debugPortRaw = getValue("BRIDGE_DEBUG_PORT");
  const debugPort = debugPortRaw ? Number.parseInt(debugPortRaw, 10) : 8788;

  return {
    deviceId: getValue("BRIDGE_DEVICE_ID") ?? "local-dev",
    wsUrl: getValue("BRIDGE_WS_URL"),
    debugPort: Number.isNaN(debugPort) ? 8788 : debugPort,
    feishu:
      appId && appSecret
        ? {
            appId,
            appSecret,
            encryptKey: getValue("FEISHU_ENCRYPT_KEY"),
            verificationToken: getValue("FEISHU_VERIFICATION_TOKEN"),
          }
        : undefined,
    agents: {
      codex: {
        command: process.execPath,
        args: [CODEX_ACP_BIN],
      },
    },
    workspaces: [
      {
        id: "local-default",
        name: "Local Default",
        cwd: defaultCwd,
        approvalMode,
        allowedAgents: ["codex"],
      },
    ],
  };
}
