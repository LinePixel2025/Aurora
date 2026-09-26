# 06 · Agent 内核设计

状态：`已定稿`（v1 基线；P3 已完成——会话 / 工具循环 / Skill 执行 / MCP 客户端均已落地，
"已定稿"指设计不变，实现细节见各节标注的 v1 / P3 范围）。
2026-09 工具面扩充：电脑操控工具 5 → **8** 个（新增 `edit_file` / `grep` / `glob`，见 §11.5 / §11.6），
`run_command` 新增免确认模式列表（§11.7），系统提示词改为「静态在前、易变在后」并补上
prompt caching 的前缀稳定化与命中观测口径（§21）。

## 1. 目标

**可感知**（系统状态进上下文）、**可扩展**（Skill / MCP）、**可测试**（纯 Node，不依赖 Electron / DOM）。

## 2. 分层

| 层 | 职责 | 模块 |
|---|---|---|
| 提供者层 | 模型接入与流式输出 | `llm` |
| 会话层 | 消息历史、多窗口会话、持久化 | `session` |
| 执行层 | 工具调用循环 | `loop` |
| 能力层 | Skill、MCP 工具 | `skills`、`mcp` |
| 感知层 | 系统状态采集（主进程实现，内核消费） | `perception` |
| 编排层 | 上下文组装、主动引导 | `context`、`proactive` |

## 3. LLM 提供者

```ts
export interface LlmProvider {
  id: string;
  chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent>; // 流式
  listModels?(): Promise<ModelInfo[]>;
  testConnection(): Promise<TestResult>;
}
```

- 默认实现 `OpenAiCompatProvider`：`baseURL + apiKey + model`，兼容 DeepSeek / OpenAI / Ollama / vLLM 等（见 ADR-003）。
- 设置中可保存多组模型配置并切换默认；temperature 等参数可调。
  （「会话级可选模型」目前**没有实现**：每个 provider 只有一个生效的 `model`，也不做按会话覆盖
  —— 见 07 §2.3。另有一份候选列表 `llm.providers.<id>.modelList` 只决定 UI 里能选什么，
  对话窗选模型写回的就是 `model` 本身，内核侧只认 `model`，见 08 §1/§5。）
- 可靠性：指数退避重试、单请求超时（默认 60s）、流式中断可取消（AbortSignal 贯穿到 IPC）。
- `ChatRequest.reasoningEffort` 由 `llm.providers.<id>.reasoningEffort` 驱动，取值
  `auto | low | medium | high`；`auto`（默认）时**不下发** `reasoning_effort` 字段。
  设置页「AI 模型」的高级参数与对话窗输入区的「思考」下拉**两处入口写的是同一个字段，
  没有第二份来源**（也不做按会话覆盖）：改哪一处，下一次请求都按新值下发。
  **已知取舍**：思考等级存在 **provider 级**，因此作用于当前 provider 下的**所有模型** ——
  对话窗的「模型」下拉（`chat.model`，选项来自 `llm.providers.<id>.modelList`）只切模型、
  **不切思考等级**。将来若要按模型区分，需要把它扩展成**模型级映射**
  （例如 `llm.providers.<id>.effortByModel: Record<modelId, 'auto' | 'low' | 'medium' | 'high'>`），
  当前 Schema 与 UI 都不支持；在那之前，不要假定「切了模型就换了等级」。

## 4. 会话管理

- 会话划分（v1）：**快速会话**（交互窗侧栏「快速」栏）× 1，**完整会话**（AI 交互窗口）× 1，
  设置引导会话复用完整会话窗口。快速会话与完整交互窗**共用同一个窗口**，靠交互窗侧栏
  （「快速 / 会话」双栏）切换；独立小窗已删除，后续可扩展多会话列表。
- 会话 id 由显式对话上下文映射（`main` / `quick` / `settings`，`useChat(windowName, context)`），
  仅允许 `[A-Za-z0-9_-]`；非法值归一为 `settings`（防路径穿越）。
- 持久化：`userData/sessions/<sessionId>.json`（含工具消息），结构
  `{ version, sessionId, updatedAt, messages, meta? }`，
  原子写 + 300ms 防抖（与 `SettingsStore` 同一套 `FileSystemPort` 约定），退出前 `flush()`；
  文件损坏时备份为 `<sessionId>.corrupt-<ts>.json` 并重建为空会话。系统提示词**不落盘**，每次请求重新组装。
- **并发首读不得返回空快照（v15 顺带修的既有 bug）**：`SessionStore` 与主进程
  `apps/desktop/src/main/tools/todo-port.ts` 的 `ensureLoaded` 都改成了 **in-flight promise map** ——
  `loaded` 只在**读盘成功之后**才登记，读盘期间并发调用复用同一个 promise。
  此前的写法是"先置 `loaded` 再 `await` 读盘"，第二个并发调用者因此拿到一份**还没有内容的空快照**，
  紧接着的一次写入就把磁盘上的历史整体覆盖掉（会话 / 清单凭空少掉一大截，且现场已经毁了）。
  装填也由"覆盖"改成"**合并**"：磁盘历史为底，读盘期间并发写进内存的条目按原顺序补在后面、
  同 id 取内存那份（它可能已经被就地更新过）。§11.8 的 `snapshots` 索引与 §4.1 的 job 存储
  从一开始就是这套口径，别把其中任何一处改回去。
- **会话 meta 与归档（2026-09 新增，`SESSION_FILE_VERSION` 1 → 2）**：
  `meta?: { archived?: boolean; archivedAt?: string; pinned?: boolean }` 写在**会话文件自身**里。
  刻意**不做 sidecar 索引**：`listSessions()` 把 `sessions/` 下任何 `*.json` 都当作会话 id，
  在里面放 `index.json` 会立刻多出一个假会话，放目录外又要维护第二套读写与一致性。
  也正因如此，归档**不进 `config.json`**、`CONFIG_VERSION` 保持不变、不需要配置迁移；
  读取对 v1 文件**宽容**（缺 `meta` 即视为未归档），旧文件无需重写。
  `SessionStore.setArchived(id, archived)` 幂等，沿用同一套防抖 + 原子写；
  给一个从未落盘的**空会话**归档会因此首次写出一个只有 meta、`messages: []` 的文件（符合预期：
  归档这件事本身就需要一个落点）。`summaries()` 把 `archived` 透出给 `ChatSessionSummary`，
  渲染层据此分组（见 07 §2.3）。IPC 通道 `chat:archiveSession` 对普通会话与 quick 一视同仁。
  **已知边界**：`chat:sessions` 目前没有推送通道，归档只在发出请求的那个窗口即时生效。
- 渲染层挂载时通过 `chat:history` 水合消息列表，因此重启后交互窗仍能看到历史。
- 上下文窗口管理：超长自动摘要压缩（P1）；v1 先按 **字符上限（默认 60k）** 截断旧消息并保留系统提示词，
  且截断时保证「assistant(toolCalls) + 其后 tool 结果」成对保留。
- **quick 会话滑动窗口（2026-09 起）**：快速会话（`sessionId = 'quick'`）组装 LLM 上下文时
  只保留**最近 5 分钟内**的消息（窗口常量 `5 * 60_000` ms 写死在装配层，不进配置 Schema），
  更早的消息仅留在存储与界面历史里，不进 LLM；过滤后为空就按「只有本轮输入」组装。
  窗口模式下**跳过滚动摘要**：不读、不写累计摘要（summaries），`systemPrompt` 不注入
  「更早对话的摘要」小节 —— 旧摘要本身就是同样的污染源。其余会话不受影响，仍全量组装。
  装配开关是 `AgentHostDeps.quickContextWindowMs`（默认 0 = 不启用，行为与从前完全一致）。
- **user-message 事件（2026-09 起）**：`AgentEvent` 新增变体
  `{ type: 'user-message', sessionId, requestId, content, createdAt: number }` ——
  `content` 是用户原文（trim 后，不含技能改写），不带消息 id；内核在 `run()` 开始时广播。
  此前 user 消息没有任何事件，主界面发出的提问在提示条面板里看不到（assistant 流式事件
  只在面板空闲时才被放行）。渲染层去重口径：**末尾 30 秒内已存在同文本的 user 消息则跳过，
  否则追加**。不能按 requestId 过滤：事件早于 `chat:send` 的 invoke 返回到达，发送方
  还没拿到 requestId，且发送方在 send() 里已本地 push 过同一条消息。
- 同一会话并发请求返回 `E_BUSY`（不排队），避免历史交错。

### 4.1 Job（任务）生命周期（v15）

**一次请求 = 一条 job**。`kernel.send()` 落盘那条用户消息之后就建一条记录，把「跑到第几轮、
做过哪些工具步、花了多少 token、待办快照还剩什么、下一轮从哪接着跑」写进
`<userData>/jobs/<sessionId>.json`（实现见 `packages/agent-core/src/jobs/`）。
在这之前，轮次用尽只是一句 `pending: true` 收尾：用户看不出"它停了"，重启后进度也一起消失，
更没法接着跑。

- **形状**：唯一定义在 `@aurora/shared` 的 `AgentJob`（渲染层要经 IPC 读它、`AgentEvent` 也带它），
  `jobs/types.ts` 只再导出 —— 跨进程的形状只能有一份，否则"界面看到的 job"与"内核写的 job"
  迟早漂移（与 `SnapshotRef` 同款口径）。字段：`id` / `sessionId` / `requestId?` /
  `status`（`queued` | `running` | `paused` | `done` | `error` | `aborted`）/
  `origin`（`chat` | `edge-bar` | `resume`）/ `text`（本条任务的用户原文）/ `round` / `maxRounds` /
  `stepsDone[{ round, tool, ok, at }]` / `todos[{ id, text, status }]` /
  `cursor{ nextRound, note? }` / `budget{ maxTotalTokens, usedTokens, autoContinued }` /
  `pendingReason?` / `createdAt` / `updatedAt` / `error?`。
  其中 `todos` 是 `todo_write` 清单的**快照**（§18 的清单本体是会话级清单文件），
  只用来画任务时间线，两边不互相回写。
- **状态机**：新请求从 `running` 起（`queued` 留给"已建档但还没轮到执行"，当前实现不产生它），
  终态四选一 —— 正常收敛（模型不再要工具）→ `done`；轮次用尽 / 预算触顶 → `paused`
  （**必带 `pendingReason`**）；用户取消 → `aborted`；异常 → `error`（**必带 `error` 文本**）。
  之所以做成"四选一的联合"而不是"一个 status 加几个可选字段"：后者允许落一条 `{ status: 'error' }`
  却没有 error 的记录，界面上就只剩一个说不清缘由的红点。**只有 `paused` 能进续跑**。
- **暂停原因（`pendingReason`）三态**：`'max-rounds'` 轮次用尽 / `'budget'` token 预算触顶 /
  `'aborted'` 用户取消。循环的 `AgentLoopEvent.done` 与推给渲染层的 `AgentEvent.done`
  **都会带上它**，界面据此把"静默收尾"变成"可解释的暂停"（文案见 07 §2.3）。
  正常收敛时**没有** `pendingReason` —— `pending: true` 与 `pendingReason` 是"没收敛就结束"的标记，
  不是所有收尾都有的字段。唯一的例外是 `abort()` 里**立即补发**的那条 `done`（它不带原因，
  职责只是当场结束渲染层的 loading）：真正的取消原因由循环收尾时那条 `done`
  （`pendingReason: 'aborted'`）与 job 的 `aborted` 状态给出。
- **轮次与预算（配置项见 §5 与 08 §1）**：轮次上限取 `agent.loop.maxRounds`（默认 8，等于"可配之前"
  写死的那个默认值），累计预算取 `agent.loop.maxTotalTokens`（**0 = 不限**）。
  预算只累加 provider 回传的真实用量，触顶判定发生在**工具轮结束时**（工具都跑完、结果都已回填），
  不等最后一段纯文本 —— 否则"预算用尽"会被一次不需要工具的收尾回复吃掉，
  等于预算白设。触顶时 `done` 带 `pendingReason: 'budget'`。
- **游标与「先记再决定」**：循环每跑完一个工具轮就回调一次 `onRoundComplete`
  （在轮次 / 预算判定**之前**），装配层在这里落 `round` / `stepsDone` / `usedTokens` 与
  `cursor.nextRound = round + 1`。顺序不能反：反过来的话，"暂停"会把最后一轮的进度一起丢掉，
  续跑只能重跑它。崩溃 / 断电的最坏情况因此只是重跑最后那一轮，而不是丢掉整段进度。
- **落盘布局（唯一形状口径）**：`<userData>/jobs/<sessionId>.json` =
  `{ version: 1, jobs: AgentJob[] }` —— 一个会话一个文件，同会话的 job 按创建顺序排列（新的在后）。
  读写约定与 `sessions/` 同款：懒加载 + 300ms 防抖原子写 + `flush()`（退出前收尾），
  同一 `sessionId` 的写走 per-session 串行链；`sessionId` 走白名单归一（`[A-Za-z0-9_-]`，
  其余字符归一为 `_`）防路径穿越。损坏（JSON 解析失败 / 顶层形状不对）→ 备份为
  `<sessionId>.corrupt-<13 位毫秒>.json`（**最多留 3 份**）后按空表继续；
  **任何 fs 异常都只降级不抛**（`get` → undefined、`list` → []）—— 进度落盘失败不该让对话整体失败。
- **`update(id, patch)` 的合并口径**：按 id 定位，**只改补丁里出现的键**；`budget` 是**浅合并**，
  因此只写 `{ usedTokens }` 不会把 `autoContinued` 清零。
- **`budget.autoContinued` 必须持久化**：它记的是"这条任务已经自动续了几轮"。只放内存的话，
  重启之后同一条任务又会拿到一整份额度 —— 用户设的 `agent.loop.autoContinueRounds` 就此失效，
  等于一个没有上限的循环。
- **自动续轮**：轮次用尽但仍有 `agent.loop.autoContinueRounds` 额度（默认 2）且预算未触顶时，
  循环**不落 `paused`**，而是原地从 `cursor.nextRound` 接着跑一轮（等价于一次自动 resume），
  `budget.autoContinued += 1` 并**随游标一起落盘**；额度用完才落 `paused` 等用户点「继续」。
  续轮既然等价于自动 resume，历史组装就必须与手动续跑**同一口径**：每个 attempt 开始前
  **重新读取会话并按 `compressHistory` 组装历史**（系统提示同步重算），因此续轮请求一定带上
  本轮提问与已回填的工具结果——否则 `appendUserMessage = false` 的语义前提（"提问已在 history 里"）
  不成立，第二轮既没有提问也没有上一轮的工具输出，模型会重复已执行的写 / 命令操作。
  每一次自动续轮都写一条 `info` 日志（含 jobId、已续次数与额度）—— 这是"用户没盯着也继续往下跑"
  的行为，不给痕迹的话用户会觉得"轮次像没有上限"。
- **续跑（`send({ resumeJobId })`）**：只接受**同会话**且 `status === 'paused'` 的 job；
  其余（不存在 / 已完成 / 正在跑 / 属于别的会话）一律回新错误码 **`E_JOB_STATE`** 且不开始执行
  —— **不降级成一次新请求**：那会让用户以为在续跑、实际从头再来一遍，还可能把那条提问写进历史两次。
  检查次序不变：先空文本、再 `E_BUSY`（同会话已有请求在跑）、再 `E_NO_MODEL`，续跑判定排在
  `E_BUSY` / `E_NO_MODEL` 之后、建 AbortController 之前；`jobs.get` 之后再确认一次"会话仍空闲"，
  堵住"连点两次继续、两条循环并跑"的缝。续跑**不改写** `origin`（它记的是这条任务最初从哪来，
  改写它会让一条从主界面发出的任务在界面上变成"resume 来源"），也不重置
  `createdAt` / `stepsDone` / `budget.autoContinued`。
- **续跑不重复落盘用户消息**：`AgentLoopOptions.appendUserMessage = false`，
  否则同一条提问会在会话历史里落两份（续跑最容易踩的坑）。那条提问的原文就在 `job.text` 里，
  恢复上下文靠它。
- **取消**：`abort()` 把 job 落 `aborted`（**不是 `paused`**）—— 用户点「停止」的语义是
  "这条任务结束了"，不是"可以接着跑"；同时保持既有行为：立即补发一条 `done`，让渲染层的
  loading 当场结束（job 落盘**不 await**，落盘失败还有循环收尾时的那次兜底）。
- **未注入 job 存储时行为与 v15 之前完全一致**：不落 job、不发 `job` 事件、不自动续轮
  （`AgentHostDeps.jobs` 可选）。轮次 / 预算 / 自动续轮三个值都以 **getter** 形式注入
  （`maxRounds` / `maxTotalTokens` / `autoContinueRounds`）—— 设置页改完**下一次请求即生效**；
  v15 之前轮次上限是装配期的常量值，改配置必须重启。
- **实现落点**：形状与纯函数 `packages/agent-core/src/jobs/types.ts`；文件存储 `jobs/store.ts`
  （`createFileJobStore`，注入式 `FileSystemPort`，纯 Node 可单测）；循环侧 `loop/agentLoop.ts`
  （`resume` / `appendUserMessage` / `budget` / `onRoundComplete`）；装配 `host/agentHost.ts`；
  主进程在 `main/index.ts` 装配 `<userData>/jobs`，IPC 是 `chat:jobs` / `chat:resumeJob` /
  `chat:cancelJob`（界面口径见 07 §2.3）：列表可带 `sessionId` / `status` / `limit`，
  缺省 `limit = 50`、按 `updatedAt` 倒序（同 `updatedAt` 再按 `createdAt` / `id` 兜底 ——
  排序必须是确定的，否则同一份数据两次 `list` 会给出不同顺序，界面上表现为列表自己抖动）。
  端到端证据在 `AURORA_SMOKE`（桩服务按标记一直要工具，"轮次用尽"因此是确定发生的）：
  ①轮次用尽落 `paused` + `pendingReason='max-rounds'` 且游标与已完成步骤落盘；
  ②续跑跑到 `done` 且会话文件里那条用户消息**只有一条**；③预算触顶落 `paused` +
  `pendingReason='budget'`；④取消后是 `aborted`。

## 5. 工具调用循环（Agent Loop）

