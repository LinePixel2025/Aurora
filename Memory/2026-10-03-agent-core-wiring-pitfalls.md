---
date: 2026-10-03
title: agent-core 接线点：getter 注入、ensureLoaded、edit_file 守卫与写前快照顺序
tags: [agent-core, 工具, 会话, 坑]
source: 模型自动记录
---

## 现象

- 可热改的上限若写成构造时常量，就成「改设置要重启才生效」的**死字段**（用户在设置页改了、AI 也在改，行为却不变）。
- 三处 `ensureLoaded`（会话 / 待办清单 / job 存储）若「先置 `loaded` 再 `await` 读盘」，并发首读会拿到**空快照**，随后那一次写入把磁盘历史整体覆盖。
- `edit_file` 的「改前必须先读」守卫若被挪进 `sync()`，用户改一个无关开关（比如关掉终端）就会清空读记录，模型刚 `read_file` 过的文件立刻被拒绝，**看起来像工具坏了**。
- 写前快照的钩子在 `file-port.writeText` 内部，顺序被改过；主写失败时用户不知道还能回滚。

## 原因

- 内核只接受注入（`fetchImpl` / `summarize` / `confirmTool` 都是这个套路），上限类配置必须以 **getter 形式**注入（如 `() => settings.get().agent.loop.maxParallelCalls`），否则读的是构造那一刻的快照。
- `sync()` 会在每次 `settings:changed` 时**重建全部工具实例**（这是让上限 / cwd 热改的必要设计），所以会话级状态不能放在它里面。
- 「先置 loaded 再读盘」在 `loaded.add()` 与读盘之间的 await 窗口里会让第二个调用者直接返回空表；`edit_file` 的读记录是会话级状态，与工具实例生命周期无关。

## 影响

- 死字段与「配置字段能写不等于生效」是同一个坑；并发首读写回 = 历史被整体覆盖（本仓库修过两次）。
- 守卫错位时用户看到的是「工具坏了」；快照顺序错位则回滚拿不到改动前内容。

## 结论与做法

- 上限 / 可热改配置一律 **getter 注入内核**，不要缓存在构造期。
- 三处 `ensureLoaded` 全都用 **in-flight promise**（读盘成功后才登记 `loaded`，失败下次访问重试）；job 存储多一条：**落盘前必须已 `ensureLoaded`**，否则内存空表会冲掉盘上数据。
- `edit_file` 守卫是**会话级单例、建在 `registerComputerTools` 的闭包里（`sync()` 之外）**：`read_file` 与 `edit_file` 共享「本会话读过哪些文件」的记录（键是解析后的绝对路径，只留最近 16 个会话，`main/tools/index.ts:162-182`）。**不要把它挪进 `sync()`**。守卫是内核可注入端口（未注入不拦截，供单测直接调工具，docs/06 §11.6）。
- 写前快照顺序**不能换**：`resolveWithin`（项目根 realpath 前缀校验）→ `capture`（把**原内容**存进 `<userData>/backups/<sessionId>/`）→ 真正写盘（`file-port.ts:490/498`）。主写失败**不回滚快照**（文件可能已被部分改写，那份快照才是唯一退路），并把快照 id 带进错误信息（docs/06 §11.8）。
- **续跑（`appendUserMessage = false`）前必须重读会话重算 `history` / `systemPrompt`**（`agentHost.ts:738-756`）：该标志的语义前提是「提问已在 history 里」，否则模型会重复已执行的写 / 命令。
- **SkillsService 目录监听**（`startWatching`）：改 `skills.userDir` 走 `reconfigure` → `rearmWatcher`，新增监听路径时同样处理；create-skill 写文件后靠监听自动重扫，没有「刷新」仪式。
- 出网统一走 `apps/desktop/src/main/net.ts` 的 `netFetch`（优先 Electron `net.fetch`，才受 `advanced.proxy` 影响），新出网调用都要注入它；`agent-core` / `modes` 不得 import electron。
