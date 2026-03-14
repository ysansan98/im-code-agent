import { homedir } from "node:os";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type ChatStateData = {
  chatCwds?: Record<string, string>;
  chatSessionIds?: Record<string, string>;
};

export type ChatState = {
  chatCwds: Map<string, string>;
  chatSessionIds: Map<string, string>;
};

export class ChatStateStore {
  constructor(
    private readonly filePath = resolve(homedir(), ".im-code-agent", "chat-state.json"),
  ) {}

  async loadState(): Promise<ChatState> {
    const raw = await readFile(this.filePath, "utf8").catch(() => undefined);
    if (!raw) {
      return {
        chatCwds: new Map(),
        chatSessionIds: new Map(),
      };
    }
    const parsed = JSON.parse(raw) as ChatStateData;
    return {
      chatCwds: new Map(Object.entries(parsed.chatCwds ?? {})),
      chatSessionIds: new Map(Object.entries(parsed.chatSessionIds ?? {})),
    };
  }

  async saveState(chatState: ChatState): Promise<void> {
    const payload: ChatStateData = {
      chatCwds: Object.fromEntries(chatState.chatCwds.entries()),
      chatSessionIds: Object.fromEntries(chatState.chatSessionIds.entries()),
    };
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });

    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    await rename(tmpPath, this.filePath);
  }
}