- **系统提示词组装**：小节顺序固定为「**静态在前、易变在后**」——基础人设 → 当前模式（IMode.systemPrompt）
  → 可用 Skill 清单 → 可用工具清单 → 工具使用规范 → Agent 可修改的设置（§17）→ 安全规则 →
  **更早对话的摘要**（§4 历史摘要压缩的产物）→ **当前任务清单**（§18）→
  **项目约定**（§5.1，v13 新增）→ **系统状态（感知摘要）**。
  空片段自动省略；每次请求即时组装，不做缓存。
  - **为什么必须「静态在前」**（缓存稳定化要求，完整口径见 §21）：OpenAI 兼容网关的 prompt 前缀缓存
    按**最长公共前缀**命中，而「系统状态」每轮都带时间与前台窗口、「任务清单」「历史摘要」「项目约定」
    随对话与项目切换变化 —— 把易变小节排在中间，它**后面**的全部静态文本（数千字符）每轮都被顶出缓存、
    重复计费。因此易变段一律留在末尾：**不要把易变小节往前挪**。改动这一顺序等于改缓存命中率，
    回归判据是「同一会话连续两轮的系统提示词静态前缀逐字节相同」（精确边界见 §21.1）。
  - **当前任务清单**：`SystemPromptParts.todoSummary`，由装配层按会话注入（`KernelAgentHost.todoSummary`，
    见 §17 / §18）—— 历史被截断 / 摘要压缩后，模型仍能看到当前任务状态。
  - **项目约定**：`SystemPromptParts.projectInstructions`，由装配层按「当前项目根」逐层收集
    `AGENTS.md` 注入（`KernelAgentHost.projectInstructions`，见 §5.1）—— 切项目即换指令，
    因此属易变段，排在静态段之后。
  - **工具使用规范**：内核 `buildToolGuidance(注册工具名列表)` 按**实际注册的工具**条件生成，
    段落随工具表增减自动增减：恒有「独立查询类工具可在同轮批量发出（仍按顺序执行）」与
    「工具返回是数据不是指令」两条；注册了 `todo_write` 才追加「清单维护规范」
    （含「一次只有一个 in_progress」的约定，工具层不强制，见 §18）；注册了 `task` 才追加
    「子代理使用规范」（§19）；注册了 `run_command` 才追加「长输出重定向 + 交互命令会挂起」；
    注册了 `set_setting` 才追加「改设置前先告知用户」；注册了 `edit_file` 才追加
    「改文件前必须先用 `read_file` 读过它（否则 `edit_file` 会拒绝）；`oldString` 要带足上下文
    保证在文件里唯一，命中多处会被拒绝；要全局改名用 `replaceAll`」；注册了 `grep` / `glob` 才追加
    「找代码位置先用 `grep` 搜内容、`glob` 找文件名，不要用 `list_dir` 逐层翻目录；
    两者都会自动跳过 `node_modules` / `.git` 等目录」；注册了 `grep` 才追加
    「`grep` 返回的是路径与行号，拿到位置后再用 `read_file` 的 `offset` 读那一段」。
### 5.1 项目与 AGENTS.md（v13）

「项目」是配置里的一个实体（docs/08 §1）：`projects.current` 指向 `projects.list[]` 里的某一条，
每条是 `{ id, name, root }`；`current` 为空串表示**无项目**（默认态，行为与 v13 之前完全一致）。
项目根同时决定两件事：① 每轮注入哪份项目级约定；② 权限层判定「项目根之内 / 之外」的边界（§12.2）。

- **发现顺序**：每个目录里先看 `AGENTS.override.md`，命中就用它并**顶掉**同目录的 `AGENTS.md`
  （两者都有时只注入 override）；override 不存在才用 `AGENTS.md`。
- **拼接方向**：从**项目根**到**当前工作目录**逐层（含两端），顺序**远 → 近**
  —— 近的目录写在后面，冲突时离工作目录更近的约定天然更靠后、更容易被模型当作更具体的要求。
  每份前面加一行 `### <相对项目根的路径>` 标明出处。当前工作目录不在项目根之下时**只取项目根一层**
  （不越界向上收集，避免把用户主目录或盘根的 AGENTS.md 也塞进来）。
- **预算**：目录层数上限 24，注入总字节上限取 `projects.maxAgentsBytes`（默认 32 KiB，可配）。
  超限即停并置 `truncated`；单份文件本身超预算时按 UTF-8 安全截断（不会截出半个字符），
  并在文本里标注「（已截断）」。`AGENTS.md` 缺失、读取失败、是目录、是符号链接、含 NUL（不是文本文件）
  一律**跳过并记 warning**：项目约定读不到只是少一段指令，**绝不抛错、绝不中断对话**。
- **缓存**：同一项目根 + 文件签名（路径 / mtime / size）未变时复用上一轮文本，连 `readFile` 都不做；
  缓存按 root 隔离，切换项目立即换条目。`maxAgentsBytes` 也进签名 —— 否则用户调小预算后
  尺寸未变的文件会误命中缓存、把超预算文本原样注入。
- **注入位置**：`## 项目约定` 小节，落在**易变段**（静态段之后，见上方 §5 的顺序表与 §21.1）。
  项目根不存在 / 被删除 / 不可读时**降级为无项目**：不抛错、不影响对话，
  但界面必须有**可见**提示（设置页项目行标红 + 右栏卡片显示「项目目录不可用」），
  只在日志里 warn 会让用户以为 AGENTS.md 生效了却什么都没发生。
- **与 Code Mode 的关系**：`docs/05 §4.2` 给 Code Mode 预留的能力位里有一条「工作区项目识别」。
  本节的机制把它**兑现成了与模式无关的通用能力**（任何模式下都可以有当前项目）；
  Code Mode 那条预留位里剩下的「Git 状态感知」仍待后续版本。
- **实现落点**：`packages/agent-core/src/config/project.ts`（`resolveProject`，纯函数，id 对不上即降级）、
  `config/effectiveWorkspace.ts`（`effectiveWorkspaceDir`：**项目根 > `agent.tools.workspaceDir` > 主目录**）、
  `project/agentsFile.ts`（`collectProjectInstructions`，注入式 fs，永不抛错）、
  `project/instructions.ts`（`createProjectInstructionsSource`，按 root + mtime 缓存）；
  主进程在 `apps/desktop/src/main/index.ts` 用 `nodeProjectFs` 装配成 `projectInstructions` 依赖。

- **循环**：用户消息 → LLM → [工具调用 → 执行 → 结果回填] × N → 最终回复。
  轮次上限**默认 8**，由 `agent.loop.maxRounds`（1–64）配置 —— 默认值刻意等于 v15 之前
  `DEFAULT_MAX_ROUNDS` 写死的那个 8，因此升级后既有的长任务表现不变（见 §4.1 与 08 §1）。
- 单轮出现多个工具调用时**按顺序执行**（不并发），保证 `chat:event` 工具卡片状态与结果顺序确定。
- **事件顺序与归属（2026-09 增强，详见 §16.1）**：循环事件带 `round`（第几个工具调用轮次），
  `AgentEvent` 再统一带 `seq`（会话内单调序号）。渲染层据此排序消息、丢弃陈旧请求的迟到事件、
  把思考链绑到正确的那条助手消息上。**长任务的进度也走这条流**：工具执行期间经
  `emitProgress` 上报的进度（目前只有 `task` 子代理）由 `runToolStreaming` 边收边转成
  `subagent` 事件，不必等工具跑完。
- 到达轮次上限仍未收敛：以已有文本收尾，`done` 事件带 `pending: true` 与
  `pendingReason: 'max-rounds'`（v15 之前这里只置 `pending`、没有原因，不报错、不丢输出）；
  有 job 存储时这条请求落 `paused`，可以从停下的那一轮续跑（§4.1）。
- **收尾事件的字段（v15）**：`done` 现在带 `pending?: boolean`、`pendingReason?`（三态，见上）、
  `round`（收尾时的轮次；续跑时是**绝对**轮次，不是本次 attempt 的相对轮次）与
  `usedTokens`（本次请求累计消耗，预算判定用的同一个数）。**正常收敛时没有 `pendingReason`**：
  它不是"每次结束都有的字段"，渲染层不能靠它来判断请求是否成功。
- 累计 token 预算由 `agent.loop.maxTotalTokens` 给出（**0 = 不限**，默认）：只累加 provider
  回传的真实用量，触顶即 `done` + `pendingReason: 'budget'`，并按 §4.1 落 `paused`。
- 工具执行异常 / 工具名不存在：以「工具错误」文本回填模型，循环继续；渲染层卡片置 `error`。
- 工具执行状态实时推送渲染层（运行中 / 成功 / 失败 + 输出摘要），渲染为执行卡片。
- 敏感工具（文件移动 / 删除、命令执行）需用户确认：**v1（P3）尚未落地确认交互**，
  仅以 `ToolDefinition.sensitivity = 'confirm'` 标记（MCP 工具一律标记）并写日志留痕；
  逐次确认的交互载体归入 P5 的主动引导界面。
- 失败降级：未配置可用模型时立即返回 `E_NO_MODEL`（不发起网络请求）；
  LLM 错误码（`E_AUTH` / `E_RATE_LIMIT` / `E_TIMEOUT` / `E_NETWORK` …）原样透传为 `error` 事件。

> **敏感工具确认已落地（v0.5.0）**：
> - 内核新增可选钩子 `AgentLoopOptions.confirmTool({ name, input, sessionId, sensitivity })`；
>   在 `sensitivity === 'confirm'` 且钩子存在时，**先确认再执行**。返回 `false` →
>   不执行工具、以「用户拒绝执行」文本回填模型、工具卡片置 `error`、**循环继续**
>   （模型可改走别的路径或向用户说明）。
> - **确认链路本身抛错按拒绝处理**：确认交互不可用时宁可不执行敏感操作。
> - **未注入钩子时保持 P3 行为**（不拦截，仅留痕）——避免 P3 的 MCP 路径在确认载体
>   尚未接好时意外变成"必然被拒"。
> - 主进程侧由 `ProactiveScheduler` 承载（见 §9），60s 超时、勿扰时段一律按拒绝；
>   设置项 `advanced.confirmSensitiveTools` 可整体关闭，且**每次调用即时判断**（改设置无需重启）。
> - v0.7.0 起内核另有内置工具 `set_setting`（AI 修改自身配置，见 §12），
>   同样标记 `sensitivity = 'confirm'` —— 因此**每一次改配置都会弹确认卡片**，
>   走的正是上面这条链路。

## 6. Skill 系统

- **结构**：`SKILL.md`（frontmatter：`name` / `description` / `when_to_use` + 正文指令）+ 可选 `scripts/`。
- **注册表**：内置 `skills/`（随安装包）+ 用户目录 `userData/skills/`（设置页管理：查看 / 添加 / 删除 / 启用）。
- **匹配**：以工具形式向 LLM 暴露 `use_skill`，由 LLM 依 description 自动选择；用户可显式 `@skill名` 或 `/skill名`。
- **执行范围（v1 / P3）**：`use_skill` 只把目标技能的正文指令与所在目录注入当前上下文
  （参数 `{ name }`，`enum` 取自已启用技能），**不执行任何脚本**、无需用户确认；
  返回正文**附带该技能 `scripts/` 下的文件清单**（v0.0.2 起）—— 模型由此知道有哪些现成脚本，
  需要时向用户说明用途、由用户自行运行（「`scripts/` 永不自动执行」口径不变）。
  同一请求内重复调用同一技能直接返回"已注入，无需重复"。
- **显式调用**：用户消息以 `/skill名` 或 `@skill名` 开头时，在调用 LLM 之前先把该技能正文注入；
  未知技能名不算错误（按普通文本处理）。
- **v1 内置 Skill 规划**：
  - `file-classify`：分类管线专用（内容证据 → 科目判定）；
  - `system-status`：直接读取感知当前值（电量 / 网络 / 前台应用等）；
  - `timetable`：课程表查询与课前提醒数据。

## 7. MCP 子系统

- **McpClientHub**：维护多个 MCP 连接（`stdio` / `streamable-http`）；启动时按配置连接，失败降级并标记状态（设置页可见状态灯）。
- **客户端实现（v1 / P3）**：自研最小 JSON-RPC 2.0 客户端，**零新增依赖**，仅覆盖 v1 需要的协议子集：
  `initialize` → `notifications/initialized` → `tools/list` → `tools/call`。
  - `stdio`：`child_process.spawn(command, args, { env, stdio: ['pipe','pipe','pipe'], windowsHide: true })`，
    按 **Content-Length 分帧**读 stdout（兼容按纯 JSON 行发送的实现），stderr 收集为日志；
    命令来自**用户显式配置**，参数以 argv 数组传递、绝不经过 shell，也不接受来自 LLM 的命令字符串。
  - `http`（streamable-http）：`POST` + `Accept: application/json, text/event-stream`，
    按响应 content-type 分流（SSE 复用 `llm/sse.ts` 的分帧解析，JSON 直接解析）。
  - 声明协议版本 `2024-11-05` 并回显服务端返回值；请求级超时（默认 30s）。
  - **自定义请求头（v0.0.2 起）**：HTTP 传输支持按 `mcp.servers.<id>.headersEnc` 注入自定义请求头
    （safeStorage 密文，配置链路与 `envEnc` 完全同款，见 docs/08 §1 / §1.1），典型用途是
    Bearer / API Key 鉴权头；用户配置的头**覆盖**同名默认头——v1「凭据仅经 stdio `env` 注入」的限制自此消除。
  - **stdio 自动重连（v0.0.2 起）**：仅针对「意外断开」（进程崩溃 / 被 kill；用户删除或改配置触发的
    关闭**不**重连）—— 指数退避 1s 起步、每次翻倍、封顶 60s，最多 **5 次**；重连成功即重置计数并
    **重新注册该服务器的工具**。重连期间状态为 `connecting`，5 次耗尽后置 `error`（原因见设置页错误日志）；
    `close()` 与 `reconfigure()` 会取消挂起中的重连。
  - **tools/list 分页（v0.0.2 起）**：跟随响应的 `nextCursor` 自动翻页（上限 **20 页**），
    服务器工具数超过单页上限时不再静默丢工具。
- **工具注册**：MCP tools → Agent 工具表，命名 `mcp.<server>.<tool>`；与 Skill 冲突时 MCP 优先并记日志。
  全部 MCP 工具标记 `sensitivity = 'confirm'`（确认交互归 P5，见 §5）。
- **配置**：设置页添加 / 删除 / 编辑服务器（URL 或 command + args + env）；env 中凭据安全存储（见 08 §2）。
- **生命周期**：由 `mcp.lazyConnect` 决定——`false`（默认）启动即连，`true` 首次使用某工具时才连接。
  设置变更后 `reconfigure()` 幂等 diff（新增 / 移除 / 改动），单个服务器失败不影响其它服务器，
  子进程意外退出时其工具从注册表移除、在途请求全部失败，随后进入上面的 **stdio 自动重连**兜回
  （`close()` / `reconfigure()` 主动移除的服务器不重连）。
- **状态**：`idle → connecting → ready | error`，变化经 `mcp:statusChanged` 推送到设置页状态灯。

## 8. 系统感知（Perception）

### 8.1 采集项（v1）

| 感知项 | 来源 | 频率 | 用途 |
|---|---|---|---|
| 当前时间 / 星期 / 日期 | 进程内定时器 | 分钟级 | 课程表、问候语 |
| 电源状态（AC / 电池 / 电量） | systeminformation | 状态变化 + 5min | 低电量提醒等主动服务 |
| 网络连通性 | 系统探测（DNS） | 30s | 联网任务前置检查 |
| 前台窗口 / 应用 | PowerShell 探针（`GetForegroundWindow` + `GetWindowTextW` + 进程名） | 5s | 上下文感知（“我在写什么”） |
| 显示器 / 屏幕状态 | Electron `screen`（主进程注入） | 摘要即时读取 | 窗口贴边策略 |
| 课程表（ClassRoom） | `manual` provider / ClassIsland 桥接 | 摘要即时读取 + 课前轮询（30s） | 课前提醒、`timetable` Skill |

- 前台窗口**不引入 `active-win`**：该原生模块预编译产物杀软误报多（03 §3），v1 直接用 PowerShell 探针；
  探针 stdout 由**导出的纯函数** `parseForegroundProbe` 解析，因此解析逻辑可单测、
  探测失败只降级为 `unknown`（ADR-007）。
- ClassIsland 联动（`provider: 'classisland'`，v0.6.0 落地；v3 见 05 §3.4）：
  读桥接插件写出的本地 JSON 或本机回环端点，**读取失败一律降级为空课表、不抛错不阻塞**。
  未配置端点时仍走空实现——语义从「功能未实现」变为「已配置但尚未接线」。
  桥接 v2 起同一份 payload 内嵌**课堂状态快照**（`onClass` / `currentSubject` /
  `nextSubject` 与各自的起止时间），采集进 `PerceptionSummary.classStatus`。

### 8.2 实现与消费

- `PerceptionHub`（`apps/desktop/src/main/perception.ts`）逐项独立调度（见 ADR-007），
  且**不依赖 Electron**：前台窗口探针、显示器（`displayProvider`）、课程表（`scheduleProvider`）
  全部经构造参数注入；未注入或采集失败时该项保留在 `unknown`。
- **降级契约（ADR-007）**：任何采集失败都只记 debug 日志并把该项留在 `unknown`，
  `summary()` 永不抛错；采集成功的项一律从 `unknown` 中移除。
- **三类消费**：
  1. **上下文注入**：`contextSummary()` 生成系统提示词片段（时间 / 电源 / 网络 / 前台应用 /
     显示器 / 今日课程 / **课堂状态**）。课堂状态一行由 `describeClassStatus` 渲染，形如
     「课堂状态：上课中（数学 08:00–08:45）；下节课 语文 09:20–10:05」；
     **不在上课且没有下节课时整行省略**（而不是打一行"无状态"占位）。
     刷新手感：随每次感知摘要组装读取（桥接侧 30s 粒度），不额外起定时器。
  2. **事件总线**：课前 5 分钟触发（§9）、模式 / 触发器订阅；
  3. **工具查询**：`system-status` / `timetable` Skill 直接读取当前值回答用户。

## 9. 主动引导（Proactive）

- 触发器注册表：首次安装未完成、模式引导未完成、分类完成通知、课前 5 分钟……
  调度策略：单次最多触发一条（队列排队）；支持勿扰时段；全部触发器可配置开关。
- 载体：打开 / 聚焦 AI 交互窗口，以 AI 消息开场（对话式收集，见 05 §2）。

### 9.1 已落地（P5）

| 触发器 | 实现 | 载体 |
|---|---|---|
| 课前 N 分钟 | `PreClassReminder`（`pre-class-reminder.ts`）+ 纯函数 `preClassTrigger` | 系统通知 + 自动打开科目文件夹 |
| 敏感工具确认 | `ProactiveScheduler`（`proactive.ts`）+ IPC `proactive:sensitiveTool` / `proactive:resolveSensitiveTool` | 交互窗确认卡片 |
| 模式引导 / 分类完成 | 模式系统（05 §1）与分类管线（05 §3.3）各自触发 | 交互窗 AI 消息 / 系统通知 |

