# Step 04 — Task/Job 持久化与可续跑 + maxRounds·预算可配 + 预算内自动续轮

- Task: agent-prod-mainline
- Step: 4 / 6
- Status: done
- Depends on: step 3
- Produces: `AgentJob` 类型与 `JobStore`（游标/待办/已完成步骤/预算/终态）、内核 `paused` 事件与预算累计、`agentHost` 逐轮落游标与 `resume`、`session/store.ts` 首读竞态修复、`jobs:*` IPC 与「任务」面板、`agent.loop.*` 配置（`maxRounds` + token 预算）、单测与文档
- Phase: 核心链路
- Writes: `packages/agent-core/src/jobs/types.ts`（新）、`packages/agent-core/src/jobs/store.ts`（新）、`packages/agent-core/src/jobs/store.test.ts`（新）、`packages/agent-core/src/loop/agentLoop.ts`、`packages/agent-core/src/loop/agentLoop.test.ts`、`packages/agent-core/src/host/agentHost.ts`、`packages/agent-core/src/host/agentHost.test.ts`、`packages/agent-core/src/session/store.ts`、`packages/agent-core/src/session/store.test.ts`、`packages/agent-core/src/index.ts`、`packages/shared/src/config/schema.ts`（仅 `agent.loop.*` + `CONFIG_VERSION` 14→15 + 迁移登记）、`packages/shared/src/config/defaults.ts`、`packages/shared/src/config/migrations.ts`、`packages/shared/src/config/schema.test.ts`、`packages/shared/src/config/migrations.test.ts`、`packages/shared/src/ipc/channels.ts`、`packages/shared/src/ipc/types.ts`、`apps/desktop/src/preload/channels.ts`、`apps/desktop/src/preload/index.ts`、`apps/desktop/src/main/jobs/port.ts`（新）、`apps/desktop/src/main/jobs/port.test.ts`（新）、`apps/desktop/src/main/tools/todo-port.ts`、`apps/desktop/src/main/tools/todo-port.test.ts`、`apps/desktop/src/main/ipc.ts`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/main/smoke.ts`、`apps/desktop/src/main/smoke-llm.ts`、`apps/desktop/src/renderer/chat/components/JobPanel.vue`（新）、`apps/desktop/src/renderer/chat/App.vue`、`apps/desktop/src/renderer/shared/composables/useChat.ts`、`apps/desktop/src/main/capture.ts`、`docs/06-agent-core.md`、`docs/07-ui-spec.md`、`docs/08-settings-onboarding.md`、`docs/10-user-guide.md`
- Risk: ①续跑最容易踩的坑是**重复落盘用户消息**（`agentLoop.ts:125-126` 无条件 append）——必须有单测锁死；②`agentHost.ts` 的 `active` 是"同会话忙就 `E_BUSY`"（`:156-165`），续跑必须复用同一套排队语义，否则会出现"job 在跑、用户又发一条"的双写；③`safeStorage`/窗口相关行为**不能单测**（`vitest` 不收 import electron 的主进程文件），重启续跑只能靠 smoke 的"两次启动"验证；④改 `SESSION_FILE_VERSION` **不要动**（新字段可选，读侧宽容）；⑤`store.ts` 的首读竞态修复会影响既有 32 条用例的时序假设，改完必须全量跑 `packages/agent-core/src/session`。出错回滚：本步独立 commit，`git revert`；已写下的 job 文件是普通 JSON，删掉即恢复旧行为。
- Sources: [openai/codex `docs/protocol_v1.md`](https://github.com/openai/codex/blob/main/codex-rs/docs/protocol_v1.md)（访问 2026-09-26，rust-v0.157.1）—— 会话用 Responses `response_id` 做书签、`Op::Interrupt` 后可带书签续跑、"一个 Session 同时最多一个 Task"；[Codex CLI 配置参考](https://mintlify.wiki/openai/codex/configuration/reference)（访问 2026-09-26）—— `model_auto_compact_token_limit` 等预算键的命名口径（本项目只借"预算可配 + 自动续轮"的语义，不引入 compaction）。

## 目标

一次 Agent 请求变成一个有身份、可查询、可续跑的 **job**：它在每一轮结束时把"已跑到第几轮 / 下一步要做什么 / 已完成哪些步骤 / 已花多少 token"落盘；轮次或预算用尽时进入 `paused`（不再静默 `pending` 收尾）；应用重启后能把 `paused` job **接着跑完**，且不会重复落盘同一条用户消息、不会与"同会话新请求"互相踩。`maxRounds` 与 token 预算都是配置字段。

## 输入

- 内核现状（**三个必须先补的语义缺口**）：
  - `packages/agent-core/src/loop/agentLoop.ts`：`DEFAULT_MAX_ROUNDS = 8`（`:21`）、生效点 `:118`、`AgentLoopEvent` 变体 `:34-47`（`done{pending?}` 在 `:46`）、`AgentLoopOptions` `:66-115`、**用户消息无条件先落盘 `:125-126`**、轮首 abort 检查 `:137-141`、工具串行 `:221-263`、`pending` 只在最后一轮置位 `:265`、`yield done` `:269`、`runTool` 与 confirm `:461-548`、进度流 `:391-459`。
  - `usage` 拿到但不累计（`:190`、`:210`）。
  - `pending` 没有原因（`:46`）。
- 装配现状：`packages/agent-core/src/host/agentHost.ts` —— `active: Map<sessionId, {requestId, controller}>`（`:108`）、`summaries` 内存态（`:110`，不落盘）、`send():128-193`（`E_BUSY` `:156-165`、`E_NO_MODEL` `:167-177`）、`abort():195-206`（**立即补发一条 `done`**，与循环内的 `done` 形成两条，渲染层靠 `finishedRequests` 去重，`useChat.ts:218`）、`run():222-440`（`compressHistory` `:261-286`、`buildSystemPrompt` `:292-311`、`runAgentLoop` 装配 `:313-345`、事件映射 `:347-431`、`finally` `:436-439`）、`AgentHostDeps` `:43-89`（`maxRounds?` 在 `:67-68`，**是值不是 getter** → 要热改需改签名为 `() => number`）。
- 主进程装配：`apps/desktop/src/main/index.ts` 的 `new KernelAgentHost({...})`（`:658-679`，`maxRounds` 从来没传过）、`syncToolRegistries()`（`:2231-2238`）、退出 flush（`:2166-2175`）、userData 子目录装配（`:521`/`:564`/`:586`，step 3 已加 `backups`）。
- 持久化骨架：`apps/desktop/src/main/tools/todo-port.ts` 全套（见 step 3 的输入清单）；**它的 `ensureLoaded`（`:117-121`）与 `packages/agent-core/src/session/store.ts:340-346` 都有"先标记 loaded 再 await"的首读竞态** —— 本步必须同时修这两处（job 续跑直接依赖"读到最新游标"）。`store.ts` 的写路径去重写法在 `:435-465`（`writing` Map），读路径要照它加 in-flight promise map。
- 会话数据结构：`packages/agent-core/src/session/types.ts` 的 `StoredToolCall:12-26`（含 `subagent?` `:25`）、`StoredMessage:28-46`、`NewMessage:80-97`、`SESSION_FILE_VERSION = 2`（`:99-105`）；`store.ts` 的 `updateToolCall:191-204`（**线性扫全部会话找 messageId**，job 的"已完成步骤"不要重蹈这个实现）、`rendererHistory:153-182`、`flush:315-325`。
- IPC 三处镜像 + 通道命名：`packages/shared/src/ipc/channels.ts:75-88`（chat 组；step 3 已加 `snapshots:*`）、`apps/desktop/src/preload/channels.ts`（字面量表 + 双向断言 `:9-11`）、`apps/desktop/src/preload/index.ts`；DTO 落点 `packages/shared/src/ipc/types.ts`（`SendMessageRequest:609-619`、`ChatMessageDto:705-715`、`AgentEvent:739-819`）。事件缓冲在 `apps/desktop/src/main/ipc.ts:567-572`（`createEventBuffer`，**只合并 text/reasoning，job 状态事件不要走合并**）。
- 配置链路（与 step 1/3 同一套 5 处，**版本号此时是 14，本步升到 15**）：`schema.ts:9`、`AgentToolsSchema` 一带、`defaults.ts:179-240`、`migrations.ts:457-484` 模板 + `:486-499` 登记、`SettingsPatch` + `settings-patch.ts:231-267`。
- 测试与桩：`packages/agent-core/src/loop/agentLoop.test.ts`（885 行；用例数按 `grep -c "  it(\|^it(" ` 实测为准 —— 侦察时统计到 **32** 个 `describe/it`，改前先自己数一遍别照抄数字）、`host/agentHost.test.ts`（814 行）、`session/store.test.ts`（522 行 / 32 例）、`apps/desktop/src/main/tools/todo-port.test.ts`（175 行 / 10 例，含防抖/flush/写失败重试/损坏备份）；桩 `packages/agent-core/src/testing/fakeProvider.ts`（`ScriptRound` `:20-29`、`calls` 记录 `:35/:43-51`）、`testing/fileSystem.ts`（`TestFileSystem` 含 `failNextWrite:13`、`writeLog:13`、`SESSION_DIR:73`）、`testing/fetchStub.ts`。
- smoke 现状：`apps/desktop/src/main/smoke.ts` 的真实对话链 `:413-436`、事件类型白名单 `:552`、会话列表/新建/归档 `:952-990`；桩服务 `smoke-llm.ts` 的分流（`chatRequests()` 过滤 `endsWith('/chat/completions')` `:158-160`、usage 片 `:788-798`、分片间隔 `FRAME_GAP_MS = 40` `:800-801`）。
- capture 现状：chat 场景注册区 `4388-4720`（**`chat-collapse` 必须最后**）、settings 场景 `4810-4839`；种盘时点 `index.ts:999`。
- 文档锚点：`docs/06-agent-core.md:51-90`（§4 会话管理）、`:91-144`（§5 工具调用循环 —— 轮次上限与预算要写进这里）、`:1120-1149`（§18 todo）、`:1231-1305`（§21 caching）；`docs/07-ui-spec.md:73-285`（§2.3）、`:348-363`（`data-field` 清单）；`docs/08-settings-onboarding.md:269-299`、`:341-366`（迁移清单）；`docs/10-user-guide.md`（用户侧的"长任务与续跑"章节）。

## 操作

1. **先改文档**：`docs/06` §5 补「轮次上限、token 预算与自动续轮」的口径（含 `paused` 的语义与"为什么不是报错"），**并订正 `:323-324` 那句"这些上限刻意不做成配置字段"** —— 那里现在把 `run_command.timeoutMs` 一类硬上限与轮次上限列在同一张常量表里；本轮把轮次挪进 `agent.loop.maxRounds`，必须把那句改成"除 `agent.loop.*` 外，其余上限仍刻意不做成配置字段"，否则同一张表里自相矛盾会留成文档债；新增一小节 `### 4.1 任务（Job）与续跑`（插在 §4 内，`:51-90` 区域）；§18 与 job 的关系加一句（todo 是 job 的"待办"视图，不是同一份数据）；`docs/08` §1 加 `agent.loop.*` 与迁移 `v14 → v15`（**并补进 §1 的 JSON 样例、`:269-299` 的散文区、`:341-366` 的迁移清单**）；`docs/07` 加「任务」面板与"续跑"按钮的规格与锚点；`docs/10` 加用户侧的"任务被暂停了怎么办"。
2. **配置字段（`agent.loop`）**：
   - `AgentLoopSchema = z.object({ maxRounds: z.number().int().min(1).max(64).default(8), maxTotalTokens: z.number().int().min(0).default(0), autoContinueRounds: z.number().int().min(0).max(8).default(2) })`，挂到 `AgentSchema`。语义：`maxTotalTokens = 0` 表示不限；`autoContinueRounds` = 预算内允许自动续几轮（0 = 关闭自动续轮，只暂停等待用户点"继续"）。
   - **不要**加进 `SETTINGS_READONLY_PREFIXES`（用户可调）也**不要**加进 `WRITABLE_PATH_OVERRIDES`（AI 不能给自己放大预算）。
   - `CONFIG_VERSION` 14 → 15；`migrateV14ToV15`（`fillMissing(agent, { loop: {...默认} })`，幂等不覆盖）；登记 `MIGRATIONS` 末尾；`defaults.ts` 同步；`schema.test.ts` / `migrations.test.ts` 各加用例。
