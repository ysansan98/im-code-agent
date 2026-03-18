import lark from "@larksuiteoapi/node-sdk";

import type { Logger } from "../utils/logger.ts";

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
}