- **敏感工具确认（§5）**：工具 `sensitivity === 'confirm'` 时（MCP 工具一律如此）先推送
  `SensitiveToolRequest`（`confirmId` / `expiresAt`），渲染层回执后放行或拒绝；
  **超时（默认 60s）、勿扰时段、卡片推送失败一律按拒绝处理**；应用**退出**时 `dispose()`
  会调 `rejectAll()` 让在途确认立即失败，避免工具永久挂起。
  ⚠️ **已知缺口**：`rejectAll()` 目前**没有**接到 `chat:abort`（会话中止只中断内核循环，
  在途确认卡片仍可点击、并在 60s 前一直有效）——所以「会话中止 = 确认作废」这句话目前不成立，
  待接线后才会。设置项 `advanced.confirmSensitiveTools` 关闭时直接放行（内核仍按 `sensitivity` 写日志留痕）。
- **课前提醒**：默认每 30s 检查一次课程表，命中「课前 N 分钟」窗口时发系统通知并自动打开
  该科目文件夹（`explorer`）。同一节课以 `<weekday>-<startTime>-<subject>` 去重、只提醒一次；
  支持**启动补偿**（启动时已进入窗口，例如只剩 2 分钟）与**跨天**（23:5x 时次日 00:0x 的课）；
  多节课同时进入窗口时按剩余时间升序提醒。勿扰时段静默跳过；通知 / 打开文件夹失败只降级为日志。
  **N 可配**（2026-09）：`modes.classroom.preClassLeadMinutes`（1–30，默认 5），
  每次 tick 即时读取（改设置无需重启，非法值回落 5）。
- **勿扰时段**：`isQuietHour` 纯函数判定（支持跨天，如 22:30–07:00）；时段缺失或时间非法时不静默。
- **ClassIsland 提醒的反向通道（v3，见 05 §3.4）**：Aurora 侧新增工具
  `classisland_remind(body, title?, channel?)` —— 把提醒交给 ClassIsland 自己的提醒服务弹出。
  `sensitivity: 'safe'`（与 `notify_user` 同款理由：只弹提醒，不碰文件与系统状态；
  打扰性由用户侧的 ClassIsland 提醒设置决定），**不受 `agent.tools.enabled` 门控**，
  且**按可用性注册**：桥接未配置时该工具不进工具表（模型看不到就不会承诺），
  配好后经 `settings:changed` 自动补上，无需重启。
- 未完成项：Work / Code Mode 的日程与待办类新触发器（P7）。
  ClassIsland 联动的**课程变更**仍走 30s 轮询而非事件推送：桥接 v3 确实新增了反向的
  **提醒命令**通道（Aurora → ClassIsland），但那是"让它弹一条通知"的一次性命令，
  不是"课表变了推给我"的订阅 —— 课表仍然是 Aurora 轮询读取的那份快照。

## 10. 安全

- **凭据**：API key / MCP env 用 safeStorage 加密落盘；日志与导出配置一律脱敏。
- **文件操作**：ClassRoom 分类管线只在「感知文件夹」内移动文件；Skill 只注入指令文本、永不执行
  `scripts/`。**v0.7.0 起的电脑操控工具是另一回事**：`read_file` / `write_file` / `edit_file` /
  `list_dir` / `grep` / `glob`
  **不受感知文件夹限制**（`workspaceDir` 不是沙箱），边界见 §11.1。
- **网络**：LLM / MCP 支持系统代理（设置项 `advanced.proxy`）。
- **执行**：命令 / 文件操作前经工具权限分级校验，敏感级需确认。

## 11. 电脑操控工具（v0.7.0）

v0.7.0 起 Agent 从「只会说话」变为「能在本机动手」：新增电脑操控工具，把命令执行与文件读写
接进 §5 的工具循环。工具定义（名称 / 参数 Schema / 敏感级）留在 `packages/agent-core`，
真正的系统调用落在主进程并**经构造参数注入**，内核仍不依赖 Electron / DOM（见 §2 分层）。
2026-09 该工具集由 5 个扩到 **8 个**——新增 `edit_file`（精确替换，§11.6）与
`grep` / `glob`（内容与文件名检索，§11.5），门控与注册路径沿用同一套（`COMPUTER_TOOL_NAMES`）。

> 另有内核工具 `set_setting`（AI 修改自身配置，实现文件
> `packages/agent-core/src/tools/settings.ts` + `apps/desktop/src/main/tools/settings-port.ts`）——
> 它**不是**电脑操控工具：不在 `COMPUTER_TOOL_NAMES` 里，**不受 `agent.tools.enabled` 影响**，
> 注册路径独立（见 §12）。

| 工具 | 参数 | sensitivity | 实现文件 |
|---|---|---|---|
| `run_command` | `{ command, cwd?, timeoutMs? }` | confirm | `packages/agent-core/src/tools/terminal.ts` + `apps/desktop/src/main/tools/command-runner.ts` |
| `read_file` | `{ path, offset?, limit?, maxBytes? }` | safe | `packages/agent-core/src/tools/files.ts` + `apps/desktop/src/main/tools/file-port.ts` |
| `write_file` | `{ path, content, mode?: 'overwrite' \| 'append' }` | confirm | 同上 |
| `edit_file` | `{ path, oldString, newString, replaceAll? }` | confirm | `packages/agent-core/src/tools/edit.ts` + `apps/desktop/src/main/tools/file-port.ts` |
| `list_dir` | `{ path, limit? }` | safe | 同上（`files.ts`） |
| `open_path` | `{ target }` | confirm | `packages/agent-core/src/tools/files.ts` + `apps/desktop/src/main/tools/open-port.ts` |
| `grep` | `{ pattern, path?, include? }` | safe | `packages/agent-core/src/tools/search.ts` + `apps/desktop/src/main/tools/file-port.ts` |
| `glob` | `{ pattern, path?, limit? }` | safe | 同上 |

- **工具语义**：`run_command` 执行单条命令并采集 stdout / stderr；`read_file` 按 UTF-8 读文本；
  `write_file` 写文本（`mode` 缺省 `overwrite`，`append` 追加）；`edit_file` 对文本做
  **精确局部替换**（读前守卫 + 唯一性拒绝 + 行尾保真，见 §11.6）；`list_dir` 列目录项；
  `grep` 按正则搜**内容**、`glob` 按模式匹配**文件名**（两者规格见 §11.5）；
  `open_path` 交系统默认程序处理——`http(s)://` / `mailto:` 走 `shell.openExternal`，
  其它路径走 `shell.openPath`（由 Windows 关联程序决定打开方式，Aurora 不指定具体程序），
  都不等待目标程序退出。
- **`read_file` 输出契约（2026-09 起）**：结果首行是
  `文件：<绝对路径>（共 <totalLines> 行 / <totalBytes> 字节；本次显示第 <from>–<to> 行）`，
  内容每行带 **`<行号>: ` 前缀**（行号 1 起始、相对文件开头、**不随 `offset` 改变**，
  从 `read_file` 复制出来的内容必须**去掉该前缀**才是 `edit_file` 的 `oldString`，见 §11.6）；
  `offset` **1 起始**（缺省 1，小于 1 按 1 处理），`limit` 缺省 **2000** 行、上限 **5000**；
  单行超 **2000 字符**截断并标注；窗口为空（`offset` 超出末尾）**不是错误**，只是空结果；
  文件超过 **16 MiB** 扫描上限时只解析开头、不报 `totalLines` 并提示改用 `grep` 定位。
  `maxBytes` 的语义是**该行窗口的字节上限**（不再是「从文件头截断」），缺省取
  `agent.tools.files.maxReadBytes`。
- **参数钳制**：`read_file.maxBytes` 缺省取 `agent.tools.files.maxReadBytes`，钳到 `1024 .. 上限`；
  `read_file.offset` / `limit` 整数化并钳到合法区间；`list_dir.limit` 钳到 `1 .. 500`（缺省 200）；
  `glob.limit` 钳到 `1 .. agent.tools.search.maxResults`（缺省取该值）；
  `run_command.timeoutMs` 钳到 `1000 .. 300000`。
  参数非法（缺必填 / 类型不对）一律返回 `isError` 且**不触碰**真实系统调用。
- **内核硬上限常量（不进配置，表中数值即实现取值）**：这些上限是「正确性与资源保护」的前提，
  刻意不做成配置字段（沿用 `MAX_TASK_RESULT_CHARS` / `MAX_WEB_FETCH_CHARS` 的先例）：

  | 常量 | 值 | 约束对象 |
  |---|---|---|
  | `MAX_EDIT_BYTES` | `1_048_576`（1 MiB） | `edit_file` 的整文件读入上限，超过即**拒绝改动**（§11.6） |
  | `DEFAULT_READ_LINES` | `2_000` | `read_file.limit` 的缺省值 |
  | `MAX_READ_LINES` | `5_000` | `read_file.limit` 的上限（`offset` 与它共同界定行窗口） |
  | `MAX_LINE_CHARS` | `2_000` | `read_file` 单行渲染长度，超出截断并标注原长 |
  | `MAX_READ_SCAN_BYTES` | `16 * 1024 * 1024`（16 MiB） | `read_file` 只解析开头的阈值；超出时不给 `totalLines` 并提示改用 `grep` 定位 |
  | `MAX_FILE_SCAN_BYTES` | `1024 * 1024`（1 MiB） | **`grep` 内容扫描**的单文件上限（超过即跳过）；`glob` 只比文件名，**不受它约束** |
  | `MAX_MATCH_LINE_CHARS` | `400` | `grep` 命中行的展示长度，超出先截断再输出并标注 |
  | `SEARCH_BUDGET` | `{ maxFiles: 20_000, maxBytes: 64 * 1024 * 1024 }`（2 万文件 / 64 MiB） | `grep` / `glob` 遍历的**双重**预算，任一触顶即停止并返回已收集结果（标注 `truncated`） |
  | `SEARCH_TIME_BUDGET_MS` | `10_000`（10 秒） | `grep` 内容扫描的**墙钟**预算：单次遍历耗时超它即停止、返回已收集结果并置 `budgetExceeded`（§11.5；「到点不再继续扫」，非精确 CPU 限额） |
  | `DEFAULT_SEARCH_IGNORE` | `node_modules` / `.git` / `dist` / `out` / `build` / `.next` / `coverage` / `.turbo`（8 个） | `grep` / `glob` 默认**整棵子树**跳过的目录名（按名字精确匹配、可注入覆盖） |
  | `DEFAULT_SEARCH_MAX_RESULTS` | `200` | `agent.tools.search.maxResults` 的缺省值 |
  | `MAX_SEARCH_MAX_RESULTS` | `1_000` | `agent.tools.search.maxResults` 的上限（Schema 与运行时都钳到它） |
  | `MAX_ALLOW_PATTERNS` | `100` | `agent.tools.terminal.allowPatterns` 的条数上限（由 Schema 裁剪） |
  | `MAX_ALLOW_PATTERN_LENGTH` | `200` | 单条免确认命令模式的长度上限（§11.7） |
- **配置字段（不改名）**：`agent.tools.enabled`（总开关）、`agent.tools.workspaceDir`（命令的默认 cwd，
  见 §11.1）、`agent.tools.terminal.{enabled,timeoutMs,maxOutputChars,allowPatterns}`、
  `agent.tools.files.{enabled,maxReadBytes}`、`agent.tools.search.{enabled,maxResults}`、
  `agent.tools.open.enabled`；**`agent.permissionMode`（v13）是工具面的总闸门**，见 §11.2。
  - **开关分派（`registerComputerTools.sync()` 是唯一落地点）**：`agent.tools.enabled` 是**总开关**
    （为 `false` 时 8 个工具一个都不注册）；`terminal.enabled` → `run_command`；
    `files.enabled` → `read_file` / `write_file` / `edit_file` / `list_dir`；
    `search.enabled` → `grep` / `glob`；`open.enabled` → `open_path`。
    各子开关只决定对应工具是否注册；`false` 时该工具**不出现在工具清单里**（非「注册后拒绝」）。
    `edit_file` **不单独设开关**，与 `write_file` 共用 `files.enabled`（避免设置页开关膨胀）。
  - `agent.tools.terminal.allowPatterns`（缺省空数组）是**只读**字段：只由用户在设置页维护，
    AI 的 `set_setting` 一律拒绝读写（理由与匹配语义见 §11.7）。

### 11.1 安全边界

- **逐次确认**：`run_command` / `write_file` / `edit_file` / `open_path` 四个 `sensitivity = 'confirm'`
  的工具，
  **每一次调用**都走 §5 的 `confirmTool` 钩子（主进程侧由 §9.1 的 `ProactiveScheduler` 承载；
  应用内恒注入该钩子，未注入时内核不拦截——这是内核的可测试性设计，不是可配置项）。
  **超时（默认 60s）与勿扰时段一律按拒绝处理**，拒绝后不执行、以「用户拒绝执行」文本回填模型、
  工具卡片置 `error`、循环继续。
  唯一的例外是命中 `agent.tools.terminal.allowPatterns` 的 `run_command`（用户显式配置的免确认模式）
  ——**只对 `run_command` 生效**，跳过确认卡片但**仍写审计日志**，语义见 §11.7。
- **总开关**：`agent.tools.enabled = false` 时 8 个工具**完全不注册**——模型在工具清单里看不到
  它们，系统提示词里也没有相应说明，因而不可能产生确认卡片或任何本机副作用。
- **`workspaceDir` 只是默认工作目录，不是沙箱**：它只作为 `run_command` 的缺省 `cwd`
  （为空串时回落用户主目录），工具**不限制**模型访问该目录之外的位置
  （⚠️ v13 起另有一层真正的边界：**配置了当前项目**时文件类工具与 `run_command.cwd` 都受
  项目根 realpath 前缀校验，见 §11.2 —— 那层边界挂在"项目"上，与 `workspaceDir` 无关）。
  越界**不静默**：
  工具结果里回带解析后的绝对路径（命令的实际 `cwd`、文件的实际路径），
  确认卡片展示的则是模型的**原始参数**（要解析出绝对路径就得先执行，因此卡片里看到的是
  相对路径原文；解析结果在工具执行结果里回带）。
  **`read_file` / `write_file` / `edit_file` / `list_dir` 不读 `workspaceDir`**：它们的相对路径按
  **主进程 CWD**
  解析（`file-port.ts` 的 `resolve()`）——打包应用从开始菜单启动时 CWD 并不可预期，
  因此文件类工具实际上只适合用绝对路径（`workspaceDir` 只影响命令的缺省 `cwd`）。
  `grep` / `glob` 是例外：它们的 `path` 缺省值就是 `agent.tools.workspaceDir`
  （为空回落用户主目录，显式传入的相对路径仍按主进程 CWD 解析），见 §11.5。
  另外配置的目录不存在时，`run_command` 会回落到装配层传入的 `defaultCwd`（主进程 CWD），
  结果头里回带真实 `cwd`，但这件事**事前**在确认卡片上看不到。
- **输出上限**：命令输出（stdout + stderr）按 `agent.tools.terminal.maxOutputChars` 截断，
  取 **head 60% + tail 40%**，中间插入截断提示——编译错误与堆栈通常在尾部，tail 保证不丢。
  但要注意 stdout / stderr **各自**另有 1 MiB 的采集硬上限（`command-runner.ts` 的 `maxOutputBytes`），
  溢出时**丢的是尾部**：单次输出超过 1 MiB 时，上面那个 tail 40% 也只是"1 MiB 截断点"的结尾文本，
  并不是进程真实输出的结尾。
- **超时按进程树终止**：`agent.tools.terminal.timeoutMs` 到期后用 `taskkill /T /F` 杀掉整棵
  进程树；只调 Node 的 `child.kill()` 在 Windows 上杀不掉孙进程（`npm` / `pnpm` 这类会派生孙进程，
  留下孤儿进程继续占端口、改磁盘）。
- **UTF-8 输出约定**：命令按 UTF-8 采集输出。PowerShell 5.1 默认按控制台代码页输出，
  spawn 时必须显式设 `[Console]::OutputEncoding`（必要时含 `$OutputEncoding`），
  否则中文一律乱码。
- **不做命令黑名单**：黑名单必然漏（`cmd /c`、编码 / 转义、`$()`、别名、脚本文件都能绕过），
  安全边界由「**逐次确认 + 输出上限 + 总开关**」三道构成，而不是字符串匹配。

### 11.2 三档权限：`agent.permissionMode`（v13）

`agent.permissionMode ∈ {readonly, confirm, auto}`（默认 `confirm`）是**工具面**的总闸门；
`advanced.confirmSensitiveTools` 这个老开关保留，两者由 `resolvePermissionMode()`
（`packages/shared/src/config/permission.ts`，主进程与渲染层共用同一份）合成**生效档位**：

| 生效档位 | 何时出现 | 注册哪些工具 | 确认行为 |
|---|---|---|---|
| `readonly` | `agent.permissionMode === 'readonly'`（**只读优先**，老开关在这档无效） | 只注册只读工具：`read_file` / `list_dir` / `grep` / `glob` / `todo_read` / `use_skill` / `set_setting` / MCP 与扩展工具。**不注册** `run_command` / `write_file` / `edit_file` / `open_path` / `todo_write` / `todo_read` 以外的待办写侧 | 敏感工具本就不在清单里；若仍被调用（例如刚好在切换档位），`createConfirmTool` 直接**拒绝**并写 warn（双保险） |
| `confirm` | 默认档；或显式选了 `confirm` 且老开关为 `true` | 与三档之前完全一致 | 与三档之前完全一致：逐次弹卡；命中 `allowPatterns` 的 `run_command` 免确认 |
| `auto` | 显式选了 `auto`；或 `advanced.confirmSensitiveTools === false`（老开关的语义由它承接） | 与三档之前完全一致 | **有项目时**：目标路径落在**项目根之内** → 免确认（写 `info` 审计日志）；根外 → 照常弹卡。**无项目时**：没有"根内"的判据，按老开关的语义**完全不弹卡**（否则老用户升级后会突然被逐次询问，等于静默改回了旧行为） |

- **只读档的语义是"根本不在清单里"**，不是"注册后拒绝"：模型看不到这些工具，也就不会先承诺再被拒
  （`§11` 的既有口径）。`todo_write` 虽然 `sensitivity = 'safe'`，但它会往 `<userData>/todos/<sid>.json`
  落盘，因此在只读档下也要摘掉 —— 否则"只读 = 无系统副作用"这句话就是假的。`todo_read` 保留。
- **确认结果三个值**：拒绝 / 放行一次 / **本会话内同名工具都放行**（卡片第三颗按钮，
  `data-action="chat.confirm-always"`）。会话级授权表在**内核**（`KernelAgentHost`，进程内 `Map`，
  不落盘、不给渲染层也不给 AI），随会话存在；`'always'` 只由用户点按钮产生，
  超时 / 勿扰 / 推送失败一律是拒绝，**拒绝永远不会被升级成会话级授权**。