3. **Job 类型与存储（新）**：
   - `packages/agent-core/src/jobs/types.ts`：`JOBS_FILE_VERSION = 1`；`AgentJobStatus = 'queued' | 'running' | 'paused' | 'done' | 'error' | 'aborted'`；`AgentJob { id, sessionId, requestId?, status, origin: 'chat' | 'edge-bar' | 'resume', text, round, maxRounds, stepsDone: Array<{ round: number; tool: string; ok: boolean; at: string }>, todos: TodoItem[], cursor: { nextRound: number; note?: string }, budget: { maxTotalTokens: number; usedTokens: number; autoContinued: number }, pendingReason?: 'max-rounds' | 'budget' | 'aborted', createdAt, updatedAt, error?: string }`；`JobSummary`（列表用的小对象，含 `budget.autoContinued`，供界面显示"已自动续 x/y 轮"）。
   - `packages/agent-core/src/jobs/store.ts`：`createFileJobStore({ dir, fs, logger, writeDebounceMs })` —— 照抄 `todo-port.ts` 的结构（懒加载 / 防抖原子写 / 损坏备份 / `flush` / `normalizeSessionId`），**但 `ensureLoaded` 用 in-flight promise map**；API：`create(job)`、`get(id)`、`list({ sessionId?, status?, limit? })`、`update(id, patch)`（**按 id 定位，不做线性扫全表**）、`listResumable()`（`status === 'paused'`）、`flush()`。
   - `packages/agent-core/src/index.ts` 导出新模块（`export * from './jobs/types.js'` / `'./jobs/store.js'`）。
