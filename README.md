# IM Code Agent

通过飞书机器人控制本地电脑上的 `codex` 执行开发任务。执行链路保持本地化，由本地 Bridge 服务驱动本地 ACP adapter / agent 进程，并将流式输出和审批请求同步到飞书。

## 当前状态

当前仓库仍处于方案落地阶段，已确定的 MVP 方向包括：

- Bridge 主动连出 WebSocket，不暴露生产入站控制面
- Agent 会话走 ACP，`acpx` 仅作为调试和接入参考，不作为当前架构里的固定运行时组件
- `codex` 方向优先接入 `@zed-industries/codex-acp`
- 已确认 `codex-acp` 使用 newline-delimited JSON 消息，不使用 `Content-Length` framing
- 敏感操作通过审批流控制
- 每个任务独立执行，任务结束即销毁

详细方案见 [docs/architecture.md](./docs/architecture.md)。

## 启动路径

当前仅保留一条入口路径：

- 飞书直连：通过飞书消息事件触发任务。

不再提供本地 debug HTTP 入口。

## 飞书直连

当前已集成飞书官方 Node SDK（`@larksuiteoapi/node-sdk`）的 WebSocket 事件接收。

推荐使用运行时配置文件 `~/.im-code-agent/config.env`（`.env` 风格，支持注释）：

```bash
# Bridge 基础配置

# 飞书应用凭据
FEISHU_APP_ID=
FEISHU_APP_SECRET=

# 可选：true 时默认 Full Access
YOLO_MODE=false

# 可选：默认工作目录，不填则使用 bridge 启动目录
WORKSPACE_DEFAULT_CWD=
```

也支持环境变量覆盖（优先级高于配置文件）：

默认读取 `~/.im-code-agent/config.env`（首次启动自动创建），也可用 `BRIDGE_ENV_PATH` 指定文件。兼容读取当前目录的 `bridge.env` / `.env`。

```bash
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=xxx
export YOLO_MODE=false
```

如果启动时未检测到有效的 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`：

- 交互终端下会提示并引导输入，输入后自动写回配置文件
- 非交互环境下会直接报错退出，避免以不可用状态启动

启动：

```bash
vp run dev
```

指定配置文件路径启动：

```bash
vp exec tsx src/cli.ts --config /absolute/path/to/config.env
# 或
vp exec tsx src/cli.ts -c /absolute/path/to/config.env
```

运行后，机器人收到文本消息会触发：

1. 飞书消息事件 `im.message.receive_v1`
2. 本地 `taskRunner.startConversationTask(...)`
3. `codex-acp` 执行
4. 飞书消息卡片流式更新执行输出

会话命令：

- `/new`：重置当前聊天会话（保留当前工作目录）
- `/new <path>`：重置会话并切换工作目录（支持绝对路径，或相对当前目录）
- `/stop` 或 `/interrupt`：立即打断当前执行中的任务
- `/perm`：查看并通过交互卡片切换权限模式

### 权限与配置清单

当前代码使用「消息卡片 + `im.v1.message.patch` 增量更新」实现流式体验，先开这批：

1. 机器人能力（Bot）
2. 事件订阅：

- `im.message.receive_v1`（接收消息 v2.0）

3. 消息接口权限：

- 发送消息（`im.v1.message.create`）
- 更新应用发送的消息（`im.v1.message.patch`）

4. 若要在群里收消息，还需要开群消息可见相关权限（例如“获取群组中所有消息”或“获取用户在群组中@机器人的消息”按你的策略选）

如果你后续要升级到 CardKit 原生文本流式接口（`cardkit.v1.cardElement.content`），再额外开：

1. 创建与更新卡片（`cardkit:card:write`）
2. 按 CardKit 实体流程创建卡片实体并维护 `card_id / element_id / sequence`

## 开发

安装依赖：

```bash
vp install
```

校验代码：

```bash
vp check
```

运行测试：

```bash
vp test
```
