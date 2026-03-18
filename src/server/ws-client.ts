import type {
  BridgeInboundMessage,
  BridgeOutboundMessage,
  BridgeReadyMessage,
  BridgeRegisterMessage,
} from "#shared";

import type { BridgeConfig } from "#shared";

import type { Logger } from "../utils/logger.ts";

export class WsClient {
  #socket?: WebSocket;
  readonly #sendQueue: string[] = [];

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
    private readonly onMessage?: (message: BridgeInboundMessage) => Promise<void> | void,
  ) {}

  async connect(): Promise<void> {
    if (!this.config.wsUrl) {
      throw new Error("wsUrl is not configured");
    }

    this.#socket = new WebSocket(this.config.wsUrl);

    this.#socket.addEventListener("open", () => {
      this.logger.info("ws client connected", { wsUrl: this.config.wsUrl });
      this.flushQueue();
    });

    this.#socket.addEventListener("message", async (event) => {
      const payload = typeof event.data === "string" ? event.data : String(event.data);
      let message: BridgeInboundMessage;
      try {
        message = JSON.parse(payload) as BridgeInboundMessage;
      } catch (error) {
        this.logger.warn("ws inbound parse failed", {
          payload,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      this.logger.info("ws inbound message", { type: message.type });
      if (this.onMessage) {
        await this.onMessage(message);
      }
    });

    this.#socket.addEventListener("close", (event) => {
      this.logger.warn("ws client closed", {
        code: event.code,
        reason: event.reason,
      });
    });

    this.#socket.addEventListener("error", () => {
      this.logger.error("ws client error");
    });

    await this.waitForOpen();
  }

  buildRegisterMessage(): BridgeRegisterMessage {
    return {
      type: "bridge.register",
      deviceId: this.config.deviceId,
      workspaces: this.config.workspaces,
      supportedAgents: Object.keys(this.config.agents) as BridgeRegisterMessage["supportedAgents"],
    };
  }

  buildReadyMessage(): BridgeReadyMessage {
    return {
      type: "bridge.ready",
      deviceId: this.config.deviceId,
      timestamp: new Date().toISOString(),
    };
  }

  async send(message: BridgeOutboundMessage): Promise<void> {
    const payload = JSON.stringify(message);
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
      this.#sendQueue.push(payload);
      this.logger.info("ws outbound queued", { type: message.type });
      return;
    }

    this.#socket.send(payload);
    this.logger.info("ws outbound sent", { type: message.type });
  }

  private flushQueue(): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
      return;
    }

    while (this.#sendQueue.length > 0) {
      const payload = this.#sendQueue.shift();
      if (!payload) {
        break;
      }

      this.#socket.send(payload);
    }
  }

  private async waitForOpen(): Promise<void> {
    const socket = this.#socket;
    if (!socket) {
      throw new Error("ws socket is not initialized");
    }

    if (socket.readyState === WebSocket.OPEN) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`ws connect timeout: ${this.config.wsUrl}`));
      }, 8_000);

      const onOpen = () => {
        clearTimeout(timeout);
        resolve();
      };

      const onError = () => {
        clearTimeout(timeout);
        reject(new Error(`ws connect failed: ${this.config.wsUrl}`));
      };

      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
    });
  }
}
