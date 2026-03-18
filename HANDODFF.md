# HANDODFF

## 1. 背景与目标

目标：在 `im-code-agent` 中建立 **权限审批闭环**（飞书交互卡片），覆盖 `write / exec / network` 人工审批，`read` 可按策略自动放行，并支持：

- 批准
- 拒绝
- 超时自动拒绝
- 审批结果回传到 ACP，驱动任务继续或终止

验收标准：

- 高风险操作在未审批前不可执行
- 审批后行为与决策一致
- 全链路可追踪（请求、决策、回传、最终执行结果）

---

## 2. 当前进度（已完成）

### 2.1 已完成分析：codex-acp 默认权限机制

已确认 `codex-acp` 侧具备审批事件与阻塞点，核心在：

- `exec_approval`：命令执行审批（含网络上下文）
- `patch_approval`：补丁/写文件审批
- `mcp_elicitation`：外部工具请求审批

关键文件：

- [/Users/ysansan/webProject/codex-acp/src/thread.rs](/Users/ysansan/webProject/codex-acp/src/thread.rs)

已确认上游预置模式（来自 `codex-utils-approval-presets`）：

- `read-only`: `OnRequest + ReadOnly`
- `auto`: `OnRequest + WorkspaceWrite`
- `full-access`: `Never + DangerFullAccess`

参考：

- [/tmp/codex-upstream-20260315/codex-rs/utils/approval-presets/src/lib.rs](/tmp/codex-upstream-20260315/codex-rs/utils/approval-presets/src/lib.rs)
- [/tmp/codex-upstream-20260315/codex-rs/core/src/exec_policy.rs](/tmp/codex-upstream-20260315/codex-rs/core/src/exec_policy.rs)

结论：`codex-acp` 已具备“审批请求 -> 等待决策 -> 回传执行决策”能力，Bridge 侧只需接通 ACP 反向请求与飞书卡片回调即可形成闭环。

### 2.2 已完成盘点：im-code-agent 现状

已有基础：

- 审批模型定义：[/Users/ysansan/webProject/im-code-agent/packages/shared/src/approval.ts](/Users/ysansan/webProject/im-code-agent/packages/shared/src/approval.ts)
- 策略引擎雏形：[/Users/ysansan/webProject/im-code-agent/apps/bridge/src/policy/policy-engine.ts](/Users/ysansan/webProject/im-code-agent/apps/bridge/src/policy/policy-engine.ts)
- 审批存储网关雏形：
  - [/Users/ysansan/webProject/im-code-agent/apps/bridge/src/approval/approval-store.ts](/Users/ysansan/webProject/im-code-agent/apps/bridge/src/approval/approval-store.ts)
  - [/Users/ysansan/webProject/im-code-agent/apps/bridge/src/approval/approval-gateway.ts](/Users/ysansan/webProject/im-code-agent/apps/bridge/src/approval/approval-gateway.ts)
- 飞书消息收发与卡片更新基础：[/Users/ysansan/webProject/im-code-agent/apps/bridge/src/feishu/feishu-gateway.ts](/Users/ysansan/webProject/im-code-agent/apps/bridge/src/feishu/feishu-gateway.ts)

缺口：

- `AgentProcess` 还未处理 ACP `request_permission` 反向请求
- `ApprovalGateway` 没有“阻塞等待 + 超时 + 幂等决策”能力
- 飞书仅处理 `im.message.receive_v1`，未处理 `card.action.trigger` 卡片交互回调
- bridge 主流程里 `approval.decision` 目前只做本地 resolve，未真正驱动 ACP 审批响应

---

## 3. 下一步实施计划（可直接执行）

## P0-1 补齐 ACP 审批协议类型与反向请求处理

改动点：

- [/Users/ysansan/webProject/im-code-agent/packages/shared/src/acp.ts](/Users/ysansan/webProject/im-code-agent/packages/shared/src/acp.ts)
- [/Users/ysansan/webProject/im-code-agent/apps/bridge/src/agent/agent-process.ts](/Users/ysansan/webProject/im-code-agent/apps/bridge/src/agent/agent-process.ts)

任务：