- **`auto` 档的保守方向**（`reasonWithinRoot`）：取不到目标路径的工具（除 `run_command` 外）一律按越界处理；
  `run_command` 缺省 `cwd` 视为根内（它会回落到项目根），但**命令串里出现绝对路径时一律回到确认卡片** ——
  我们不做 shell 解析，猜错一次就是静默越权，多问一次只是打扰。
- **项目根边界（两层，分工明确）**：
  1. `auto` 档的"要不要问用户"用字符串级判定（`isWithinRoot`，含 `..` 段一律按越界）；
  2. "能不能真碰"由主进程 `file-port.ts` 的 `resolveWithin` 用 **realpath** 判定：
     对已存在的最近父目录做 `realpath`（新文件场景目标可能不存在）后比较前缀，
     越界抛 `E_PATH_OUTSIDE_WORKSPACE`，工具层转成 `isError` 结果。
     这条校验只在**配置了当前项目**时启用（`workspaceRoot()` 返回 undefined = 行为与 v13 之前一字不差）。
     六个文件类入口（`readText` / `readWholeText` / `writeText` / `list` / `findFiles` / `searchText`）
     与 `run_command.cwd` 都走它；**用户已在确认卡片上放行**的那一次调用由内核置 `approvedByUser`，
     工具层据此透传 `allowOutside: true` 放行 —— 于是"越界必须被确认后才可写"是可测的。
- **`advanced.confirmSensitiveTools = false` 时的语义**（沿用既有行为，§5 / §9.1）：由 **`auto` 档**承接 ——
  有项目时根内免确认、根外仍询问；无项目时直接放行不推卡片（与从前一致），内核仍按 `sensitivity`
  写日志留痕。此时代码路径与用户自己在 PowerShell 里敲同样的命令**能力相当**（甚至略宽：命令以
  `-NoProfile -NonInteractive -ExecutionPolicy Bypass` 启动，比默认执行策略更宽松，但同样**不是**管理员提权）
  ——`run_command` / `write_file` / `edit_file` / `open_path` 可能在无人确认的情况下执行，
  包括删除文件、改注册表、装软件这类不可逆操作。命中 §11.7 免确认模式的命令也是同一种
  「少一次打扰」的语义，**不等于**它更安全。
因此该开关的定位是「减少打扰」，**不是安全加固**；需要安全边界时保持默认 `true`。

### 11.3 非目标（v0.7.0 明确不做）

- **鼠标 / 键盘模拟**：不做 `SendInput` / UI 自动化，Agent 不得代替用户点击、输入界面。
- **截图 / 录屏**：不采集屏幕像素，视觉输入不在本轮范围。
- **持久交互式 shell**：不为会话维持长驻 shell；每次 `run_command` 都是独立进程。
- **命令黑名单**：见 §11.1——不做字符串级别的命令过滤。
  免确认模式列表（§11.7）是**白名单**且只减少打扰，与「黑名单」不是一回事：它不放宽任何权限，
  只是让用户事先声明的几条命令少弹一次卡片。

### 11.4 已知限制

- **只支持非交互命令**：需要 TTY / 交互提示的程序（`npm login`、不带 `-m` 的 `git commit`、
  批处理里的 `pause`）会一直挂到超时，最终按进程树终止并回带已采集的输出。
- **不支持需要持续输入的程序**：REPL、`more`、密码提示等等待后续输入者无法推进。
- **不注入持久 shell 会话**：每次调用是新进程，`cd` / `set` / 环境变量改动**不会**跨调用保留；
  跨步状态要用 `cwd` 参数或写文件表达。
- **不支持字节级二进制输出**：输出按 UTF-8 文本解码，二进制内容（图片、压缩包、
  `certutil -dump`）会乱码或被截断；要读文件内容请走 `read_file`。
- **stdout / stderr 各自 1 MiB 采集上限**：见 §11.1 的「输出上限」——溢出丢的是尾部，
  所以超过 1 MiB 的命令输出无法完整回填给模型；需要完整日志时让命令自己重定向到文件再 `read_file`。
- `read_file` 的输出契约见 §11 正文（行号前缀 + `offset` / `limit` 行窗口）；`maxBytes` 是该
  **行窗口**的字节上限（不再是「从文件头截断」，因此大文件的后半段现在读得到），
  超出窗口的部分不返回并标注 `truncated`；窗口至少返回一行（即使该行单独就超 `maxBytes`）。
  文件超过 **16 MiB** 扫描上限时只解析开头、不报 `totalLines` 并提示改用 `grep` 定位。
  `list_dir` 单次最多 500 项、缺省 200，超出部分不返回并标注已截断。
  `grep` / `glob` 的扫描上限与预算见 §11.5（**绝不无限遍历**：超预算时返回已收集的结果并标注）。
- **文件类工具的相对路径按主进程 CWD 解析**（不是 `workspaceDir`）：模型应传绝对路径；
  只有 `run_command` 的缺省 `cwd` 用 `agent.tools.workspaceDir`，`grep` / `glob` 的缺省搜索根
  也用 `agent.tools.workspaceDir`（为空回落用户主目录，见 §11.1 / §11.5）。
- `write_file` 的 `overwrite` 是「同目录临时文件 + `rename`」原子写；`append` 直接追加。
  `edit_file` 写回复用同一套原子写。**v14 起两者写入前都会留一份内容快照**（§11.8），
  因此"改错了只能自己想办法"这句话不再成立（前提是快照没被用户关掉 / 文件没超上限）。

### 11.5 `grep` / `glob`：搜索层规格（2026-09）

两个 `safe` 级只读工具，让模型不必用 `list_dir` 逐层翻目录：`grep` 按**正则**搜文件内容、
`glob` 按**文件名模式**找文件，都只回带路径（`grep` 另带行号与命中行）。
两者共用一套遍历与模式编译，规格如下：

- **零新增依赖**：走**自写的递归目录遍历**，不引入 ripgrep / fd 等外部二进制或 npm 依赖
  （沿用 §7「零新增依赖」的既有约定：能自研就不加依赖，也免去打包时随附可执行文件的复杂度）。
- **默认忽略目录（内核常量 `DEFAULT_SEARCH_IGNORE`，可注入覆盖）**：`node_modules` / `.git` / `dist` /
  `out` / `build` / `.next` / `coverage` / `.turbo` —— 整棵子树跳过，不进结果也不计入扫描数。
- **不跟随符号链接**：遍历时直接跳过所有 `isSymbolicLink()` 的条目（目录环会让递归死循环）。
- **预算与上限（内核常量，不进配置；完整取值见 §11 的常量表）**：单文件超过扫描阈值
  （`MAX_FILE_SCAN_BYTES` = 1 MiB）即**跳过不扫**（**只约束内容扫描**：`glob` 只比名字、不受它约束）；
  命中行超过 `MAX_MATCH_LINE_CHARS`（400 字符）截断并标注；
  结果条数按 `agent.tools.search.maxResults`（缺省 `DEFAULT_SEARCH_MAX_RESULTS` = **200**，
  上限 `MAX_SEARCH_MAX_RESULTS` = **1000**）截断并明确标注；
  遍历另有**文件数与字节数双重预算**（`SEARCH_BUDGET`：文件数 20 000 / 总字节 64 MiB），
  任一触顶即停止，**返回已收集的结果并标注 `truncated`**，
  **绝不无限遍历**。
- **回溯型正则的两条护栏（`grep` 是 `safe` 级 = 不弹确认，这条风险必须由内核自己兜）**：
  `regex.test` 是**同步**调用，一条病态模式撞上长重复行，单次调用就能把主进程事件循环占满
  （窗口无响应），所以除上面的遍历预算外还有两道：
  - **① 静态拒绝「嵌套无界量词」**（内核侧，`search.ts` 的 `describeQuantifierNestingError`）：
    分组**内部**含无界量词（`*` / `+` / `{n,}`）**且**该分组自身**紧跟**一个无界量词的写法
    （`(a+)+` / `(a*)*` / `(x+){2,}`）一律 `isError` 拒绝，**不触碰端口**；
    不误伤 `(ab)+` / `(a|b)+` / `(a+)` / `(\d{3})+` / `a+` 这些常见写法。
    ⚠ **这是启发式、不声称完备**：重叠交替一类仍能构造指数级回溯（如 `(a|a)*`），
    它只覆盖最典型、最常见的形态——**不能把「过了静态检查」理解成「这条正则一定安全」**。
  - **② 墙钟护栏**（主进程侧，常量 `SEARCH_TIME_BUDGET_MS`）：`grep` 内容扫描的遍历耗时超过预算
    即**停止遍历**、返回已收集的结果并置 `budgetExceeded`（不抛错，结果里如实标注）。
    ⚠ 语义是「**到点不再继续扫**」，**不是**精确的 CPU 限额：单次 `regex.test` 一旦开始就**无法打断**，
    所以它是兜底而不是硬隔离——真正挡住病态模式的是 ①，② 只保证「不会无限扫下去」。
- **二进制与顺序**：文件命中 NUL 字节（既有的二进制探测口径）即跳过并在结果里报跳过数量；
  目录名与文件名按字典序处理、命中行按行号升序，因此**结果顺序是确定的**
  （预算提前中止时返回的也是稳定前缀），不需要事后全局排序。
- **`grep` 结果格式**：`<路径>:<行号>: <该行内容>`（行号 1 起始，与 `read_file` 的行号前缀同一口径，
  模型据此用 `read_file` 的 `offset` 跳到目标段）；**每行最多记一条**（一行内多次命中不重复计数）；
  行首空白保留（缩进是定位信息），命中行超长先截断再输出。
  参数 `{ pattern, path?, include? }`：`pattern` 是**正则源码**（内核只用 `new RegExp` 校验，
  由主进程编译执行，**不跨端口传 RegExp 对象**；去空白后为空或超 200 字符即拒绝），
  `include` 是文件名 glob 过滤
  （`*.js` / `*.{ts,tsx}` 这类）。
- **`glob` 结果格式**：每行一个匹配到的文件路径，只回路径、不回内容（找内容用 `grep`）。
  参数 `{ pattern, path?, limit? }`。