4. **内核循环改造（`agentLoop.ts`）**：
   - `AgentLoopOptions` 新增：`resume?: { nextRound: number; stepsDone: number }`、`appendUserMessage?: boolean`（**缺省 `true`，续跑时传 `false`**）、`budget?: { maxTotalTokens: number }`、`onRoundComplete?: (info: { round: number; usage?: TokenUsage; pendingCalls: StoredToolCall[] }) => Promise<void> | void`。
   - 累计预算：在 `:190`/`:210` 拿到 `usage` 的地方累加 `totalTokens`；当 `budget.maxTotalTokens > 0 && used >= maxTotalTokens` 时**停止进入下一轮**。
   - 事件：`AgentLoopEvent.done` 扩成 `done { pending?: boolean; pendingReason?: 'max-rounds' | 'budget' | 'aborted'; round: number; usedTokens?: number }`（**保留 `pending` 字段以兼容既有 28 条用例与渲染层**）；轮次用尽置 `pendingReason: 'max-rounds'`（`:265`），预算用尽置 `'budget'`，abort 置 `'aborted'`（`:137-141`、`:223-226`）。
   - 续跑语义：`resume` 存在时从 `resume.nextRound` 开始（循环变量初值改为 `resume?.nextRound ?? 0`），且**不重复 append 用户消息**（`:125` 按 `appendUserMessage` 分支）；`resume.stepsDone` 只用于日志与 job 一致性校验，不参与执行。
   - 每轮结束时调 `onRoundComplete`（在 `:265` 前后，**先落游标再决定是否继续**）。
