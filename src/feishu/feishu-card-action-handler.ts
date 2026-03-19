import { randomUUID } from "node:crypto";

import type { ApprovalDecision } from "#shared";

import type { ApprovalGateway } from "../approval/approval-gateway.ts";
import type { TaskRunner } from "../session/task-runner.ts";
import type { Logger } from "../utils/logger.ts";
import { parseCardActionValue } from "./command-router.ts";
import type { FeishuCardRenderer } from "./card-renderer.ts";
import type { FeishuMessageClient } from "./feishu-message-client.ts";
import type { FeishuSessionController } from "./session-controller.ts";

type CardActionHandlerDeps = {
  sessionController: FeishuSessionController;
  taskRunner: TaskRunner;
  approvalGateway: ApprovalGateway;
  messageClient: FeishuMessageClient;
  cardRenderer: FeishuCardRenderer;
  logger: Logger;
  onApprovalResolved: (decision: ApprovalDecision) => void;
};

export class FeishuCardActionHandler {
  readonly #permissionCardMessages = new Map<string, string>();
  readonly #permissionCardRevisions = new Map<string, number>();
  readonly #permissionCardUpdatedAt = new Map<string, number>();
  readonly #handledPermissionCardIds = new Map<string, number>();
  readonly #modelCardMessages = new Map<string, string>();
  readonly #modelCardUpdatedAt = new Map<string, number>();
  readonly #handledModelCardIds = new Map<string, number>();
  readonly #handledCardActionEventIds = new Map<string, number>();

  constructor(private readonly deps: CardActionHandlerDeps) {}

  async sendPermissionCard(chatId: string): Promise<void> {
    this.gcPermissionCardState();
    const cardId = randomUUID();
    const version = 1;
    this.#permissionCardRevisions.set(cardId, version);

    const card = this.deps.cardRenderer.buildAccessModeCard({
      cardId,
      chatId,
      defaultMode: this.deps.sessionController.getDefaultAccessMode(),
      overrideMode: this.deps.sessionController.getAccessOverride(chatId),
      readonly: false,
    });

    const messageId = await this.deps.messageClient.sendCard(chatId, card);
    this.#permissionCardMessages.set(cardId, messageId);
    this.#permissionCardUpdatedAt.set(cardId, Date.now());

    this.deps.logger.info("permission card sent", {
      chatId,
      cardId,
      version,
      messageId,
      defaultMode: this.deps.sessionController.getDefaultAccessMode(),
      overrideMode: this.deps.sessionController.getAccessOverride(chatId),
      effectiveMode: this.deps.sessionController.getAccessMode(chatId),
    });
  }

  async sendModelCard(chatId: string): Promise<void> {
    this.gcModelCardState();
    const cardId = randomUUID();
    const card = this.deps.cardRenderer.buildModelCard({
      cardId,
      chatId,
      currentModel: this.deps.sessionController.getModel(chatId),
      models: this.deps.sessionController.getAvailableModels(chatId),
      readonly: false,
    });

    const messageId = await this.deps.messageClient.sendCard(chatId, card);
    this.#modelCardMessages.set(cardId, messageId);
    this.#modelCardUpdatedAt.set(cardId, Date.now());

    this.deps.logger.info("model card sent", {
      chatId,
      cardId,
      messageId,
      currentModel: this.deps.sessionController.getModel(chatId),
      models: this.deps.sessionController.getAvailableModels(chatId).map((item) => item.id),
    });
  }