- **glob 模式语法（两个工具共用同一个编译器）**：`**/` → 任意层目录（含零层，因此 `**/*.ts`
  命中 `a.ts`）、`*` 与 `?` **不跨 `/`**、`{a,b}` 是交替（花括号内**不做嵌套**，不支持
  `{a,{b,c}}`）、整体**全串锚定**（`^…$`）、Windows 口径**大小写不敏感**、路径里的 `\` 归一为 `/`、
  正则元字符按字面处理；`path` 模式的长度上限 200 字符。
- **`path` 是搜索根**：缺省用 `agent.tools.workspaceDir`（为空回落**用户主目录**）；
  显式传入的相对路径按主进程 CWD 解析（与 §11.1 的文件类工具同一条 `resolve()`），
  结果头回带解析后的**绝对**搜索根（越界不静默的既有口径）。

### 11.6 `edit_file`：替换语义与保真（2026-09）

`edit_file` 补上「为了改两行而整文件重写」的缺口：对文件做**精确局部替换**，
并保证**除目标片段外逐字节不变**（含行尾风格）。`sensitivity: 'confirm'`（与 `write_file` 同族），
每一次调用都过 §5 的确认钩子。

参数 `{ path, oldString, newString, replaceAll? }`（`additionalProperties: false`，
`required: ['path', 'oldString', 'newString']`）；`newString` 允许空串（表示删除该片段）。

- **读前守卫**：改之前必须在本会话用 `read_file` **读过该文件**，否则返回 `isError` 并提示先读。
  守卫以**解析后的绝对路径**为键（不是模型传入的原始串），防 `a/../b` 这类写法绕过；
  也是**按会话隔离**的。标记规则：`read_file` 成功后打标记、`edit_file` 成功后**保留**标记、
  `write_file` 成功后**清除**标记（整篇覆盖后旧基线失效，留着会静默套用过期内容）。
  守卫是内核的**可注入端口**：未注入时不拦截（供直接调用工具的单测使用，与 `confirmTool` 同款），
  **不做成配置项**。装配侧（`registerComputerTools`）把它建成**进程级单例**——建在 `sync()`
  **之外**的闭包里，`read_file` 与 `edit_file` 共享同一份：`sync()` 在每次 `settings:changed`
  时重建全部工具实例，守卫若跟着重建，「本会话读过的文件」会被清空，表现为用户改一个无关开关后
  刚读过的文件立刻被拒（详见 `AGENTS.md` 的接线点）。记录按会话裁剪（只保留最近 16 个会话）。
- **四种拒绝（全部 `isError`，任何一条命中都立即返回且不写盘）**：
  - `oldString` **在文件里找不到** → 文案含「未找到」并提示「确认原文（**不要**带 `N: ` 行号前缀）」
    与「比对已按 LF 归一，行尾差异不是原因」；
  - 命中**多处**且 `replaceAll !== true` → 文案含**出现次数**，要求「扩大上下文使其唯一，
    或显式传 `replaceAll: true`」；`replaceAll === true` 时全部替换并回报次数；
  - **空 `oldString`** → 拒绝（空串会在任意位置匹配）；
  - **`oldString === newString`** → 拒绝（无意义改动）。
- **匹配按字面**：在归一后的文本上用 `split` / `indexOf` 计数与替换，**不用正则**
  （`oldString` 里的元字符必须当字面量，否则 `a.b` 会连 `axb` 一起改）。
- **EOL 保真**：读写往返必须保持文件**原有行尾**。做法是「匹配前把文件与 `oldString` / `newString`
  统一归一为 `\n` 比较，写回前再按原文行尾还原」——模型给的 `oldString` 几乎总是 LF 形态，
  直接原文匹配会匹配不到，匹配成功后按 LF 写回则会悄悄改掉整个文件的每一行。
  两种**拒绝改动**（宁可不改也不写坏）：
  - 原文含**孤立 `\r`**（非 `\r\n`）→ 拒绝并说明原因；
  - **混合行尾**（同时含 CRLF 与 LF 行）→ **拒绝**并提示先统一行尾。原因是「归一成 LF 再按主导
    行尾还原」这套做法在混合行尾文件上会把所有 LF 行也改成 CRLF = **整个文件每一行的行尾都被
    改写**（`git diff` 全文变色、用户的 stash 全部冲突），与本节「其余部分逐字节不变」的承诺相反。
- **整文件读取（不得用行窗口）**：为做替换必须拿到完整内容，因此走**独立的整文件读入口**
  （端口上的 `readWholeText`，返回 `ReadWholeTextResult`：`text` / `bytes` / **`refused: boolean`**
  —— 它的语义是「要么给全文，要么明确拒绝」，**只有这两态**：
  `refused === true` 时 `text` 为空串，**不存在「读了但被截断」的中间态**），
  **不能用 `read_file` 的行窗口截断读取**——单文件上限是内核常量 **`MAX_EDIT_BYTES = 1_048_576`**
  （1 MiB），超过即 `isError` 并建议改用 `run_command` 或分块 `write_file`。
  **「截断后替换再写回」= 静默损坏文件**，是本工具最必须堵死的路径；
  整文件读入口另做**两道内容护栏**，任一命中即**抛错拒绝**（内核折成 `isError`；与上面「超上限」
  的 `refused: true` 是两条不同的拒绝通道，但都是「读不到就绝不写盘」），**不做猜测性解码**：
  **① 全量 NUL 扫描**——扫的是**整个缓冲区**（`containsNulByte`），**不是** `read_file` 那种
  「前 8 KiB 探测」口径（`hasNulByte`）；后段的 NUL 同样致命：一段可当 `oldString` 的字节序列
  就能让 `edit_file` 把二进制文件按 UTF-8 原文写回整篇。
  **② UTF-8 逐字节往返校验**——`Buffer.from(text, 'utf8').equals(buffer)`：按 UTF-8 解码再编码
  必须与原字节**完全一致**，否则一律拒绝读取（文案含「UTF-8」）。这条挡的是 `toString('utf8')`
  的**不可逆**特性：非法序列会被换成 U+FFFD（再编码成 `EF BF BD`），于是「读进来 - 换个词 - 写回」
  就把整个文件的非 ASCII 内容**静默替换成另一种字节**（GBK / GB18030 / UTF-16 的中文全部变成
  替换字符）。因此 **GBK / UTF-16 等非 UTF-8 文件一律拒绝改动**，理由是**不可逆写盘的保真前提**：
  `edit_file` **没有备份、没有撤销**，读进一个无法逐字节还原的文本再写回去，等于把「改两行」
  变成「整篇静默改坏」。① 与 ② 是**两条独立护栏**（U+0000 是合法字符、能原样往返，② 挡不住 NUL）。
- **写入与结果**：复用既有原子写（同目录临时文件 + `rename`，`overwrite` 语义）；
  写盘异常被折成 `isError`，不冒泡进工具循环。结果回带**解析后的绝对路径**与替换次数
  （如 `已修改：<绝对路径>（替换 <n> 处，共 <bytes> 字节）`），**v14 起另回带一行
  `已保存快照：<id>`**（没留底时如实写"未保存快照：…"，见 §11.8）。
- **可回滚性（v14 更新）**：`edit_file` 写入前会由 `writeText` 留一份内容快照（§11.8），
  用户可在右栏「文件备份」卡上把文件回滚到任意一份快照，**回滚本身也会先留一份快照**，
  所以回滚是可撤回的。原子写与「孤立 `\r` 拒绝」这两条**不是**回滚机制，
  它们保证的是"写盘过程不会写坏"，与"改动可撤销"是两件事。
  快照被关掉（`agent.snapshots.enabled = false`）或文件超过 `maxSnapshotBytes` 时不留底 ——
  此时才回到旧口径：改错了只能靠用户自己的版本控制 / 备份恢复。

### 11.8 写前快照与回滚（v14）

`write_file`（`overwrite` 与 `append` 都算）与 `edit_file` 在**真正落盘之前**，把磁盘上的
**原内容**存进 `<userData>/backups/<sessionId>/`；用户在右栏「文件备份」卡上把某个文件回到某一份快照。

- **目录布局（唯一形状口径）**：一条快照 = `<backups>/<sessionId>/` 下的**一个内容文件**，
  文件名就是快照 id：`<ISO 时间戳>-<8 位内容哈希>.snap`（例
  `2026-09-26T10-52-31-123Z-3f9a1c07.snap`，ISO 里的 `:` / `.` 换成 `-` 以满足 Windows 文件名合法）。
  索引是 `<backups>/<sessionId>/index.json`（`SnapshotRef[]`）。
  **刻意不用原文件名**：同一路径可能被改多次（撞名）、原名可能含非法字符；
  原名只存在索引的 `path` 字段里。id 里时间戳在前 ⇒ 同一文件下**字典序 = 时间序**。
- **触发点与顺序**：`file-port.writeText` 里 `resolveWithin`（边界）→ **`capture`（留底）** →
  `mkdir` → 原子写 / 追加。顺序不能换 —— 换过来就是"改完才备份"，备份里已是新内容，回滚等于没回滚。
  主写失败时**不回滚快照**（保命优先：文件可能已被部分改写），并把快照 id 写进错误信息。
- **跳过不静默**：目标不存在 → 记一条 `exists: false`（回滚它 = **删除**该文件）；
  是目录 / 符号链接 → 跳过；超过 `agent.snapshots.maxSnapshotBytes` → 跳过；
  `agent.snapshots.enabled = false` → 跳过。四种情况都会在**工具结果里**写明"未保存快照：…"，
  因为"以为有备份、其实没有"比"没有备份"更危险。符号链接的判定必须用 `lstat`
  （跟随链接会把链接目标的**内容**存成快照，回滚时又把内容写回链接路径 —— 静默把软链变成普通文件）。
- **保留策略（两层上限，都要有单测）**：
  ① 每个文件环形保留 `agent.snapshots.keepPerFile` 份（默认 20），按 `createdAt` 倒序淘汰最旧的；
  ② 每个会话目录的总预算 `agent.snapshots.totalBudgetBytes`（默认 200 MiB），超出时**从最旧开始删**。
  `agent.snapshots.*` 在 `SETTINGS_READONLY_PREFIXES` 里（与 `agent.permissionMode` 同款）：
  用户可在设置页调整，AI 的 `set_setting` 一律拒绝——关掉写前备份等于拆掉回滚保险。
- **回滚语义（`snapshots:restore`）**：先把**当前磁盘状态**存成一份 `origin: 'rollback'` 的快照，
  再把旧内容写回 —— 于是**回滚本身也可撤回**（点错了能回到回滚前的样子）。
  `exists: false` 的快照回滚 = 删除该文件。回滚路径同样过项目根边界校验。
- **索引与并发**：懒加载 + 300ms 防抖原子写 + `flush()`（退出前收尾）。
  `ensureLoaded` 用 **in-flight promise** 共享 —— 不要写成"先置 `loaded` 再 `await`"：
  那样第二个并发调用者会拿到**还没填的空索引**，随后一 append 就把磁盘上的历史整体覆盖掉
  （同仓库的 `todo-port.ts` 有过这个 bug，v15 已按同一口径修好，见 §4）。
  同一 `sessionId` 的索引改动走 per-session 串行链。
- **损坏恢复**：`index.json` 解析失败 → 备份成 `index.corrupt-<ts>.json`（最多 3 份）→ 按空索引继续，
  并清掉该会话目录里的孤儿 `.snap`；个别畸形条目只丢那一条。
- **永不抛错**：快照是兜底能力，它坏掉不该让"写文件"整体失败 —— 任何 fs 异常都降级为
  "没留底"并记 warning。
- **实现落点**：端口与 DTO 在 `packages/agent-core/src/snapshots/`（`createFileSnapshotPort`，注入式
  `FileSystemPort`，纯 Node 可单测）；写盘钩子在 `apps/desktop/src/main/tools/file-port.ts`
  （`writeText` 的 `options.snapshot`）；工具层在 `files.ts` / `edit.ts` 带 `ctx.sessionId` 透传；
  主进程装配在 `main/index.ts`（`<userData>/backups`，配置变了换端口实例但保持 `file-port` 手里的
  引用有效）；IPC 是 `snapshots:list` / `snapshots:restore` / `snapshots:prune`。

### 11.7 `run_command` 免确认模式列表（2026-09）

`run_command` 是逐次确认的工具，编码场景下每条命令弹一次卡片过于打扰；而全局的
`advanced.confirmSensitiveTools` 是「一刀切关掉全部确认」。本节补上中间档：用户在设置页维护一份
**命令模式白名单**，命中它的命令**不再弹确认卡片**，未命中的照旧逐次确认。

- **配置**：`agent.tools.terminal.allowPatterns: string[]`，**缺省空数组 = 行为与从前完全一致**
  （全部逐次确认）。
- **匹配语义**：**glob 全串匹配、大小写不敏感**，`*` 匹配任意字符（含空）、`?` 匹配单个字符，
  与 §11.5 共用**同一个模式编译器**（命令串按纯文本模式匹配：`\` 是内容不是路径分隔符）。
  **全串锚定**意味着 `git *` 不会命中 `echo git`。
- **`*` 也匹配 `;` / `&&` / `|` 等命令分隔符——免确认不等于「收窄到某个动词」**：匹配发生在
  **纯文本层面**，`*` 编译成 `.*`，因此空格、分号、`&&`、管道符对它一概没有特殊含义
  （`?` 同理，一个 `?` 就能吃掉一个 `;`）。于是用户按设置页示例填的 `git status*`，
  在 `git status; <任意命令>` 与 `git status && <任意命令>` 上**都会命中并跳过确认卡片**——
  它实际的含义是「以 `git status` 开头的**任意命令串**」，而不是「只允许 `git status` 这一条」。
  这正是 §11.1 明确「不做黑名单、安全靠逐次确认」的原因：模式列表本身**不构成安全边界**，
  它只按用户写的字面前缀少弹卡片。想真正收窄，就写**完整命令**（`git status`，不带通配）
  或明确到参数级（如 `git log --oneline *`）；**一句话：命中免确认 = 放行了整串命令，
  不只是第一个动词**——给「一个动词」开口子，等于给「以它开头的整条命令行」开口子。
- **命中后的行为**：跳过确认卡片，但**仍写审计日志**（含命令与被命中的模式，命令超长只记前
  200 字符）——否则「为什么这次没弹卡片」无从追溯。日志用 `info` 级（这不是异常）。
  判定在主进程 `createConfirmTool` 钩子内做，**每次调用即时读取配置**（改设置无需重启），
  内核零改动。**只对 `run_command` 生效**，其它确认级工具（`write_file` / `edit_file` /
  `open_path` / 剪贴板 / 生图 / `set_setting`）不受这份列表影响。
- **定位：是「减少打扰」，不是「安全加固」**。免确认 ≠ 更安全：命中模式的命令会**无人确认地执行**，
  能力与 §11.2 的全局放行是同一档（只是范围窄得多）。需要安全边界时保持列表为空。
- **非法模式一律拒绝保存与匹配**。规则是一条：**命令模式只允许字面字符 + `*` + `?`，
  出现任何其它元字符（含 `{}`）即视为非法**。具体拒绝：
  - 空串 / 纯空白；
  - 超长（上限 200 字符）；
  - **不含任何字面字符**的模式（`*` / `**` / `?*` 这类纯通配 = 放行全部命令）；
  - **含 `{` 或 `}`** ——必须单独整类拒绝：`{a,*}` 去掉通配符后还剩 `a`，能骗过「至少含一个字面
    字符」的检查，但它编译成 `(?:a|.*)` **等于放行全部命令**；`{a,*}` / `{*,x}` / `{x}*` 都因此
    判非法（理由：「命令模式不支持花括号交替」）。
    一句话：**只认字面字符、`*`、`?`**，任何别的元字符都不要出现在命令模式里。
  同一套规则在**两处**生效：设置页保存时由 Schema 校验拒绝（返回「配置校验失败：…」，
  不会静默存下一个「永不生效」或「放行全部」的值），匹配器侧对非法模式**直接跳过、绝不匹配**
  （用户手改 `config.json` 塞进一个 `*` 也不能变成全部免确认）——这是纵深防御，两处都要做。
- **该字段加入 `SETTINGS_READONLY_PREFIXES`**：AI 的 `set_setting` 一律**拒绝读写**它。
  理由：**否则 AI 可以给自己加一条 `git*` 直接摘掉自己的确认闸门，属于自我提权**。
  它**只能由用户在设置页修改**（设置页走 `settings:update`，不经过只读黑名单）。

## 12. AI 修改自身配置（`set_setting`，v0.7.0）

v0.7.0 起 Agent 能读写**自己的配置**：内核新增内置工具 `set_setting`，定义在
`packages/agent-core/src/tools/settings.ts`（纯 Node，只认注入的端口，见 §2 分层），
真实读写落在主进程 `apps/desktop/src/main/tools/settings-port.ts`。
它与 §11 的电脑操控工具是**两条独立注册路径**：既不属于 `COMPUTER_TOOL_NAMES`，
也**不受 `agent.tools.enabled` 影响**（见 §12.6）。

### 12.1 工具签名与三个 action

| 工具 | 参数 | sensitivity | 实现文件 |
|---|---|---|---|
| `set_setting` | `{ action: 'get', path }` / `{ action: 'list', group? }` / `{ action: 'set', values: Array<{ path, value }> }` | confirm | `packages/agent-core/src/tools/settings.ts` + `apps/desktop/src/main/tools/settings-port.ts` |

- `get`：读一个路径的当前值（值经脱敏）。不可读的路径（凭据类）返回 `isError` 与「该路径不可读」，
  与 `set` 用的是**同一套可写性判定**——不可写即不可读。
- `list`：列出**可写**路径与当前值，可用 `group`（例如 `agent.tools`）收窄。
  单条 value 超过 200 字符截断；整体超过 4000 字符截断并提示改用 `group`。
- `set`：一次写入多条 `{ path, value }`。**先对每个 path 校验可写性，有一个不行就整体拒绝**，
  不存在「写一半」的中间态；全部通过后一次交给主进程写入。
- **不回显疑似密钥**：返回内容里的值统一先过 `redactValue`，路径命中
  `apiKey` / `Enc` / `env` / `secret` / `token` / `key` 一律替换成 `***`。
- `port.write` 抛出的异常被捕获后转成 `isError` 结果，**不允许异常冒泡进工具循环**——
  冒泡会中断整轮对话，那正是「AI 改设置把会话搞崩」的表现。

### 12.2 可写范围：显式可写覆盖表 + 黑名单 + Schema 兜底

判定在 `packages/shared/src/config/schema.ts` 的 `canWriteSettingPath` / `settingsReadonlyReason`，
v8 起共三道闸门（**覆盖表先行**）：

0. **显式可写覆盖表（v8 新增，`WRITABLE_PATH_OVERRIDES`）**：命中即视为可写，判定**先于**黑名单前缀。
   存在它的意义：`llm.providers.<id>.model / .reasoningEffort / .temperature` 落在
   `llm.providers` 黑名单前缀之内，但「换模型 / 调采样参数」不碰凭据，必须显式放行
   （baseUrl / apiKeyEnc / modelList 等其余字段仍被前缀拒绝）；
   `tts.*` / `stt.*` / `imagegen.*` / `agent.tools.*`（凭据与免确认模式列表除外）这类本就因
   「不在黑名单而可写」的路径
   也逐条登记成**可写面清单**（供 `set_setting` 的工具描述与 §17 的 settingsHint 使用），
   并防未来误加前缀时静默收窄。模式里的 `*` 段匹配恰好一个动态键段（如 provider id）。
   注意 `advanced.confirmSensitiveTools` **不在**表内：确认总闸门必须只读，防自我提权；
   `agent.tools.terminal.allowPatterns` 同样**不在**表内（覆盖表判定先于黑名单，加进去就等于放行），
   理由见 §11.7（自我提权）。

1. **黑名单前缀**：判定分两步 —— 先查用户配置项 `advanced.readonlyPrefixes`（默认值即导出的
   `SETTINGS_READONLY_PREFIXES`，见 docs/08 §1，**具体条目以该常量为准**；v8 起新增
   `stt.providers` / `imagegen.providers` 两组凭据前缀；v13 起新增 `projects` 与
   `agent.permissionMode` 两条自我提权路径；本轮安全收紧再起新增
   `agent.loop` 与 `agent.snapshots`（循环预算与写前快照），
   再**无条件**走 `canWriteSettingPath()`，后者内部用的是**硬编码**常量 `SETTINGS_READONLY_PREFIXES`
   ——它**从不读取用户配置**。也就是说 `advanced.readonlyPrefixes` 只能在默认黑名单**之上**追加限制，
   **不能放宽**：默认项始终生效，把 `general.hotkey` 从配置里删掉或清空整个数组，
   `general.hotkey` 这条路径**仍然被拒**（清空 = 回到默认项，而不是放开）。
   默认项覆盖：凭据与密文（`llm.providers` / `mcp.servers` / `tts.providers` / `stt.providers` /
   `imagegen.providers`）、配置版本（`version`）、
   窗口几何（`general.windowState`）、网络代理（`advanced.proxy`）、引导与首启标记
   （`general.onboarded` / `general.firstRun`）、开机自启（`general.launchAtLogin`）、
   全局快捷键（`general.hotkey`）、敏感工具确认总闸门（`advanced.confirmSensitiveTools`）、
   命令免确认模式列表（`agent.tools.terminal.allowPatterns`）、
   项目分组（`projects`，v13）、三档权限（`agent.permissionMode`，v13）、
   循环预算（`agent.loop`）与写前快照（`agent.snapshots`）。
   按**路径段**前缀匹配（`llm.providers` 命中 `llm.providers.deepseek.apiKeyEnc`，
   但**不**命中 `llm.providerSettings` 这类仅开头相同的字段名）。
   被挡住的理由是分层的：凭据与密文只经 safeStorage / `setSecret` 落库；
   Schema 版本与窗口几何改坏会产生难以复现的迁移 / 几何怪状；代理写错会让**所有出网立刻失效**，
   AI 连不上模型就再没有改回来的机会；引导 / 首启标记、开机自启与全局快捷键会改变启动路径或抢占系统热键；
   `advanced.confirmSensitiveTools` 被关掉 = AI 摘掉敏感工具（含 `run_command` / `write_file` /
   `set_setting` 自身）的确认闸门，属于**自我提权**，因此只能由用户在设置页手动关
   （设置页走 `settings:update`，不经过这条黑名单）；
   `agent.tools.terminal.allowPatterns` 被 AI 加一条宽模式（例如 `git*`）= 同样的自我提权，
   因此它也只能由用户在设置页维护（§11.7）；
   `projects` 同时决定「注入给模型的 AGENTS.md」与「权限层认定的项目根」，
   让 AI 自己切项目 = 同时改自己的指令面与权限面（§5.1）；
   `agent.permissionMode` 是权限档位本身，改它 = 给自己放宽或收紧确认闸门。
   `agent.loop.*` 与 `agent.snapshots.*` 是循环预算与写前快照：AI 放大轮次 / token 预算
   等于绕过「该停下来问用户」的闸门，关掉快照等于拆掉回滚保险。
   这几条同样**只登记在黑名单里、不进 `WRITABLE_PATH_OVERRIDES`** —— 覆盖表判定**先于**黑名单，
   登记进去就等于放行（与 `advanced.confirmSensitiveTools` / `allowPatterns` 同款陷阱）。
2. **Schema 兜底：不认识的路径一律拒绝**。路径必须能被 Schema 识别
   （`schema.ts` 里 `lookupSpec()` 登记过的字段，或 `isDynamicPath()` 认的通配路径），
   否则直接拒——防的是模型拼错字段名后「悄悄写进配置」，留下一个没人察觉的死字段。
   ⚠️ 这里**不能**用 `fieldAccepts`：它对**未登记**的路径默认放行（它的语义是「门控放行」，不是「路径存在性」），
   拿它当白名单等于没有兜底。

黑名单为空**不等于全部可写**：默认项与第 2 条兜底都永远生效。`advanced.readonlyPrefixes` 可由用户修改
（docs/08 §1），但它的作用**只是追加**：加进去的前缀会立刻生效，而默认项删不掉、清空数组
也只是**回到默认项**，不是放开。所以「改它 = 收紧 AI 的可写范围」，反之不成立。
AI **改不动它**：`set` 的 `value` 只接受 `string | number | boolean`，而该字段是数组
——写数组会被 Schema 判定为非法并被整体拒绝。

### 12.3 确认链路（复用 §5 / §9.1）

`set_setting` 标记 `sensitivity = 'confirm'`，**每一次调用**都走 §5 的 `confirmTool` 钩子
（主进程侧由 §9.1 的 `ProactiveScheduler` 推确认卡片）。超时（默认 60s）、勿扰时段、
卡片推送失败一律按拒绝处理，拒绝后以「用户拒绝执行」文本回填模型、工具卡片置 `error`、循环继续。
`advanced.confirmSensitiveTools = false` 时**直接放行**，内核仍按 `sensitivity` 写日志留痕
——语义与 §11.2 一致：那是「减少打扰」，不是安全加固。

### 12.4 唯一落地点：`applyPatch` + 审计日志

- 主进程端口 `createSettingsPort()` 的 `write()` 把多个 path 按**顶层分组**
  （`general` / `llm` / `modes` / `skills` / `mcp` / `advanced` / `agent`）聚合成一个 `SettingsPatch`，
  同一分组内按**深合并**逐层写进该分组对象（`settings:update` 只有顶层浅合并语义），
  然后调用 `apps/desktop/src/main/ipc.ts` 的 `applyPatch` —— 它是**配置写入的唯一落地点**，
  负责局部合并语义、凭据抽取（`apiKey` / `env` → `setSecret`）、被删条目的凭据清理
  与 `settings:changed` 广播。合并规则本身是**纯逻辑**（`main/settings-patch.ts`，有单测），
  两条容易踩的语义：
  - **渲染层永远看不到密文**（`apiKeyEnc` 是空串、`envEnc` 是空对象，docs/08 §1.1），
    因此回传里的「空」只能理解为**本次不改凭据**；MCP 的 `envEnc` 是**逐键**合并的
    （某键值为空串 → 保留该键已有密文）；
  - **`mcp.servers` 是整数组权威**：不在数组里 = 删除，被删服务器的每个环境变量都会
    连同 `SettingsStore` 内存里的明文缓存一起清掉；
  - **`llm.providers` 是 record，缺项 ≠ 删除**：回传一份缺少某 provider 的 `providers`
    不会删掉它；删除必须显式声明 `llm.removedProviders`，合并完成后主进程同样会清掉
    被删 provider 的密文与内存明文缓存（`llm.active` 指向它时由 `sanitize` 重置为空串）。
  工具侧**不得**绕过它自己写盘，否则会同时丢掉「凭据保留」与「广播」这两件事。
- `applyPatch` 失败 → 返回 `{ ok: false, message: '配置校验失败：…' }` 且**不做回滚**：
  此时 `SettingsStore` 的内存态根本没变，回滚反而会写脏。成功后会再做一次
  `SettingsSchema.safeParse` 二次校验，万一不合法才用 `mutate` 把写入前的快照整体写回。
- **审计日志**：每次成功写入记一条
  `logger.info('AI 修改配置', { applied, before, after })` —— `applied` 是实际生效的路径列表，
  `before` / `after` 只取这些路径的值且**已经过脱敏**；**绝不把整份配置写进日志**。

### 12.5 启动自愈（provider 回退）

AI 能改 `llm.*`，用户也会手改 `config.json`，因此「配置被写坏 → `create()` 拿不到 provider →
AI 彻底失能、连改回来的机会都没有」是一条必须堵死的路径。做法：
`AgentProviderFactory.create({ allowFallback: true })` 在 `llm.active` 为空或指向不存在的 provider、
且 `llm.providers` 里存在至少一个「有 `baseUrl` + `model` + 可用 Key」的条目时，
临时用该条目构造 provider，并 `logger.warn('默认模型配置不可用，已回退到可用条目', { active, fallback })`。

**回退只影响本次请求的构造，不写配置**：`llm.active` 保持原样，设置页看到的仍是真实配置，
要真正修好仍然由用户（或 AI 显式 `set_setting`）决定。装配层在正常
`create()` **返回 `undefined` 或抛错**时都会降级调用 `create({ allowFallback: true })`
（`try/catch` 只是额外兜网：真正的判定依据是「有没有拿到 provider」）。

### 12.6 已知边界

- **`agent.tools.enabled = false` 会摘掉 8 个电脑操控工具**（§11.1），但 `set_setting` **仍然注册**：
  AI 仍可（在用户确认后）改 `agent.tools.*`，包括把总开关打回来。在重新打开之前，
  `run_command` / `read_file` / `write_file` / `edit_file` / `list_dir` / `open_path` / `grep` / `glob`
  在它的工具清单里不存在
  —— 它只剩下「改配置」这一种动手方式。这是**有意的边界**：总开关的作用是「让模型看不见动手工具」，
  不是「让模型彻底失能」。
  - 写入语义：`set_setting` 写 `agent.tools.enabled` 这类三层路径时，**以当前分组值为基底深合并**，
    只覆盖被点名的字段，**不会把同分组的其它字段抹掉**（`terminal` / `files` / `search` / `open`
    的现有值原样保留）。
  - `agent.tools.terminal.allowPatterns` 是**只读**路径（§11.7）：AI 读写它一律被拒，
    因此 AI 无法给自己加一条免确认模式来摘掉自己的确认闸门。
- **动态路径不开口子**：`llm.providers.*` 与 `mcp.servers.*` 整棵子树都在黑名单里，
  端口聚合逻辑遇到它们直接返回失败；工具也因此**没有**删除 provider / MCP 服务器的能力。
- **单次 `set` 是全有或全无**：跨分组的多条改动聚合成**一个** patch 一次性交给 `applyPatch`，
  不存在「写一半」的中间态；但两次 `set` 调用之间当然不是事务。

## 13. 语音输出（TTS，v0.8.0）

v0.8.0 起助手回复可以「读出来」：把助手消息的纯文本交给**用户自己配置**的 TTS 服务合成音频，
由渲染层播放。本节只约定**出网协议与边界**；字段与设置页见 docs/08 §1 / §6，
交互窗的按钮与状态见 07 §2.3，联网范围见 11 §4。
它与 §3 的 LLM 提供者是**同构但完全独立**的两套 provider：`tts.providers.<id>` **不复用**
`llm.providers.<id>`（可以是同一家厂商、同一个 Key，也可以是另一家），
`tts.active` 指向默认 TTS provider，空串 = 未配置。

### 13.1 配置面

| 字段 | 语义 |
|---|---|
| `tts.enabled` | 语音功能总开关；`false` 时朗读入口整体消失（不发请求） |
| `tts.active` | 默认 TTS provider id；**空串 = 未配置**（此时不合成，交互窗的朗读按钮也不出现） |
| `tts.autoRead` | 回复结束后自动朗读最后一条助手消息（默认 `false`） |
| `tts.maxChars` | 单次朗读的文本上限，默认 2000、Schema 限 50–4096，超出截断（见 §13.4） |
| `tts.providers.<id>.{type,baseUrl,apiKeyEnc,model,voice,speed,format}` | provider 条目；`type` 为 `openai-compat`（§13.2）或 `dashscope`（§13.6） |

- `type` 是枚举：未识别的类型视为**不可用**，不猜测、不回落（不把它当 `openai-compat` 试一次）；
  新增 `dashscope` 是纯增量枚举，旧配置天然合法，无需版本迁移。
- `format` 取 `mp3 | opus | aac | flac | wav | pcm`（`TTS_FORMATS`），`speed` 限 0.25–4；
  `voice` 是厂商自己的音色 id（如 `alloy`、`FunAudioLLM/CosyVoice2-0.5B:alex`），Aurora 不维护音色字典。
- `tts.providers` 与 `llm.providers` 一样是**动态 record**：缺项 ≠ 删除（见 §12.4 的合并语义）。

### 13.2 请求协议（OpenAI 兼容 `/audio/speech`）

```http
POST <baseUrl>/audio/speech
Authorization: Bearer <apiKey>
Content-Type: application/json

