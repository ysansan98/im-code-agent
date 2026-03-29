import lark from "@larksuiteoapi/node-sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import type { Logger } from "../utils/logger.ts";

type DownloadedMessageResource = {
  filePath: string;
  mimeType: string;
  dataBase64: string;
};

export class FeishuMessageClient {
  constructor(
    private readonly client: lark.Client,
    private readonly logger: Logger,
  ) {}

  async sendText(chatId: string, text: string): Promise<void> {
    await this.client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
  }

  async sendCard(chatId: string, card: Record<string, unknown>): Promise<string> {
    const res = await this.client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });

    const messageId = res.data?.message_id;
    if (!messageId) {
      throw new Error("failed to create card message: missing message_id");
    }
    return messageId;
  }

  async patchCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    await this.client.im.v1.message.patch({
      path: {
        message_id: messageId,
      },
      data: {
        content: JSON.stringify(card),
      },
    });
  }

  async addTypingReaction(messageId: string): Promise<string | undefined> {
    try {
      const res = await this.client.im.v1.messageReaction.create({
        path: {
          message_id: messageId,
        },
        data: {
          reaction_type: {
            emoji_type: "Typing",
          },
        },
      });
      return res.data?.reaction_id;
    } catch (error) {
      this.logger.warn("add typing reaction failed", {
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async removeTypingReaction(messageId: string, reactionId: string): Promise<void> {
    await this.client.im.v1.messageReaction.delete({
      path: {
        message_id: messageId,
        reaction_id: reactionId,
      },
    });
  }

  async downloadMessageImage(params: {
    messageId: string;
    imageKey: string;
    outputDir: string;
  }): Promise<DownloadedMessageResource> {
    const response = await this.client.im.v1.messageResource.get({
      path: {
        message_id: params.messageId,
        file_key: params.imageKey,
      },
      params: {
        type: "image",
      },
    });
    const stream = response.getReadableStream();
    const buffer = await readStreamToBuffer(stream);
    const mimeType = normalizeMimeType(getHeaderValue(response.headers, "content-type"));
    const extension = extensionFromMime(mimeType);
    const filePath = resolve(
      params.outputDir,
      `${Date.now()}-${sanitizeFileToken(params.imageKey)}${extension}`,
    );

    await mkdir(params.outputDir, { recursive: true });
    await writeFile(filePath, buffer);

    return {
      filePath,
      mimeType,
      dataBase64: buffer.toString("base64"),
    };
  }
}

function getHeaderValue(headers: unknown, key: string): string | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  const lowerKey = key.toLowerCase();
  for (const [headerKey, value] of Object.entries(headers as Record<string, unknown>)) {
    if (headerKey.toLowerCase() !== lowerKey) {
      continue;
    }
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value) && typeof value[0] === "string") {
      return value[0];
    }
  }
  return undefined;
}

function normalizeMimeType(rawMimeType: string | undefined): string {
  const value = rawMimeType?.split(";")[0]?.trim().toLowerCase();
  if (!value) {
    return "image/jpeg";
  }
  return value;
}

function extensionFromMime(mimeType: string): string {
  if (mimeType === "image/png") {
    return ".png";
  }
  if (mimeType === "image/webp") {
    return ".webp";
  }
  if (mimeType === "image/gif") {
    return ".gif";
  }
  if (mimeType === "image/bmp") {
    return ".bmp";
  }
  if (mimeType === "image/tiff") {
    return ".tiff";
  }
  if (mimeType === "image/x-icon" || mimeType === "image/vnd.microsoft.icon") {
    return ".ico";
  }
  if (mimeType === "image/jpg" || mimeType === "image/jpeg") {
    return ".jpg";
  }
  return ".img";
}

function sanitizeFileToken(token: string): string {
  const base = token.replace(/[^a-zA-Z0-9._-]/g, "-");
  const withoutExt = extname(base) ? base.slice(0, -extname(base).length) : base;
  return withoutExt.slice(0, 64) || "image";
}

function readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolveBuffer, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("end", () => {
      resolveBuffer(Buffer.concat(chunks));
    });
    stream.on("error", (error) => {
      reject(error);
    });
  });
}