  async handleCardAction(
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    this.deps.logger.info("card action received", {
      topLevelKeys: Object.keys(data),
      eventId: this.extractCardActionEventId(data),
      actionMessageId: this.extractActionMessageId(data),
    });

    this.gcHandledCardActionEventIds();
    const eventId = this.extractCardActionEventId(data);
    if (eventId && this.#handledCardActionEventIds.has(eventId)) {
      this.deps.logger.info("card action ignored: duplicated event", { eventId });
      return undefined;
    }
    if (eventId) {
      this.#handledCardActionEventIds.set(eventId, Date.now());
    }

    const action = parseCardActionValue(data);
    if (!action) {
      this.deps.logger.warn("card action ignored: invalid payload");
      return undefined;
    }

    if (action.type === "access") {
      return this.handleAccessAction(action, data);
    }

    if (action.type === "model") {
      return this.handleModelAction(action, data);
    }

    const decision: ApprovalDecision = {
      requestId: action.requestId,
      taskId: action.taskId,
      decision: action.decision,
      comment: action.comment,
      decidedAt: new Date().toISOString(),
      decidedBy: this.extractOperatorId(data),
    };

    this.deps.approvalGateway.resolve(decision);
    this.deps.onApprovalResolved(decision);
    return undefined;
  }

  private async handleModelAction(
    action: Extract<ReturnType<typeof parseCardActionValue>, { type: "model" }>,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    this.gcHandledModelCardIds();

    const chatId = action.chatId;
    const actionMessageId = this.extractActionMessageId(data);
    const availableModels = this.deps.sessionController.getAvailableModels(chatId);
    if (availableModels.length > 0 && !availableModels.some((item) => item.id === action.model)) {
      this.deps.logger.warn("model card action ignored: unsupported model", {
        chatId,
        cardId: action.cardId,
        model: action.model,
      });
      return undefined;
    }

    if (this.#handledModelCardIds.has(action.cardId)) {
      this.deps.logger.info("model card action ignored: card already locked", {
        chatId,
        cardId: action.cardId,
        messageId: actionMessageId,
      });
      return undefined;
    }

    this.#handledModelCardIds.set(action.cardId, Date.now());

    try {
      await this.deps.sessionController.setModel(chatId, action.model, this.deps.taskRunner);
      this.deps.logger.info("model card action applied", {
        chatId,
        cardId: action.cardId,
        model: action.model,
      });
    } catch (error) {
      this.#handledModelCardIds.delete(action.cardId);
      this.deps.logger.warn("model card action failed, unlock card", {
        chatId,
        cardId: action.cardId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const card = await this.updateModelCard(chatId, actionMessageId, action.cardId, true, false);
    if (!card) {
      return undefined;
    }
    return {
      card: {
        type: "raw",
        data: card,
      },
    };
  }

  private async handleAccessAction(
    action: Extract<ReturnType<typeof parseCardActionValue>, { type: "access" }>,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    this.gcHandledPermissionCardIds();

    const chatId = action.chatId;
    const actionMessageId = this.extractActionMessageId(data);

    this.deps.logger.info("permission card action parsed", {
      chatId,
      cardId: action.cardId,
      action: action.action,
      mode: action.action === "set" ? action.mode : undefined,
      actionMessageId,
    });

    if (this.#handledPermissionCardIds.has(action.cardId)) {
      this.deps.logger.info("permission card action ignored: card already locked", {
        chatId,
        messageId: actionMessageId,
        cardId: action.cardId,
      });
      return undefined;
    }

    this.#handledPermissionCardIds.set(action.cardId, Date.now());

    try {
      if (action.action === "clear") {
        await this.deps.sessionController.clearAccessOverride(chatId, this.deps.taskRunner);
      } else {
        await this.deps.sessionController.setAccessMode(chatId, action.mode, this.deps.taskRunner);
      }
      this.deps.logger.info("permission card action applied", {
        chatId,
        cardId: action.cardId,
        effectiveMode: this.deps.sessionController.getAccessMode(chatId),
      });
    } catch (error) {
      this.#handledPermissionCardIds.delete(action.cardId);
      this.deps.logger.warn("permission card action failed, unlock card", {
        chatId,
        cardId: action.cardId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const card = await this.updatePermissionCard(
      chatId,
      actionMessageId,
      action.cardId,
      true,
      undefined,
      false,
    );
    if (!card) {
      this.deps.logger.warn("permission card action applied but card update skipped", {
        chatId,
        cardId: action.cardId,
        actionMessageId,
      });
      return undefined;
    }

    return {
      card: {
        type: "raw",
        data: card,
      },
    };
  }

  private async updatePermissionCard(
    chatId: string,
    messageId?: string,
    cardId?: string,
    lockAfterPatch = false,
    readonlyReason?: string,
    patch = true,
  ): Promise<Record<string, unknown> | undefined> {
    this.gcPermissionCardState();
    const resolvedCardId = cardId ?? randomUUID();
    const nextRevision = (this.#permissionCardRevisions.get(resolvedCardId) ?? 1) + 1;
    this.#permissionCardRevisions.set(resolvedCardId, nextRevision);
    this.#permissionCardUpdatedAt.set(resolvedCardId, Date.now());

    const card = this.deps.cardRenderer.buildAccessModeCard({
      cardId: resolvedCardId,
      chatId,
      defaultMode: this.deps.sessionController.getDefaultAccessMode(),
      overrideMode: this.deps.sessionController.getAccessOverride(chatId),
      readonly: lockAfterPatch,
      readonlyReason,
    });

    const fromActionMessageId = messageId;
    const fromCardMap = this.#permissionCardMessages.get(resolvedCardId);
    const targetMessageId = fromActionMessageId ?? fromCardMap;

    if (!targetMessageId) {
      this.deps.logger.warn("permission card update skipped: message id not found", {
        chatId,
        cardId: resolvedCardId,
      });
      return undefined;
    }

    this.deps.logger.info("permission card patch start", {
      chatId,
      cardId: resolvedCardId,
      version: nextRevision,
      targetMessageId,
      targetSource: fromActionMessageId ? "action-message-id" : "card-id-map",
      lockAfterPatch,
      overrideMode: this.deps.sessionController.getAccessOverride(chatId),
      effectiveMode: this.deps.sessionController.getAccessMode(chatId),
    });

    try {
      this.#permissionCardMessages.set(resolvedCardId, targetMessageId);
      if (patch) {
        await this.deps.messageClient.patchCard(targetMessageId, card);
        this.deps.logger.info("permission card patch done", {
          chatId,
          cardId: resolvedCardId,
          version: nextRevision,
          targetMessageId,
          lockAfterPatch,
        });
      } else {
        this.deps.logger.info("permission card patch skipped: callback response mode", {
          chatId,
          cardId: resolvedCardId,
          version: nextRevision,
          targetMessageId,
          lockAfterPatch,
        });
      }
      return card;
    } catch (error) {
      this.deps.logger.warn("patch permission card failed", {
        chatId,
        messageId: targetMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async updateModelCard(
    chatId: string,
    messageId?: string,
    cardId?: string,
    lockAfterPatch = false,
    patch = true,
  ): Promise<Record<string, unknown> | undefined> {
    this.gcModelCardState();
    const resolvedCardId = cardId ?? randomUUID();
    this.#modelCardUpdatedAt.set(resolvedCardId, Date.now());
    const card = this.deps.cardRenderer.buildModelCard({
      cardId: resolvedCardId,
      chatId,
      currentModel: this.deps.sessionController.getModel(chatId),
      models: this.deps.sessionController.getAvailableModels(chatId),
      readonly: lockAfterPatch,
    });
    const targetMessageId = messageId ?? this.#modelCardMessages.get(resolvedCardId);
    if (!targetMessageId) {
      this.deps.logger.warn("model card update skipped: message id not found", {
        chatId,
        cardId: resolvedCardId,
      });
      return undefined;
    }

    try {
      this.#modelCardMessages.set(resolvedCardId, targetMessageId);
      if (patch) {
        await this.deps.messageClient.patchCard(targetMessageId, card);
      }
      return card;
    } catch (error) {
      this.deps.logger.warn("patch model card failed", {
        chatId,
        messageId: targetMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private extractOperatorId(data: Record<string, unknown>): string {
    const operator =
      data.operator && typeof data.operator === "object"
        ? (data.operator as Record<string, unknown>)
        : undefined;
    const operatorId =
      operator?.operator_id && typeof operator.operator_id === "object"
        ? (operator.operator_id as Record<string, unknown>)
        : undefined;

    if (typeof operatorId?.open_id === "string") {
      return operatorId.open_id;
    }
    if (typeof operatorId?.user_id === "string") {
      return operatorId.user_id;
    }
    return "feishu-user";
  }

  private extractActionMessageId(data: Record<string, unknown>): string | undefined {
    const topLevel = typeof data.open_message_id === "string" ? data.open_message_id : undefined;
    if (topLevel) {
      return topLevel;
    }

    const eventObj =
      data.event && typeof data.event === "object"
        ? (data.event as Record<string, unknown>)
        : undefined;
    if (eventObj) {
      if (typeof eventObj.open_message_id === "string") {
        return eventObj.open_message_id;
      }
      const contextObj =
        eventObj.context && typeof eventObj.context === "object"
          ? (eventObj.context as Record<string, unknown>)
          : undefined;
      if (contextObj && typeof contextObj.open_message_id === "string") {
        return contextObj.open_message_id;
      }
      const messageObj =
        eventObj.message && typeof eventObj.message === "object"
          ? (eventObj.message as Record<string, unknown>)
          : undefined;
      if (messageObj && typeof messageObj.message_id === "string") {
        return messageObj.message_id;
      }
    }

    const messageObj =
      data.message && typeof data.message === "object"
        ? (data.message as Record<string, unknown>)
        : undefined;
    if (messageObj && typeof messageObj.message_id === "string") {
      return messageObj.message_id;
    }
    return undefined;
  }

  private extractCardActionEventId(data: Record<string, unknown>): string | undefined {
    if (typeof data.event_id === "string") {
      return data.event_id;
    }

    const headerObj =
      data.header && typeof data.header === "object"
        ? (data.header as Record<string, unknown>)
        : undefined;
    if (headerObj && typeof headerObj.event_id === "string") {
      return headerObj.event_id;
    }

    const eventObj =
      data.event && typeof data.event === "object"
        ? (data.event as Record<string, unknown>)
        : undefined;
    if (eventObj && typeof eventObj.event_id === "string") {
      return eventObj.event_id;
    }

    return undefined;
  }

  private gcHandledCardActionEventIds(): void {
    const expireMs = 60_000;
    const now = Date.now();
    for (const [eventId, ts] of this.#handledCardActionEventIds.entries()) {
      if (now - ts > expireMs) {
        this.#handledCardActionEventIds.delete(eventId);
      }
    }
  }

  private gcHandledPermissionCardIds(): void {
    const expireMs = 10 * 60_000;
    const now = Date.now();
    for (const [cardId, ts] of this.#handledPermissionCardIds.entries()) {
      if (now - ts > expireMs) {
        this.#handledPermissionCardIds.delete(cardId);
      }
    }
  }

  private gcHandledModelCardIds(): void {
    const expireMs = 10 * 60_000;
    const now = Date.now();
    for (const [cardId, ts] of this.#handledModelCardIds.entries()) {
      if (now - ts > expireMs) {
        this.#handledModelCardIds.delete(cardId);
      }
    }
  }

  private gcPermissionCardState(): void {
    const expireMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const [cardId, ts] of this.#permissionCardUpdatedAt.entries()) {
      if (now - ts > expireMs) {
        this.#permissionCardUpdatedAt.delete(cardId);
        this.#permissionCardRevisions.delete(cardId);
        this.#permissionCardMessages.delete(cardId);
      }
    }
  }

  private gcModelCardState(): void {
    const expireMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const [cardId, ts] of this.#modelCardUpdatedAt.entries()) {
      if (now - ts > expireMs) {
        this.#modelCardUpdatedAt.delete(cardId);
        this.#modelCardMessages.delete(cardId);
      }
    }
  }
}