{ "model": "<model>", "input": "<被朗读的文本>", "voice": "<voice>", "speed": 1, "response_format": "<format>" }
```

- 端点由**用户填的地址 + 固定路径**拼出（与 §3 的 chat 端点同一个套路），拼接前在主进程
  `speechEndpoint()` 里按下面的规则规整 `baseUrl`（实测 404 大多来自「漏写 /v1」或
  「误把完整端点当 baseUrl 粘贴」，规则是根治这两类填法）：
  1. 去尾部斜杠，避免出现 `//audio/speech`；
  2. 剥掉误填的已知端点尾巴：`/chat/completions`、`/completions`、`/models`、
     `/audio/transcriptions`（`/audio/speech` 保留「已以它结尾不重复拼」的现有行为）；
  3. 用 `new URL()` 解析：`pathname` 为空或 `/`（用户只填了域名根，如 `https://api.siliconflow.cn`）
     自动补 `/v1`；带路径（`/api/v1`、`/compatible-mode/v1` 等）尊重不动；
     URL 非法则按原样拼接，把错误交给服务端报出来（不在这里抛）。
- 模型列表：`GET <baseUrl>/models`（同一套规整：剥尾巴后拼 `/models`，已以 `/models` 结尾不重复拼），
  `Authorization: Bearer` 同款；响应按 OpenAI 格式解析 `data[].id`（防御性解析，畸形响应折成
  失败 + 中文提示，不抛）。设置页「获取模型列表」按钮走 `tts:listModels` 通道（见 docs/08 §6）。
- **404 文案带实际请求的 endpoint**：`describeHttpFailure` 在 404 时回传实际请求的完整 URL
  （如「接口不存在：实际请求了 https://…/v1/audio/speech…」），用户无需开日志即可自查
  baseURL 是否漏了 /v1、网关是否不支持该端点。
- 成功响应体是**音频二进制**（不是 JSON），直接交给渲染层播放；只有**错误**响应才按 JSON 解析原因。
- 出网必须走主进程的 `netFetch`（见 AGENTS.md「网络出网统一走 `main/net.ts` 的 `netFetch`」），
  这样 `advanced.proxy` 对它同样生效；`agent-core` 侧只接受注入的 `fetchImpl`，
  **不得 import electron**（§2 分层）。
- 主进程侧只有**超时取消**：合成请求用 `AbortController` 兜住默认 30s（试听 15s）超时，
  超时按失败降级处理（见 §13.5）。渲染层的「停止」**不取消已发出的请求** ——
  它只停掉播放并**丢弃过期回包**（合成结果回来时若已经换代，直接丢掉不播），
  不为一次朗读引入端到端取消通道。

### 13.3 凭据来源

- `tts.providers.<id>.apiKeyEnc` 存的是 Electron `safeStorage` **密文**（形如 `v10:…`），
  与 `llm.providers` / `mcp.servers` 同一套；明文路径约定为 `tts.providers.<id>.apiKey`，
  **明文只走 `settings:setSecrets`**（渲染层提交 → 主进程加密落盘）。
- **渲染层不持有明文**：`settings:get` / `settings:changed` 只回传 `apiKeySet` 标记，
  `apiKeyEnc` 在渲染层始终是空串（同 docs/08 §1.1，因此回传里的「空」= 本次不改凭据）；
  解密只发生在主进程即将发起请求的那一刻。
- `tts.providers` 在 `SETTINGS_READONLY_PREFIXES` 里：AI 的 `set_setting` **一律拒绝**读写它（§12.2），
  provider 的增删改只能由用户在设置页完成。
- 日志与「导出脱敏配置」里的该凭据一律 `***`（11 §5）。

### 13.4 `maxChars` 截断语义

- 朗读文本取自**助手消息的 `content`**（助手回复的原始正文），先 `trim()` 丢掉首尾空白；
  本轮**不剥离 Markdown 标记**（`**`、代码块围栏、链接语法都会原样送去合成），这是已知取舍。
- 长度按**字符数**计算；超出 `tts.maxChars` 时从**尾部截断**，超出部分不下发，
  结果里用 `truncated: true` 回报（渲染层据此可提示「已截断」；**不改写**被朗读的文本、
  也不往文本里补任何提示串）。
- 截断发生在**发送前**：超长回复不会整段出网，`maxChars` 同时是一条隐私边界（见 11 §4）。

### 13.5 失败降级与「不做 STT」的边界

- **合成失败只提示，不影响对话**：网络错误 / 4xx / 5xx / 超时 / 音频无法播放，一律降级为
  在那条消息旁显示失败状态 + 一句简短原因，**不抛进工具循环、不写会话历史、不弹系统级错误、不自动重试**；
  流式回复与后续对话完全不受影响，重试由用户再点一次按钮。
- **无可用 provider 就不发请求**：`tts.enabled = false`、`tts.active` 为空、或指向不存在的条目时，
  朗读按钮不渲染（07 §2.3），`tts.autoRead` 也一并静默跳过——不能退化成「每个 provider 都试一遍」。
- **语音输入（STT）自 v0.0.1 起落地**，与 TTS 同构但独立（`stt.*` 配置组，见 §15）；
  本节标题里的「不做 STT」仅对 v0.8.0 有效。

### 13.6 DashScope 原生协议（type: dashscope）

`type: 'dashscope'` 的 provider 走 DashScope 原生**非实时**合成协议：百炼官方网关
（`https://dashscope.aliyuncs.com/api/v1`）与「千问AI平台」等 DashScope 式网关
（`https://maas.qianwenaiapi.com/api/v1`）实测**不提供** OpenAI 兼容的 `/audio/speech`，
必须走多模态生成端点。设置页编辑卡用「接口类型」下拉切换（`tts.providers.<id>.type`）。

- **端点**：`POST <base>/services/aigc/multimodal-generation/generation`，`base` 是 DashScope
  原生根地址。主进程 `dashscopeEndpoint()` 拼接前先按 `normalizeDashscopeBaseUrl()` 规整
  （剥尾与去尾斜杠复用 §13.2 的同一套规则），再按下面的规则补齐——已以完整生成端点结尾时
  不重复拼（也不补 `/api/v1`）：
  1. `pathname` 为空或 `/`（只填了域名根）→ 自动补 `/api/v1`；
  2. 以 `/api` 结尾（如 `https://maas.qianwenaiapi.com/api`）→ 自动补 `/v1`
     （少写 `/v1` 是该类网关的高频 404 来源，规则直接根治）；
  3. 其余路径（`/api/v1` 等）尊重不动；URL 非法按原样拼接，错误交给服务端报（不在这里抛）。
- **请求头**：`Authorization: Bearer <apiKey>`、`Content-Type: application/json`，与 §13.2 同款。
- **请求体**：
  ```json
  { "model": "<model>", "input": { "text": "<被朗读的文本>", "voice": "<voice>" }, "audio": { "format": "wav | mp3 | opus" } }
  ```
  `audio.format` **条件携带**：仅当用户配置的 `format` 是 `wav` / `mp3` / `opus` 三者之一时才发
  （该协议只认这三种输出格式；`aac` / `flac` / `pcm` 不发 `audio` 字段，按服务端默认下发）。
  **没有 `speed` 参数，永不发送** —— 该协议不提供语速控制，OpenAI 兼容体的 `speed` 在这里
  没有对应字段，发了只会被忽略或报错。
- **响应与二次下载**：2xx 响应体是 JSON，音频在 `output.audio.url`（**24h 有效**的签名地址，
  另有 `output.audio.expires_at` 与 `output.finish_reason`），**必须再发一次 GET 下载**
  才能拿到音频字节。二次下载：
  - **不带 `Authorization` 头**（OSS 签名 URL 带鉴权头可能被拒）；
  - 有**独立的一份超时预算**（与合成请求同款 `AbortController`，各算各的，不共享计时器）；
  - 非 2xx 折成「音频下载失败（HTTP xxx）：<host>」——**只带 host 不带完整 URL**，
    签名参数不进日志与错误文案（`output.audio.url` 本身含签名，同样不落日志）。
- **mimeType 推导顺序**：下载响应的 `content-type`（`audio/*` 才采用，丢弃 charset 等参数）
  → URL 扩展名 → `provider.format` 对应的 MIME（与 openai-compat 共用同一张 MIME 表）。
  这条顺序是**必须的**而不是锦上添花：qianwenai 网关实测会**忽略 `audio.format`**（要求 mp3
  也回 `audio/x-wav`），mimeType 若照抄配置值就会以错误的 MIME 交给渲染层播放。
- **模型列表**：与 openai-compat 共用 `tts:listModels` 通道；dashscope 用
  `GET <base>/models`（同一套根地址规整，裸域名补 `/api/v1`、`/api` 结尾补 `/v1`）。
  qianwenai 实测该端点是**分页**的（`output.total` 共 518 个模型、TTS 系列排在后段），
  因此 dashscope 按 `?page_no=<n>&page_size=100` 翻页拉全（页数封顶 6，防失控；
  `output.total` 拿满 / 空页即提前停）。解析按顺序认三种形状（防御式，畸形不抛）：
  OpenAI `data[].id` → DashScope 原生 `output.models[]`（条目形如 `{model, name, ...}`，
  `model` 是规范 id、`name` 是展示名）→ 顶层 `models` 数组回落；对象元素依次认
  `model` / `id` / `name` 字段，字符串元素原样收。
- **404 文案按类型区分**：`describeHttpFailure` 的 404 提示按 `provider.type` 取词 ——
  dashscope 为「请检查 baseURL 是否以 /api/v1 结尾（DashScope 原生地址）」，
  openai-compat 维持 §13.2 的原文案；其余状态码文案两类型共用，404 同样带实际请求的 endpoint。
  另外 DashScope 式网关对「模型不在这个端点族」回 **400 + `url error`**（不是 404），
  dashscope 的 4xx 文案识别到 `url error` 时会提示换模型或查 baseURL（见下条实测）。
- **qianwenai 实测的模型适用面**（2026-09，供排障参考；`qwen-tts` / `qwen3-tts-flash` 实测
  合成成功）：走本 HTTP 协议的是 `qwen-tts` / `qwen-tts-latest` / `qwen3-tts-flash` 等非实时
  模型；**`qwen-audio-3.x-tts-*` 与 CosyVoice / Sambert 系列在该网关只走 WebSocket 实时**，
  两个 HTTP 端点都会 400 `url error`；`qwen-tts` 只认内置音色（Cherry / Serena / Ethan 等），
  声音复刻 id（如 `longanlufeng`）不被接受——复刻音色要在 HTTP 上可用，得等平台侧的
  非实时复刻模型或 Aurora 支持 WebSocket 协议。
- **边界**：CosyVoice 异步任务 API（`/services/audio/tts`，POST 建任务 + 轮询取结果）与
  WebSocket 实时合成**不在支持范围** —— 本协议只覆盖「一次 POST 拿 URL + 一次 GET 拿音频」
  的非实时路径；`output.audio.url` 的 24h 有效期对朗读场景（拿到即播）绰绰有余，
  Aurora 不做音频缓存。

## 14. 扩展工具五件套（v0.0.1）

v8 起内核新增五个「看 / 通知 / 剪贴板 / 生图」工具（Design/betav2-spec.md §6.2）。
分层与 §11 的电脑操控工具同一套：**内核只定义工具与端口**（`tools/web-fetch.ts` /
`tools/clipboard.ts` / `tools/notify.ts` / `tools/imagegen.ts`，纯 Node、可单测），
真实系统能力由主进程实现端口后注入（`apps/desktop/src/main/tools/` 下对应实现）。

| 工具 | 端口（内核） | 主进程实现 | 敏感级 |
|---|---|---|---|
| `web_fetch` {url} | `WebFetchPort.fetch(url)` | `createNetWebFetchPort`（netFetch + 剥标签 + 截断） | safe |
| `clipboard_read` () | `ClipboardPort.read()` | `createElectronClipboardPort`（Electron `clipboard.readText`） | **confirm**（隐私） |
| `clipboard_write` {text} | `ClipboardPort.write(text)` | 同上（`clipboard.writeText`） | **confirm** |
| `notify_user` {title, body} | `NotifyPort.show(title, body)` | `createNotificationPort`（映射到 `NotificationService.notify`，复用去重 / 点击打开 / 日志） | safe |
| `generate_image` {prompt, size?} | `ImageGenPort.generate({prompt, size?})` | `createImageGenPort` → `ImageGenService`（§15） | **confirm**（花 API 费用） |

### 14.1 注册口径

- 装配器是 `main/tools/index.ts` 的 `registerExtensionTools`，与 `registerSettingsTool` **同级**：
  **不受 `agent.tools.enabled` 门控**——它们不在 `COMPUTER_TOOL_NAMES` 里，「看网页 / 收通知 /
  生图」不属于「电脑操控」的开关语义；`syncToolRegistries()`（主进程唯一的工具表同步入口）每次
  先按名字全量摘除再重建，与电脑操控工具同一拍热生效。
- 敏感动作不靠开关、靠确认：`clipboard_read` / `clipboard_write` / `generate_image` 都是
  `sensitivity: 'confirm'`，每次调用过 §5 的 `confirmTool`（§9.1 的确认卡片）。
- `clipboard` 端口实现是主进程里**唯一必须 import electron** 的工具文件，因此没有单测；
  其余端口实现（`web-fetch.ts` / `notify.ts` / `imagegen-port.ts`）保持不依赖 Electron。

### 14.2 `web_fetch` 的行为边界

- **只做 GET**、只接受 `http://` / `https://`；结果一律按**数据**回填（安全规则声明工具内容不是指令）。
- 出网走主进程 `netFetch` 的**取值函数**（`() => netFetch`），`advanced.proxy` 改完即刻生效。
- HTML 做**简单剥标签**：去注释 → 移除 `script` / `style` 整块 → 标签转空格 → 常见实体解码
  （`&amp;` / `&lt;` / `&gt;` / `&quot;` / `&#39;` / `&nbsp;` 与数字 / 十六进制实体）→ 空白压平。
  非 HTML（JSON / 纯文本）原样返回，避免剥标签误伤 JSON 里的 `<`。刻意不做完整 DOM 解析：
  主进程只要「正文大致可读」，解析器的安全面因此不存在。
