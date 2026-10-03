---
date: 2026-10-03
title: agent-core 的几处接线点：getter 注入、续轮重算、ensureLoaded、写前快照顺序
tags: [agent-core, 接线, 坑]
source: 模型自动记录
---

# agent-core 接线点

## 现象

1. `agent.loop` 的三个上限（`maxRounds` 等）若写成构造时常量值，就变成"改设置要重启才生效"的**死字段**。
2. 自动续轮：`history` / `systemPrompt` 若整块外置到 `for (;;)` attempt 循环之前，续轮会拿**请求前**的旧快照 ——
   第二轮既没有本轮提问、也没有上一 attempt 的工具结果，模型会**重复已执行的写 / 命令操作**。
3. `ensureLoaded`（会话 / 待办清单 / job 存储三处）写成"先置 `loaded` 再 `await` 读盘"，并发首读会拿到**空快照**，
   随后那一次写入把磁盘上的历史**整体覆盖**。
4. `edit_file` 的「改前必须先读」守卫若被挪进 `sync()`，用户改一个无关开关（比如关掉终端）就会清空读记录，
   模型刚 `read_file` 过的文件立刻被 `edit_file` 拒绝「修改前必须先读」，**看起来像工具坏了**。
5. 写前快照的钩子在 `apps/desktop/src/main/file-port.writeText` 内部，顺序被改过。

## 原因

- 内核只接受注入（`fetchImpl` / `summarize` / `confirmTool` 都是这个套路），上限类配置必须用
  **getter 形式**注入（`() => settings.get().agent.loop.maxRounds`），否则读的是构造那一刻的快照。
- `agentLoop` 在 `appendUserMessage = false` 时**既不落盘也不 push** 用户消息，其语义前提是「提问已在 history 里」——
  只有每个 attempt 重新读会话组装才成立。
- `sync()` 会在每次 `settings:changed` 时**重建全部工具实例**（这是让上限 / cwd 热改的必要设计），
  所以会话级状态不能放在它里面。

## 影响

- 死字段：用户在设置页改了、AI 也在改，行为却不变 —— 与"配置字段能写不等于生效"是同一个坑，本仓库已修过一批。
- 续轮重复执行写 / 命令 = 数据被改两次；`ensureLoaded` 写回 = 历史被整体覆盖（本仓库已修过两次）。

## 结论与做法

- 上限 / 可热改配置一律 **getter 注入内核**，不要缓存在构造期。
- 自动续轮的 `history` / `systemPrompt` 必须在 `for (;;)` attempt 循环**内、每 attempt 重算**。
  回归护栏：`agentHost.test.ts` 的「自动续轮的请求带本轮提问与上一轮工具结果」用例。
- 三处 `ensureLoaded`（会话 / 待办清单 / job 存储）都必须用 **in-flight promise**；
  job 存储还多一条：**落盘前必须已 `ensureLoaded`**，否则内存里的空表会冲掉盘上数据。
- `edit_file` 守卫是**会话级单例、建在 `registerComputerTools` 的闭包里（`sync()` 之外）**：
  `read_file` 与 `edit_file` 共享「本会话读过哪些文件」的记录（键是**解析后的绝对路径**，
  按会话裁剪、只留最近 16 个会话）。**不要把它挪进 `sync()`**。
  守卫是内核的可注入端口（未注入时不拦截，供单测直接调工具），见 docs/06 §11.6。
- 写前快照顺序**不能换**（v14）：`resolveWithin`（项目根 realpath 前缀校验）→ `capture`
  （把**原内容**存进 `<userData>/backups/<sessionId>/`）→ 真正写盘。换成"先写再备份"就等于"改完才备份"，
  回滚拿不到改动前的内容；主写失败**不回滚快照**（文件可能已被部分改写，那份快照才是唯一退路），
  改成把快照 id 带进错误信息（见 docs/06 §11.8）。
- **SkillsService 的目录监听**（`startWatching`）：改 `skills.userDir` 会走 `reconfigure` → `rearmWatcher`，
  新增监听路径时记得同样处理；create-skill 技能写文件后依赖这个监听自动重扫，**没有任何"刷新"仪式**。
- 网络出网统一走 `apps/desktop/src/main/net.ts` 的 `netFetch`：它优先用 Electron `net.fetch`
  （走 Chromium 网络栈 → 才受 `session.setProxy` 的代理影响），并保留 `globalThis.fetch` 回落。
  新增任何出网调用都要注入它，否则 `advanced.proxy` 对该调用无效。
- `agent-core` / `modes` **不得 import electron**：代理、快捷键、窗口、日志实现全在主进程，
  内核只接受注入（`fetchImpl` / `summarize` / `confirmTool` 都是这个套路）。