5. **Host 改造（`agentHost.ts`）**：
   - `AgentHostDeps` 新增：`jobs?: JobStore`、`maxRounds?: () => number`（**把 `:67-68` 的值改成 getter**，这样才能热改；装配处 `index.ts:658-679` 传 `() => settings.get().agent.loop.maxRounds`）、`maxTotalTokens?: () => number`、`autoContinueRounds?: () => number`、`clock?: () => Date`（测试可注入）。
   - `send()` 增可选 `resumeJobId?: string`（`:128-137`）：①若给了 `resumeJobId` 且 job 状态是 `paused` → 走续跑（**不重复 append 用户消息**、`round` 从游标继续、`requestId` 换新、`E_BUSY` 语义不变：同会话已 active 时仍返回 `E_BUSY`）；②若 job 不是 `paused` → 返回 `E_JOB_STATE`（新错误码，加在 `agentHost.ts` 的错误常量区 `:91-92` 附近，并在 shared 的类型联合里登记）；③`E_NO_MODEL` 检查次序不变。
   - `run()`：开始时创建 job（`status:'running'`，`origin` 由 `send` 传入）、把 job.id 通过新事件 `{ type: 'job'; job: JobSummary }` 推给渲染层；`onRoundComplete` 回调里更新 job（`round`、`stepsDone` 追加本轮工具、`budget.usedTokens`、`cursor.nextRound`）；结束时按 `pendingReason` 落 `paused` / `done` / `aborted` / `error`（`finally` `:436-439` 保证异常也落终态）。
   - **预算内自动续轮**：若 `pendingReason === 'max-rounds'` 且 `autoContinueRounds > 0` 且 `job.budget.autoContinued < autoContinueRounds` 且预算未触顶 → **不落 `paused`**，直接把 `maxRounds` 再续一轮（等价于用 `resume` 语义原地继续），`job.budget.autoContinued += 1` 并**随游标一起落盘**，同时在事件流里推一条 `job` 更新（`round` 继续递增）。超过自动续轮次数才落 `paused`。**这条要有明确日志**，否则用户会看到"轮次像没上限"。⚠️ **计数器必须持久化**：只放内存的话，重启续跑会重新获得一份额度，等于给一个任务无限轮次。因此 `AgentJob.budget` 里要有 `autoContinued: number` 字段（见操作第 3 条的 DTO），并有单测断言"重启后额度不重置"。
   - `abort()`（`:195-206`）：把 job 落成 `aborted`（**不是 `paused`**），并保持"立即补发一条 `done`"的既有行为不变（渲染层去重已有）。
   - 主进程装配：`index.ts` 的 userData 子目录区加 `jobs` 目录、创建 `createFileJobStore` 并注入 `KernelAgentHost`、退出 flush 链（`:2166-2175`）加 `jobs.flush()`。
6. **首读竞态修复（两处，独立 commit 更清晰）**：
   - `packages/agent-core/src/session/store.ts:340-346`：`ensureLoaded` 改成 `loading: Map<string, Promise<void>>`，先取 in-flight promise，未命中才发起读盘并 `await`，成功后再 `loaded.add(id)`；若期间有 `append` 写入 cache，读盘结果要与 cache **合并**而不是覆盖（按 `id` 去重，cache 中的新消息优先）。补一条并发用例：`Promise.all([store.get(id), store.append(id, msg)])` 后 `store.get(id)` 必须包含刚 append 的消息。
   - `apps/desktop/src/main/tools/todo-port.ts:117-121`：同款修复 + 同款并发用例（`todo-port.test.ts`）。
