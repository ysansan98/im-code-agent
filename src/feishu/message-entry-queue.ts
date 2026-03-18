type QueueTask = () => Promise<void>;

export class MessageEntryQueue {
  readonly #processingMessageIds = new Set<string>();
  readonly #handledMessageIds = new Map<string, number>();
  readonly #chatQueues = new Map<string, Promise<void>>();

  constructor(private readonly dedupeTtlMs = 10 * 60 * 1000) {}

  gcHandledMessageIds(): void {
    const now = Date.now();
    for (const [messageId, timestamp] of this.#handledMessageIds.entries()) {
      if (now - timestamp > this.dedupeTtlMs) {
        this.#handledMessageIds.delete(messageId);
      }
    }
  }

  tryBegin(messageId: string): boolean {
    if (this.#handledMessageIds.has(messageId) || this.#processingMessageIds.has(messageId)) {
      return false;
    }
    this.#processingMessageIds.add(messageId);
    return true;
  }

  runInChatQueue(chatId: string, messageId: string, task: QueueTask): Promise<void> | undefined {
    if (!this.tryBegin(messageId)) {
      return undefined;
    }

    const queue = (this.#chatQueues.get(chatId) ?? Promise.resolve())
      .catch(() => {
        return;
      })
      .then(async () => {
        await task();
      });

    this.#chatQueues.set(chatId, queue);

    void queue.finally(() => {
      this.complete(messageId);
      if (this.#chatQueues.get(chatId) === queue) {
        this.#chatQueues.delete(chatId);
      }
    });

    return queue;
  }

  complete(messageId: string): void {
    this.#processingMessageIds.delete(messageId);
    this.#handledMessageIds.set(messageId, Date.now());
  }
}
