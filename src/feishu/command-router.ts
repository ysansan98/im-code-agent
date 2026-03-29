import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export type FeishuMessageContent = {
  text?: string;
  image_key?: string;
  [key: string]: unknown;
};

export type UserCommand =
  | {
      type: "prompt";
      prompt: string;
    }
  | {
      type: "help";
    }
  | {
      type: "new";
      cwd?: string;
    }
  | {
      type: "model";
      model?: string;
    }
  | {
      type: "status";
    }
  | {
      type: "stop";
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

export type ModelCardActionValue = {
  type: "model";
  cardId: string;
  chatId: string;
  model: string;
};

export type CardActionValue =
  | ApprovalCardActionValue
  | AccessCardActionValue
  | ModelCardActionValue;

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

export function extractPromptFromMessage(messageType: string, content: string): string {
  const parsed = parseContent(content);
  if (messageType === "text") {
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    return text || content.trim();
  }

  if (messageType === "image") {
    const imageKey = typeof parsed.image_key === "string" ? parsed.image_key : "";
    if (imageKey) {
      return `【飞书图片】image_key=${imageKey}\n请根据这张图片继续处理。如果需要先进行 OCR 或内容描述，请先明确说明。`;
    }
    return content.trim();
  }

  if (messageType === "post") {
    const postText = extractPostText(parsed).trim();
    return postText || content.trim();
  }

  return "";
}

function extractPostText(payload: Record<string, unknown>): string {
  const primary = resolvePostLocale(payload);
  if (!primary) {
    return "";
  }
  const lines: string[] = [];
  const title = typeof primary.title === "string" ? primary.title.trim() : "";
  if (title) {
    lines.push(title);
  }

  const paragraphs = Array.isArray(primary.content) ? primary.content : [];
  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) {
      continue;
    }
    const chunk: string[] = [];
    for (const node of paragraph) {
      if (!node || typeof node !== "object") {
        continue;
      }
      const item = node as Record<string, unknown>;
      const tag = typeof item.tag === "string" ? item.tag : "";
      if (tag === "text" || tag === "a") {
        const text = typeof item.text === "string" ? item.text : "";
        if (text.trim()) {
          chunk.push(text);
        }
        continue;
      }
      if (tag === "at") {
        const mention =
          typeof item.user_name === "string"
            ? item.user_name.trim()
            : typeof item.user_id === "string"
              ? item.user_id.trim()
              : "";
        if (mention) {
          chunk.push(`@${mention}`);
        }
      }
    }
    const line = chunk.join("");
    if (line) {
      lines.push(line);
    }
  }

  return lines.join("\n");
}

function resolvePostLocale(payload: Record<string, unknown>): Record<string, unknown> | null {
  const locales = ["zh_cn", "en_us", "ja_jp"];
  for (const locale of locales) {
    const value = payload[locale];
    if (value && typeof value === "object") {
      const post = value as Record<string, unknown>;
      if (Array.isArray(post.content) || typeof post.title === "string") {
        return post;
      }
    }
  }
  if (Array.isArray(payload.content) || typeof payload.title === "string") {
    return payload;
  }
  return null;
}

export async function parseUserCommand(
  rawPrompt: string,
  currentCwd: string,
): Promise<UserCommand> {
  if (rawPrompt === "/help") {
    return {
      type: "help",
    };
  }

  if (rawPrompt === "/status") {
    return {
      type: "status",
    };
  }

  if (rawPrompt === "/stop" || rawPrompt === "/interrupt") {
    return {
      type: "stop",
    };
  }

  if (rawPrompt === "/perm") {
    return {
      type: "show-access",
    };
  }

  if (rawPrompt === "/model") {
    return {
      type: "model",
    };
  }

  if (rawPrompt.startsWith("/model ")) {
    const model = rawPrompt.slice(7).trim();
    return {
      type: "model",
      model: model || undefined,
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
    item.type === "model" &&
    typeof item.cardId === "string" &&
    typeof item.chatId === "string" &&
    typeof item.model === "string"
  ) {
    return {
      type: "model",
      cardId: item.cardId,
      chatId: item.chatId,
      model: item.model,
    };
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