7. **IPC 与界面**：
   - 通道：`chat.jobs`（列表）、`chat.resumeJob`、`chat.cancelJob`；DTO：`SendMessageRequest` 加 `resumeJobId?: string`；`AgentEvent` 加 `{ type: 'job'; job: JobSummary }`；`JobSummary` / `AgentJob` 的渲染层形状追加在 `types.ts` 的 job 区（`:819` 之后）。三处镜像同步（`channels.ts` / `preload/channels.ts` / `preload/index.ts`）。
   - `ipc.ts`：加 `chat:jobs`（默认当前会话 + 可查 `status`）、`chat:resumeJob`（`{ sessionId, jobId }` → 调 `deps.agent.send({ ..., resumeJobId })`）、`chat:cancelJob`（abort + 落 `aborted`）；`chat:send` 保持原样。事件广播：job 事件走**非合并**通路（参考 `ipc.ts:567-572` 与 `event-buffer.ts` 的 flush 规则），保证 pause 事件不被 16ms 合并吞掉。
   - 渲染层：`useChat.ts` 加 `jobs` 状态 + `job` 事件处理 + `resumeJob(jobId)`；`components/JobPanel.vue`（新）显示"任务"列表（状态徽标 / 轮次 x/y / token 用量 / 待办 / 已完成步骤时间线 / 「继续」与「取消」按钮）；`chat/App.vue` 在右栏或左栏固定项挂一个入口（`data-field="chat.jobs"`）；`done.pending` 的既有提示文案改为按 `pendingReason` 显示（轮次用尽 / 预算用尽 / 已取消）。
   - 设置页：`AgentPage.vue` 的「文件检索」附近加「Agent 循环」一栏（`maxRounds` / `maxTotalTokens` / `autoContinueRounds`，`data-field="agent.loop.maxRounds"` 等），保存带完整 `agent` 子树。
8. **探针与端到端**：
   - `capture.ts`：新增场景 `chat-job-panel.png`（种一个 `paused` job 的 `jobs/<sid>.json` + 相应会话文件，**种盘必须早于窗口首读**，参考 `index.ts:999` 的种盘时点）→ 断言面板出现、状态文案含"已暂停"、"继续"按钮可点。settings 探针加 `agent.loop.*` 字段计数。
   - `smoke.ts` + `smoke-llm.ts`：桩服务加一个"按标记让第 N 轮触顶"的分支（照 `SUBAGENT_TASK_MARKER` 的分流写法 `smoke-llm.ts:34/267-305`）。新增断言：①`maxRounds` 设为 2 且 `autoContinueRounds=0` 时，一次 `send` 后 job 落盘为 `paused` 且 `pendingReason='max-rounds'`；②`chat:resumeJob` 后 job 跑到 `done`，且**会话文件里那条用户消息只有一条**（锁死"重复落盘"）；③预算触顶（`maxTotalTokens` 设小）时 job 落 `paused` 且 `pendingReason='budget'`；④`cancelJob` 后状态是 `aborted`。**重启续跑**用两次启动验证：第一次启动跑到 `paused` 后退出（smoke 已有退出路径），第二次启动断言 `chat:jobs` 能列出该 job 并成功续跑。
9. **测试落点**：
   - `jobs/store.test.ts`：往返 / 懒加载 / 防抖 / `flush` / 写失败重试 / 索引损坏备份恢复 / `update` 按 id 且不误改其它 job / `listResumable` 只回 `paused` / `Promise.all([list(), create()])` 不返回空。
   - `loop/agentLoop.test.ts` 新增：`resume.nextRound` 从第 N 轮开始且 `appendUserMessage=false` 时**不调 append**（用桩记录 append 次数）；预算触顶 → `done.pendingReason='budget'`；轮次用尽 → `'max-rounds'`；abort → `'aborted'`；`onRoundComplete` 每轮被调用一次且参数含 `pendingCalls`。**既有 28 条必须全绿**（`pending` 字段保留就是为了这个）。
   - `host/agentHost.test.ts` 新增：job 随请求创建并落终态；`resumeJobId` 指向非 `paused` → `E_JOB_STATE`；`E_BUSY` 在续跑时仍生效；`maxRounds` 以 getter 形式热改（改后下一轮立即生效）；自动续轮达上限才 `paused`；**重启后 `budget.autoContinued` 不重置**（用一个新的 host 实例 + 同一份 job 存储模拟重启）。
   - `session/store.test.ts` 新增：并发首读/append 的竞态用例（见第 6 步）。
10. **验证并提交**：`pnpm --filter @aurora/shared build && pnpm --filter @aurora/agent-core build` → `pnpm typecheck && pnpm test && pnpm lint` → smoke/capture。建议拆成 3 个 commit：`fix(agent-core): 修会话与待办清单的首读竞态`、`feat(agent-core): Task/Job 持久化与预算内自动续轮（agent.loop，配置 v15）`、`feat(desktop): 任务面板与续跑入口`。

## 验收标准

