import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

type SessionStateData = {
  chatCwds?: Record<string, string>;
  chatBridgeSessionIds?: Record<string, string>;
  chatSessionIds?: Record<string, string>;
};

export type SessionState = {
  chatCwds: Map<string, string>;
  chatBridgeSessionIds: Map<string, string>;
  chatSessionIds: Map<string, string>;
};

export interface SessionStateStore {
  loadState(): Promise<SessionState>;
  saveState(state: SessionState): Promise<void>;
}

export class FileSessionStateStore implements SessionStateStore {
  constructor(
    private readonly filePath = resolve(homedir(), ".im-code-agent", "chat-state.json"),
  ) {}

  async loadState(): Promise<SessionState> {
    const raw = await readFile(this.filePath, "utf8").catch(() => undefined);
    if (!raw) {
      return {
        chatCwds: new Map(),
        chatBridgeSessionIds: new Map(),
        chatSessionIds: new Map(),
      };
    }
    const parsed = JSON.parse(raw) as SessionStateData;
    return {
      chatCwds: new Map(Object.entries(parsed.chatCwds ?? {})),
      chatBridgeSessionIds: new Map(Object.entries(parsed.chatBridgeSessionIds ?? {})),
      chatSessionIds: new Map(Object.entries(parsed.chatSessionIds ?? {})),
    };
  }

  async saveState(state: SessionState): Promise<void> {
    const payload: SessionStateData = {
      chatCwds: Object.fromEntries(state.chatCwds.entries()),
      chatBridgeSessionIds: Object.fromEntries(state.chatBridgeSessionIds.entries()),
      chatSessionIds: Object.fromEntries(state.chatSessionIds.entries()),
    };
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });

    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    await rename(tmpPath, this.filePath);
  }
}