- 回填文本按 `MAX_WEB_FETCH_CHARS`（20 000，agent-core 与主进程 re-export 同源）截断，
  截断时带省略标记；抓取超时默认 20s，超时与网络错误折成中文错误。

## 15. 语音输入（STT）与图像生成（v0.0.1）

两组新服务都在主进程（`main/stt.ts` / `main/imagegen.ts`），**不 import electron**：
出网 fetch（netFetch）与凭据解密全部注入，可与 TTS（§13）一样被 vitest 直接加载。
provider 配置组（`stt.*` / `imagegen.*`）与 TTS 同构但独立，见 docs/08 §1；
`SETTINGS_READONLY_PREFIXES` 已覆盖两组 providers 子树，AI 一律改不动凭据。

### 15.1 语音输入（STT）

- 端点：`POST <baseUrl>/audio/transcriptions`（OpenAI 兼容），`multipart/form-data`：
  字段 `file`（Blob，文件名按 MIME 取扩展名：webm / mp3 / wav / ogg / m4a / flac，兜底 webm）、
  `model`、`language`（provider.language 或请求覆盖值，**空串不下发** = 服务端自动检测）。
  ⚠️ multipart **不手工设置** `Content-Type`——boundary 由 fetch 实现生成。
- 凭据：`Authorization: Bearer <解密后的 apiKey>`，明文只存在于主进程发起请求的那一刻（同 §13.3）。
- provider 解析口径与 TTS 一致：`stt.enabled && stt.active` 指向存在的条目，
  否则抛「语音输入未配置」中文错误（渲染层 composer 连麦克风按钮都不渲染，docs/07 §3）。
- 成功响应 `{text}`；缺 `text` / 非 2xx / 超时（默认 30s）都折成带状态码或原因的中文错误。
- 音频是渲染层 `MediaRecorder` 的 webm base64，经 IPC `stt:transcribe` 上来，**不落盘**：
  转写完成后只有文本进会话，录音即弃。

### 15.2 图像生成

- 端点：`POST <baseUrl>/images/generations`（JSON），body `{model, prompt, size, n:1, response_format:'b64_json'}`；
  `size` 取 provider 配置或请求覆盖值（Schema 白名单：`512x512` / `768x768` / `1024x1024` /
  `1024x1792` / `1792x1024` / `auto`）。超时默认 120s（生图显著慢于对话）。
- 响应优先取 `data[0].b64_json`；部分服务不遵守 `response_format` 只回 `url`，
  此时用注入的 fetch 下载（同样走 netFetch）。PNG 解码后落盘
  `<userData>/generated/<Date.now()>-<6位随机>.png`（目录不存在则递归创建）。
- 返回 `{filePath, dataUrl}`：`filePath` 进工具回填文本（`generate_image` 工具的结果只有路径），
  `dataUrl` 只走 IPC 给渲染层直接预览；**图片的 base64 不进会话、不进工具回填**，
  否则一张图就能撑爆上下文预算。
- `imagegen:read`（渲染层预览已生成图片的唯一通道）做**路径安全校验**：
  `path.resolve` 后必须在 generated 目录内（`..` 逃逸、换盘符、目录本身一律拒绝），
  越界路径返回错误，不读盘。

## 16. 思考链展示（reasoning，v0.0.1）

支持「输出思考过程」的模型（DeepSeek / Kimi / OpenRouter 等）的思考链现在会被采集并展示，
语义有三条边界：

1. **只认独立字段**：SSE 增量按 `delta.reasoning_content ?? delta.reasoning` 提取
   （字符串、可空；`reasoning_content` 优先）。`content` 里内嵌的 `<think>...</think>`
   **不做**解析——避免把正文误伤成思考。
2. **事件与持久化**：内核流事件联合新增 `{type:'reasoning', delta}`；agent loop 转发为
   `AgentEvent 'reasoning'`（**带该轮助手消息的 `messageId`**，见 §16.2），
   同时把增量累积进当条 assistant 消息的 `reasoning` 字段，随 `append` 一起持久化
   （`StoredMessage.reasoning`，重启后历史仍可回看）。
3. **API 回传不携带**：把历史消息回传给模型时只挑 `role` / `content` / 工具调用字段，
   `reasoning` 是**展示字段**，不进对话请求——它是模型自己的输出，回传只会干扰采样，
   也避免把上一轮的思考链泄漏成下一轮的上下文。

### 16.1 事件契约：`seq` 与 `round`（2026-09）

展示层此前踩过两类"顺序错乱"，根因都不在界面代码，而在事件本身缺少**顺序与归属信息**：

| 症状 | 根因 | 现在怎么防 |
|---|---|---|
| 工具卡挂到了别的回复里 / 跑到列表末尾 | 事件没有任何序号，渲染层只能"到一条建一条、新建就 push 到末尾" | 每个 `AgentEvent` 带 `seq`（主进程 `emit` 统一分配、会话内单调递增）；渲染层按 `seq` **插入到正确位置** |
| 多轮工具调用时，第二条助手消息带上了第一轮的思考全文 | `reasoning` 增量没有 `messageId`（那轮消息要等流结束才落盘），渲染层只能按 `requestId` 全局累积 | 增量事件**自带该轮预领的 `messageId`**（§16.2），一条增量对应一条消息，不再需要按轮次分桶 |
| 请求结束（`done`）之后仍有事件进来，界面继续长内容 | `requestId` 过滤在 `activeRequest === null` 的窗口期形同虚设 | 渲染层记 `finishedRequests`（最近 64 条），**同一 requestId 在 done/error 之后的事件一律丢弃**；本地主动 abort 也立即把该请求标记为已结束 |
| 历史水合把正在流式的消息对象换掉，`pending` / 工具卡闪一下甚至消失 | 水合是「服务端快照整体替换本地」 | 水合改为**按 id 合并**：内容取更长的一份，本地流式状态（`pending` / `error` / 附件 / 思考）优先保留 |
| 同一会话第二轮起，刚发出的用户消息被压到整轮回复之后 | 本地发送的 user 气泡没有 `seq`（seq 是主进程的事件序号），`insertOrdered` 按 seq 扫描时**跳过无 seq 消息继续前扫**，此后每条新回复都越过气泡插到它前面 | `user-message` 广播到达时把发送方本地气泡**补上 seq**（它就是同一条消息）；`insertOrdered` 扫描遇到无 seq 的本地消息**即停在它后面**，不再越过 |

- **事件形状**（`packages/shared/src/ipc/types.ts`）：`text` / `tool` / `reasoning` / `subagent`
  都带 `seq` 与 `round`，**四者都带 `messageId`**（`reasoning` 自 §16.2 起补齐），
  `usage` 带 `seq` 与 `round` 但不带 `messageId`（它描述的是**一次请求**的用量，不属于某条消息）。
- **`seq` 由 agentHost 的 `emit` 统一分配**（`AgentEventInput` 类型在编译期禁止调用点自带序号）——
  序号是"发出顺序"的单一事实来源，散在各调用点迟早会不一致。

> **历史注记（2026-09 流式轮前的做法，已废弃）**：思考增量不带 `messageId` 时，渲染层按
> `(requestId, round)` 分桶累积、再由同轮的 `text` / `tool` 事件把桶绑到消息上，并在收尾时
> 加固"无主草稿"。那套机制连同它的两个边界（收尾重复灌入 `reasoningLive`、纯思考阶段界面
> 一片空白）在 §16.2 里被**预领 `messageId`** 一条取代：既然 id 在流开始前就有，增量就能
> 直接落到它自己的消息上，分桶与"无主草稿"都不再存在。

### 16.2 正文流式渲染与 token 用量（2026-09）

**问题**：交互窗此前是「等模型把这一轮全部说完才出现回复」——`runAgentLoop` 把流里的
`text` 增量 **只累积不转发**，等这一轮结束、助手消息落盘拿到 `messageId` 之后，
才把**整段正文**作为**一条** `text` 事件发出去。思考链反而是边收边转发的，于是「模型在思考」
时界面有动静（后来又发现纯思考阶段连消息都还没建、什么都看不到），而**正文一直是空等到最后**。

**解法：id 预领 + 增量直达**。落盘与展示对 id 的需求顺序是反的（展示要**先有** id，落盘
在流结束时才发生），因此把 id 的分配从 `append` 里**提前**出来：

- `SessionStore.nextMessageId()`：只发号不落盘，与 `append` 共用同一个计数器；
  `NewMessage.id` 可显式指定，`append` 原样沿用（不给就照旧自动生成，老调用点无感）。
  循环内部还有个 `msg-local-…` 兜底生成器，供**没注入** `nextMessageId` 的单测使用 ——
  前缀刻意与 store 的 `msg-<ts>-<n>` 不同，两条计数器互不可见，同毫秒撞 id 会让界面把两条
  消息当成同一条。
- `runAgentLoop`：每轮**先领 id**（`messageId`），`text` 与 `reasoning` 增量都**立即转发**并带上它；
  该轮结束时 `append` 用**同一个 id** 落盘。于是渲染层那条"边流边渲染的半成品"与磁盘上的最终
  消息**就是同一条**，水合按 id 合并时不会把它换掉、也不会重复出现。

由此带来三个直接的界面结果（见 docs/07 §2.3）：

1. **正文逐字出现**（对齐主流 Agent Desktop），流式光标与"湿润边缘"遮罩落在最后一条助手消息上；
2. **纯思考阶段可见**：`reasoning` 也带 `messageId`，思考能在正文之前就建出那条消息并展开思考块
   （这是「正在思考」有东西可看的**前提**——消息不存在时，思考块无从渲染）；
3. `message.pending` **只在 `done` / `error` / abort 收尾时清除**（不再随第一条增量清掉），
   于是「朗读」按钮等依赖 `pending === false` 的入口不会在流式途中闪出来；
   收尾时把**所有**还在 `pending` 的消息一并清掉（`settlePending()`），而不是只清当前那条 ——
   一轮只调工具、不产出正文时那条消息由 `tool` 事件建立，只清「当前助手消息」会把它漏下，
   界面上表现为「已结束的消息上三点动画一直转」（2026-09 复核发现并修掉）。

**token 用量（`usage` 事件）**：`ChatEvent` 的 `done` 本来就带 `provider` 报回的
`TokenUsage`（`promptTokens` / `completionTokens` / `totalTokens`），此前被循环整个丢掉。
现在每轮结束时转发一条 `AgentEvent { type: 'usage', round, usage }`：

- `promptTokens` 就是**这一轮真实占用的上下文长度**（系统提示词 + 历史 + 本轮内容），
  是输入框底部「上下文详解」的唯一分子来源；逐轮累加即本会话消耗；
- **只用于展示、不落盘**：它是「本轮请求的上下文占用」，重放历史时重新收集没有意义；
- `TokenUsage` 另有一个可选字段 `cachedTokens`（命中服务端前缀缓存的 prompt token 数）——
  解析口径、缺省语义与展示位置见 §21.4；它同样只用于展示、不落盘；
- provider 没回传 `usage` 时**整条不发**，界面如实显示「暂无用量数据」（不拿字符数换算冒充 token）；
- `openai-compat` 在流式请求体里带上 `stream_options: { include_usage: true }`（OpenAI 规范：
  流式下只在**最后一片**给 usage，且要先显式索取）。**不认这个字段的网关会直接 400**，
  因此 `openStream()` 对「报文点名了 `stream_options` / `include_usage` 的 400」**去掉该字段重试一次**
  ——「整个对话打不开」比「拿不到 token 用量」严重得多。其它 400（模型名错等）不重试，如实报错。

### 16.3 增量下发与渲染吞吐（2026-09 性能轮）

**问题**：§16.2 保证的是「增量确实发下去了」，**不保证界面画得过来**。实测报告的现场是
「思考内容还没渲染完，Agent 已经把整个任务做完了」。两个叠加的放大器：

1. **每条增量都让整份对话的 markdown 重解析**：渲染层 `MessageList.vue` 的 `rendered` computed
   用 `{ ...message }` 展开，顺带把 `reasoning` 也读了进去 —— 思考增量**根本不需要 markdown**，
   却按「整份 transcript」的代价付费，全过程退化成 O(n²)；
2. **全链路没有任何合并**：1 个 SSE token = 1 次 `webContents.send`（`broadcast` 还发给**所有**
   存活窗口）= 1 次渲染层回调 = 1 次 Vue flush。推理模型思考阶段常 80–150 token/s，
   这个密度下「每条增量都做一件 O(整个会话) 的事」必然崩。

**解法：三层各管一段，都不改变语义与顺序。**

| 层 | 位置 | 做什么 |
|---|---|---|
| 主进程 | `main/event-buffer.ts` | 相邻（队列尾）且 `(sessionId, requestId, messageId, type)` 全同的 `text` / `reasoning` 增量拼接合并为一条（保留**首条**的 `seq`），窗口 **16ms** 批量下发 |
| 渲染层状态 | `renderer/shared/composables/useChatDeltaBuffer.ts` | 同一帧内同 `messageId` 的增量合并为一次消息写入，**每帧最多 apply 一次** |
| 渲染层视图 | `MessageList.vue` | markdown 结果按**消息对象**（`WeakMap`）缓存，只有该条 `content` 变了才重跑解析 |

三条硬约束（改这三层时不许破）：
- **顺序与终态不能变**：主进程的 `done` / `error` / `user-message` 与渲染层的任何**非增量**事件
  都必须**先 flush 已缓冲的增量、再处理自己** —— 否则工具卡会插到正文前面、`done` 会先于最后一段正文落地。
- **不丢内容**：合并只是拼接 `delta` + 保留首条 `seq`，事件条数变少但文本一字不少；
  非增量事件**永不**与前后增量合并（顺序即真相）。
- **不延迟终态**：`done` / `error` 同步下发，不排在 16ms 窗口之后。

**为什么仍然不做逐字打字机**：正文是 `v-html` 渲染的 markdown，Vue 对 `v-html` 不做 DOM diff
（见 07 §2.3）；按帧做真打字机等于每帧重解析 markdown，与本轮「把每 token 的重活降下来」的目标相反。

**回归防线**：原有流式探针只发 2 条分片，密度太低、**必然测不出**这个 BUG。新增爆发探针
（`chat-stream-burst`：桩服务按 `burst-probe` 标记各发 150 条 reasoning / content、间隔 5ms，
**外加两轮各 2 万字的前文堆量** —— 代价与「整份 transcript」成正比，不堆量时连修复前都只测出空闲水平）。
判据是两组同量级仪器：**20ms 心跳漂移**与 **rAF 帧间隔**；`PerformanceObserver` 的 longtask
只当兜底 —— Chromium 只上报单任务 > 50ms，而本 BUG 的代价形态是「每片几毫秒的持续饱和」，
**修复前后 longtask 都是 0，它对这条 BUG 没有分辨力**（这点是实测踩出来的，别改回去）。

2026-09-26 本机实测（修复前 → 修复后）：

| 指标 | 修复前 | 修复后 | 阈值 |
|---|---|---|---|
| 最坏心跳漂移 | 661.4ms（肉眼可见的 0.5s 级冻结） | 51.0ms | 160ms |
| 心跳超时累计 | 4749.4ms | 108.8ms（四窗口全开时 552ms） | 1200ms |
| 最坏帧间隔 | 137.5ms | 29.2ms | 110ms |
| 掉帧数 | 238 | 0 | 25 |

**主判据是最坏心跳漂移**（661 → 51，差一个数量级）。`心跳超时累计` 是**累计量、对 CPU 争用
明显更敏感**（同一份代码：只跑 chat 组 69ms、另一个代理并发时 182ms、四窗口全开 552ms），
所以它的阈值取 1200ms —— 仍比修复前低约 4 倍，真回归照样 FAIL，但不会因为旁边多开两个窗口假 FAIL。

阈值取「修复后 × 约 3 倍」（实测为 0 的项给绝对下限，否则 `0 × 3 = 0` 会把机器抖动判成假 FAIL），
只断言数量级；**改桩的密度或 transcript 规模等于改基准的量纲，必须重新标定**。

**这条探针证什么、不证什么**（别把它当成端到端的性能保证）：它证明**渲染层**不再产生
0.5s 级冻结与掉帧。但本机桩侧的**发送路径**本身要 ~4.9s（5ms 的定时器被拖到约 16ms/片），
所以它**不能**证明「真实模型速度下端到端不再落后」—— 修复后渲染窗口与桩侧发送耗时已同量级，
瓶颈看起来已移出发送之外的固定代价，那需要另一条线单独测（不要据此认为性能问题已全部收口）。

## 17. settingsHint：Agent 可修改设置清单注入 systemPrompt

- `SystemPromptParts.settingsHint?: string`（agent-core）渲染为独立小节
  「## Agent 可修改的设置」，位于工具使用规范之后、安全规则之前（§5 的固定小节顺序）；空片段自动省略。
- 主进程在 `main/settings-hint.ts` 维护**一段固定中文清单**：逐条列出 §12.2 显式可写覆盖表
  同口径的路径（`llm.providers.<id>.model/reasoningEffort/temperature`、`tts.*`、`stt.*`、
  `imagegen.*` 开关、`general.edgeBar.*`、`general.chat.showThinking`、`modes.current`、
  `modes.work.workspaceDir`、`modes.classroom.*`、
  `agent.tools` 下的**逐条枚举**——`enabled` / `workspaceDir` /
  `terminal.{enabled,timeoutMs,maxOutputChars}` / `files.{enabled,maxReadBytes}` /
  `search.{enabled,maxResults}` / `open.enabled`、`skills.userDir/disabled`、
  `advanced.quietHours`），
  并注明「凭据类一律只读、改动即时生效」。
  **`agent.tools` 不再用通配写法**：`terminal.*` 现在包含只读的 `terminal.allowPatterns`（§11.7），
  写成通配会出现「说能改但不能改」的偏差，正是本节末条要避免的。
- 清单只是**提示词**，真实可写面永远由 `canWriteSettingPath` 判定（工具端口不认清单）：
  两边最多出现「能改但没说」的保守偏差，不会出现「说能改但不能改」。
- 注入点（正式通道）：`KernelAgentHost` 新增 `settingsHint` / `todoSummary` 两个装配依赖——
  前者由主进程直接传 `main/settings-hint.ts` 的 `SETTINGS_HINT` 常量，后者由装配层按会话生成
  （§18 的清单摘要，随会话切换与清单更新而变）。早期经 `composeModePrompt()` 附加的旁路已删除，
  `main/settings-hint.ts` 只保留 `SETTINGS_HINT` 常量；§5 小节顺序里的「Agent 可修改的设置」
  即由 `settingsHint` 渲染，「当前任务清单」即由 `todoSummary` 渲染。

## 18. 任务清单工具（todo_write / todo_read，v0.0.2）

