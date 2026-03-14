import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type {
  AgentType,
  BridgeConfig,
  CreateTaskInput,
  WorkspaceConfig,
} from "@im-code-agent/shared";

import { TaskRunner } from "../session/task-runner.ts";
import type { Logger } from "../utils/logger.ts";

type DebugTaskRequest = {
  prompt: string;
  workspaceId?: string;
  agent?: AgentType;
};

export class DebugHttpServer {
  constructor(
    private readonly logger: Logger,
    private readonly config: BridgeConfig,
    private readonly taskRunner: TaskRunner,
  ) {}

  async start(port: number): Promise<void> {
    const server = createServer(async (request, response) => {
      await this.handleRequest(request, response);
    });

    await new Promise<void>((resolve) => {
      server.listen(port, "127.0.0.1", () => resolve());
    });

    this.logger.info("debug http server started", { port });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "GET" && request.url === "/health") {
      this.writeJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && request.url === "/debug/workspaces") {
      this.writeJson(response, 200, {
        workspaces: this.config.workspaces,
      });
      return;
    }

    if (request.method === "POST" && request.url === "/debug/tasks") {
      const body = await this.readJson<DebugTaskRequest>(request);
      const workspace = this.resolveWorkspace(body.workspaceId);
      if (!workspace) {
        this.writeJson(response, 400, {
          error: "Workspace not found",
        });
        return;
      }

      const agent = body.agent ?? "codex";
      const input: CreateTaskInput = {
        workspaceId: workspace.id,
        agent,
        prompt: body.prompt,
      };

      const result = await this.taskRunner.startTask(input, workspace);
      this.writeJson(response, 200, result);
      return;
    }

    this.writeJson(response, 404, { error: "Not found" });
  }

  private resolveWorkspace(workspaceId?: string): WorkspaceConfig | undefined {
    if (!workspaceId) {
      return this.config.workspaces[0];
    }

    return this.config.workspaces.find((workspace) => workspace.id === workspaceId);
  }

  private async readJson<T>(request: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }

    return JSON.parse(Buffer.concat(chunks).toString()) as T;
  }

  private writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(body, null, 2));
  }
}
