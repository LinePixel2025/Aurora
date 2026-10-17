---
date: 2026-10-17
title: Agent 循环"任务编排"这一层的四条形变约束（并发批次 / 插话注入 / 工具超时 / job 账本）
tags: [agent-core, 循环, 工具, 插话, job, 口径, 坑]
source: 模型自动记录
---

# Agent 循环「任务编排」这一层的四条形变约束

这一轮把 `todo` 之外的**内核任务编排**（工具调用轮次、同轮多工具、运行中用户插话、job 账本）
对齐主流编码代理。四条都是"看着能跑、其实不能"的约束，改这一层之前先读完。

## 1. 同轮工具并发：批次只改起跑时机，绝不改落盘顺序

**现象 / 风险**：把 `for (const call of calls)` 改成并发之后，最容易写的版本是"谁先跑完谁先回填"，
本地看起来正常，真机上模型会报 `assistant(tool_calls)` 与各 `tool` 消息的配对链断裂（网关直接 400），
而渲染层的工具卡顺序会抖。

**原因**：`messages` 数组里 `tool` 消息的**追加顺序**就是回给模型的结果顺序，它与并发完成顺序无关地
必须等于模型写下的调用顺序。

**做法（`packages/agent-core/src/loop/agentLoop.ts`）**：

- `ToolDefinition.parallel` 是**显式 opt-in**，不是按 `sensitivity` 推的类别 —— 只读 ≠ 无副作用，
  `todo_write` 也是 `safe`，但它是整表替换的写，两个并发写会互相顶掉。
- 两道硬闸门在循环里（`isParallelEligible`），不靠声明自觉：① `confirm` 级**永不并发**
  （一次弹两三张确认卡片，用户没法判断"我在批准什么"，比慢一点严重得多）；
  ② 非 `parallel` 的调用是**串行屏障**，后面的调用不越过它提前起跑，
  于是「读 → 写 → 再读同一处」仍严格按模型写下的顺序成立。
- 结构是**两段**：① 整批发 `running` 事件 + 并发跑（进度事件按到达顺序转发，不承诺顺序）；
  ② 严格按原始下标结算（`updateToolCall` → tool 事件 → `append` tool 消息 → 收图片）。
  单条批次走的是与串行时代逐字相同的路径，所以未标 `parallel` 的会话行为零变化。
- **不做跨批次重排**：越过屏障需要"哪些调用互相依赖"的信息，那既不是模型今天会给的，
  也不是能靠工具名猜的。

## 2. 运行中插话：注入点顺序 + `user-message` 事件的归属

**现象**：插话事件如果按**排队那条自己的 requestId** 广播，渲染层会把它整条丢掉 —— 界面上
「排队中」永远不消失。

**原因**：`useChat` 的事件入口有 `if (activeRequest !== null && event.requestId !== activeRequest) return`。
注入发生在**正在跑的那次请求**内部，事件的归属就必须是那个请求；界面那个排队气泡靠既有的
文本对账（`matchUserMessageEcho`）转正，不需要新 id。

**做法**：

- 队列在**内核**（`KernelAgentHost.pending`，按会话隔离、只在内存、不落盘）。渲染层"等跑完再发"
  只是把两条请求排成两个任务，模型永远看不到"用户在任务中途改过口" —— 那才是插话的全部价值。
- 注入点**只有一个**且顺序不能换：`AgentLoopOptions.takePendingInput` 在轮次边界被调用，
  排在 `onRoundComplete`（游标落盘）**之后**、预算判定之后、且**只在确实还会进下一轮**时。
  排在游标之前 → 崩溃续跑会丢掉这条插话；在最后一轮消费 → "消费掉却发不出去"，那句话凭空消失。
- **收尾补发是必需的**（`flushPending` 在 `run()` 的 `finally`）：模型这一轮没再调工具、直接收敛时
  边界从未到来，队列里的话必须另起一次全新请求。少了这一步就是最难查的一类问题 ——
  用户看着气泡发出去了，界面从此再没有任何反应。补发沿用队首那条的 `requestId`
  （`send` 因此接受一个内部 `requestId`，IPC 请求不带）。
- `abort()` **同时清队列**，渲染层把排队气泡收回输入框（两边各清一份，不靠事件回传）；
  否则点完停止会立刻看到新一轮。
- **仍回 `E_BUSY` 的两个入口不是遗漏**：带 `resumeJobId` 的续跑（要对齐 paused 的游标，
  插进正在跑的请求里没有意义）与 `/compact`（不产生回复，没有可插的边界）。
- 取队首前必须做**身份校验** `this.active.get(sessionId)?.requestId === requestId`：
  取消后（active 已删）或取消又立刻重发（active 换了主人）时，还在收尾的旧循环可能越过边界抢走别人的话。

## 3. 工具级超时：只兜真挂起，不抢既有预算

- 默认 `DEFAULT_TOOL_TIMEOUT_MS = 600_000`（10 分钟）；`ToolDefinition.timeoutMs` 覆盖，`0` = 不限。
- **实现是 per-call `AbortController`**，不是把 `options.signal` 直接交给工具：超时只中止这一次调用
  （先 `abort` 再 reject，`run_command` 这类据此杀进程树），外层取消仍照常传导进来。
  超时之后那次调用可能仍在背后拒绝 —— 必须挂 `running.catch(() => undefined)`，否则 unhandledRejection。
- **自带预算的长工具一律不再声明**（`office_render` 120s、`ask_user` 180s、`run_command` ≤300s、
  `generate_image` 120s、`web_fetch` 20s）：两道计时器抢同一次调用只会让归因变模糊。
