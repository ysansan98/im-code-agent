import type { CreateTaskInput, Task, TaskStatus, WorkspaceConfig } from "@im-code-agent/shared";

export class SessionManager {
  readonly #tasks = new Map<string, Task>();

  createTask(input: CreateTaskInput, workspace: WorkspaceConfig): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id: crypto.randomUUID(),
      workspaceId: workspace.id,
      agent: input.agent,
      prompt: input.prompt,
      cwd: workspace.cwd,
      status: "pending",
      createdAt: now,
    };

    this.#tasks.set(task.id, task);
    return task;
  }

  getTask(taskId: string): Task | undefined {
    return this.#tasks.get(taskId);
  }

  updateTaskStatus(taskId: string, status: TaskStatus): Task | undefined {
    const task = this.#tasks.get(taskId);
    if (!task) {
      return undefined;
    }

    const updatedTask: Task = {
      ...task,
      status,
      startedAt: status === "running" ? new Date().toISOString() : task.startedAt,
      endedAt:
        status === "completed" || status === "failed" || status === "cancelled"
          ? new Date().toISOString()
          : task.endedAt,
    };

    this.#tasks.set(taskId, updatedTask);
    return updatedTask;
  }
}
