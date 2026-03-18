# Bridge 通用 IM 事件契约（工具调用 / 权限请求）

## 目标

本文定义 Bridge 对外可复用的最小稳定字段，用于接入飞书、Slack、Telegram、企业微信等 IM。

设计原则：

- 上游 ACP 字段允许变化；
- Bridge 对 IM 暴露固定核心字段；
- 不可稳定推断的字段使用 `unknown`，避免前端崩溃。

---

## 1) 工具调用事件（推荐消费）

事件类型：`task.tool_update`

字段（`event.update`）：

- `updateType` `string`：ACP 会话更新类型（如 `tool_call` / `tool_call_update`）
- `toolCallId` `string`：工具调用 ID，缺失时固定为 `unknown`
- `toolName` `string`：标准化后的工具名，缺失时固定为 `unknown`
- `toolNameSource` `string`：工具名来源
  - `action_type` / `title` / `direct_field` / `known_pattern` / `command` / `fallback`
- `kind` `string`：工具类型，缺失时固定为 `unknown`
- `status` `string`：状态，缺失时固定为 `unknown`
- `title?` `string`
- `query?` `string`
- `url?` `string`
- `command?` `string`
- `path?` `string`
- `error?` `string`
- `fieldPaths` `string[]`：本次原始 update 的字段路径全集（用于 UI 映射与调试）

参考类型定义：

- `packages/shared/src/events.ts` 中 `ToolInvocation`

---

## 2) 权限请求事件（业务审批）

事件类型：`task.approval_requested`

字段（`event.request`）：

- `id`、`taskId`、`kind`、`title`、`cwd`
- `target?`、`command?`、`diffPreview?`、`reason?`
- `riskLevel`、`createdAt`、`expiresAt`

参考类型定义：

- `packages/shared/src/approval.ts` 中 `ApprovalRequest`

---

## 3) ACP 原始字段可观测性（日志）

为支持不同 IM 设计展示字段，Bridge 日志保留字段名观测：

### 工具调用日志

日志名：`agent tool update`

- `fieldPaths`：本次工具更新实际出现的所有字段路径
- `standardFields`：ACP 常见字段清单（用于对照）

### 权限请求日志

日志名：`permission request payload`

- `permission.fieldPaths`：权限请求原始 payload 的字段路径
- `toolCallFieldPaths`：`toolCall` 子对象字段路径
- `permission.standardFields`、`toolCallStandardFields`：常见字段清单

---

## 4) 兼容约定

- 向后兼容：新增字段只增不删；
- `toolName/toolCallId/kind/status/updateType` 作为跨 IM 的固定核心字段；
- 对于缺失或无法识别的上游字段，Bridge 必须输出 `unknown`，而不是省略。
