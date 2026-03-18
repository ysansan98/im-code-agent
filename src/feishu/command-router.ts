import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export type FeishuMessageContent = {
  text?: string;
};

export type UserCommand =
  | {
      type: "prompt";
      prompt: string;
    }
  | {
      type: "new";
      cwd?: string;
    }
  | {
      type: "show-access";
    };

export type ApprovalCardActionValue = {
  type: "approval";
  requestId: string;
  taskId: string;
  decision: "approved" | "rejected";
  comment?: string;
};

export type AccessCardActionValue =
  | {
      type: "access";
      cardId: string;
      chatId: string;
      action: "set";
      mode: "standard" | "full-access";
    }
  | {
      type: "access";
      cardId: string;
      chatId: string;
      action: "clear";
    };

export type CardActionValue = ApprovalCardActionValue | AccessCardActionValue;

export function isInterruptCommand(text: string): boolean {
  return text === "/stop" || text === "/interrupt";
}

export function parseContent(content: string): FeishuMessageContent {
  try {
    return JSON.parse(content) as FeishuMessageContent;
  } catch {
    return {};
  }
}

export async function parseUserCommand(
  rawPrompt: string,
  currentCwd: string,
): Promise<UserCommand> {
  if (rawPrompt === "/perm") {
    return {
      type: "show-access",
    };
  }

  if (rawPrompt === "/new") {
    return {
      type: "new",
    };
  }

  if (rawPrompt.startsWith("/new ")) {
    const inputPath = rawPrompt.slice(5).trim();
    if (!inputPath) {
      return {
        type: "new",
      };
    }
    const cwd = await resolveValidatedCwd(inputPath, currentCwd);
    return {
      type: "new",
      cwd,
    };
  }

  return {
    type: "prompt",
    prompt: rawPrompt,
  };
}

export function parseCardActionValue(data: Record<string, unknown>): CardActionValue | null {
  const payload =
    (data.action as { value?: unknown } | undefined)?.value ??
    (data.event as { action?: { value?: unknown } } | undefined)?.action?.value;
  if (!payload) {
    return null;
  }
  let value: unknown = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const item = value as Record<string, unknown>;
  if (
    item.type === "access" &&
    typeof item.cardId === "string" &&
    typeof item.chatId === "string" &&
    (item.action === "set" || item.action === "clear")
  ) {
    if (item.action === "clear") {
      return {
        type: "access",
        cardId: item.cardId,
        chatId: item.chatId,
        action: "clear",
      };
    }
    if (item.mode === "standard" || item.mode === "full-access") {
      return {
        type: "access",
        cardId: item.cardId,
        chatId: item.chatId,
        action: "set",
        mode: item.mode,
      };
    }
    return null;
  }

  if (
    typeof item.requestId === "string" &&
    typeof item.taskId === "string" &&
    (item.decision === "approved" || item.decision === "rejected")
  ) {
    return {
      type: "approval",
      requestId: item.requestId,
      taskId: item.taskId,
      decision: item.decision,
      comment: typeof item.comment === "string" ? item.comment : undefined,
    };
  }
  return null;
}

async function resolveValidatedCwd(inputPath: string, baseCwd: string): Promise<string> {
  const candidate = isAbsolute(inputPath) ? inputPath : resolve(baseCwd, inputPath);
  const dirStat = await stat(candidate).catch(() => undefined);
  if (!dirStat || !dirStat.isDirectory()) {
    throw new Error(`路径不存在或不是目录：${candidate}`);
  }
  return resolve(candidate);
}