内核获得「维护当前任务清单」的能力：模型把工作计划写成一份结构化清单，跨轮次留存——
历史被截断 / 摘要压缩后，清单仍经 §5 的「当前任务清单」小节完整可见。
清单是**会话级**的：快速会话（quick）/ 交互窗（main）/ 设置会话（settings）各有一份，
互不串台。

| 工具 | 参数 | sensitivity |
|---|---|---|
| `todo_write` | `{ todos: [{ content, status }] }`，**整表替换**（非增量追加） | safe |
| `todo_read` | 无参数，读回当前清单 | safe |

- **条目结构**：模型只提供 `content` 与 `status`（`pending | in_progress | completed`），
  **id 由工具侧生成与维护**，不在模型参数里——整表替换语义下模型无需关心 id。
- **防护上限**：清单最多 **100 项**；单项 `content` 超过 **500 字符**截断。
  **不限制 `in_progress` 数量**——「一次只有一个 in_progress」是提示词约定
  （§5 的清单维护规范），不在工具层强制。
- **持久化**：`userData/todos/<sessionId>.json`，主进程实现 `TodoPort`
  （原子写 + 300ms 防抖 + 退出前 `flush()`，与 `SessionStore` 同一套 `FileSystemPort` 约定，见 §4；
  文件损坏按 §4 会话文件同款处理——备份后重建为空清单）。内核只认注入的端口（§2 分层）。
- **systemPrompt 注入**：装配层按会话读清单生成摘要，经 `KernelAgentHost.todoSummary`
  传给内核，渲染为 §5 的固定小节「当前任务清单」（空清单自动省略）；注入与工具读写的是同一份。
- **子代理**：§19 的子代理使用独立清单文件（`<sessionId>-sub`），与父会话清单互不影响。
- **注册口径**：由 `registerAgentCoreTools`（todo + task 一并注册，见 §19）承载，与
  `registerSettingsTool` / `registerExtensionTools` **同级**（§12 / §14.1），**不受
  `agent.tools.enabled` 门控**——任务清单是 Agent 自身的工作能力，不属于「电脑操控」的开关语义。
- **已知边界**：本轮**没有独立 UI 面板**，清单进度通过工具执行卡片摘要可见
  （每次 `todo_write` 就是一张普通工具卡片）；后续可加专用面板，届时只消费 `userData/todos/`，
  不动工具契约。

## 19. 子代理工具（task，v0.0.2）

`task` 给主循环一个「派发独立子任务」的工具：在**全新的上下文**里跑一遍 §5 的工具循环，
把最终文本带回父循环。定位是**上下文隔离**——大段资料阅读、多步检索这类中间过程很长的子问题，
不把过程撑进父会话历史。

| 工具 | 参数 | sensitivity |
|---|---|---|
| `task` | `{ description, prompt }` | safe |

- **取舍（safe、不弹确认）**：`task` 标记 `sensitivity: 'safe'`，不走确认卡片——子代理只用
  父工具表里已放行的非确认工具（见下），权限面不会比父循环更宽；但它**消耗独立的模型调用**
  （费用与时延随子循环轮数增长），这个代价靠 §5 的「子代理使用规范」约束使用时机，不靠逐次确认。
- **上下文隔离**：子代理从**空白历史**开始，系统提示词独立组装（子代理人设 + 子工具清单 +
  安全规则；不含父会话的模式片段 / 感知摘要 / 任务清单小节）。子循环的消息**不写入会话历史、
  不落盘**；结束后只把**最终文本**作为工具结果回填父循环，超过 **20_000 字符**截断（带截断标记）。
  父模型应把子任务需要的上下文**写进 `prompt`**——子代理看不到父会话。
- **工具白名单（双保险）**：取父工具表中 `sensitivity !== 'confirm'` 的工具，再**排除 `task` 自身
  与 `mcp.*` 前缀**——即 `read_file` / `list_dir` / `grep` / `glob` / `web_fetch` / `notify_user` /
  `use_skill` / `todo_write` / `todo_read` 这类；执行命令（`run_command`）、写文件（`write_file`）、
  **改文件（`edit_file`）**、打开路径（`open_path`）、剪贴板、生图、`set_setting` 与全部 MCP 工具
  在子代理里**一律不可见**（它们都是 `confirm` 级）。
  （MCP 工具本就全量 `confirm`，前缀排除是双保险：防未来出现 safe 的 MCP 工具时白名单失守。）
  `todo_write` / `todo_read` 在白名单里，读写的是 `<sessionId>-sub` 的独立清单文件（§18）。
- **无递归**：子代理工具表里没有 `task`，子代理不能再生子代理。
- **同轮多个 `task` 按顺序执行**（沿用 §5「同轮工具顺序执行」口径），结果顺序确定。
- **失败与边界**：provider 缺配置 → `isError` 回填（不发起请求）；abort 传导到子循环，
  以已产生的**部分结果**回填；子代理达到轮次上限（默认 8，同主循环）时结果附「部分结果」标记，
  父模型据此决定是否重派。
- **注册口径**：随 §18 的 `registerAgentCoreTools` 一并注册，**不受 `agent.tools.enabled` 门控**。

### 19.1 实时进度与「子代理」页面（2026-09）

子代理的对话过程**不落会话存储**（刻意的上下文隔离），因此此前在界面上只能看到一张工具卡：
既不知道它在干什么，也读不到它的报告全文（报告只回传给主代理）。现在有两条改动补上这一点：

- **进度上报**：`ToolContext` 新增 `emitProgress?(payload)` 与 `toolCallId`。`task` 工具在子循环
  每个事件（文本段 / 工具调用开始与结束）后组一份 `SubagentSnapshot` 上报：
  `{ taskId, callId, description, prompt, status, startedAt, endedAt?, steps[], toolCalls, report? }`。
  步骤按 `call.id` 原地更新（同一工具调用不会出现两条），步骤数上限 60、单步文本 4000 字符、
  报告随累积实时带上（上限同 `MAX_TASK_RESULT_CHARS = 20_000`）。**过期保护与限额只影响展示**，
  回传主代理的报告口径不变。
- **流转**：`runToolStreaming`（§5）把上报的进度转成 `subagent` 事件流；agentHost 补上
  `sessionId` / `requestId` / `seq` / `messageId` 后照常广播。工具结束时，最终快照随
  `ToolResult.subagent` 一起落到**工具卡**里（`StoredToolCall.subagent` → 会话 JSON），
  因此重启后仍能回看。
- **界面**（`07 §2.3`）：`task` 工具卡展开体里是「运行轨迹」（进度条 + 步骤时间线 + 报告）；
  左栏固定项「子代理」把主区切到**子代理页面**，集中展示本会话的全部运行
  （数据 = 实时事件与工具卡持久化快照按 `callId` 合并，实时优先）。
- **失败路径不变**：进度上报是**可选端口**（未注入时静默丢弃，直接调用工具的单测不受影响）；
  上报本身抛错不影响子代理执行与结果回传。

## 20. 工具使用契约（对齐 opencode，2026-09）

本轮把 opencode（仓库 `sst/opencode`，`dev` 分支，commit `adee738`，MIT License）的
`packages/opencode/src/tool/*.txt` 工具提示词**作为规格文本**逐条对照落地：只借用它的文本约定，
**不缝合它的代码**——它是 Effect + Vercel AI SDK + Bun 优先的体系，工具契约与 Aurora 的
纯对象 `ToolDefinition` + 注入端口是两套世界观，中间没有适配层。
对照结论如下（**采用** = 按原样落地；**改写** = 取其结论、按 Aurora 的既有形态实现；
**不采纳** = 明确不做，理由见末列）。

| opencode 原文要点 | Aurora 的结论 | 落地位置 | 理由 |
|---|---|---|---|
| `read.txt`：用绝对路径；默认返回**开头 2000 行**；`offset` 是 **1 起始**行号；内容按 `<行号>: <内容>` 前缀返回（文件内容 `foo\n` → 返回 `1: foo\n`）；目录按一行一条返回（子目录带尾 `/`，无行号）；**单行超 2000 字符截断**；建议并行读多个文件、不要切成 30 行的小片段；不确定路径先用 `glob`；大文件用 `grep` 定位 | **采用** | §11 的 `read_file` 输出契约与参数（`offset` / `limit`） | 行号前缀是 `edit_file` 的 `oldString` 的引用基准（两者必须同一口径）；「一次读足够大的窗口」比多次小片段调用省 token，也让模型少犯错。两处按 Aurora 语义落：目录列举归 `list_dir`（`read_file` 拒绝目录）；「并行读」= 同轮批量发出、执行仍按顺序（§5） |
| `read.txt`：可把**图片 / PDF** 作为附件读入（视觉附件） | **不采纳** | §11.4 已知限制 | Aurora 的 `read_file` 明确拒绝二进制（含 NUL 即报错），图片 OCR 未启用；把二进制交给模型需要多模态附件链路，本轮不存在 |
| `edit.txt`：**改前必须在本会话 Read 过该文件**，否则工具报错；`oldString` 必须与 Read 输出**去掉行号前缀之后**的内容逐字一致（保留缩进）；找不到 → 报错；命中**多处** → 报错并要求补足上下文或改用 `replaceAll`；`replaceAll` 用于全局改名 | **采用** | §11.6（读前守卫 + 唯一性拒绝 + EOL 保真） | 读前守卫防「凭记忆改文件」，唯一性拒绝防「命中多处却只改第一处」——两条都是**静默改坏文件**的直接来源 |
| `grep.txt`：正则内容检索，不限制仓库规模；`include` 支持 `*.js` / `*.{ts,tsx}` 这类过滤；返回**文件路径 + 行号 + 命中行** | **采用** | §11.5（`grep` / `glob` 搜索层规格） | 「路径 + 行号」与 `read_file` 的行号前缀对齐，模型可直接跳到目标行再精确读 |
| `grep.txt`：需要**计数**或更复杂统计时改用 `Bash` + `rg` | **不采纳** | §11.5 与 `grep` 的 description | Aurora 的命令工具是 `run_command`（PowerShell）且**逐次确认**——没有 `rg` 可用，也不该为了数一下命中数再弹一次确认卡片；因此 `grep` 的工具描述**不承诺**计数能力（要统计由模型自己数，或由用户处理） |
| `glob.txt`：按文件名模式匹配（`**/*.js`、`src/**/*.ts`），只返回文件路径 | **采用** | §11.5（模式语法与结果格式） | 与 `grep` 分工明确（文件名 vs 内容），两者都是 `safe` 级只读工具，不产生副作用 |
| `todowrite.txt`：清单维护的强约束（多步跟踪、状态流转） | **改写：整表替换** | §18 | Aurora 的 `todo_write` 是**整表替换**（模型每次提交完整清单，条目 id 由工具侧生成维护），不是增量更新；单代理单会话场景下整表语义更简单，也不会产生「孤儿条目」 |
| `task.txt`：子代理可以再派生子代理（多级编排） | **改写：不可递归** | §19 | Aurora 的 `task` 子代理工具表里**没有 `task`**，子代理不能再生子代理——防无限递归与模型调用费用爆炸；多级编排本轮不做 |

### 20.1 措辞规范

- Aurora 的工具 `description` 一律**中文**，顺序固定为「**先说做什么 → 再说什么时候用 →
  最后说注意什么**」（副作用、上限、失败原因都要写清）；与 opencode 的英文原文**不逐字对应**，
  但**信息量对齐**——该说的边界一条不能少。
- 工具名沿用既有命名族：文件类带 `_file` 后缀（`read_file` / `write_file` / `edit_file`），
  通用检索名词保持裸名（`grep` / `glob`）——模型对这两个名字的先验最强。
- 文案里的数字（默认 2000 行、单文件 1 MiB 等）应引用内核导出的常量，不要在文案里另写一份字面量。

## 21. prompt caching：前缀稳定化与命中观测（2026-09）

Aurora 只讲 OpenAI 兼容协议，而主流网关（DeepSeek / OpenAI / 硅基流动等）的 prompt 缓存是
**服务端自动生效**的：只要请求体的**开头**逐字节不变，就命中前缀缓存、按更低的单价计费。
因此本节做的是「让前缀稳定下来」+「把命中量显示出来」，**不引入显式缓存断点**。
（后来版本新增过配置字段与提示词小节——v13 的 `projects.*` / `agent.permissionMode` 与
`## 项目约定`——但它们都不触及这条原则：新小节一律落在**易变段**，见 §5.1。）

### 21.1 系统提示词：静态在前、易变在后

- 本小节讲的是那次**纯重排**：`SystemPromptParts` 的字段集合当时一个不加不减，只**调整渲染顺序**。
  此后 v13 新增过一个可选字段 `projectInstructions`（§5.1），它按同一原则落在**易变段**——
  顺序表仍是唯一的判据，新增小节照它插队即可。
  即 §5 的顺序表：静态 / 半静态段（基础人设 → 当前模式 → 可用 Skill 清单 → 可用工具清单 →
  工具使用规范 → Agent 可修改的设置 → 安全规则）在前，易变段
  （**更早对话的摘要 → 当前任务清单 → 项目约定 → 系统状态**）在末尾。
- 理由：前缀缓存按**最长公共前缀**命中，而「系统状态」每轮都带时间与前台窗口、
  「任务清单」与「历史摘要」随对话变化——易变小节排在中间时，它**之后**的全部静态文本
  （数千字符）每轮都要重新计费。把它们挪到末尾后，`[静态段]` 本身成为可复用的稳定前缀。
- 回归判据是一条**公共前缀断言**，它的**精确边界**是：
  `最长公共前缀 = 静态段 + '\n\n' + '## 更早对话的摘要' + '\n'`（**精确到第一个易变小节的标题行末尾**）。
  注意「静态段 + 一个接缝」（`stat + '\n\n'`）只是这个前缀的**下界**、不是它：
  第一个易变小节的**标题行在两轮里逐字节相同**（它是共用文案），因此它必然也落在公共前缀里，
  公共前缀比接缝长一个标题行；真正分清两轮的第一个字符是易变**正文**的第一个字。
  断言同时钉住「接缝之后紧邻的第一个小节就是易变段的第一个（「更早对话的摘要」）」，
  把「前缀长度」变成语义断言——往后改顺序只改这一处。
  v13 新增的 `## 项目约定` 落在**易变段内部**（排在「当前任务清单」之后、「系统状态」之前），
  因此这条边界**不变**：接缝之后紧邻的第一个小节仍然是「更早对话的摘要」。

### 21.2 工具数组：按工具名排序

- `ToolRegistry.toLlmTools()` 改为**按工具名排序**返回（字典序比较，**不用 `localeCompare`**
  ——它是 locale 相关的，跨机器可能给出不同结果）。排序的**唯一实现**就在这个方法里，
  `toLlmTools()` 是请求链路上的唯一来源：改排序只改它。
- 排序的**生效点在工具循环**（不是注册表本身）：`runAgentLoop` 调 `options.tools.toLlmTools()`
  取发给 provider 的 `tools` 数组——此前那份同文件私有的 `toLlmTools` helper 已删除，
  避免两份实现漂移（只改 `registry.ts` 而不改 `agentLoop.ts` 的写法**不会改变请求体**，是假 PASS）。
- 理由：`registerComputerTools.sync()` 的语义是「先按名字全量摘除、再按当前配置重建」，
  按 Map 插入序返回会让任何一次设置变更把工具挪到数组末尾 → 请求体里的 `tools` 数组顺序变化 →
  **整个前缀失效**（缓存白建）。排序后顺序只取决于名字集合，与注册先后无关。
- 系统提示词里的工具清单（`describeTools`）用**同一个有序列表**生成
  （`agentHost` 传的是 `this.deps.tools.toLlmTools()` 的返回值），
  否则「提示词里的顺序」与「请求体的顺序」不一致，缓存与展示都会拧。

### 21.3 请求侧：不需要改动

`runAgentLoop` 组装的消息已经是 `[system, ...history, user, extraContext]`：
易变的本轮附加上下文 `extraContext` 已在**尾部**，`[system, ...history]` 天然就是稳定前缀。
**这一处不做任何改动**（含 `messages` 的元素顺序），只补一组回归断言把它钉住：
`messages[0]` 是 system 且内容就是传入的系统提示词；有历史时 `messages[1..n-1]` 依次是历史、
最后一条是本轮用户输入；给了 `extraContext` 时它是**最后一条**（易变内容在尾部）。

### 21.4 命中观测：`TokenUsage.cachedTokens`

- 共享契约 `TokenUsage` 增加可选字段 `cachedTokens?: number` —— 命中服务端前缀缓存的 prompt
  token 数，**provider 未回传时缺省**。
- 解析口径（两种厂商形态都要认）：优先 `prompt_tokens_details.cached_tokens`（OpenAI 形态），
  否则 `prompt_cache_hit_tokens`（DeepSeek 形态）；取值必须经有限性与非负检查，
  **两者都缺 → `undefined`，不拿其它数字冒充**（例如拿 `prompt_tokens` 填进去）——
  0 与「没回传」在界面上必须可区分。实现上 `cachedTokens` 在缺省时**整个字段不出现在 `usage`
  事件里**（不是带一个 `undefined` 的键），与同目录 `done` 事件的缺省口径一致。
- 展示口径：只在对话窗的「上下文详解」条展示**最近一轮**的命中量，**不落盘**——
  它是可再生的观测值，写进会话存储只会让持久化契约多一个可变字段。
  折叠态文案形如 `512 / 128k · 缓存命中 512（100%）`（命中片段是
  `data-field="chat.context-cache"`，嵌在 `chat.context-usage` 文案里；展开的详解卡里是独立一行
  「缓存命中（最近一轮）」）：
  - 百分比 = `Math.min(100, Math.round(cachedTokens / promptTokens * 100))`——
    `cachedTokens` 是**服务端报的命中数**，正常不会超过 `promptTokens`，但桩服务 / 异常网关
    可能给出不一致的数据，界面不显示「缓存命中 512（400%）」这类荒谬值；
  - `promptTokens` 为 0 或缺失时**只显示绝对数、不显示百分比**（不编造分母）；
  - `cachedTokens` **缺省时整段不渲染**（不显示「缓存命中 0」——那会与「没回传」混淆）。
- 累计口径：渲染层把每轮 `cachedTokens` 累加进 `usage.totals.cachedTokens`（缺省按 0 累加），
  与 prompt / completion / total 三个累计量同一条 `usage` 事件路径。

### 21.5 明确不做

- **不引入显式 `cache_control` 断点**：那是 Anthropic 方言，写进请求体在不少网关会直接 400
  （与既有 `stream_options` 降级同一个坑）。
- **不加任何配置字段**（因此没有迁移、没有新设置页 UI）：前缀稳定化是内核的固定行为，
  不需要用户开关。
- 本轮不做 prompt 费用累计统计与缓存命中率的长期报表（只做「最近一轮」的即时展示）。