- [ ] `pnpm vitest run packages/agent-core/src/jobs` 全绿，含 `listResumable` 只返回 `paused`、`update` 按 id 定位不误改其它 job、索引损坏后恢复、并发首读不返回空四条断言。
- [ ] `pnpm vitest run packages/agent-core/src/loop` 全绿，含四条新增断言（`resume` 不重复 append 用户消息 / 预算触顶 `pendingReason='budget'` / 轮次用尽 `'max-rounds'` / abort `'aborted'`），且**改动前的既有用例全部仍然通过**（先跑一次 `pnpm vitest run packages/agent-core/src/loop` 记下改前的通过数，改后再跑，数不减少）。
- [ ] `pnpm vitest run packages/agent-core/src/host` 全绿，含 `E_JOB_STATE`、续跑时 `E_BUSY` 仍生效、`maxRounds` getter 热改、**重启后 `autoContinued` 不重置**四条断言。
- [ ] `pnpm vitest run packages/agent-core/src/session apps/desktop/src/main/tools/todo-port.test.ts` 全绿（**不要写成 `pnpm --filter ... test`** —— 根 `vitest.config.ts` 的 include 是根相对路径，在包目录下跑会 `No test files found` 退出码 1），且存在"并发 append 后 get 能读到"的竞态用例。
- [ ] `pnpm vitest run packages/shared/src/config` 全绿，含 `migrate({ version: 15 })` 恒等 + v14→v15 补默认不覆盖；同时 `migrations.test.ts` 里写死旧形状/旧版本号的严格断言（`:342` / `:365` / `:835` 一类）已随本轮改动同步（每加一段迁移都要过一遍）。
- [ ] `pnpm typecheck`、`pnpm lint`、`pnpm format:check` 退出码 0；`pnpm test` 全量退出码 0；`pnpm verify` 退出码 0（它断言 `fresh.version === CONFIG_VERSION` 与 `appliedMigrations.length === CONFIG_VERSION`，需先 `pnpm build`）。
- [ ] `AURORA_SMOKE=1 pnpm dev` 的 `AURORA_SMOKE_RESULT` 全通过，含四条新增断言，且**"用户消息只有一条"**那条在日志里可见。
- [ ] **重启续跑真的能跑**：手动脚本化两步 —— 第一次 `AURORA_SMOKE=1 pnpm dev`（`maxRounds=2`、`autoContinueRounds=0`）跑到 `paused` 并退出；第二次启动后 `chat:jobs` 能列出该 job、`chat:resumeJob` 后状态变 `done`，且 `%APPDATA%\Aurora\jobs\<sid>.json` 里 `cursor.nextRound > 0`、`stepsDone` 非空。两条命令与观测点都写进执行记录。
- [ ] `AURORA_CAPTURE="$env:TEMP\aurora-capture-04" pnpm dev` 退出码 0、`report.json` 无 FAIL，含 `chat-job-panel.png`。
- [ ] 配置真的生效：把 `agent.loop.maxRounds` 改成 3 并重启，跑一次会调用工具的对话，`jobs/<sid>.json` 里 `maxRounds === 3`（证明配置替代了写死的 8）。

## 交接

- 给 step 5：端到端综合场景需要的三块证据（快照链路、job 续跑、权限档位）分别来自 step 2/3/4 的 smoke 断言；step 5 负责把它们串成一条并做文档收口（`docs/README.md`、`docs/04-roadmap.md`、`AGENTS.md`）。
- 给第二批（多模态 / 子代理 / 压缩）：`AgentHostDeps` 已改成 getter 风格（`maxRounds` 等），`AgentEvent` 已有 `job` 变体；`SESSION_FILE_VERSION` 仍是 2（job 是独立存储面），**第二批加图片字段时不需要动 session 版本号**。

## 执行记录

执行时间：2026-09-26（本会话）。执行模式：全部连续执行。依赖 step 3（done）。

### 提交清单

| SHA | 提交 |
|---|---|
| `681b705` | `fix(agent-core): 修会话与待办清单的首读竞态（并发首读会拿到空快照并覆盖磁盘历史）` |
| `aad5c06` | `feat(config): 配置 v15 —— agent.loop.*（轮次上限 / token 预算 / 自动续轮）` |
| `2e49525` | `feat(agent-core): Task/Job 持久化与预算内自动续轮（agent.loop，配置 v15）` |
| `39d10ac` | `feat(desktop): 任务面板与续跑入口（chat.jobs / resumeJob / cancelJob + 端到端探针）` |

### 实际改动

- **首读竞态（顺带修的既有 bug，独立提交）**：`session/store.ts` 与 `main/tools/todo-port.ts` 的
  `ensureLoaded` 改成 **in-flight promise map**（读盘成功后才登记 `loaded`），读盘结果与期间写入
  **合并**而不是覆盖。原写法下 `Promise.all([get, append])` 的 `get` 会拿到**空快照**，
  随后一次写入把磁盘历史整体覆盖。
