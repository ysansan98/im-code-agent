# /perm 卡片回退问题排查总结

## 现象

- 在飞书中发送 `/perm` 后，点击“本会话 Full Access”。
- 卡片先更新为 `v2`，随后看起来又回到 `v1`。
- 用户确认是点击的同一张卡片发生回退，而不是新增一张卡片。

## 目标

- 让权限卡点击后只发生一次可预期更新，不出现回退感知。
- 明确回退是否来自当前 bridge 进程，还是来自外部写入源。

## 已做改动

### 权限模型与入口

- 移除 `WORKSPACE_APPROVAL_MODE`。
- 新增 `YOLO_MODE`（默认 `false`）作为全局默认权限。
- 权限切换入口收敛为 `/perm`（移除 `/full-access`、`/safe-access` 文本入口）。

### /perm 卡片交互与状态

- `/perm` 始终新发一张权限卡。
- 点击按钮后，优先 patch 被点击的卡片，而不是新发卡。
- 卡片显示当前状态高亮（按钮“当前”标识 + 主按钮样式）。
- 回调后卡片可切只读（隐藏操作按钮/锁定提示）。

### 去重与防重复处理

- `card.action.trigger` 增加 `event_id` 去重。
- 权限卡动作增加 `cardId` 一次性消费（同一 `cardId` 只处理一次）。
- 回调目标定位改为 `cardId -> messageId` 精确映射，避免按 `chatId` 误 patch 到其他卡。

### 诊断增强

- 权限卡正文增加可观测字段：
  - 卡片版本 `vN`
  - 更新时间
  - 写入实例 `instanceId`
- 新增关键日志：
  - `card action received/parsed/applied`
  - `permission card patch start/done`（包含 `targetSource`）
  - `patch card invoked/success`（包含 `messageId`、`count`、`kind`）

## 关键日志结论

- 在多次复现中，当前进程对同一权限卡 `messageId` 的 `patchCard` 只有一次调用：
  - `patch card invoked` 的 `count=1`
  - `patch card success` 也仅一次
- 即：当前 bridge 进程内没有证据显示“同一消息被 patch 两次”。

## 当前判断

- 用户看到的 `v2 -> v1`，不是当前进程 `patchCard` 二次调用导致。
- 高概率是外部写入源覆盖同一 `message_id`（例如并行运行的其他 bridge 实例或其他路径写入）。

## 尚未彻底闭环的点

- 旧历史权限卡在进程重启后无法完整追踪（只掌握当前进程登记的 `cardId/messageId`）。
- 尚未强制单实例运行，同一飞书应用存在被多进程同时消费回调的可能。

## 建议在“干净会话”优先做的动作

1. 增加单实例互斥锁（同一时间只允许一个 bridge 实例连接飞书）。
2. 仅保留一个实例复现 `/perm` 点击流程。
3. 对照 `patch card invoked` 的 `messageId + count` 与卡片 `instanceId`，确认是否仍出现回退。