- `task` 子代理**显式 `timeoutMs: 0`**：它的上限是轮次与取消，按墙钟砍它会误杀正常长任务。
- **没做成设置项**（故不走 `CONFIG_VERSION` 迁移）：这条是故障兜底，不是用户会按任务调的工作量旋钮。
  ⚠️ 本条原文写的「`agent.loop.*` 那三项是用户会按任务调的旋钮」已在**同一天被推翻**，见文末修订。
  这条是故障兜底。

## 4. job 账本：`todos` 曾是死字段，而 UI 一直在渲染它

**现象**：`JobPanel.vue` 从 v15 起就在渲染 `job.todos`（`job.todos.slice(0, TODO_LIMIT)`），
但内核**从来没写过**这个字段 —— 面板那段清单永远显示不出来，而且没有任何报错。

**原因**：`AgentJob.todos` 的形状、落盘、读侧守卫都齐了，唯独缺"谁来填"。文档只写了它是"快照"，
没写生产者。

**做法**：

- 唯一来源是装配层注入的 `KernelAgentHost.jobTodos(sessionId)`（主进程从 `userData/todos/<id>.json` 读，
  与 `todoSummary` 同一份数据的两种形状），每轮随游标写一次。
- 降级口径：端口未注入 / 抛错 → **沿用上一份**并 warn 留痕（一次盘抖动不该抹平时间线）；
  清单被合法清空 → 如实落一次**空表**（"沿用上一份"只用于读失败）。
- `stepsDone` 有上限 `MAX_JOB_STEPS = 200`：job 落盘是**整表重写**，不设上限会让长任务的记录
  随轮次二次方膨胀。丢最早的、留最近的；**`cursor.nextRound` 不受修剪影响**。
- **续跑要把 job 上的 `maxRounds` 刷成当前生效值**：循环读的是新值、job 留的是建档那刻的旧值
  → 面板显示「1 / 1」而实际闸门早已放宽。`budget` 走浅合并补丁，`usedTokens` 不会被顺手清零。
  （原文还包含 `budget.maxTotalTokens`，v34 已随预算一起删除，见文末修订。）
- `AgentJobStatus` 里的 `queued` **仍然不产生**：插话排队是内核内存里的会话队列，不是一条 job
  （给排队的话先建 `queued` job，"注入"那条路径会留下一条永远跑不起来的记录）。

## 5. 验证与用例的口径（这一轮踩到的）

- 排队这类"必须还在跑"的行为，**要用挂起工具把第一条请求按住**：假 provider 全是微任务，
  第一条会在第二次 `send` 之前自己跑完，于是"排队"退化成"顺序发送"，用例看着绿、其实什么都没断言。
- `waitForDone` 这类 helper 的条件是"出现任一 `done` **或** `error`"，而 `E_QUEUE_FULL` / abort
  都会立刻产生一条 `error`/`done` —— 用它等边界注入会**跑在断言之前的时序上拿到假绿/假红**，
  要改用 `waitUntil(具体谓词)`。
- 并发与否的断言只能写**并发计数**（`maxActive`）：断言"看起来快了一点"会随机器负载抖。
- 无 TTY 时 `pnpm vitest` / `pnpm exec prettier` 会先撞
  `[ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY]`，一律加 `--config.verify-deps-before-run=false`。
- 本仓库 `pnpm exec prettier --check` 对全仓有 **37 个文件的历史偏差**（`App.vue` 在 HEAD 就不合规）：
  只格式化自己改过的文件，别顺手 `--write` 全仓。

## 6. 同日修订（v33 → v34）：`agent.loop` 三退一

用户当天判定「轮次上限 / token 预算 / 自动续轮」这三个旋钮本身就不该存在，配置简化为
**只剩 `maxParallelCalls`（1–32，默认 8）**。上面几节里凡提到那三项的地方以此为准：

- **轮次上限回到内核常量** `RUNAWAY_MAX_ROUNDS = 512`：一次请求跑到模型自己收敛。
  「第 32 轮断任务 + 让用户点继续」被判定为错误的修法（主流代理都不这么干），
  但**完全不设墙**也不行 —— 模型偶发会陷入「调用 → 看结果 → 再调用同一个」直到上下文耗尽。
- **`autoContinueRounds` 与 attempt 循环一起删除**：`run()` 里那个 `for (;;)` 只为自动续轮存在。
  ⚠️ 但它守的那条不变量**换人继承了**：`appendUserMessage = false` 的语义前提是
  "提问已在 history 里"，今天只有**手动续跑**会走到它 → 续跑前必须重读会话重算历史，
  否则模型重复已执行的写 / 命令。AGENTS.md 那条硬规则已按新措辞改写。
- **token 只统计不限制**：`AgentJob.budget` 收成 `{ usedTokens }`，`JobPendingReason`
  从三态变两态（`'budget'` 删除）。连带删掉 JobPanel / Center JobCard 的「/ 不限」与
  「已自动续 N 轮」两行 —— 留着一个永远等于 0 的字段就是下一个死口子。
- **子代理不跟主循环共用那道墙**：`SUBAGENT_MAX_ROUNDS = 32` 单独一个常量。
  子代理没有用户盯着、也没有「继续」可点，给它 512 轮等于给它一张失控的信用卡。
- **迁移 `v33 → v34` 是这条链上第一条删字段的**：三个旧值**整体丢弃、不做映射**
  （搬进新字段只会造出没人消费的影子配置）；`agent` / `agent.loop` 缺失时**不造对象**
  （与 v13→v14 等步骤同一约定，否则「缺分组不造对象」那批用例全红）。
- **冒烟怎么造 `paused`**：轮次上限不再是设置项，`set_setting` 式的临时改配置失效 ——
  改用 `AURORA_SMOKE_MAX_ROUNDS` 环境变量（装配处只在 `smokeMode` 下读它）。
  生产不设置 → 常量。**别为了测试往生产配置里加旋钮**。