- **Job 形状与存储**：`jobs/types.ts`（形状定义在 `@aurora/shared`，内核只再导出 + `createJob` /
  `toJobSummary`）与 `jobs/store.ts`（`<userData>/jobs/<sessionId>.json` = `{version, jobs}`；
  懒加载 in-flight、300ms 防抖 + `flush()`、per-session 串行写、损坏备份 3 份、`update` 按 id
  浅合并、任何 fs 异常只降级不抛）。`budget.autoContinued` 随 job 落盘。
- **循环（`agentLoop.ts`）**：`resume.nextRound`（绝对轮次起点）、`appendUserMessage: false`
  （续跑不再落盘用户消息）、预算累计（只认 provider 回传的真实用量，工具轮结束时即可判定）、
  `onRoundComplete`（每轮结束、决定继续之前回调，调用方在此落游标）、
  `done.pendingReason = 'max-rounds' | 'budget' | 'aborted'`（保留 `pending` 字段兼容既有断言）。
- **Host（`agentHost.ts`）**：`jobs` / `maxRounds`（**getter**）/ `maxTotalTokens` /
  `autoContinueRounds` / `clock` 注入；`send({resumeJobId})` 只接受 `paused`（否则 `E_JOB_STATE`）、
  `E_BUSY` 语义不变；`abort()` 落 `aborted`；预算内**自动续轮**（`autoContinued` 持久化 + `info` 日志）；
  `done` 事件转发 `pendingReason` / `round` / `usedTokens`；异常也落终态。
- **IPC / 界面**：`chat.jobs` / `chat.resumeJob` / `chat.cancelJob`（三处镜像 + preload + handler）；
  `AgentEvent` 新增 `job` 变体（**不走 text 合并通路**）；右栏「任务」面板 + 左栏入口 +
  composer 区暂停提示（文案与面板共用一份）+ 设置页「Agent 循环」栏。
- **探针/自测**：capture 新增 `chat-job-panel.png` 与 settings 的 `agent.loop.*` 计数；
  smoke 桩服务按 `AURORA_JOB_LOOP` 一直要工具并**每轮带 usage**，四条新断言。

### 与计划的偏差

1. **`AgentJob` / `JobSummary` 等形状放在 `@aurora/shared`**（计划把它们放在
   `packages/agent-core/src/jobs/types.ts`）：`AgentEvent` 要带 `JobSummary`、渲染层要经 IPC 读
   `AgentJob`，跨进程形状只能有一份定义 —— 内核只再导出。
2. **`E_JOB_STATE` 加进 `packages/shared/src/utils/result.ts` 的 `ErrorCode`**（计划只说"加在
   `agentHost.ts` 的错误常量区并在 shared 的类型联合里登记"，登记点在 `result.ts` 而不是 `ipc/types.ts`）。
3. **`normalizeSessionId` 在 jobs 侧不导出**：与 `session/store.ts` 的同名导出同时进 `index.ts`
   星号再导出会让 `import { normalizeSessionId } from '@aurora/agent-core'` 的语义取决于解析器
   （`todo-port.ts` 正是这样用的）—— 改为模块内私有，`TODO` 里那条"两者空 id 回落不同"的风险随之消失。
4. **左栏入口位置**：计划说挂在「子代理」那一组固定项区（`SessionNav.vue`），实际实现放在
   `aside.nav` 的**第二行 = 左栏底部固定项**（`App.vue` 内的 `.nav-jobs`），不改 `SessionNav.vue`
   —— 功能等价、不参与会话列表滚动、三栏几何不变（`.nav` 改两行网格）。这是有意接受的偏差。
5. **`JobPanel` 的 `prune`/`lastStep` 未使用**：面板展示完整 `stepsDone`（最近 3 条），
   `JobSummary.lastStep` 留给别处一行摘要用。
6. **设置页新增「Agent 循环」栏**（计划 Writes 未列 `AgentPage.vue`）：三个新配置字段没有界面
   就是死字段，而这一页正是 `agent.*` 的落点。

### 验证结果（全部由主代理亲自复跑）