- 增加 `request_permission` 相关类型（请求参数、选项、响应结构）
- 在 `AgentProcess.handleMessage` 中识别 `request` 消息并路由到审批处理器
- 审批处理器在未得到决策前阻塞，不回写 ACP
- 回写结果映射到 ACP 预期字段（选项 ID / cancel）

## P0-2 实现审批等待与超时

改动点：

- [/Users/ysansan/webProject/im-code-agent/apps/bridge/src/approval/approval-store.ts](/Users/ysansan/webProject/im-code-agent/apps/bridge/src/approval/approval-store.ts)
- [/Users/ysansan/webProject/im-code-agent/apps/bridge/src/approval/approval-gateway.ts](/Users/ysansan/webProject/im-code-agent/apps/bridge/src/approval/approval-gateway.ts)

任务：

- `ApprovalStore` 扩展为状态机：`pending/approved/rejected/expired`
- 增加 `awaitDecision(requestId, timeoutMs)`
- 超时后自动转 `expired` 并返回拒绝语义
- 保证幂等：重复决策只接受第一次有效点击

## P0-3 接飞书交互卡片回调

改动点：

- [/Users/ysansan/webProject/im-code-agent/apps/bridge/src/feishu/feishu-gateway.ts](/Users/ysansan/webProject/im-code-agent/apps/bridge/src/feishu/feishu-gateway.ts)

任务：

- 在 EventDispatcher 注册卡片回调（建议新版 `card.action.trigger`）
- 解析按钮 `value`（包含 `requestId/taskId/decision`）
- 3 秒内返回 200
- 调用 `approvalGateway.resolve(...)`
- 更新原卡片状态（已批准/已拒绝/已超时）

## P0-4 策略落地

改动点：

- [/Users/ysansan/webProject/im-code-agent/apps/bridge/src/policy/policy-engine.ts](/Users/ysansan/webProject/im-code-agent/apps/bridge/src/policy/policy-engine.ts)

任务：

- `read`：按工作区范围自动放行（可结合 `blockedPaths`）
- `write/exec/network`：默认 `ask`
- 增加“会话放行全部权限”能力（session scope）

---

## 4. 建议的最小交付切片

第一刀先做 `exec` 全闭环：

- ACP `request_permission(exec)` -> 飞书卡片 -> 决策 -> ACP 回写 -> 任务继续/终止

通过后再扩：

- `write`（patch approval）
- `network`（从 exec 事件里的 network context 识别）

原因：`exec` 路径最长、风险最高，打通后其它类型基本是同构扩展。

---

## 5. 测试与验收清单

- [ ] 未审批前，`exec` 不会实际执行
- [ ] 点击批准后，`exec` 继续执行
- [ ] 点击拒绝后，当前步骤终止并回显拒绝
- [ ] 无操作超时后，自动拒绝并终止
- [ ] 重复点击按钮不改变首个决策结果
- [ ] 任务日志中可追踪 `approval_requested -> approval_resolved`

建议新增最小测试：

- `policy-engine` 单测（kind -> allow/ask/deny）
- `approval-gateway` 单测（等待、超时、幂等）
- `agent-process` 集成测试（模拟 ACP request_permission 往返）

---

## 6. 飞书侧配置提醒

需要确保应用已订阅并具备：

- 消息接收：`im.message.receive_v1`
- 消息发送：`im.v1.message.create`
- 消息更新：`im.v1.message.patch`
- 卡片交互回调：`card.action.trigger`（新版）

参考本地文档：

- [/Users/ysansan/webProject/im-code-agent/feishu-docs/5-处理卡片回调.md](/Users/ysansan/webProject/im-code-agent/feishu-docs/5-处理卡片回调.md)
- [/Users/ysansan/webProject/im-code-agent/feishu-docs/4-更新卡片.md](/Users/ysansan/webProject/im-code-agent/feishu-docs/4-更新卡片.md)
- [/Users/ysansan/webProject/im-code-agent/feishu-docs/0-卡片 JSON 2.0 结构.md](/Users/ysansan/webProject/im-code-agent/feishu-docs/0-卡片 JSON 2.0 结构.md)

---

## 7. 当前阻塞项

无代码级阻塞。主要是待实现工作，不是信息缺失问题。

唯一注意：`HANDODFF.md` 文件名按你的原始要求创建（拼写不是常见 `HANDOFF`）。