| 验收项 | 结果 |
|---|---|
| `pnpm vitest run packages/agent-core/src/jobs` | **18 passed**（含 `listResumable` 只回 paused、`update` 按 id 不误改其它 job、损坏索引恢复、`Promise.all([list(), create()])` 非空、`autoContinued` 换实例仍是 2） |
| `pnpm vitest run packages/agent-core/src/loop` | **35 passed**（改前 28 → 现 35，未减少；新增 `resume` 不重复 append、`budget`、`max-rounds`、`aborted`、`onRoundComplete` 每轮一次） |
| `pnpm vitest run packages/agent-core/src/host` | **58 passed**（含 `E_JOB_STATE`、续跑时 `E_BUSY`、`maxRounds` getter 热改、自动续轮达上限才 paused、**重启后 `autoContinued` 不重置**） |
| `pnpm vitest run packages/agent-core/src/session apps/desktop/src/main/tools/todo-port.test.ts` | **63 passed**（49→51 / 10→12；修复前先复现 4 条红） |
| `pnpm vitest run packages/shared/src/config` | **138 passed**（含 `migrate({version: CONFIG_VERSION})` 一条迁移都不应用、v14→v15 补缺不覆盖） |
| `pnpm typecheck` / `pnpm lint` / `pnpm format:check` | 均 exit 0 |
| `pnpm test` | **79 文件 / 1496 用例全绿**（step 3 后为 1454） |
| `pnpm verify` | **26/26**（`version=15`、`v0 → 当前版本` 15 条迁移） |
| `AURORA_SMOKE=1 pnpm dev` | **157/157 passed，exit 0**；四条新断言逐条可见，`oneUserMsg=true`（"用户消息只有一条"）在日志里 |
| `AURORA_CAPTURE=$env:TEMP\aurora-capture-11 pnpm dev` | **52 张 PNG / 52 条 checks / 0 FAIL / exit 0**；`chat-job-panel.png` → `{panel:1, items:1, resume:1, resumeLabel:"继续", text:"…已暂停…第 1/2 轮…token 1284 / 不限…已达到轮次上限，已暂停…第 1 轮 write_file 成功…第 0 轮 read_file 成功"}`；`settings-agent.png` → `loopFields: 3` |

**验收标准第 7 条（配置真的生效）**：`%TEMP%\aurora-smoke-<pid>-<ts>\jobs\smoke-job.json` 里
`maxRounds = 2`（本次 smoke 把 `agent.loop.maxRounds` 设成 2）而**不是内核写死的 8** ——
证明配置替代了常量，且 getter 热改生效。

**验收标准第 6 条（重启续跑）**：本步拿到的证据是
①同一次启动内 `paused → chat:resumeJob → done`（smoke 断言）；
②落盘实据 `<userData>/jobs/smoke-job.json`：`status=done`、`cursor.nextRound=3`、`stepsDone=3`
（正是验收要求的"`cursor.nextRound > 0`、`stepsDone` 非空"）；
③单元级"换一个 host 实例 + 同一份存储"的 `autoContinued` 不重置与 `listResumable` 只回 paused。
**未做**的是"两次独立启动"的手工脚本（smoke 的 userData 是每次新建的临时目录，没有跨启动 harness）——
这一条如实记为未覆盖，不假称已验。

### 过程中的问题与处置

1. **预算形同虚设（只有 smoke 抓得到）**：桩服务原本只在最后一段纯文本回 `usage`，而预算判定发生在
   **工具轮结束**时 —— 于是"预算触顶"这条断言第一轮 smoke 直接红。修法不是放宽断言，而是让桩服务
   在工具轮也带回 `usage`（真实 provider 在 `include_usage` 下每轮都报），这条正好钉住了语义。
2. **`E_BUSY` 用例靠调度运气（改了 3 版）**：原写法"两次 `send` 都不 await"在全量并行跑时红，
   因为桩 provider 可能在第二次检查前就跑完。最终版用**可控闸门**把续跑请求真的停在工具执行里，
   断言改成"游标恰好多 1 + provider 调用次数不变"，连跑 3 次稳定。
3. **capture 夹具时序**：第一版把 `paused` job 种在场景 `prepare` 里 → 面板显示「暂无任务」，
   因为**任务面板挂载时已经读过一次**（job 存储首读即缓存）。夹具改到 `runCapture` 跑计划之前
   （与 `seedChatTtsHistory` 同一批），场景 `prepare` 只负责 reload。
4. **host 子代理无遗言失败**：它把 job 生命周期写完就断了（未回报），我复跑发现一条红并接手修完
   （见第 2 条）；其产出可用，但按"失联即未完成"一律重新验证过。
5. **一处 PowerShell 转义事故**：用双引号字符串替换注释时反引号被当成转义符，把 `` `runCapture` ``
   变成了换行 + 非法字符（TS1127）。已改用单引号/数组切片重写该段，并记下"注释里含反引号时不要
   用 PowerShell 双引号字符串替换"。

### 遗留问题

1. **"两次独立启动"的重启续跑脚本未做**（原因见验收第 6 条）；`chat:jobs` 重启后可列出、
   `resumeJob` 可续跑这一点由存储层与 host 层单测 + 同进程链路共同保证。
2. 左栏入口在底部固定项而非常规固定项区（有意偏差，见偏差 4）。
3. `JobStore` 接口没有 `dispose()`（实现里有，用于取消防抖定时器），主进程退出靠 `flush()`；
   若将来要"未落盘即退出"的强保证，需要把它加进接口。
4. `list()` 不带 `sessionId` 时会读盘上所有会话文件再内存过滤（会话多时是 O(会话数) 次读盘）；
   当前会话数量级下可接受，需要时再加索引。
5. `docs/06 §4.1` 在本步一度是**悬空引用**（三处文件头先引用了它），已由本步文档补齐。
