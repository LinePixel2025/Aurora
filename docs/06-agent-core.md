# 06 · Agent 内核设计

状态：`已定稿`（v1 基线；P3 已完成——会话 / 工具循环 / Skill 执行 / MCP 客户端均已落地，
"已定稿"指设计不变，实现细节见各节标注的 v1 / P3 范围）。
2026-09 工具面扩充：电脑操控工具新增 `edit_file` / `grep` / `glob`（见 §11.5 / §11.6），
`run_command` 新增免确认模式列表（§11.7），系统提示词改为「静态在前、易变在后」并补上
prompt caching 的前缀稳定化与命中观测口径（§21）。
v0.2.8 内核新增**运行档**：`AgentHostDeps.runProfileFor` + `RunProfile`（人设 / `## 本次运行` /
`hiddenTools`）与请求级工具摘除（`ToolSource` / `filterTools`，见 §5.2）—— 唯一消费方是
自动化触发的会话（docs/13 §7.1）。

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

- 稳定实现 `OpenAiCompatProvider`：`baseURL + apiKey + model`，兼容 DeepSeek / OpenAI / Ollama / vLLM 等（见 ADR-003）；
  第二个实现 `OpenAiResponsesProvider`（OpenAI **Responses API**，v22 新增）见 §3.2。
  多模态（图片输入）见 §3.1。
- 设置中可保存多组模型配置并切换默认；思考等级等参数可调（v23 起随模型绑定，见下）。
  另有一份候选列表 `llm.providers.<id>.modelList` 只决定 UI 里能选什么，
  内核侧只认生效的 `(providerId, model)`，见 08 §1/§5。
- **会话级模型（本轮）**：每个会话可以覆盖「用哪个模型」——覆盖写在**会话文件自身**
  （`sessions/<id>.json` 的 `meta.llm = { providerId, model }`，经 `chat:setSessionModel` 写入 /
  清除），**不是配置项、不进 `CONFIG_VERSION` 迁移链**（与 `meta.projectId` / `meta.permissionMode`
  同一条零迁移路子）。解析链为：**会话覆盖 > Center 官方语言模型（启用且目录可用）>
  全局 `llm.active` + 该 provider 的 `model`**。覆盖里的 provider 已被删除 / model 为空时
  **静默回落全局**（逐次执行不刷 warn，与 `meta.projectId` 绑定失效同款）；Center 官方不可用时
  继续按现有回落与运行态提示处理。
  存 `(providerId, model)` **一对**而不是只存 model：模型名可跨 provider 重名，且思考等级等参数
  是 `providers.<pid>.modelParams[<model>]` 名下的（见下），只存 model 会在切 provider 后取错参数表。
  取值口径：内核每轮经注入的 `AgentProviderFactory.createForSession({ sessionId })` 现解析
  （`provider.create()` 仍是全局语义、`isReady()` 仍看全局；未注入 `createForSession` 的老装配器
  行为逐字不变）；子代理（§19）经 `parentSessionIdOf` 剥回父会话，**继承父会话的模型**。
  Center 的 `session.setModel` 远程命令（docs/12 §6.3）走同一个 `SessionStore.setModelOverride`；
  网页端会话行可看可切（docs/12 §6.3）。
  对话窗输入区的模型选择器采用「模型来源 + 模型」双下拉：来源为 `Center 官方` / `用户模型`，
  不再提供「跟随全局」清除项。没有 `meta.llm` 的旧会话先如实显示当前实际生效的全局选择，
  但不立即写盘；用户首次切换来源或模型时才写入覆盖。`用户模型` 聚合全部非 `center-*` Provider
  的 `model` 与 `modelList`，保存的仍是 `providerId + model` 一对。Center 模型选中后，
  思考等级按其目录参数只读展示，不允许改本地 `center-llm` 参数。
- 可靠性：指数退避重试、单请求超时（默认 60s）、流式中断可取消（AbortSignal 贯穿到 IPC）。
- `ChatRequest.reasoningEffort` 由
  `llm.providers.<id>.modelParams.<modelId>.reasoningEffort` 驱动，取值
  `auto | low | medium | high`；`auto`（默认）时**不下发** `reasoning_effort` 字段。
  设置页「AI 模型」的模型行内参数与对话窗输入区的「思考」下拉**两处入口写的是同一个字段，
  没有第二份来源**：改哪一处，下一次请求都按新值下发。（等级**本身不按会话覆盖** ——
  会话级模型只决定「用哪个模型」，等级随该模型的参数表取，见上条。）
  **v23 起思考等级随模型绑定**：`modelParams` 是**按模型 id 键的参数表**
  （`Record<modelId, { reasoningEffort, contextWindow, vision }>`；`modelList` 仍是 `string[]`
  候选列表），参数取的是**当前生效模型**（`llm.providers.<id>.model`）名下的那一份 ——
  `model` 是唯一生效值、参数随之取，切模型即切等级。未命中的键由唯一入口
  `resolveModelParams(provider, modelId?)` 回落默认
  （`{ reasoningEffort: 'auto', contextWindow: 0, vision: false }`，`modelId` 缺省取 `provider.model`）；
  主进程 / 渲染层 / Center 三处取值都走它，不各写一套。

### 3.1 多模态输入（图片进模型，v22）

- **线上形状**：`ChatRequestMessage.images?: LlmImageInput[]`，其中
  `LlmImageInput = { mimeType, dataBase64, name?, detail? }`（`dataBase64` 是**裸 base64**，
  不带 `data:` 前缀）。非空时该条消息的 `content` 由字符串变成 **content parts 数组**：
  正文一段 `{ type: 'text', text }` + 每张图一段
  `{ type: 'image_url', image_url: { url: 'data:image/png;base64,…' } }`。
  正文为空时**只发图片分片**、不发空 text 分片 —— 部分服务把空 text 当「空消息」直接 400。
- **落地链**：渲染层拖入的附件始终是**绝对路径**（`SendMessageRequest.attachments`，没有第二套
  上传通道）。主进程按扩展名分流：`png / jpg / jpeg / webp / gif / bmp` 是图片，其余仍走
  `extract.ts` 提取文本 —— 同一轮里「一段提取文本 + 若干图片」可以并存，两者走的是同一条
  `chat:send`（图片路径经 `agent.send({ images })` 透传给内核，内核用注入的 `loadImages`
  端口读成 base64）。
- **会话历史存路径、不存 base64**（`StoredMessage.images?: string[]`）：会话文件体积不被图片
  撑大（一张 4 MB 的图 base64 后是 5.3 MB，几轮对话就能把 `sessions/*.json` 顶成几十 MB），
  跨轮次续聊时按路径**重新读盘**，用户追问「刚才那张图里的公式」时模型仍看得到图。
  代价是历史里那份图片会被重复计费（与「图片一直留在上下文里」的通行做法一致）。
  文件被删 / 读不出时**该轮跳过这张图并记 warn**：不编造内容，也不因此让整轮请求失败。
- **能力开关：当前生效模型在 `modelParams` 里的 `vision`（默认 `false`）**：模型是否支持图片
  输入因模型而异，与本仓库不做内置模型表的口径一致（`vision` 与 `contextWindow` 同处一张参数表）。
  判据是当前生效模型（`llm.providers.<id>.model`）在
  `llm.providers.<id>.modelParams.<modelId>` 里的 `vision`，未命中的键由 `resolveModelParams`
  回落**缺省关**（`vision: false`）。关闭时图片按**未读取**降级成
  一行文字（`【附件】a.png：内容未读取（当前模型未开启图片输入）`），请求体里不出现图片分片 ——
  对不支持视觉的模型发图片会被服务端 400，**整个对话都用不了**，这个开关就是那道闸。
- **上限**：单图 `IMAGE_MAX_BYTES`（8 MiB，超出按未读取处理并在降级文案里写明原因）、
  单轮附件数沿用既有的 `MAX_ATTACHMENTS`（5，图文合计）。`detail` 字段在类型里预留但**当前不下发**
  （多数网关不认它）。
- **工具产出的图片（图像工具，见 §25）**：`view_image` / `screenshot` / `clipboard_read_image`
  的结果图走一条独立于附件的通路 —— `ToolResult` 新增 `images`（`{ path, image }`，`image` 是端口
  已读好的 `LlmImageInput` 裸 base64）：**路径随 tool 消息落盘**（`StoredMessage.images`，与用户附件
  存路径同款），**图片内容作为一条合成 user 消息**在本轮**全部 tool 结果之后**下发 —— 同轮多工具调用
  时插在中间会破坏 tool_call ↔ tool 的配对，服务端直接 400。历史重放时同样补这条合成 user 消息，
  图片经既有 `resolveImages` 解析，因此关闭态返回空数组的那道闸门自动生效；回放口径与用户拖入的附件
  一致（存路径、跨轮重放）。`generate_image` 只回路径 + 渲染层预览（§15.2），不走这条通路。

### 3.2 Responses API（`type: 'openai-responses'`，v22）

- `llm.providers.<id>.type` 由单值枚举扩为 **`openai-compat | openai-responses`**（纯增量，
  旧配置天然合法，见 08 §1）。前者走 `POST {baseUrl}/chat/completions`（既有实现不动），
  新增的 `OpenAiResponsesProvider` 走 `POST {baseUrl}/responses`，`stream: true`。
  装配层（`createProviderFactory`）按 `config.type` 分派，其余（思考等级 / 图片输入 / 附件）
  两套协议共用同一份上层逻辑。
- **请求映射**：**首条** `system` 消息（系统提示词）→ 顶层 `instructions`；其余 `system` 消息
  （如技能正文与附件文本）**保留在 `input` 里的原位**、以 `{ role: 'system', content: [...] }`
  下发 —— 这样「易变内容靠尾部」的性质与 chat-completions 侧一致，前缀缓存不被破坏。
  用户 / 助手消息 → `{ role, content: [{ type: 'input_text' | 'output_text' }, { type: 'input_image', image_url }] }`；
  assistant 的每次工具调用是**独立条目** `{ type: 'function_call', call_id, name, arguments }`，
  工具结果是 `{ type: 'function_call_output', call_id, output }`（顺序按对话原序，不能合并进上一条消息）。
  `tools` 用**扁平**形状 `{ type: 'function', name, description, parameters }`（不套 `function` 一层）。
  `reasoningEffort` → `reasoning: { effort }`；`jsonObject` → `text: { format: { type: 'json_object' } }`；
  `max_output_tokens` **仅在给了值时才出现**（不认这个字段的推理模型会 400）。
  **v23 起请求体不再下发 `temperature`**：主流 Agent（Claude Code / Codex 一类）不设该参数，
  由服务商默认值决定 —— 桌面装配层不再由配置喂值。内核侧的 `ProviderConfig.temperature?: number`
  这个可选能力**保留**（`fakeProvider` / 子任务 `task.ts` / 单测仍在用），只是配置里已无此字段。
  **`store: false` 恒定下发**：不在服务端留存会话（docs/11 的隐私口径）。
- **事件映射**（SSE 的 `data:` 负载统一带 `type` 字段）：
  `response.output_text.delta` → `text`；
  `response.reasoning_summary_text.delta` / `response.reasoning_text.delta` → `reasoning`；
  `response.output_item.added`（`item.type === 'function_call'`）开一条工具调用、
  `response.function_call_arguments.delta` 累加参数、`response.output_item.done` 收口并
  `yield { type: 'tool_call' }`；
  `response.completed` 带 `usage`（`input_tokens` / `output_tokens` / `total_tokens`，缓存命中读
  `input_tokens_details.cached_tokens`）与收尾原因；`response.failed`、`response.incomplete`
  （`incomplete_details.reason === 'max_output_tokens'` → `length`）与顶层 `{ type: 'error' }`
  映射为 `error` 事件 / 收尾原因。
- **工具调用 id 用 `call_id`**（形如 `call_…`），**不是**条目 id（`fc_…`）：下一轮的
  `function_call_output.call_id` 必须与它配对，拿条目 id 会被服务端直接拒绝、
  表现为「工具跑完了但对话再也继续不下去」。
- **可靠性**：超时 / 取消 / 指数退避 / 错误码 / `listModels` / `testConnection` 全部复用
  §3 抽出的共享传输层（`llm/transport.ts`），两个 provider 在这些行为上逐字一致；
  唯一的差异是 chat-completions 专有的 `stream_options` 降级重试，Responses 侧不适用。

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
- **会话自动标题（2026-10-05，`meta.title` / `titleState`）**：用户可见会话发出**首条用户需求**
  后，主进程异步复用该会话当前生效模型，把需求总结成 6–14 字的单行任务名，写入
  `meta.title`。标题请求与主回复并行，不阻塞对话、不新增聊天消息、不进会话历史，也不计
  `meta.usage`。成功时经 `chat:sessionTitleChanged` 推送 `{ sessionId, title }`，左栏与主区标题
  原位更新；失败时静默保留“首条用户消息前 24 字”的回退标题，并把内部 `titleState: 'pending'`
  留在会话 meta 中，后续用户发送时重试。`awareness-` / `auto-` / `-sub` 等隐藏后台会话跳过；
  升级前已有且没有 `pending` 标记的旧会话不批量回填。`meta.title` 非空时永不自动覆盖。
- **会话文件格式版本**（`SESSION_FILE_VERSION`，与 `CONFIG_VERSION` 是两条独立的链）：
  v1 → v2 加 `meta`（上面那条）；v2 → v3 加 `StoredMessage.images`（图片附件**路径**，§3.1）；
  **v3 → v4** 加 `asks`（提问留痕，§24）；**v4 → v5（本轮）** 给工具卡加
  `displayImages`（对话图片区，§14）；**v5 → v6** 给 `meta` 加 `title` / `titleState` ——
  **v6 → v7** 给消息加可选 `requestId`（请求级工作折叠与总用时）—— 六条都是
  **可选字段、无迁移脚本**，
  读取侧宽容归化（缺字段 = 没有那个能力），版本号只用于说明"这个文件可能带什么"。
- **会话绑定项目（v17，2026-09，`chat:setSessionProject`）**：`meta` 新增可选
  `projectId?: string`（`''` 与缺字段都算未绑定，空 meta 判定同步覆盖，不写空键）；
  写入 / 清除走 `SessionStore.setProject`（幂等 + await 落盘，惯例与 `setArchived` 全同）。
  解析链与消费方见 §5.1 的「会话级项目」段。
- **会话空间（2026-09-30，主界面左栏三分）**：`meta` 新增可选
  `space?: 'agent' | 'work'`（`SessionSpace`；`'code'` 为 Code Mode 预留取值，当前不产生）。
  它把左栏会话列表分成三个**工作目录互不相同**的分区（docs/07 §2.3）：
  **项目对话**（绑定了 `projectId`，工作目录 = 项目根）/** 工作目录对话**（`space: 'work'`，
  Work 模式专属，工作目录 = `modes.work.workspaceDir`）/** Agent对话**（`space: 'agent'` 或未标记，
  含 `quick` 与历史会话，工作目录 = 固定 `%USERPROFILE%\Desktop\Aurora`）。
  写入入口：`SessionStore.setSpace` + `createSession({ space })`（新建时只记**内存 pending meta**，
  首条消息 append 时才并入落盘 —— 保持「空会话不落盘」的不变量）；`chat:newSession` 的可选参数
  `{ space?, projectId? }` 是 IPC 层入口（`projectId` 校验存在性，同 `chat:setSessionProject`）。
  空间目录是**回落链的一级**（§5.1）与 `confirm` 档的**权限边界根**（§11.2）：
  `confirm` 档下 Agent 会话在桌面 Aurora 目录之内直接执行敏感工具、之外逐次确认；
  `auto`（完全权限）不再弹确认卡（**不是 OS 级沙箱**，`run_command` 仍是当前用户权限）。
  space 与 projectId 一样是**会话数据**：不进 `config.json`、不进 `CONFIG_VERSION` 迁移链。
- 渲染层挂载时通过 `chat:history` 水合消息列表，因此重启后交互窗仍能看到历史。
- **会话内存有界（2026-10-04 性能轮）**：`SessionStore` 的 `cache` 只保留最近活跃的若干个
  已装载会话（`maxLoadedSessions`，默认 8；脏的 / 正在写盘的 / 正在读盘的永不淘汰），
  被淘汰的会话下次 `ensureLoaded` 自动重读；`summaries()` 不再把每个会话的消息都常驻内存 ——
  它先用 `summaryCache` 命中已算过的摘要，未装载的会话按「读盘 → 算摘要 → 立即释放消息」处理，
  因此 `chat:sessions` 的内存占用与磁盘会话总量脱钩（归因见 Memory 的性能轮记录）。
- 上下文窗口管理：超长自动摘要压缩（P1）；v1 先按 **字符上限（默认 60k）** 截断旧消息并保留系统提示词，
  且截断时保证「assistant(toolCalls) + 其后 tool 结果」成对保留。
- **quick 会话滑动窗口（2026-09 起）**：快速会话（`sessionId = 'quick'`）组装 LLM 上下文时
  只保留**最近 5 分钟内**的消息（窗口常量 `5 * 60_000` ms 写死在装配层，不进配置 Schema），
  更早的消息仅留在存储与界面历史里，不进 LLM；过滤后为空就按「只有本轮输入」组装。
  窗口模式下**跳过滚动摘要**：不读、不写累计摘要（summaries），`systemPrompt` 不注入
  「更早对话的摘要」小节 —— 旧摘要本身就是同样的污染源。其余会话不受影响，仍全量组装。
  装配开关是 `AgentHostDeps.quickContextWindowMs`（默认 0 = 不启用，行为与从前完全一致）。
- **会话级用量累计（2026-10-03，`meta.usage`）**：内核在每轮 usage 事件处
  **先调 `SessionStore.addUsage` 累计进 meta、再广播事件**（字段
  `promptTokens / completionTokens / totalTokens / cachedTokens / rounds`，随会话文件落盘，
  300ms 防抖）。渲染层切回会话时以 `chat:sessions` 摘要带出的这份值为**种子**恢复累计
  （覆盖而非相加——meta 恒 ≥ 渲染层已计入部分），平均缓存命中率因此按**会话**算、
  跨切换跨重启连续（展示口径见 §21.4）。
- **手动压缩（2026-10-03，`/compact` → `chat:compact` → `agent.compact`）**：
  把**当时的全部消息**交给注入的 summarizer 压成一段摘要，写进 `meta.compact`
  `{ summary, at, upToMessageId }`（`SessionStore.setCompact`，await 落盘）。
  此后 `run()` 组装历史时只取 `upToMessageId` **之后**的消息（游标 id 被条数环挤掉时
  按全量兜底），摘要经 `previousSummary` 链注入 systemPrompt 的 `historySummary` 小节——
  **消息本体不删**，历史仍可在界面回看。三条口径：
  ① 在跑的会话**拒绝压缩**（E_BUSY 语义，`CompactOutcome.ok: false` 表达，不抛错）；
  ② 内存 `summaries` Map 与 `meta.compact` 由 compact() 写成同一份——进程内自动压缩链
  从内存续写，重启后回落落盘的 `meta.compact`（自动压缩的内存摘要仍不落盘，维持原口径）；
  ③ `/compact` 由渲染层斜杠命令**直接调 IPC**，不进 `chat:send` 发送链。
  回归护栏：`agentHost.test.ts` 的「手动压缩 /compact」组（落盘 / 组装裁剪 / 摘要注入 /
  在跑拒绝 / 空会话与无 summarizer 拒绝）。
- **user-message 事件（2026-09 起）**：`AgentEvent` 新增变体
  `{ type: 'user-message', sessionId, requestId, content, createdAt: number }` ——
  `content` 是用户原文（trim 后，不含技能改写），不带消息 id；内核在 `run()` 开始时广播。
  此前 user 消息没有任何事件，主界面发出的提问在提示条面板里看不到（assistant 流式事件
  只在面板空闲时才被放行）。渲染层去重口径（P2-19，2026-10-01 修正）：**只与「无 `seq` 的本地
  临时气泡」按内容对账** —— 末尾 30 秒窗口内匹配到一条尚未编号（`seq === undefined`）的同文本
  本地气泡就回填它的 `seq` / `createdAt`，否则追加一条新的 `u-evt-` 气泡；**已带 `seq` 的气泡
  一律跳过 content 匹配**（跨窗口 30 秒内重发同文本不再吞掉第二条、也不再错改第一条的 `seq`）。
  不能按 requestId 过滤：事件早于 `chat:send` 的 invoke 返回到达，发送方
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
  `origin`（`chat` | `edge-bar` | `resume` | `center` | `automation`）/
  `text`（本条任务的用户原文）/ `round` / `maxRounds` /
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
- **轮次与预算（配置项见 §5 与 08 §1）**：轮次上限取 `agent.loop.maxRounds`（v18 起默认 32），
  累计预算取 `agent.loop.maxTotalTokens`（**0 = 不限**）。
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
- **自动续轮**：轮次用尽但仍有 `agent.loop.autoContinueRounds` 额度（v18 起默认 8）且预算未触顶时，
  循环**不落 `paused`**，而是原地从 `cursor.nextRound` 接着跑一轮（等价于一次自动 resume），
  `budget.autoContinued += 1` 并**随游标一起落盘**；额度用完才落 `paused` 等用户点「继续」。
  续轮既然等价于自动 resume，历史组装就必须与手动续跑**同一口径**：每个 attempt 开始前
  **重新读取会话并按 `compressHistory` 组装历史**（系统提示同步重算），因此续轮请求一定带上
  本轮提问与已回填的工具结果——否则 `appendUserMessage = false` 的语义前提（"提问已在 history 里"）
  不成立，第二轮既没有提问也没有上一轮的工具输出，模型会重复已执行的写 / 命令操作。
  每一次自动续轮都写一条 `info` 日志（含 jobId、已续次数与额度）—— 这是"用户没盯着也继续往下跑"
  的行为，不给痕迹的话用户会觉得"轮次像没有上限"。
  ⚠️ **quick 会话窗口的已知豁免**（与手动续跑同一口径，非续轮修复的回归）：quick 滑动窗口启用时
  窗外消息（含本轮提问，若单 attempt 耗时超过窗口）不进 `history`，续轮请求同样看不到它——
  这是 §4「更早的仅留在存储 / 界面历史」的既定语义，窗口模式本就不产摘要兜底。
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
  空片段自动省略；**每个 attempt 即时组装、不做缓存**（自动续轮的第 2/3 个 attempt 同样重组，
  与「每 attempt 重读会话」是同一条不变量的两半，见 §4.1）。
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

「项目」是配置里的一个实体（docs/08 §1）：`projects.list[]` 每条是 `{ id, name, root }`。
⚠️ **v25 / 2026-10-02 起全局 `projects.current` 整体退役**（v24 → v25 迁移删除该字段）：
v17 起它就已经不决定会话的实际工作目录 / 边界，界面的「设为当前」早已过时 ——
项目现在只是「可被会话绑定的目录清单」，哪个会话用哪个项目由**会话绑定**（下段）决定。
项目根同时决定两件事：① 绑定它的会话每轮注入哪份项目级约定；② 权限层判定
「项目根之内 / 之外」的边界（§12.2）与缺省工作目录 / 搜索根（`effectiveWorkspaceDir`，
见本节末条）。解析链（2026-09-30 起含会话空间一级）：
**会话绑定项目 > 会话空间目录 > 激活模式目录 > `agent.tools.workspaceDir` > 主目录**
—— 未绑定会话落自己的空间目录（Agent 空间恒 `桌面\Aurora`）。

**会话级项目（v17，2026-09）**：每个会话可以绑定 `projects.list` 里的某一项——绑定写在
**会话文件自身**（`sessions/<id>.json` 的 `meta.projectId`，经 `chat:setSessionProject` 写入 / 清除），
**不是配置项、不进 `CONFIG_VERSION` 迁移链**（与归档同一条路，`''` 与缺字段都算未绑定）。
  解析链（2026-09-30 起加会话空间一级，见下）：**会话绑定项目 > 会话空间目录 >
  激活模式目录 > `agent.tools.workspaceDir` > 主目录**；
绑定项已被删除时**静默回落**空间目录（会话级绑定是可选的，逐次执行不刷 warn）。
三处消费方全部按**会话**解析（`main/tools/session-project.ts` 是唯一解析口径，别另写第二份）：
缺省 cwd / 搜索根（工具执行时经 `ctx.sessionId` 现调 getter）、项目根边界与 confirm 档判定
（`file-port` / `command-runner` 的 `workspaceRoot(sessionId)` 与 `createConfirmTool`）、
AGENTS.md 注入（`projectInstructions(sessionId)`，每轮组装提示词时按会话解析）。
其中缺省 cwd / 搜索根与边界根的取值经 `adaptForSubagent` 视图：子代理（§19）的 `-sub`
会话 id 先剥回父会话再解析 —— 子代理的工作目录跟随父会话（2026-10-02，docs/06 §19.2）。
中心会话（`center-` 前缀）与本地会话同一条逻辑，默认未绑定；绑定入口除本机
`chat:setSessionProject` 外还有 Aurora Center 的 `session.setProject` 远程命令
（docs/12 §6.3，走同一个 `SessionStore.setProject`）。
注意装载时序：同步取绑定走 `SessionStore.projectOf`（内存缓存读），其前提是
「会话的工具执行之前 `agentLoop` 必然已读过该会话」；允许 await 的路径（确认钩子 / 指令注入）
先用 `projectIdOf` 预热再取。

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
- **实现落点**：`packages/agent-core/src/config/project.ts`（`resolveProject` / `resolveProjectRootById`，
  纯函数，id 对不上即降级）、
  `config/effectiveWorkspace.ts`（`effectiveWorkspaceDir`：**会话项目根 > 项目根 > `agent.tools.workspaceDir` > 主目录**）、
  `config/agentWorkspace.ts`（`agentDesktopDir`：Agent 空间的固定工作目录
  `%USERPROFILE%\Desktop\Aurora`，纯函数、主进程负责懒创建目录）、
  `project/agentsFile.ts`（`collectProjectInstructions`，注入式 fs，永不抛错）、
  `project/instructions.ts`（`createProjectInstructionsSource`，按 root + mtime 缓存）；
  主进程在 `apps/desktop/src/main/index.ts` 用 `nodeProjectFs` 装配成 `projectInstructions` 依赖。
- **缺省工作目录 / 搜索根的回落链（以本节为准，Codex 式「一个会话一个工作目录」的唯一口径）**：
  `effectiveWorkspaceDir` 的取值顺序是
  **会话绑定项目根 > 会话空间目录（2026-09-30 起：`space: 'agent'` → `%USERPROFILE%\Desktop\Aurora`；
  `space: 'work'` → `modes.work.workspaceDir`，目录为空串时跳过本机继续旧链）>
  当前项目根（配置了当前项目时）> 激活模式工作目录（v18，当前只有 Work 模式）>
  `agent.tools.workspaceDir` > 用户主目录**（v17 会话级、v18 模式级、2026-09-30 会话空间级）。
  会话空间排在**全局当前项目之前**：空间是会话创建时刻的显式归属（左栏三分的判定依据），
  不随用户后来切 `projects.current` 漂移 —— 三分区的「工作目录互不相同」靠这一级保证。
  **未标记空间且未绑项目的会话（历史会话与 `main`）默认按 Agent 空间解析**：
  工作目录落 `桌面\Aurora`，这是 2026-09-30 的**有意行为变化**（此前它们回落
  `projects.current` / `agent.tools.workspaceDir` / 主目录）。
  已接进装配层：Agent 会话不显式传 `cwd` 的 `run_command` 与不传 `path` 的 `grep` / `glob`
  落在 `桌面\Aurora`；§11.1 / §11.4 / §11.5 说的「缺省 `cwd` / 缺省搜索根」
  都指这条链的结果，**工具执行链上不再设第二套口径**。
  设置页「打开工作目录」按钮（`openPath kind:'workspace'`，`ipc.ts`）**已接同一链**（2026-09）：
  解析抽为纯函数 `resolveWorkspaceOpenTarget`（`main/tools/workspace-target.ts`，不 import electron、可单测），
  配了项目时按钮打开**项目根**，Work 模式下未绑项目时打开**模式工作目录**，与命令缺省落地目录一致，
  早前的展示/执行分叉已消除；
  无项目时行为与旧两级解析（字面 `workspaceDir`，空串 = 主目录）逐字一致。
  注意 `kind:'workspace'` 与 `kind:'project'` 仍是两个入口：前者打开生效工作目录，后者固定打开当前项目根。

- **循环**：用户消息 → LLM → [工具调用 → 执行 → 结果回填] × N → 最终回复。
  轮次上限**默认 32**，由 `agent.loop.maxRounds`（1–128）配置（v18 放宽：原默认 8 会把长任务
  卡在半途，对齐 Codex / OpenHands 等主流 Agent「不在个位数轮次上断任务」的做法；
  v17 → v18 迁移把旧默认值抬升到新默认，见 08 §1）。
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
> - **确认判定返回四态 decision（2026-09，`ConfirmDecision`）**：`false`（拒绝，见上）/
>   `true`（用户**当次**在确认卡片上点放行，或用户已显式选择 `auto` 完全权限档）/
>   `'always'`（用户**当次**点「总是允许」：本次放行且本会话记住该工具名，见 §11.2
>   的会话级授权表）/ `'machine'`（**历史授权或免确认模式的机器放行**：
>   `allowPatterns` 命中、已记住 `'always'` 后的会话授权短路 —— 照常执行但不算用户当次批准）。
>   仅 `true | 'always'` 由内核置 `ctx.approvedByUser`；
>   `'machine'` 不置位，工具拿不到 `allowOutside`，端口层的项目根 realpath 兜底**保留**
>   （出处语义与边界效果见 §11.2）。
> - **确认链路本身抛错按拒绝处理**：确认交互不可用时宁可不执行敏感操作。
> - **未注入钩子时保持 P3 行为**（不拦截，仅留痕）——避免 P3 的 MCP 路径在确认载体
>   尚未接好时意外变成"必然被拒"。
> - 主进程侧由 `ProactiveScheduler` 承载（见 §9），60s 超时、勿扰时段一律按拒绝；
>   设置项 `advanced.confirmSensitiveTools` 可整体关闭，且**每次调用即时判断**（改设置无需重启）。
> - v0.7.0 起内核另有内置工具 `set_setting`（AI 修改自身配置，见 §12），
>   同样标记 `sensitivity = 'confirm'` —— 因此**每一次改配置都会弹确认卡片**，
>   走的正是上面这条链路。

### 5.2 运行档（RunProfile，v0.2.8）

同一个内核要跑两种运行：用户坐在窗口前发起的**交互式会话**，与自动化触发的**无人值守运行**。
两者的差别不是「另一个模式」（mode 是用户可切换的场景，见 §5 的「当前模式」小节），而是
**本次请求的来源**。内核因此多了一个可选依赖：

```ts
interface RunProfile {
  persona?: string                  // 替换 BASE_PERSONA（系统提示词的第一段）
  runContext?: string               // 渲染成「## 本次运行」小节
  hiddenTools?: readonly string[]   // 本次运行从工具面摘除的工具名
}
interface AgentHostDeps {
  runProfileFor?(context: { sessionId: string; origin: string }): RunProfile | undefined
}
```

- **`persona` 是替换不是追加**：交互式人设的第一条应对策略是「缺少信息时先问最关键的问题」，
  而无人值守时提问只会超时按跳过继续。因此自动化会话**整个换掉**人设，而不是在人设后面
  加一句"别提问"（两条相互矛盾的指令同时在场，模型会挑自己熟悉的那条）。
- **`runContext`** 渲染为独立小节 `## 本次运行`，位置**紧随「## 当前模式」，在「## 可用 Skill」
  之前** —— 属**静态段**（在「## 安全规则」之前），因此**不动 §21 的缓存边界**：
  静态段只是多了一节，而"接缝之后紧邻的第一个易变小节仍是「更早对话的摘要」"这条
  边界判据不变。未传 / 纯空白时整段省略，普通会话的提示词与从前逐字一致。
- **`hiddenTools` = 请求级摘除**：新增结构接口 `ToolSource`（`get` / `list` / `toLlmTools`）
  与纯函数 `filterTools(source, hidden)`，返回**只读视图** —— 被摘掉的名字在
  `get`（回 `undefined`，循环按「工具不存在」回填）/ `list` / `toLlmTools` **三处同时消失**，
  **原注册表不动**（注册表是进程级、`sync()` 按时重建的，而"哪些工具能用"是请求级的）。
  视图在 `agentHost` 组装请求时现造，提示词工具清单 / 工具使用规范 / 循环执行**三处消费
  同一个来源**（否则会出现"提示词里有、请求体里没有"这类两处不同口径）。
- **失败一律降级为「无运行档」**：`runProfileFor` 抛错时记一条 warn
  （「运行档解析失败，已按默认档继续」）并退回默认人设与完整工具面 ——
  运行档是提示词层面的定制，不是请求的前置条件。
- **唯一消费方是自动化触发的会话**（`origin === 'automation'` 或 `auto-` 前缀会话 id，
  含 `-sub` 子代理会话；判据与实现在主进程 `main/automation/run-profile.ts`，
  业务口径见 docs/13 §7.1）。普通会话（`chat-*` / `quick` / `center-*`）返回 `undefined`，
  提示词与工具面与从前逐字相同。

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
- **内置命令 `/init`（2026-10-03，与技能表无关的主进程命令）**：渲染层斜杠菜单选中后
  照常走 `chat:send` 发送链（用户气泡就是 `/init` 三个字符），`ipc.ts` 在透传前识别
  整串 `/init`（`main/agent-commands.ts` 的 `isInitCommand`），把初始化指令正文拼进本轮
  `extraContext`（与技能正文同一通道，只影响本轮、不落盘）。指令要求模型：先探查项目
  结构 → 已有 AGENTS.md 时**补全而非推翻重写** → 用 `write_file` 写在**会话边界根**下
  （`DesktopDeps.workspaceRootOf` = `sessionProjects.boundaryRoot` 回落链，与 file-port
  边界同源；未绑定项目时指令里说明这是 Agent 空间固定目录）→ 写完一句话总结。
  写入走模型自己的 `write_file`，受权限档 / 项目根边界约束，**不开任何旁路**；
  边界根解析不出时 `/init` 原样透传（按普通提问处理）。
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
| 前台窗口 / 应用 | PowerShell 探针（`GetForegroundWindow` + `GetWindowTextW` + 进程名） | 摘要即时读取（TTL 60s，非阻塞刷新，无后台定时器） | 上下文感知（“我在写什么”） |
| 显示器 / 屏幕状态 | Electron `screen`（主进程注入） | 摘要即时读取 | 窗口贴边策略 |
| 课程表（ClassRoom） | `manual` provider / ClassIsland 桥接 | 摘要即时读取 + 课前轮询（15s，自动化引擎节拍，docs/13 §3） | 课前提醒、`timetable` Skill |

- 前台窗口**不引入 `active-win`**：该原生模块预编译产物杀软误报多（03 §3），v1 直接用 PowerShell 探针；
  探针 stdout 由**导出的纯函数** `parseForegroundProbe` 解析，因此解析逻辑可单测、
  探测失败只降级为 `unknown`（ADR-007）。
  ⚠️ 探针本身要**新建 `powershell.exe` 并现场 `Add-Type` 编译 C#**，单次成本约 1s 级 CPU：
  因此**不挂后台定时器**，只在 `summary()` 消费时按 TTL（`foregroundTtlMs`，默认 60s）
  **非阻塞**触发一次刷新，空闲时零开销；首次探测未完成前该项按 `unknown` 展示，绝不阻塞系统提示词组装。
- `systeminformation`（电源 / 网卡）与整个感知采集**在第一次 `summary()` 消费时才激活**：
  提示条收起、没有聊天、没开设置页的纯空闲进程不加载它、也不起 30s DNS 探测；
  首次激活并行采电源 + 网络，DNS 超时收紧到 800ms（2026-10-04 性能轮）。
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

### 8.3 游戏模式联动（v30）

- 配置 `general.gameMode.enabled`（默认开启）只控制**联动**，不改变 Windows 自身的 Game Mode 设置。
  仅 Windows 生效；其它平台与未开启时不启动检测。
- Windows 没有公开的「Game Mode 正在运行」查询 API，`AutoGameModeEnabled` 注册表值也只是用户
  设置而非运行态。Aurora 用两个轻量信号做交叉判定：
  1. `GameBarPresenceWriter.exe` 是否存在 —— Game Bar 识别到游戏后会启动该进程，
     覆盖窗口化 / 无边框游戏；
  2. `SHQueryUserNotificationState()` 是否返回 `QUNS_RUNNING_D3D_FULL_SCREEN` ——
     覆盖 Game Bar 被禁用时的独占全屏 D3D 游戏，同时避开 PowerPoint 等普通全屏窗口。
- 检测在**单条常驻 PowerShell 子进程**里完成（只在这一特性开启且平台为 Windows 时启动）；
  首次加载 P/Invoke 后按短周期读取进程与系统状态，只在状态翻转时向主进程输出一行，避免每轮
  新建 PowerShell / 重复 `Add-Type`。检测失败按「不在游戏中」降级，只记 debug 日志。
- 进入游戏：提示条若当时可见则记住该状态并隐藏；随后调用文件自感知 `suspend()`，停止文件监听、
  最近使用轮询与队列推进，但不删除已排队任务、状态或笔记。正在执行的那一次提取 / 分析允许收尾。
- 退出游戏：文件自感知 `resume()` 并按当前设置重新监听与扫描；提示条只在进入前确实可见、
  当前总开关允许且不在勿扰时段时恢复。关闭游戏模式开关时同样解除挂起并恢复提示条。
- 已知边界：Game Bar 关闭且游戏使用无边框窗口时，两个信号都可能无法识别；该场景不猜、不误伤。

## 9. 主动引导（Proactive）

- 触发器注册表：首次安装未完成、模式引导未完成、分类完成通知、课前 5 分钟……
  调度策略：单次最多触发一条（队列排队）；支持勿扰时段；全部触发器可配置开关。
- 载体：打开 / 聚焦 AI 交互窗口，以 AI 消息开场（对话式收集，见 05 §2）。

### 9.1 已落地（P5）

| 触发器 | 实现 | 载体 |
|---|---|---|
| 课前 N 分钟（内置自动化） | 自动化引擎的内置自动化 `builtin.pre-class-notify` / `builtin.pre-class-open-folder`（`main/automation/engine.ts`）+ 纯函数 `preClassTrigger` | 系统通知 + 自动打开科目文件夹（docs/05 §3.4、docs/13 §6） |
| 敏感工具确认 | `ProactiveScheduler`（`proactive.ts`）+ IPC `proactive:sensitiveTool` / `proactive:resolveSensitiveTool` | 交互窗确认卡片 |
| 模式引导 / 分类完成 | 模式系统（05 §1）与分类管线（05 §3.3）各自触发 | 交互窗 AI 消息 / 系统通知 |

- **敏感工具确认（§5）**：工具 `sensitivity === 'confirm'` 时（MCP 工具一律如此）先推送
  `SensitiveToolRequest`（`confirmId` / `expiresAt`），渲染层回执后放行或拒绝；
  **超时（默认 60s）、勿扰时段、卡片推送失败一律按拒绝处理**；应用**退出**时 `dispose()`
  会调 `rejectAll()` 让在途确认立即失败，避免工具永久挂起。
  ⚠️ **已知缺口**：`rejectAll()` 目前**没有**接到 `chat:abort`（会话中止只中断内核循环，
  在途确认卡片仍可点击、并在 60s 前一直有效）——所以「会话中止 = 确认作废」这句话目前不成立，
  待接线后才会。设置项 `advanced.confirmSensitiveTools` 关闭时直接放行（内核仍按 `sensitivity` 写日志留痕）。
- **课前提醒（v0.2.5 起是内置自动化）**：由常驻的自动化引擎按 **15s 节拍**检查课程表，命中
  「课前 N 分钟」窗口时发系统通知并自动打开该科目文件夹（`explorer`）；旧 `PreClassReminder`
  服务已删除，行为逐字保留（去重键仍是 `<weekday>-<startTime>-<subject>`、只提醒一次、
  **启动补偿**、**跨天**、多节课按剩余时间升序、勿扰静默跳过、失败只降级为日志）。
  **N 可配**（2026-09）：`modes.classroom.preClassLeadMinutes`（1–30，默认 5），
  引擎每次评估即时读取（改设置无需重启，非法值回落 5）。
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
2026-09 新增 `edit_file`（精确替换，§11.6）与 `grep` / `glob`（内容与文件名检索，§11.5）。
2026-10 再新增 `office_read` / `office_help` / `office_create` / `office_edit` /
`office_render` / `office_pdf` / `office_raw_edit` 七个 Office 专用工具：
DOCX / XLSX / PPTX 的读取、创建、元素级编辑、校验与渲染默认走包内固定版 OfficeCLI，
不再让模型手写 PowerShell COM。七个工具并入 `COMPUTER_TOOL_NAMES`，共用
`agent.tools.files.enabled`，因此当前电脑操控工具集为 **15 个**。

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
| `office_read` | `{ path, mode, target?, offset?, limit?, depth? }` | safe | `packages/agent-core/src/tools/office.ts` + `apps/desktop/src/main/tools/office-port.ts` + `office-worker.ts` |
| `office_help` | `{ format, verb?, element? }` | safe | 同上 |
| `office_create` | `{ path, format, templatePath?, templateData?, commands?, overwrite? }` | confirm | 同上 |
| `office_edit` | `{ path, saveAs?, commands, overwrite? }` | confirm | 同上 |
| `office_render` | `{ path, mode, target?, pageStart?, pageEnd?, grid?, maxPages? }` | safe | 同上 |
| `office_pdf` | `{ path, outputPath?, pageStart?, pageEnd?, overwrite? }` | confirm | 同上 |
| `office_raw_edit` | `{ path, saveAs?, rawOperations, overwrite? }` | confirm | 同上 |
| `list_dir` | `{ path, limit? }` | safe | 同上（`files.ts`） |
| `open_path` | `{ target }` | confirm | `packages/agent-core/src/tools/files.ts` + `apps/desktop/src/main/tools/open-port.ts` |
| `grep` | `{ pattern, path?, include? }` | safe | `packages/agent-core/src/tools/search.ts` + `apps/desktop/src/main/tools/file-port.ts` |
| `glob` | `{ pattern, path?, limit? }` | safe | 同上 |

> 图像工具（`view_image` / `screenshot` / `clipboard_read_image`）**不属于**这一族：它们按当前
> 生效模型的 `vision` 注册（不是 `agent.tools.enabled`），只读档也不摘除，见 §25。

- **工具语义**：`run_command` 执行单条命令并采集 stdout / stderr；`read_file` 按 UTF-8 读文本；
  `write_file` 写文本（`mode` 缺省 `overwrite`，`append` 追加）；`edit_file` 对文本做
  **精确局部替换**（读前守卫 + 唯一性拒绝 + 行尾保真，见 §11.6）；`list_dir` 列目录项；
  七个 Office 工具只处理 `.docx` / `.xlsx` / `.pptx`，在 `utilityProcess` 中调用包内固定版
  OfficeCLI，**不依赖本机 Office、不执行宏、不自动回退 COM**。`office_read` 返回稳定元素
  路径并用 `mode` 选择摘要 / 文本 / 元素 / 查询 / issues / validate；`office_help` 查询可写
  属性和示例；`office_create/edit` 用 OfficeCLI 的 `add/set/remove/move/swap` JSON 命令，
  写入前必须 `office_read`，默认另存，只有 `overwrite: true` 才覆盖源文件且必须先保存二进制
  快照。写盘前在**保留原扩展名**的同目录临时文件上执行 batch，再跑 `validate`，成功后原子
  替换；失败与危险编辑不改源文件。`office_render` 用 HTML 渲染生成 PNG/HTML，`office_pdf`
  逐页截图后用 `pdf-lib` 合成栅格 PDF。`office_raw_edit` 是唯一允许 `raw-set` 的独立
  confirm 工具；普通 `office_edit` 不暴露 raw，失败后不得自动降级到 raw 或 COM。
  `grep` 按正则搜**内容**、`glob` 按模式匹配**文件名**（两者规格见 §11.5）；
  `open_path` 打开 `http(s)://` 时按 `agent.tools.open.urlMode` 选择右栏内置浏览器（默认）或
  `shell.openExternal`；`mailto:` 和本地路径仍走系统默认程序。所有打开动作都不等待目标程序退出。
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
- **配置字段（不改名）**：`agent.tools.enabled`（总开关）、`agent.tools.workspaceDir`（缺省工作目录 /
  搜索根，取值走 §5.1 的 `effectiveWorkspaceDir` 回落链，见 §11.1）、
  `agent.tools.terminal.{enabled,timeoutMs,maxOutputChars,allowPatterns}`、
  `agent.tools.files.{enabled,maxReadBytes}`、`agent.tools.search.{enabled,maxResults}`、
  `agent.tools.open.enabled`；**`agent.permissionMode`（v13）是工具面的总闸门**，见 §11.2。
  - **开关分派（`registerComputerTools.sync()` 是唯一落地点）**：`agent.tools.enabled` 是**总开关**
    （为 `false` 时全部工具一个都不注册）；`terminal.enabled` → `run_command`；
    `files.enabled` → `read_file` / `write_file` / `edit_file` / `office_read` /
    `office_help` / `office_create` / `office_edit` / `office_render` / `office_pdf` /
    `office_raw_edit` / `list_dir`；
    `search.enabled` → `grep` / `glob`；`open.enabled` → `open_path`。
    各子开关只决定对应工具是否注册；`false` 时该工具**不出现在工具清单里**（非「注册后拒绝」）。
    `edit_file` **不单独设开关**，与 `write_file` 共用 `files.enabled`（避免设置页开关膨胀）。
  - `agent.tools.terminal.allowPatterns`（缺省空数组）是**只读**字段：只由用户在设置页维护，
    AI 的 `set_setting` 一律拒绝读写（理由与匹配语义见 §11.7）。

### 11.1 安全边界

- **逐次确认**：`run_command` / `write_file` / `edit_file` / `office_create` / `office_edit` /
  `office_pdf` / `office_raw_edit` / `open_path` 这些 `sensitivity = 'confirm'`
  的工具，
  **每一次调用**都走 §5 的 `confirmTool` 钩子（主进程侧由 §9.1 的 `ProactiveScheduler` 承载；
  应用内恒注入该钩子，未注入时内核不拦截——这是内核的可测试性设计，不是可配置项）。
  **超时（默认 60s）与勿扰时段一律按拒绝处理**，拒绝后不执行、以「用户拒绝执行」文本回填模型、
  工具卡片置 `error`、循环继续。
  唯一的例外是命中 `agent.tools.terminal.allowPatterns` 的 `run_command`（用户显式配置的免确认模式）
  ——**只对 `run_command` 生效**，跳过确认卡片但**仍写审计日志**，语义见 §11.7。
- **总开关**：`agent.tools.enabled = false` 时全部电脑操控工具**完全不注册**——模型在工具清单里看不到
  它们，系统提示词里也没有相应说明，因而不可能产生确认卡片或任何本机副作用。
- **`workspaceDir` 只是默认工作目录，不是沙箱**：`run_command` 的缺省 `cwd`（`grep` / `glob` 的缺省
  搜索根同理）取的是 §5.1 `effectiveWorkspaceDir` 那条回落链——**当前项目根（配置了当前项目时）>
  激活模式工作目录（Work）> `agent.tools.workspaceDir` > 用户主目录**；未配置当前项目时与既往行为完全一致。工具**不限制**模型
  访问该目录之外的位置
  （⚠️ v13 起另有一层真正的边界：**配置了当前项目**时文件类工具与 `run_command.cwd` 都受
  项目根 realpath 前缀校验，见 §11.2 —— 那层边界挂在"项目"上，与 `workspaceDir` 无关）。
  越界**不静默**：
  工具结果里回带解析后的绝对路径（命令的实际 `cwd`、文件的实际路径），
  确认卡片展示的则是模型的**原始参数**（要解析出绝对路径就得先执行，因此卡片里看到的是
  相对路径原文；解析结果在工具执行结果里回带）。
  **`read_file` / `write_file` / `edit_file` / `list_dir` 不读 `workspaceDir`**：它们的相对路径按
  **主进程 CWD**
  解析（`file-port.ts` 的 `resolve()`）——打包应用从开始菜单启动时 CWD 并不可预期，
  因此文件类工具实际上只适合用绝对路径（`workspaceDir` 只影响命令的缺省 `cwd` 与检索的缺省搜索根）。
  `grep` / `glob` 是例外：它们的 `path` 缺省值走 §5.1 `effectiveWorkspaceDir` 的回落链
  （**当前项目根（配置了当前项目时）> 激活模式工作目录（Work）> `agent.tools.workspaceDir` > 用户主目录**），
  显式传入的相对路径仍按主进程 CWD 解析，见 §11.5。
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
- **终止诊断不靠“有没有报错”**：命令结果头部必须明确区分超时与被取消，并说明整棵进程树已强制
  终止；空 stdout / stderr 不代表命令未开始执行。COM 启动阶段的静默挂起属于“超时且没有业务输出”，
  调用方必须按超时停止、不重试，并分别检查目标文件是否生成、Office 进程是否残留。
- **UTF-8 输出约定**：命令按 UTF-8 采集输出。PowerShell 5.1 默认按控制台代码页输出，
  spawn 时必须先 `chcp 65001`，再显式设 `[Console]::OutputEncoding` 与 `$OutputEncoding`，
  否则中文（尤其是原生命令输出）可能乱码。即使编码前缀正确，**stdout 里的中文也不能作为
  Office 文件内容的校验依据**；校验必须回读目标文件本身（结构化读取或 XML/逐段核对）。
- **不做命令黑名单**：黑名单必然漏（`cmd /c`、编码 / 转义、`$()`、别名、脚本文件都能绕过），
  安全边界由「**逐次确认 + 输出上限 + 总开关**」三道构成，而不是字符串匹配。

### 11.2 三档权限：`agent.permissionMode`（v13）

`agent.permissionMode ∈ {readonly, confirm, auto}`（**默认 `auto`**，2026-09-29 起；
`advanced.confirmSensitiveTools` 与它镜像，出厂同为 `false`）是**工具面**的总闸门；
那个老开关保留，两者由 `resolvePermissionMode()`
（`packages/shared/src/config/permission.ts`，主进程与渲染层共用同一份）合成**生效档位**：

| 生效档位 | 何时出现 | 注册哪些工具 | 确认行为 |
|---|---|---|---|
| `readonly` | `agent.permissionMode === 'readonly'`（**只读优先**，老开关在这档无效） | 只注册只读工具：`read_file` / `list_dir` / `grep` / `glob` / `todo_read` / `use_skill` / `set_setting` / MCP 与扩展工具。**不注册** `run_command` / `write_file` / `edit_file` / `open_path` / `todo_write` / `todo_read` 以外的待办写侧 | 敏感工具本就不在清单里；若仍被调用（例如刚好在切换档位），`createConfirmTool` 直接**拒绝**并写 warn（双保险） |
| `confirm` | 显式选了 `confirm` 且老开关为 `true`（用户手动切回的边界档，**不再是出厂档**） | 与三档之前完全一致 | **旧 auto 语义**：未配置项目时直接放行；有项目时根内免确认、根外弹卡；`run_command` 命令串含绝对路径时回到确认卡；命中 `allowPatterns` 的 `run_command` 仍免确认 |
| `auto` | **出厂默认**；或显式选了 `auto`；或 `advanced.confirmSensitiveTools === false`（老开关的语义由它承接） | 与三档之前完全一致 | **完全权限：所有敏感工具调用直接放行，不再弹任何确认卡，也不访问确认载体**；项目根不再参与确认判定（仍可作为缺省工作目录 / `confirm` 档边界）。每次调用写 `info` 审计日志 |

- **为什么默认档从 `confirm` 提到 `auto`（2026-09-29）**：Aurora 是系统级 Agent 工具，
  出厂就逐次确认会让绝大多数正常操作（改自己项目里的文件、跑一条构建）都要先点一次卡片，
  用户反馈「默认权限太低」。`auto` 是完全权限：用户显式选择这一档后，不再出现任何确认卡；
  主进程仍对工具做参数与权限校验，但这不再是逐次交互。
  **边界根按会话解析（2026-09-30 起覆盖所有会话）**：**会话绑定项目 > 会话空间目录**
  （Agent 空间 → `%USERPROFILE%\Desktop\Aurora`；Work 空间 → `modes.work.workspaceDir`）
  **> 全局当前项目**。空间目录仍决定缺省工作目录，并参与 `confirm` 档的「根内免确认」；
  完全权限档不做「根内 / 根外」分流。界面文案（权限下拉的提示与菜单项）必须写明
  **完全权限 = 不再弹卡**。
  **只影响新装 / 缺字段的配置**（`zod` 默认值）：既有 `config.json` 里已持久化的
  `permissionMode` / `confirmSensitiveTools` 一律保持原值（含绝大多数沿用旧默认值的配置），
  需用户自行切换；因此本次**不进迁移链、不改 `CONFIG_VERSION`**。

- **只读档的语义是"根本不在清单里"**，不是"注册后拒绝"：模型看不到这些工具，也就不会先承诺再被拒
  （`§11` 的既有口径）。`todo_write` 虽然 `sensitivity = 'safe'`，但它会往 `<userData>/todos/<sid>.json`
  落盘，因此在只读档下也要摘掉 —— 否则"只读 = 无系统副作用"这句话就是假的。`todo_read` 保留。
- **用户可选的确认结果三个值**：拒绝 / 放行一次 / **本会话内同名工具都放行**（卡片第三颗按钮，
  `data-action="chat.confirm-always"`）。会话级授权表在**内核**（`KernelAgentHost`，进程内 `Map`，
  不落盘、不给渲染层也不给 AI），随会话存在；`'always'` 只由用户点按钮产生，
  超时 / 勿扰 / 推送失败一律是拒绝，**拒绝永远不会被升级成会话级授权**。
  （内核的确认判定是四态 decision，机器放行不是用户可选取值，出处语义见下。）
- **`auto` 档不做路径启发式判定**：`createConfirmTool` 直接返回 `true`（用户已选完全权限授权），
  不再解析项目根、不再访问 `ProactiveScheduler`，也不因命令里出现绝对路径而弹卡。
  这条路径仍写 `info` 审计日志；真正的系统边界是当前 Windows 用户权限，而不是 Aurora 的确认卡。
- **`center_send_file` 不逐次确认（v0.2.4）**：用户明确要求「给 Center 发文件直接发送」，
  原 v0.2.3 的外发类特例名单（`ALWAYS_CONFIRM_TOOLS`）随之删除。它的闸门在**注册与配置层**：
  `center.enabled` + `serverUrl` 才注册、`center.allowFileTransfer` 可整体关闭、
  `center.maxFileMb` 限大小 —— 三个开关都是用户在设置页维护的（`center.*` 在只读黑名单里，
  AI 自己改不动），逐次确认属重复设防。工具本身 `sensitivity: 'safe'`，
  确认链路（含推网页端）不再经过它。
- **confirm 档恢复旧 auto 语义（2026-10-05）**：`createConfirmTool` 在 confirm 档下按会话解析
  边界根（会话绑定项目 > 会话空间目录 > 全局当前项目 > Work 模式工作目录，docs/06 §5.1）；
  未配置项目或无可用根时直接机器放行；有根时根内调用免确认，根外回到确认卡。
  `run_command` 走同一套判定：相对命令 / 根内 cwd 可免确认，命令串出现绝对路径时保守回到确认卡。
  这条路径返回 `'machine'`，不置 `ctx.approvedByUser`，端口层 realpath 兜底仍然生效。
- **项目根边界（两层，分工明确）**：
  1. `confirm` 档的"要不要问用户"用字符串级判定（`isWithinRoot`，含 `..` 段一律按越界）；
  2. "能不能真碰"由主进程 `file-port.ts` 的 `resolveWithin` 用 **realpath** 判定：
     对已存在的最近父目录做 `realpath`（新文件场景目标可能不存在）后比较前缀，
     越界抛 `E_PATH_OUTSIDE_WORKSPACE`，工具层转成 `isError` 结果。
     这条校验只在**配置了当前项目**时启用（`workspaceRoot()` 返回 undefined = 行为与 v13 之前一字不差）。
     六个文件类入口（`readText` / `readWholeText` / `writeText` / `list` / `findFiles` / `searchText`）
     与 `run_command.cwd` 都走它；确认钩子返回 `true | 'always'`（用户当次批准或完全权限档）的那一次调用
     由内核置 `approvedByUser`，工具层据此透传 `allowOutside: true` 放行 ——
     于是"越界必须被确认后才可写"是可测的。
- **`approvedByUser` 已区分出处（2026-09，四态 decision）**：确认判定 `ConfirmDecision` 取值
  `false | true | 'always' | 'machine'` —— `false` = 拒绝；`true` = 用户**当次**在确认卡片上点放行；
  `'always'` = 用户**当次**点「总是允许」（本次放行且本会话记住该工具名）；`'machine'` =
  **历史授权或免确认模式的机器放行**（`allowPatterns` 命中、已记住 `'always'` 后的会话授权短路）。
  `auto` 完全权限档返回 `true`（用户已显式选择完全权限），因此也置 `ctx.approvedByUser`。
  仅 `true | 'always'` 置 `ctx.approvedByUser`
  并免掉 realpath 兜底；`'machine'` **照常执行但边界兜底保留**：内核不置 `approvedByUser`，
  工具拿不到 `allowOutside`，`resolveWithin` 照常校验。于是此前披露的「根内建指向根外的
  junction / 符号链接（`run_command` 里 `%USERPROFILE%\…` 形态不被 `containsAbsolutePath` 识别），
  再对链接路径写文件」在机器放行路径下被 realpath **拒绝且不弹卡**（零静默越权）；
  这条出处区分还顺带兜住「判定与执行取值时刻不同步」的竞态（用户中途切项目时按新根判定、
  按旧实例烘焙目录执行）—— 机器放行 fail-closed 落回 realpath 校验，不再存在免校验窗口。
- **`advanced.confirmSensitiveTools = false` 时的语义**（沿用既有行为，§5 / §9.1）：由 **`auto` 档**承接 ——
  所有敏感工具直接放行、不弹确认卡，内核仍按 `sensitivity` 写日志留痕。
  此时代码路径与用户自己在 PowerShell 里敲同样的命令**能力相当**（甚至略宽：命令以
  `-NoProfile -NonInteractive -ExecutionPolicy Bypass` 启动，比默认执行策略更宽松，但同样**不是**管理员提权）
  ——`run_command` / `write_file` / `edit_file` / `open_path` 可能在无人确认的情况下执行，
  包括删除文件、改注册表、装软件这类不可逆操作。命中 §11.7 免确认模式的命令也是同一种
  「少一次打扰」的语义，**不等于**它更安全。
因此该开关的定位是「减少打扰」，**不是安全加固**；需要安全边界时保持默认 `true`。
- **会话级权限档覆盖（v0.2.3，docs/12 §6.3）**：`SessionMeta.permissionMode`（会话文件
  数据，不进 CONFIG_VERSION）为**单个会话**覆盖生效档位，解析链 **会话覆盖 > 全局
  `resolvePermissionMode()`**，由装配层的 `mode` getter 按 `info.sessionId` 现解析（与
  `agent.loop` 上限的 getter 套路同款）。当前**唯一写入口**是 Aurora Center 的
  `session.setPermission` 远程命令（docs/12 §6.3）；本机侧的会话权限写入 IPC 尚未实装
  ——**AI 不可写**
  （`set_setting` 只认配置路径，SessionMeta 不是配置；且改档位 = 自我提权）。
  全局 `agent.permissionMode` 仍只能由用户在设置页调（`SETTINGS_READONLY_PREFIXES` 口径不变）。

### 11.3 非目标（v0.7.0 明确不做）

- **鼠标 / 键盘模拟**：不做 `SendInput` / UI 自动化，Agent 不得代替用户点击、输入界面。
- **录屏**：不做屏幕录制。**截屏不是非目标**：`screenshot` 工具（§25）按需截取当前屏幕像素并交给
  模型看，每次调用过确认卡片、受当前生效模型的 `vision` 门控；它是扩展工具、不在 `COMPUTER_TOOL_NAMES`
  里，不受 `agent.tools.enabled` 门控，也不是持续录屏。
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
  `run_command` 的缺省 `cwd` 与 `grep` / `glob` 的缺省搜索根共用同一条回落链——
  **当前项目根（配置了当前项目时）> 激活模式工作目录（Work）> `agent.tools.workspaceDir` > 用户主目录**
  （与 §5.1 的 `effectiveWorkspaceDir` 同源，见 §11.1 / §11.5），未配置当前项目时与既往行为一致。
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
- **`path` 是搜索根**：缺省走 §5.1 的 `effectiveWorkspaceDir` 回落链——**当前项目根
  （配置了当前项目时）> 激活模式工作目录（Work）> `agent.tools.workspaceDir` > 用户主目录**，未配置当前项目时与既往行为一致；
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
  用户可在设置页「智能与工具」页的文件备份区组（v0.2.4 起迁入设置页，主界面右栏不再展示）
  把文件回滚到任意一份快照，**回滚本身也会先留一份快照**，
  所以回滚是可撤回的。原子写与「孤立 `\r` 拒绝」这两条**不是**回滚机制，
  它们保证的是"写盘过程不会写坏"，与"改动可撤销"是两件事。
  快照被关掉（`agent.snapshots.enabled = false`）或文件超过 `maxSnapshotBytes` 时不留底 ——
  此时才回到旧口径：改错了只能靠用户自己的版本控制 / 备份恢复。

### 11.8 写前快照与回滚（v14）

`write_file`（`overwrite` 与 `append` 都算）、`edit_file` 与显式覆盖的 Office 写入在
**真正落盘之前**，把磁盘上的
**原内容**存进 `<userData>/backups/<sessionId>/`；用户在设置页「智能与工具」页的文件备份区组
（v0.2.4 起迁入设置页）把某个文件回到某一份快照。

- **目录布局（唯一形状口径）**：一条快照 = `<backups>/<sessionId>/` 下的**一个内容文件**，
  文件名就是快照 id：`<ISO 时间戳>-<8 位内容哈希>.snap`（例
  `2026-09-26T10-52-31-123Z-3f9a1c07.snap`，ISO 里的 `:` / `.` 换成 `-` 以满足 Windows 文件名合法）。
  索引是 `<backups>/<sessionId>/index.json`（`SnapshotRef[]`）。
  **刻意不用原文件名**：同一路径可能被改多次（撞名）、原名可能含非法字符；
  原名只存在索引的 `path` 字段里。id 里时间戳在前 ⇒ 同一文件下**字典序 = 时间序**。
- **触发点与顺序**：`file-port.writeText` / Office 端口里 `resolveWithin`（边界）→ **`capture`（留底）** →
  `mkdir` → 原子写 / 追加。顺序不能换 —— 换过来就是"改完才备份"，备份里已是新内容，回滚等于没回滚。
  主写失败时**不回滚快照**（保命优先：文件可能已被部分改写），并把快照 id 写进错误信息。
- **二进制**：Office 快照直接保存原始字节（`SnapshotCaptureInput.bytes`），不得经 UTF-8 往返；
  `origin` 为 `office_edit` / `office_export`。快照读回与回滚本来就使用 `Uint8Array`，
  因此可无损恢复 `.docx/.xlsx/.pptx/.pdf`。
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
- **它只在「会弹卡」的档位上有意义**：`auto` 档下未命中的命令本来就不弹卡（那是免确认档），
  所以讨论"命中 vs 未命中"必须落在 `confirm` 档上。`AURORA_SMOKE` 的 9.5 节因此**显式把档位
  切到 `confirm`** 再跑正负两条对照（出厂默认是 `auto`，不切档负对照会整体失效），收尾还原成默认档。
- **匹配语义**：**glob 全串匹配、大小写不敏感**，`*` 匹配任意字符（含空）、`?` 匹配单个字符，
  与 §11.5 共用**同一个模式编译器**（命令串按纯文本模式匹配：`\` 是内容不是路径分隔符）。
  **全串锚定**意味着 `git *` 不会命中 `echo git`。
- **匹配按「语句边界」而非「字符」判定（P2-10 起步、2026-10-01 补齐）**：匹配发生在
  **纯文本层面**，`*` 编译成 `.*`，所以分隔符对它本来没有特殊含义。实际口径有两层：
  1. **先按分段符拆段，每一段都要命中某个模式才整体放行**。分段符 = `;`、换行、`&&`、
     `||`、`|`。于是 `git *` **不再**命中 `git status; <任意命令>`、`git status && <任意命令>`、
     `git log | more`；尾部空段（`git status;`）忽略，两侧都命中同一模式时（`git status && git log`）
     整体仍放行。
  2. **命令里出现「语句构造」时，整条命令一律不免确认（退回弹卡）**：`$(...)`、反引号、
     `@(...)`、`@{...}`、`%{...}`，以及调用运算符 `&`（`&&` 已作分段符剔除，其余任何 `&`
     都按调用运算符 / 重定向处理）。这些构造**不与分隔符对齐**（`git status $(del x)` 是
     一个段），只靠拆段堵不住，所以整体判不命中 —— **宁可多弹一张卡**。
  即便如此，模式列表本身**仍不构成安全边界**：`git *` 现在放行的是「每一段都以 `git` 起头
  的多条命令」，而不是「只允许 `git` 这一条」；想真正收窄就写**完整命令**（`git status`，
  不带通配）或明确到参数级（如 `git log --oneline *`）。这正是 §11.1 明确「不做黑名单、
  安全靠逐次确认」的原因。
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
   存在它的意义：`llm.providers.<id>.model / .modelParams.<modelId>.reasoningEffort` 落在
   `llm.providers` 黑名单前缀之内，但「换模型 / 调思考等级」不碰凭据，必须显式放行
   （baseUrl / apiKeyEnc / modelList 等其余字段仍被前缀拒绝）；
   `tts.*` / `stt.*` / `imagegen.*` / `agent.tools.*`（凭据与免确认模式列表除外）这类本就因
   「不在黑名单而可写」的路径
   也逐条登记成**可写面清单**（供 `set_setting` 的工具描述与 §17 的 settingsHint 使用），
   并防未来误加前缀时静默收窄。模式里的 `*` 段匹配恰好一个动态键段（如 provider id）。
   注意 `advanced.confirmSensitiveTools` **不在**表内：确认总闸门必须只读，防自我提权；
   `agent.tools.terminal.allowPatterns` 同样**不在**表内（覆盖表判定先于黑名单，加进去就等于放行），
   理由见 §11.7（自我提权）；
   `modes.work.workspaceDir` 也已**移出**本表并进黑名单 —— 它是权限边界根回落链的一级（§5.1 / §11.2），
   只删本表登记不够：那样会落回「Schema 登记过即默认可写」，必须同时进 `SETTINGS_READONLY_PREFIXES`。

1. **黑名单前缀**：判定分两步 —— 先查用户配置项 `advanced.readonlyPrefixes`（默认值即导出的
   `SETTINGS_READONLY_PREFIXES`，见 docs/08 §1，**具体条目以该常量为准**；v8 起新增
   `stt.providers` / `imagegen.providers` 两组凭据前缀；v13 起新增 `projects` 与
   `agent.permissionMode` 两条自我提权路径；v15 配套的安全收紧再新增
   `agent.loop` 与 `agent.snapshots`（循环预算与写前快照）与 `advanced.readonlyPrefixes`
   （黑名单配置自身，防 AI 自我收紧），
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
   Work 模式工作目录（`modes.work.workspaceDir`，权限边界根的一级 —— AI 改写它等于把免确认范围
   扩到任意目录，与 `projects` 同构的自我提权路径）、
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
放行同样按 §11.2 的四态 decision 带出处：只有用户**当次**在卡片上批准（`true` / 首次 `'always'`）
才置 `approvedByUser`；`advanced.confirmSensitiveTools = false` 时的**直接放行**属于
`'machine'` 机器放行（照常执行、不置 `approvedByUser`、项目根 realpath 兜底保留），
内核仍按 `sensitivity` 写日志留痕 —— 语义与 §11.2 一致：那是「减少打扰」，不是安全加固。

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

- **`agent.tools.enabled = false` 会摘掉全部电脑操控工具**（§11.1），但 `set_setting` **仍然注册**：
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

## 14. 扩展工具七件套（v0.0.1；`show_preview` / `show_image` 后续补入）

v8 起内核新增五个「看 / 通知 / 剪贴板 / 生图」工具（Design/betav2-spec.md §6.2），
2026-10-03 起加 `show_preview`（把成果展示到桌面右栏的预览面板，见 07 §2.3 的
「Agent 展示」——渲染层收到推送后把目标投给**浏览器标签**：已有就复用、没有才新建，
2026-10-03 二次修订）；2026-10-04 加 `show_image`（把本地图片加入**对话图片区**，
并按同一套无路径元数据同步到 Center）。
分层与 §11 的电脑操控工具同一套：**内核只定义工具与端口**（`tools/web-fetch.ts` /
`tools/clipboard.ts` / `tools/notify.ts` / `tools/imagegen.ts` / `tools/preview.ts` /
`tools/image-display.ts`，
纯 Node、可单测），真实系统能力由主进程实现端口后注入（`apps/desktop/src/main/tools/`
下对应实现）。

| 工具 | 端口（内核） | 主进程实现 | 敏感级 |
|---|---|---|---|
| `web_fetch` {url} | `WebFetchPort.fetch(url)` | `createNetWebFetchPort`（netFetch + 剥标签 + 截断） | safe |
| `clipboard_read` () | `ClipboardPort.read()` | `createElectronClipboardPort`（Electron `clipboard.readText`） | **confirm**（隐私） |
| `clipboard_write` {text} | `ClipboardPort.write(text)` | 同上（`clipboard.writeText`） | **confirm** |
| `notify_user` {title, body} | `NotifyPort.show(title, body)` | `createNotificationPort`（映射到 `NotificationService.notify`，复用去重 / 点击打开 / 日志） | safe |
| `generate_image` {prompt, size?} | `ImageGenPort.generate({prompt, sessionId, size?})` | `createImageGenPort` → `ImageGenService`（§15） | **confirm**（花 API 费用） |
| `show_preview` {target, title?} | `PreviewPort.show(target, {sessionId, title})` | `createPreviewPort`（目标校验 + 推送到 chat 窗口；URL 去向遵守 `urlMode`） | safe |
| `show_image` {path, caption?} | `ImageDisplayPort.prepareImage(...)` | `createImageDisplayPort`（格式 / 大小 / 会话边界校验 + 图片元数据） | safe |

`generate_image` 只管**写**图，且**不受门控**（任何模型都能照着描述生图）；成功后其产物
自动进入对话图片区。补齐「看图」三件套的
`view_image` / `screenshot` / `clipboard_read_image` 是 §25 的图像工具，门控口径与本节七件套**相反**
（按当前生效模型的 `vision` 注册）—— 别把三者按「不受门控」理解。

**对话图片区按需加载（2026-10-04 性能轮）**：`DisplayImageGallery` 用 `IntersectionObserver`
只在图片进入视口附近时才调 `chat:readDisplayImage`；请求带 `maxDimension`（列表默认 720），
主进程用 `nativeImage` 缩到该边长后再回 data URL —— 原图最大 10MB，不缩尺寸直接 base64
会让多图会话的渲染进程常驻几百 MB。原图仍只在磁盘上，后续「查看大图」需要时再单独读。

### 14.1 注册口径

- 装配器是 `main/tools/index.ts` 的 `registerExtensionTools`，与 `registerSettingsTool` **同级**：
  **不受 `agent.tools.enabled` 门控**——它们不在 `COMPUTER_TOOL_NAMES` 里，「看网页 / 收通知 /
  生图 / 展示成果」不属于「电脑操控」的开关语义；`syncToolRegistries()`（主进程唯一的工具表同步入口）每次
  先按名字全量摘除再重建，与电脑操控工具同一拍热生效。
- 敏感动作不靠开关、靠确认：`clipboard_read` / `clipboard_write` / `generate_image` 都是
  `sensitivity: 'confirm'`，每次调用过 §5 的 `confirmTool`（§9.1 的确认卡片）。
- `clipboard` 端口实现是主进程里**唯一必须 import electron** 的工具文件，因此没有单测；
  其余端口实现（`web-fetch.ts` / `notify.ts` / `imagegen-port.ts` / `preview-port.ts`）
  保持不依赖 Electron（推送动作由装配层以 `present` 回调注入）。

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

- 两套协议，由 `stt.providers.<id>.type` 选择（v24 起可选，旧配置一律 `openai-compat`）：

  - **`openai-compat`**：`POST <baseUrl>/audio/transcriptions`，`multipart/form-data`：
    字段 `file`（Blob，文件名按 MIME 取扩展名：webm / mp3 / wav / ogg / m4a / flac，兜底 webm）、
    `model`、`language`（provider.language 或请求覆盖值，**空串不下发** = 服务端自动检测）。
    ⚠️ multipart **不手工设置** `Content-Type`——boundary 由 fetch 实现生成。成功响应读 `{text}`。
  - **`dashscope-native`**（阿里云百炼 / DashScope 原生，2026-10 实装）：
    `POST <baseUrl>/api/v1/services/aigc/multimodal-generation/generation`（同步 JSON），
    body `{ model, input: { messages: [{ role: 'user', content: [{ audio: 'data:<mime>;base64,…' }] }] },
    parameters: { asr_options: { language } } }` —— `language` 为空串时 **`parameters` 整个不下发**；
    识别文本取 `output.choices[0].message.content[].text`（内容数组逐项找第一条带 `text` 的）。
    `baseUrl` 的规范填法是**服务根**（`https://dashscope.aliyuncs.com`），也容忍写到 `…/api`、
    `…/api/v1`、`…/compatible-mode/v1` 或**完整端点**这四种常见粘法。
    **音频不转码**：渲染层 `MediaRecorder` 的 webm/opus 直接以数据 URI 下发
    （数据 URI 的 MIME 只保留 `type/subtype`，`;codecs=opus` 必须剥掉，实测
    `audio/webm` + `qwen3-asr-flash` 端到端可用、4 秒语音约 0.5–0.7 秒返回）。

- 凭据：`Authorization: Bearer <解密后的 apiKey>`，明文只存在于主进程发起请求的那一刻（同 §13.3）。
- provider 解析口径与 TTS 一致：`stt.enabled && stt.active` 指向存在的条目，
  否则抛「语音输入未配置」中文错误（渲染层 composer 连麦克风按钮都不渲染，docs/07 §3）。
- 非 2xx / 超时（默认 30s）都折成带状态码或原因的中文错误；原生接口的错误体是
  `{ code, message, request_id }`，按「code：message」呈现（`code` 才是能对照阿里云文档的东西），
  解析不出时退回原始 body。响应形状不对（缺 `text` / 缺 `output.choices…`）一律按失败处理，
  不编造空文本。
- 音频是渲染层 `MediaRecorder` 的 webm base64，经 IPC `stt:transcribe` 上来，**不落盘**：
  转写完成后只有文本进会话，录音即弃。
- 设置页预设两条（`STT_PRESETS`，含 `type`）：OpenAI 语音识别（`openai-compat`）与
  阿里云百炼原生 ASR（`dashscope-native` + `qwen3-asr-flash` + 官方域名）。
  换 MaaS 专属网关（如 qianwenai）只需把 baseUrl 换成网关根地址或 `…/api`，协议不用改。

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
- **`generate_image` 不受 `vision` 门控**：生图只需模型会写描述、不需要它自己会看图，
  因此对**不支持图片输入**的模型同样注册；开启 `vision` 的模型可以顺手用 `view_image` 回看自己刚
  生成的图（`<userData>/generated` 在 `view_image` 的自有目录白名单里，见 §25）。

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
- `AgentHost` 在持久化用户 / 助手 / 工具消息时统一写入本轮 `requestId`（自动续轮沿用，手动续跑
  产生新的 requestId）。桌面端与 Center 都用它把一次请求的中间正文 / 思考 / 工具调用收成一个
  工作胶囊；旧历史缺 requestId 时按相邻助手消息回退分组。

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
- **分母（上下文窗口）来自当前生效模型**：取
  `llm.providers.<id>.modelParams.<modelId>.contextWindow`（`modelId` = 该 provider 的 `model`，
  未命中的键由 `resolveModelParams` 回落 `0` = 窗口未知）—— v23 起窗口是**随模型绑定**的事实，
  不再是 provider 级的单个值（§3 / §3.1）；
- 「上下文详解」卡保留**四行**：本轮输入 / 上下文窗口 / 模型 / 平均缓存命中
  （2026-10-03 起，缓存命中从折叠条搬进详解卡）；缺用量时显示「暂无用量数据」
  （不编造分母），平均缓存命中的展示口径见 §21.4；
- **只用于展示，累计除外**：`latest`（本轮占用）不落盘 —— 重放历史时重新收集没有意义；
  但逐轮累计自 2026-10-03 起写进 `meta.usage`（会话级持久累计，见 §4「会话级用量累计」），
  渲染层切回会话时以它为种子恢复（平均缓存命中率因此跨切换、跨重启连续）；
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
| 主进程 / 内核 | `main/event-buffer.ts`、`loop/agentLoop.ts` | 同一子代理调用的连续进度是“当前快照”而非日志：消费窗口内只保留最新快照，终态仍由工具结果单独落盘，避免大型任务积压事件与重复唤醒渲染进程 |
| 渲染层状态 | `renderer/shared/composables/useChatDeltaBuffer.ts` | 同一帧内同 `messageId` 的增量合并为一次消息写入，**每帧最多 apply 一次** |
| 渲染层视图 | `MessageList.vue` | markdown 结果按**消息对象**（`WeakMap`）缓存，只有该条 `content` 变了才重跑解析；**流式未收盘的消息按 ~80ms 节流重解析、且不做语法高亮**（代码块按转义纯文本显示），`done` / `error` 收盘后再一次性高亮 —— 长代码块因此不会每帧重跑 highlight.js |

子代理历史快照在 `useChat` 中维护增量索引，水合或工具卡更新时才重建 / 更新索引；实时进度不再为每个快照扫描整段消息历史。索引只改变聚合路径，不改变“实时事件优先、历史快照补齐”的展示口径。

主代理的长任务路径也遵循同一原则：`SessionStore.append` 常态原地追加消息，只有触发条数上限时才重建截断数组；工具卡更新按消息 id 维护会话归属索引，避免每次状态变化扫描全部会话。工具注册表缓存稳定排序后的 LLM 工具定义，请求级过滤视图复用列表；历史截断与 quick 窗口先线性建立工具调用归属索引，避免对每条 `tool` 结果反复向前扫描。

三条硬约束（改这三层时不许破）：
- **顺序与终态不能变**：主进程的 `done` / `error` / `user-message` 与渲染层的任何**非增量**事件
  都必须**先 flush 已缓冲的增量、再处理自己** —— 否则工具卡会插到正文前面、`done` 会先于最后一段正文落地。
- **不丢内容**：合并只是拼接 `delta` + 保留首条 `seq`，事件条数变少但文本一字不少；
  非增量事件**永不**与前后增量合并（顺序即真相）。
- **不延迟终态**：`done` / `error` 同步下发，不排在 16ms 窗口之后。

**为什么仍然不做逐字打字机**：正文是 `v-html` 渲染的 markdown，Vue 对 `v-html` 不做 DOM diff
（见 07 §2.3）；按帧做真打字机等于每帧重解析 markdown，与本轮「把每 token 的重活降下来」的目标相反。

**2026-10-04 追加的第三条放大器**：`highlightCode` 对**正在增长**的围栏代码块是 O(n²) ——
每帧整块重跑 highlight.js，实测 TypeScript 20KB 约 48ms、45KB 约 145ms，未知语言走
`highlightAuto` 时 5KB 就要约 300ms。因此流式期间高亮**整体跳过**，并且 `highlightCode`
对超过 `MAX_HIGHLIGHT_CHARS`（40KB）的代码块、以及未知语言的**长**代码块一律回落转义纯文本；
`highlightAuto` 只保留给很短的未知语言片段。这条口径与桌面 / Center 两端共享（`packages/shared`），
改这里必须同时跑两端截图。

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
  同口径的路径（`llm.providers.<id>.model/modelParams.<modelId>.reasoningEffort`、`tts.*`、`stt.*`、
  `imagegen.*` 开关、`general.edgeBar.*`、`general.chat.showThinking`、`modes.current`、
  `modes.classroom.*`、
  `agent.tools` 下的**逐条枚举**——`enabled` / `workspaceDir` /
  `terminal.{enabled,timeoutMs,maxOutputChars}` / `files.{enabled,maxReadBytes}` /
  `search.{enabled,maxResults}` / `open.enabled`、`skills.userDir/disabled`、
  `advanced.quietHours`），
  并注明「凭据类一律只读、改动即时生效」。
  **`modes.work.workspaceDir` 不在这份可改清单里**：它是权限边界根回落链的一级（§5.1 / §11.2），
  已进 `SETTINGS_READONLY_PREFIXES`（§12.2 第 1 条），清单末尾的只读小节会逐字点出它。
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
- **删除会话级联清理（2026-10-06）**：`chat:deleteSession` 在 running job 守卫通过后，
  先删除 `<sessionId>.json` 与 `<sessionId>-sub.json`，再删除会话并在成功后广播。
  todo 清理失败时不删会话、不广播；清理顺序不能反，否则固定会话 id（`main` / `quick`）
  重建后会把上一条任务的清单重新注入系统提示词。
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
| `task` | `{ description, prompt, permission?: 'read' \| 'write' }` | safe |

- **取舍（safe、不弹确认）**：`task` 标记 `sensitivity: 'safe'`，不走确认卡片——子代理只用
  父工具表里已放行的工具（见下），权限面不会比父循环更宽；但它**消耗独立的模型调用**
  （费用与时延随子循环轮数增长），这个代价靠 §5 的「子代理使用规范」约束使用时机，不靠逐次确认。
- **上下文隔离**：子代理从**空白历史**开始，系统提示词独立组装（子代理人设 + 子工具清单 +
  安全规则；不含父会话的模式片段 / 感知摘要 / 任务清单小节）。子循环的消息**不写入会话历史、
  不落盘**；结束后只把**最终文本**作为工具结果回填父循环，超过 **20_000 字符**截断（带截断标记）。
  父模型应把子任务需要的上下文**写进 `prompt`**——子代理看不到父会话。
- **工具白名单（双保险）**：取父工具表中 `sensitivity !== 'confirm'` 的工具，再**排除 `task` 自身
  与 `mcp.*` 前缀**——即 `read_file` / `list_dir` / `grep` / `glob` / `web_fetch` / `notify_user` /
  `use_skill` / `todo_write` / `todo_read` 这类；执行命令（`run_command`）、写文件（`write_file`）、
  **改文件（`edit_file`）**、打开路径（`open_path`）、剪贴板、生图、`set_setting` 与全部 MCP 工具
  在子代理里**一律不可见**（它们都是 `confirm` 级）——**除非显式授予 `permission: 'write'`**
  （下一节）。
  （MCP 工具本就全量 `confirm`，前缀排除是双保险：防未来出现 safe 的 MCP 工具时白名单失守。）
  `todo_write` / `todo_read` 在白名单里，读写的是 `<sessionId>-sub` 的独立清单文件（§18）。
- **无递归**：子代理工具表里没有 `task`，子代理不能再生子代理。
- **同轮多个 `task` 按顺序执行**（沿用 §5「同轮工具顺序执行」口径），结果顺序确定。
- **失败与边界**：provider 缺配置 → `isError` 回填（不发起请求）；abort 传导到子循环，
  以已产生的**部分结果**回填；子代理达到轮次上限（默认 32，同主循环）时结果附「部分结果」标记，
  父模型据此决定是否重派。
- **注册口径**：随 §18 的 `registerAgentCoreTools` 一并注册，**不受 `agent.tools.enabled` 门控**。

### 19.2 子代理的写权限（`permission`，2026-09）

主代理可以显式授予子代理**文件写**能力，让「读取 → 整理 → 落盘」这类子任务不必回到主循环：

| 取值 | 子代理额外可用的工具 | 缺省 |
|---|---|---|
| `read` | 无（= §19 的既有行为） | ✅ |
| `write` | `write_file`、`edit_file`（`SUBAGENT_WRITE_TOOLS` 固定白名单） | |

- **不是新通道，是同一道闸门的又一入口**：写工具进子表后，每次调用仍经**父会话的确认回调**
  （`TaskToolOptions.confirmTool` ← 装配层 `getConfirmTool` ← `createConfirmTool`）逐次判定，
  口径与主对话完全一致：档位（`readonly` / `confirm` / `auto`）、项目根 realpath、免确认命令模式
  全都不打折。子代理的写操作因此也受「根内按档位机器放行、根外弹卡」的既有规则约束。
- **会话 id 钉回父会话（两个半边，2026-10-02 补齐）**：
  ① 确认链——内核把确认请求的 `sessionId` **强写成父会话**（不是循环看到的 `-sub`）；
  ② 工作目录——装配层注入工具的缺省 cwd / 搜索根与 file-port / command-runner / view_image
  的 `workspaceRoot` guard 时经 `adaptForSubagent` 视图（`tools/session-project.ts`），用
  `parentSessionIdOf` 把 `-sub` **剥回父会话**再解析。修复前子代理的缺省 cwd / 搜索根 /
  边界根恒落 Agent 空间（`-sub` 查不到会话绑定）—— 主代理在项目里派子代理，
  子代理却在 `桌面\Aurora` 里 grep / 写文件。
  `-sub` 会话在会话库里不存在，按它解析项目根会走另一条回落链 —— 那等于换了一条护栏。
  两处钉回都不动 `-sub` 本身：todo 清单（§18）与读记录等**状态隔离**仍按 `-sub`。
- **白名单只做减法**：只读档下装配层注入的 `subagentToolNames` 与写入白名单取**交集**，
  因此只读档即使模型写了 `permission: 'write'`，子代理照样拿不到写工具（回归用例钉住）。
- **`run_command` / MCP / 递归派生拿不到**：写入白名单是**固定枚举**，不按 sensitivity 通配 ——
  命令的能力面（任意命令）远超「写几个文件」，需要它请回主对话走完整确认链。
- **降级要说出来**：装配层没注入确认回调时（如单测、未来别的壳层），`write` 一律降级为只读，
  并在工具结果里追加「装配层未接入确认链，本次已按只读执行」——**静默降级**会让主代理
  以为文件已经改好了。
- **快照如实记录**：`SubagentSnapshot.permission` / `tools` 记的是**实际授予**的结果
  （降级后是 `read`），界面据此显示「只读 / 可读写」徽章与可用工具清单。

### 19.3 独立对话视图（2026-09）

子代理的对话过程依然不落会话存储，但**过程本身**现在看得见了：

- **数据**：`SubagentSnapshot.messages`（`SubagentTranscriptMessage[]`）是内存收集器
  （`collected`）的投影：`user`（主代理的任务指令）/ `assistant`（正文 + 它发起的工具调用，
  工具调用的**结果正文回填到对应调用上**，与主对话工具卡的信息组织一致）/ 游离的 `tool` 消息。
  条数上限 **40**、单条正文 **2 000**、单次工具结果 **1 200**、入参 **400** 字符；条数超限时
  **保留开头与结尾**（开头是任务、结尾是结论），并置 `transcriptTruncated` 让界面如实标出
  「中间已省略」而不是假装完整。**限额只影响展示**，回传主代理的报告口径不变。
- **轨迹步骤也合并了正文增量**：早先每个流式 delta 各成一步，时间线上是一堆半句（读起来像卡带）；
  现在连续正文增量合并成一段（`steps` 的语义不变，仍是紧凑轨迹 + 进度条的数据源），
  工具步骤另外带上 `args`（入参摘要）。
- **界面**（`07 §2.3`）：`SubagentConversation` 组件渲染这段对话 —— 主代理气泡 → 子代理正文 →
  工具行（图标 + 名 + 结果摘要，点开看参数与结果正文）→ 最终报告（**最后一条有正文的助手消息**
  被标为「最终报告」；`report` 本就是所有正文的拼接，不另起一块，免得同一段文字出现两遍）。
  **两个消费方共用同一个组件**：`task` 工具卡的展开体（卡头在授予写权限时另有「可读写」徽章）
  与「子代理」页面的运行卡（展开态渲染它，折叠态给紧凑轨迹；权限徽章 + 可用工具清单在这里）。
- **只读口径**：视图里没有输入框、没有发送键、没有任何干预入口 —— 子代理的生死跟着父请求，
  要中止就中止父请求（这句话也写在视图底部）。capture 探针按「容器内不存在
  `textarea` / `input` / `contenteditable`」来钉这条口径，而不是靠注释。

### 19.4 实时进度与「子代理」页面（2026-09）

子代理的对话过程**不落会话存储**（刻意的上下文隔离），因此此前在界面上只能看到一张工具卡：
既不知道它在干什么，也读不到它的报告全文（报告只回传给主代理）。现在有两条改动补上这一点：

- **进度上报**：`ToolContext` 新增 `emitProgress?(payload)` 与 `toolCallId`。`task` 工具在子循环
  每个事件（文本段 / 工具调用开始与结束）后组一份 `SubagentSnapshot` 上报：
  `{ taskId, callId, description, prompt, status, startedAt, endedAt?, steps[], toolCalls, report? }`
  （2026-09 起另有 `permission` / `tools` / `messages` / `transcriptTruncated`，见 §19.2 / §19.3）。
  步骤按 `call.id` 原地更新（同一工具调用不会出现两条），步骤数上限 60、单步文本 4000 字符、
  报告随累积实时带上（上限同 `MAX_TASK_RESULT_CHARS = 20_000）。**过期保护与限额只影响展示**，
  回传主代理的报告口径不变。
- **流转**：`runToolStreaming`（§5）把上报的进度转成 `subagent` 事件流；agentHost 补上
  `sessionId` / `requestId` / `seq` / `messageId` 后照常广播。工具结束时，最终快照随
  `ToolResult.subagent` 一起落到**工具卡**里（`StoredToolCall.subagent` → 会话 JSON），
  因此重启后仍能回看。
- **界面**（`07 §2.3`）：`task` 工具卡展开体里是**独立对话视图**（§19.3，2026-09 起替换了
  原先卡内的紧凑轨迹 —— 两者信息重复）；左栏固定项「子代理」把主区切到
  **子代理页面**，集中展示本会话的全部运行（数据 = 实时事件与工具卡持久化快照按 `callId` 合并，
  实时优先），每条运行**两个缩放级别**：折叠是紧凑轨迹、展开是独立对话视图
  （同一段内容不说两遍），卡头带权限徽章。
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
| `read.txt`：可把**图片 / PDF** 作为附件读入（视觉附件） | **部分采纳：图片进模型已落地（多模态附件 + 图像工具），`read_file` 仍不读二进制、PDF 不支持** | §3.1 / §25 | Aurora 的 `read_file` 仍明确拒绝二进制（含 NUL 即报错）、**图片 OCR 仍未启用**；但「把图片交给模型看」已由多模态附件（§3.1）与图像工具 `view_image` / `screenshot` / `clipboard_read_image`（§25）承接 —— 路径与边界见该两节 |
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
  即 §5 的顺序表：静态 / 半静态段（基础人设 → 当前模式 → **本次运行（v0.2.8，§5.2）** →
  可用 Skill 清单 → 可用工具清单 →
  工具使用规范 → Agent 可修改的设置 → 安全规则）在前，易变段
  （**更早对话的摘要 → 当前任务清单 → 项目约定 → 系统状态**）在末尾。
  v0.2.8 的 `runContext`（§5.2）刻意落在**静态段**（紧随「当前模式」）：它按**本次请求的来源**
  变化（同一个会话在自动化档与普通档之间来回切换是极罕见的事），且它后面的静态文本
  正好是「先讲清现在是什么场景、再列可用能力」的自然读序。
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
- 展示口径（2026-10-03 起）：对话窗「上下文详解」条显示**平均缓存命中率**——
  分子 / 分母都是**累计**（`usage.totals.cachedTokens / usage.totals.promptTokens`），
  折叠态文案形如 `512 / 128k · 平均缓存命中 100%`（命中片段是
  `data-field="chat.context-cache"`，嵌在 `chat.context-usage` 文案里）：
  - 单轮命中率抖动大，平均值才反映 provider 缓存的真实收益；绝对数（累计命中 / 累计输入）
    在展开的详解卡里；
  - 百分比 = `Math.min(100, Math.round(totalCached / totalPrompt * 100))`——
    `cachedTokens` 是**服务端报的命中数**，正常不会超过 `promptTokens`，但桩服务 / 异常网关
    可能给出不一致的数据，界面不显示「平均缓存命中 400%」这类荒谬值；
  - 累计 prompt 为 0 时不显示（不编造分母）；
  - **provider 是否回传**以 `latest.cachedTokens` 是否缺省判定（totals 累计后无法区分
    「没回传」与「全没命中」）——未回传时那一段**整段不渲染**（不显示「平均缓存命中 0%」）。
- 持久口径（2026-10-03 起，**本条推翻「不落盘」的旧口径**）：主进程在每轮 usage 事件处
  **先累计进 `meta.usage`、再广播事件**（`SessionStore.addUsage`，随会话文件落盘，
  字段：`promptTokens / completionTokens / totalTokens / cachedTokens / rounds`）。
  渲染层切回会话时以 `chat:sessions` 摘要带出的 `meta.usage` 为**种子**恢复累计，
  之后逐轮继续累加——平均命中率因此按**会话**算，跨切换、跨重启连续，
  不再是「本窗口本次观看期间」的口径。
- 累计口径：渲染层把每轮 `cachedTokens` 累加进 `usage.totals.cachedTokens`（缺省按 0 累加），
  与 prompt / completion / total 三个累计量同一条 `usage` 事件路径；
  防重集合 `countedUsage`（键 `requestId#round`）**跨会话切换不清**——
  切回后迟到的旧事件不能把种子里的轮次再加一遍。

### 21.5 明确不做

- **不引入显式 `cache_control` 断点**：那是 Anthropic 方言，写进请求体在不少网关会直接 400
  （与既有 `stream_options` 降级同一个坑）。
- **不加任何配置字段**（因此没有迁移、没有新设置页 UI）：前缀稳定化是内核的固定行为，
  不需要用户开关。
- 本轮不做 prompt 费用累计统计与长期报表（平均缓存命中率见 §21.4 的 `meta.usage` 持久口径）。


## 22. Aurora Center 工具与 create_skill（v0.2.0）

### 22.1 Center 工具组（`center_status` / `center_send_file`）

Aurora Center（docs/12）连接建立后，Agent 获得两个 Center 工具；内核经 **`CenterPort`**
注入实现，内核本身不做任何网络与 Electron 操作（与 `fetchImpl` / `confirmTool` 同一套路）：

| 工具 | 入参 | sensitivity | 说明 |
|---|---|---|---|
| `center_status` | 无 | 无 | 返回连接状态 / 服务器地址 / 客户端展示名；未连接时如实返回「未启用或未连接」 |
| `center_send_file` | `path`（绝对路径）, `note?` | `'safe'`（v0.2.4 起直接发送，不逐次确认） | 校验存在与大小（`center.maxFileMb`）后上传到 Center，返回 `{ fileId, name, size, url }` |

- **注册门控**：`center.enabled === true` 且 `center.serverUrl` 非空**才注册**（未配置时
  连工具都不出现，与 STT/TTS 的按钮门控同口径）；`center_send_file` 另受
  `center.allowFileTransfer` 约束（关闭时工具明确报错而非消失）。**不受**
  `agent.tools.enabled` 门控（与扩展工具七件套同口径）。v0.2.4 起它不再逐次确认 ——
  安全闸门就是这三层配置开关（见 §11.2），用户要求发文件零打扰。
- **只读前缀联动**：`center.*` 整组在 `SETTINGS_READONLY_PREFIXES` 里 —— 连接目标是
  数据外发通道，AI 的 `set_setting` 不得启用 / 改向 / 填令牌（自我外联 = 数据外泄）。
  工具 description 与 systemPrompt 的 settingsHint 都写明这条。
- 上传实现（主进程 `CenterPort.sendFile`）走客户端与 Center 的 HTTP 通道
  （`POST /api/ingest/files`，配对令牌鉴权），**v1 不经代理配置**。

### 22.2 create_skill：用户经对话创建自己的 Skill

内置技能 `skills/create-skill/SKILL.md`：用户说"帮我做一个 xxx 的技能"时命中。正文指导
Agent 按以下流程产出用户技能：

1. 向用户收集：技能名（kebab-case，与目录名一致）、一句话 description、适用场景
   （when_to_use）、指令正文；
2. 生成 `SKILL.md`（frontmatter 格式与内置技能一致：`name` / `description` /
   `when_to_use` 可选），用 `write_file` 写入用户技能目录
   `userData/skills/<name>/SKILL.md`（`skills.userDir` 非空时用配置目录）；
3. 技能可附 `scripts/` 目录（只注入文件清单，**永不自动执行**，见 §6）；
4. 写完后提示用户：目录监听会自动重扫（§22.3），新技能即刻出现在 `use_skill`
   清单里，也可在设置页启用 / 禁用。

安全口径：create_skill 只是一个**教模型怎么写 SKILL.md 的指令模板**，不是特权工具 ——
写文件仍走 `write_file` 的全部权限与确认链路（`sensitivity` / 项目根边界 / 快照）。

### 22.3 用户技能目录监听与自动重扫

`SkillsService`（主进程）对生效的用户技能目录挂 `fs.watch`（防抖 500ms）：
目录内新增 / 删除 / 修改 SKILL.md 后自动 `rescan()` 并广播 `skills:changed`。因此
create_skill 写完文件后**无需任何"刷新"仪式**；监听失败（如目录被删）降级为日志
告警，不影响既有技能表。

## 23. 自动化管理工具与自动化触发的会话（v0.2.5）

自动化（Agent Mode / Normal Mode）的完整设计见 **docs/13**；本节只写**工具面与会话面的契约**：
AI 用什么工具管理自动化，以及自动化触发 Agent 时那条会话长什么样。

### 23.1 自动化管理工具（`automation_*` 六件套）

主进程 `apps/desktop/src/main/tools/automation-tools.ts` 注册（装配器 `registerAutomationTools`，
接线在 `main/tools/index.ts`）：

| 工具 | 参数摘要 | sensitivity |
|---|---|---|
| `automation_list` | 无（列出用户定义 + 内置自动化 + 摘要） | safe |
| `automation_create` | `name` / `mode` / `trigger{kind, params}` / `prompt`（agent）或 `actions`（normal） | **confirm** |
| `automation_update` | `id` + 局部字段（含 `enabled` 启停） | **confirm** |
| `automation_delete` | `id` | **confirm** |
| `automation_run` | `id`（手动触发一次；Agent 模式会跑一次完整会话） | **confirm** |
| `automation_history` | `automationId?` / `limit?`（默认 20，最大 200） | safe |

- **注册口径**：与 `registerSettingsTool`（§12）/ `registerExtensionTools`（§14.1）/
  `registerAgentCoreTools`（§18 / §19）**同级**，**不受 `agent.tools.enabled` 门控** ——
  这六件套管的是自动化的**元数据**（定义与运行历史），不属于「电脑操控」的开关语义；
  `syncToolRegistries()` 每拍全量重建，热生效。
- **只读档摘掉写类四个**：`agent.permissionMode = 'readonly'` 时不注册
  `automation_create` / `automation_update` / `automation_delete` / `automation_run`，
  只保留 `automation_list` / `automation_history` —— 档位叫「只读」就必须真的没有副作用（§11.2）。
  **自动化会话里被摘掉的恰好也是这四个**，但判据与机制不同（会话来源的**请求级摘除** +
  `execute` 层拒绝，v0.2.8，§5.2 / §23.2）。
- **写类四个一律 `sensitivity: 'confirm'`**：AI 给自己排一个后台动作必须用户点头，
  每次调用都走 §5 的 `confirmTool` 与 §9.1 的确认卡片；拒绝时按「用户拒绝执行」回填、循环继续。
- **`automation_update` 对 `builtin.` 前缀 id 直接拒绝**并引导去设置页
  （内置自动化的启停映射既有配置字段，见 docs/05 §3.4、docs/13 §6）；内置的删除请求同理。
- **参数合法化以主进程 catalog 为准**：工具 description 给出触发器 / 操作组件的 kind 清单与
  参数形状，非法 kind、缺参数、catalog 之外的组件一律拒绝（保存入口的唯一合法化层是
  `validateDefinition`）—— 渲染层 / 远程路径经 IPC 回 `E_INVALID_ARGUMENT`（带中文原因），
  AI 工具侧以 `isError` 回填同一原因。
- **未进 `buildToolGuidance`**：§5 的「工具使用规范」小节**没有**为自动化工具加段落
  （按注册工具名条件生成的那几段仍只覆盖 `todo_write` / `task` / `run_command` / `set_setting` /
  `edit_file` / `grep` / `glob`），这六件套靠自身 description 自述。
- **与 `set_setting` 的分工**：`automations.*` 整组在 `SETTINGS_READONLY_PREFIXES` 里（§12.2）——
  AI 改不动自动化总开关，增删改自动化只能走上面的专用工具（逐次确认）。

### 23.2 自动化触发的 Agent 会话

Agent Mode 触发时，引擎用**专属会话**跑一次完整的 §5 工具循环（与用户对话同一条内核链路，
docs/13 §7）：

- **会话 id**：`sessionId = runId = auto-<ts36>-<n>`。runId 在 `agent.send` **之前**就落进运行记录，
  因此即便 send 失败（如未配置模型），历史仍能指向「本该承载本次任务的会话」；
  隐藏后台会话不参与自动标题，沿用既有的「首条用户消息前 24 字」推导
  （`SessionStore.titleFor`，即任务指令摘要）。
- **origin**：`SendMessageRequest.origin` 与 `AgentJob.origin` 的联合类型各扩一个 `'automation'`
  成员（job 字段形状见 §4.1）。内核不为它分支 —— 只写进 job 记录与日志，扩联合即安全。
- **`extraContext`**：按契约注入触发上下文（自动化名称 + 触发描述，如「距上课 3 分钟」，
  并附一句「请直接开始执行任务」），模型因此知道「为什么被唤醒」。
- **运行终态由事件驱动**：`done` → `success`（落 `durationMs`）、`error` → `failed`（落错误文本）；
  另有 **30 分钟兜底超时**，超时按失败收尾 —— 不留永远「进行中」的记录；
  进程重启时历史里遗留的 `running` 记录改判 `interrupted`（docs/13 §3）。
- **敏感工具确认沿用既有确认链，自动化没有自己的权限体系**：无人值守时 **60s 超时默认拒绝**
  （`ProactiveScheduler` 既有语义，§9.1）。要「免打扰」得由用户把 `agent.permissionMode`
  设为 `auto`（完全权限，所有敏感工具不弹卡，§11.2）或在会话里点「本会话都允许」（会话级授权表）——
  **不为自动化新增静默放行通道**。
- **运行档（v0.2.8，§5.2）**：这条会话不套交互式人设（换成「后台执行体」，不反问、做完汇报），
  多一段「## 本次运行」小节，并在**工具面**摘掉 `automation_create` / `automation_update` /
  `automation_delete` / `automation_run` 四个写类工具（执行层另有一道拒绝）—— 自动化不能自我
  延续；只读的 `automation_list` / `automation_history` 保留。业务口径见 docs/13 §7.1。

### 23.3 `auto-` 前缀会话只过滤展示
`auto-` 前缀会话**不进主界面左栏会话列表**（渲染层按前缀过滤，与 `center-` 可见性同款口径，
docs/12 §5）—— **只影响展示**：会话与 job 照常落盘、可经 `chat:history` 回放，
入口是「自动化 → 历史」里那条运行记录的 `sessionId`（即 runId）。
会话 id 走既有 `normalizeSessionId` 白名单归一（`[A-Za-z0-9_-]`），`auto-` 前缀天然合法（docs/13 §12）。

## 24. 向用户提问（`ask_user`，2026-09）

`ask_user` 给 Agent 一个**问到答案再继续**的能力：碰到「用户没说清、但答案会决定后面几十步走向」
的分叉时，此前只有两个选择 —— 猜一个（猜错就把整轮做完才发现）或把问题写进正文里停住
（用户得手动再发一条消息才继续）。现在它是一次工具调用：问一次、拿到回答、**同一次请求里往下走**。

| 工具 | 参数 | sensitivity |
|---|---|---|
| `ask_user` | `{ question, header?, options?: {label, description?}[], multiSelect?, allowCustom?, timeoutMs?, questions? }` | safe |

- **一次只问一个问题**（除非用 `questions` 一次问相关的 2–4 件）：`options` 2–4 个
  （不给选项 = 用户看到自由输入框），问题 ≤ 500 字符、选项文案 ≤ 60、选项说明 ≤ 200；
  多选只在不少于 2 个选项时才有意义（工具会把「1 个选项 + multiSelect」归一成单选）。
  **`questions`（本轮）** 是「一次问几件相关的事」的入口：逐项与单问同形，卡片渲染成
  一张卡里的分节、用户一次提交，作答按顺序回填 `answersByQuestion`（`answers` 仍是它的
  扁平副本供旧消费方用）；顶层的 `question` / `options` / `multiSelect` 取**第一问**的副本，
  因此老客户端 / 老网页端天然降级成"显示第一问"。不相干的问题仍应拆成多轮 —— 批量提问
  会把用户淹没，那与「减少打扰」的初衷相反。
- **`allowCustom: false`（本轮）**：两端都不渲染自由输入框，用于「只能从这几个选项里选」
  （如选一个已存在的 id）。**`timeoutMs`（本轮）**：这一次提问的等待时长，钳制在
  30s–10min（缺省 180s）—— 需要用户去别处查一下再回来答的场合可以放宽。
- **不是确认，也不替代确认**：`sensitivity: 'safe'`（不写盘、不执行命令，它的"危险"只是打扰用户），
  因此**在只读档也照常注册**。敏感动作该走的确认卡片与它并存、互不替代：
  确认问的是「要不要执行这个敏感动作」，提问问的是「这件事你想怎么办」。
- **一定会有结论**：三条兜底出口都写在这里，因为内核在 `await` 它 ——
  ① **超时**（默认 **3 分钟**，`ASK_USER_TIMEOUT_MS`；可按次用 `timeoutMs` 覆盖）按「用户没答」结算；
  ② **跳过**（卡片上有这个入口，语义比超时明确）；
  ③ **请求被中止**（用户点停止 / 退出）立刻结算 aborted。
  三种情况回填给模型的都是「没有回答 + 请说明假设并继续，不要重复提问」，
  区别只在文案与 `isError`（只有 aborted 算错误 —— 这一轮已经不算数了）。
  多问时回填**逐问列出**（`- 问题 → 作答`），不会只把第一问抄给模型。
- **端口缺失时不静默失败**：未注入提问端口（单测 / 未来别的壳层）时工具回 `isError`
  并告诉模型"这里问不了人，改用假设继续" —— 静默成功会让模型以为问题已经问出去了。
  端口抛错同样转 `isError`（问答通道坏了不能把整轮请求带崩）。
- **界面上是一次协作**（`07 §2.3`）：`AskUserCard` 与确认卡片同区域、同款交互语言，
  但**没有**「总是允许」这类记忆（提问是一次性的，不是要记住的授权），
  倒计时 ≤ 30 秒转红；卡片收起不代表"被拒绝"，主进程那边早有结论。
- **子代理不向用户提问**：`ask_user` 是 `safe` 级，本该进子代理的工具表，
  但 `task` 的过滤里**显式排除**它 —— 一个后台子代理弹卡片打断用户，
  而它自己又看不到回答之外的上下文，澄清需求是主代理的职责（子代理人设里也写明了）。
- **IPC 契约**（`askUser:request` 推送 + `askUser:answer` 回执，docs/02 §6）：
  与 `proactive:*` **刻意分表**，因为两者对「超时」的语义相反（确认按拒绝、提问按未回答继续）。
- **远程会话的提问经 Center 中转（v0.3.3，docs/12 §5）**：`center-` 前缀会话里提问时，
  `AskUserService.onRequest` 除本机渲染层外还把 `ask.request` 上行到 Center
  （本地会话不上行，与确认卡同口径；连接器离线时进同一补发队列）；网页作答经 `ask.resolve`
  转回 `AskUserService.resolve` —— 与本地卡**先到先得**（`resolve` 对已结算 requestId 返回
  false，重复批复不重复结算，本地卡照常显示）。网页刷新后未过期的提问由服务器回放。
- **本地结算会外发（本轮，docs/12 §5）**：`AskUserService.onSettle` 在**四条结算路径**
  （作答 / 跳过 / 超时 / 中止）都触发一次，装配层把 `center-` 会话的那条上行成
  `ask.settled`，网页端据此**立刻收起卡片**（此前它只能靠自己的倒计时，本地先答了它也不知道）。
  离线不入补发队列（过期即无意义）。
- **提问留痕（本轮）**：`center-` 会话的问答以 `StoredSession.asks` sidecar 持久化
  （会话文件格式 **v4**，有界环最近 50 条 / 同 requestId 幂等覆盖），
  `rendererHistoryWithAsks` 把它按时间与消息交错带回 Center 回放 —— 刷新 / 换设备后
  「问了什么、答了什么」仍然可见。**刻意不写成 system 消息**：`context()` 只读 `messages`，
  留痕绝不进模型上下文。本地会话的提问卡仍是瞬时卡片（不留痕、不落 sidecar）。
- **注册口径**：随 §18 的 `registerAgentCoreTools` 一并注册，**不受 `agent.tools.enabled` 门控**，
  也不按权限档摘除。

## 25. 图像工具（`view_image` / `screenshot` / `clipboard_read_image`）

`generate_image`（§15.2）让 Agent 能**写**图，这一节补齐它**看**图的能力：读一张本地图片、
截取当前屏幕、读剪贴板里的图片，并把图片作为本轮输入的一部分交给模型。三者与 §14 的扩展工具
同族（内核只定义工具与端口，系统能力由主进程注入），但**门控方式与它们相反**。

| 工具 | 参数 | sensitivity | 门控 | 产物落盘 |
|---|---|---|---|---|
| `view_image` | `{ path }` | `safe`（与 `read_file` 同档） | 仅当当前生效模型 `vision === true` 时注册 | 无写入 |
| `screenshot` | `{ display?: 'primary' \| 'all' }` | **confirm** | 同上 | `<userData>/screenshots/<ts>.png`，保留最近 50 张 |
| `clipboard_read_image` | `()` | **confirm** | 同上 | `<userData>/clipboard/<ts>.png`，保留最近 50 张 |

### 25.1 门控：按当前生效模型的 `vision` **注册级**生效

- **判据是「当前生效模型是否开启图片输入」**：读的是
  `llm.providers.<active>.modelParams.<modelId>.vision`（v23 起按模型绑定），唯一取值口径是
  `resolveModelParams`（§3）——判决与图片附件管线**共用同一份实现**（主进程 `main/vision.ts`），
  **不写第二份**。
- **门控是「注册级」而不是「调用级」**：`vision` 为假时这三个工具**根本不进工具表** ——
  模型在系统提示词的「## 可用工具」清单里看不到、请求体 `tools` 数组里也没有、即便调用也会被回填
  「工具不存在」。这与 ClassIsland / Center 工具「按可用性注册」同款，不是「注册后再拒绝」。
- **热生效**：工具表由 `sync()` 在启动与每次 `settings:changed` 时重建，因此在**对话窗的模型下拉里
  换模型**（写 `llm.providers.<active>.model`）**下一次请求即生效，无需重启**（与 §3 的参数取值同拍）。
- **`generate_image` 不在门控内**：生图只需要模型会写描述、不需要它自己会看图，因此**任何模型都能生图**；
  开启 `vision` 后模型可以顺手 `view_image` 检查自己刚生成的图（见 §14 / §15.2）。

### 25.2 `view_image` 的读盘边界与自有目录

- **与 `read_file` 同一条边界**：`view_image` 是 `sensitivity: 'safe'`，读盘走 `file-port.ts` 的
  `resolveWithin`（项目根 realpath 前缀校验，边界根按会话解析 `sessionProjects.boundaryRoot(sessionId)`，
  见 §11.1 / §5.1）—— 与 `read_file` 完全一致，没有第二条读盘通路。
- **app 自己的三个目录始终可读**：`<userData>/generated`（生图）、`<userData>/screenshots`（截屏）、
  `<userData>/clipboard`（剪贴板）**不受边界根限制** —— 这三处是 app 自己写出的产物，必须能被回看，
  否则「生成一张图再看看」这条最自然的用法会被边界挡死。
- **根外路径如实拒绝**：越界时不静默返回空、也不假装读过，而是把错误回填给模型，并提示它
  「可以让用户把图片拖进对话窗口」（附件管线不受该边界限制，那是用户显式动作）。
- **只读图片格式**：只接受图片扩展名（`png / jpg / jpeg / webp / gif / bmp`），读文本要用 `read_file`；
  单图上限沿用 `IMAGE_MAX_BYTES`（8 MiB）。
- **工具描述要交代的**：`view_image` 说明「只能读图片格式，读文本用 `read_file`」；
  `screenshot` 说明「截的是当前屏幕，会给用户弹确认卡」。
- **提示词另有一行规范**：`buildToolGuidance` 在工具表含 `view_image` 或 `screenshot` 时追加
  「用户问屏幕上是什么、或指向某个报错窗口时，直接用 `screenshot` 截图自己看，不要让用户描述」——
  模型在这类问题上最容易走偏的一步就是反问用户「你能描述一下吗」。工具表里没有它们时这一行自动消失，
  不会出现「提示词让模型去调一个不存在的工具」。

### 25.3 图片怎么回到模型

- 三者都走 §3.1 那条通路：`ToolResult.images`（`{ path, image }`）里的**路径随 tool 消息落盘**
  （`StoredMessage.images`），**图片内容作为一条合成 user 消息**在本轮全部 tool 结果之后下发；
  历史重放时同样补这条消息 —— 口径与用户拖入的附件一致（存路径、跨轮重放），关闭态自动降级。

### 25.4 与权限档、配置 Schema 的关系

- **只读档（`agent.permissionMode === 'readonly'`）不摘这三个工具**：与 §14 的扩展工具七件套同口径 ——
  `screenshot` / `clipboard_read_image` 写的是 app 自己的目录（不是用户文件）、`view_image` 纯读，
  因此不属于「写入 / 执行类工具」。
- **无配置 Schema 变更**：本能力不新增配置字段、不推进 `CONFIG_VERSION`、无新迁移
  （当前版本号见 08 §2）—— 门控读的是既有的 `vision`。

## 26. 文件自感知（v29）

- **定位**：独立的桌面后台子系统，不是普通聊天会话。它记录用户选定目录内的文件变化与
  Windows 最近使用记录，对常见图片、Office / PDF / 开放文档 / HTML / EPUB / 纯文本做内容分析
  并生成用户可见 Markdown 笔记；老式 `.doc` / `.ppt` / `.xls` 只记录使用与变化，不做伪正文解析。
- **启用闸门**：`fileAwareness.enabled && fileAwareness.contentConsentAccepted` 且知识库 / 模型可用。
  未满足时只维护索引与队列，不提取正文、不出网；整组配置对 `set_setting` 只读。
- **后台模型**：设置页会把后台模型固化为显式的 provider + model；旧配置仍为空时运行时
  兼容跟随全局 `llm.active`。显式选择使用该 provider + model 的 Base URL、Key、思考等级与 vision。
  显式模型不可用时
  队列暂停并显示原因，**不回落主模型**，避免文件正文发给用户未选择的接收方。
- **读取口径**：图片仅在有效后台模型开启视觉输入时读取像素并作为图片分片；否则只保留文件名、
  尺寸等元数据。文档优先走结构化提取：DOCX / PPTX / PDF / ODF / RTF / HTML / EPUB 输出
  Markdown 标题、列表与表格，XLSX / ODS 输出 CSV；老解析器不支持结构化输出时退回纯文本。
  自感知证据上限为 24KB，仍按头尾采样，兼顾完整度与单文件成本。
- **扫描范围**：监控目录按**无限层级递归**；任意子目录内的受支持图片 / 文档 / 文本都进入分析，
  老式 `.doc` / `.ppt` / `.xls` 仍只观察，不生成正文记忆。
- **后台 Agent**：每次分析使用 `awareness-<noteId>` 隐藏会话与 `origin: 'file-awareness'`，
  `RunProfile.allowedTools = []`。模型接收元数据、8KB 提取证据、当前笔记生成区、本地筛选出的
  最多 20 份候选笔记；文档内嵌图片或源图片在用户同意正文出网后一并提取，若当前模型开启
  `vision` 则随本轮作为图片分片分析（最多 8 张，单张解码后不超过 8 MiB、合计不超过 24 MiB），
  否则在证据中如实列出图片元数据并声明“未读取图片视觉内容”。模型返回严格 JSON；主进程负责
  校验、渲染 Markdown 与写盘，模型不能直接操作文件。临时图片只用于本轮分析，结束后删除。
- **笔记与过期**：一份源文件对应一份稳定笔记，使用 `<!-- aurora:generated:start/end -->` 包围生成区；
  标记外内容不改写。标记缺失 / 重复视为冲突并停止自动更新。旧版本只落私有目录，默认每笔 20 份或
  50 MB。知识库公开路径为 `<格式>/<首次感知日期>/<标题>--<fileId>.md`，同一源文件后续更新
  始终写回同一份 md，不因当天日期变化另建副本；旧版根目录笔记在启动或配置重载时自动迁移。
  每条记忆有 `inherit / never / at` 三种过期策略：`inherit` 按 `updatedAt + defaultMemoryTtlDays`
  计算，源文件重新分析后续期；显式固定时间不续期；`at` 的 `preset: 'manual'` 表示用户在记忆库
  手动立即过期，状态始终为已过期且源文件重新分析不会续期。过期后记忆仍留在记忆库与 Markdown 中，
  但后台候选与 `awareness_*` 工具都不再使用它；用户可改为永不过期或重新选择到期时间恢复。
  根目录维护 `INDEX.md`：按格式与日期列出笔记链接、ID、来源、标签、摘要与过期状态；后台候选筛选使用
  同一份轻量索引快照，不再逐次遍历完整笔记正文。
  源文件消失时同步删除对应 Markdown、状态项、索引项与版本备份；启动 / 扫描时也会核对监控根仍
  可访问的旧笔记，避免离线删除长期残留。监控根本身不可访问时只暂停核对，不误删整批记忆。
- **建议气泡**：只有模型返回可行动建议、当前源版本未忽略且未处于勿扰时段时才推送提示条。
  若建议还给出了 `action: { label, prompt }`，气泡额外显示执行按钮；点击后创建一条 Agent
  空间的新会话，把 `prompt` 作为首条用户消息、建议与来源作为同轮附加上下文送入，并打开主界面
  切到该会话。顺序固定为**先创建并持久化空会话 → 推送激活 → 再发送首条消息**：
  激活发生在会话未落盘时，主界面列表刷新不到目标 id，会停留在原会话或落到错误现场。
  工具权限、确认卡片与项目边界仍走既有链路，不因“来自建议”而放宽。
  同一 `noteId + sourceHash` 去重；忽略只影响该版本，不删除笔记。提示条把本次运行内收到的
  未忽略建议聚合展示：单条保持完整卡片，多条显示折叠组并在点击后展开；不再因固定超时消失。
  模型提示词和解析上限共同收紧 `headline` / `body` / 动作文案，避免提醒堆成长段落。
- **记忆库窗口**：设置页只保留知识库配置、后台模型、默认有效期、笔记数量 / 冲突 / 过期摘要与入口；
  完整浏览由独立
  `memory` 窗口承载。窗口经 `awareness:readNote` 读取已知 noteId 的 Markdown，在本窗口内
  左侧先按源格式（Word / PPT / Excel / PDF / 图片 / 文本等）分组、组内再按首次感知日期分组，日期组可折叠，默认只展开
  当前笔记所在日期；左栏提供关键词与格式 / 时间筛选，右侧安全渲染预览；详情区可设置
  跟随默认 / 永不过期 / 24 小时 / 7 天 / 30 天 / 自定义到期时间，并提供“立即过期”按钮；
  “用系统打开”和“打开源文件”仍复用原有 `openNote` /
  `openSource` 单向通道。提示条经 `awareness:presentNote` 显示记忆库并选中目标笔记；
  读取只允许知识库状态里登记的 noteId，不接受任意路径。
- **分析记录**：只保留文件实际内容变化后的终态记录（`done` / `error` / `conflict`），删除源文件
  仍记一条 `skipped`；未变化、不支持、排队与分析中状态不进入记录，进度只在“运行状态”中展示。
- **系统重置**：设置页可两步确认后重置全部记忆。重置会删除已登记笔记、`INDEX.md` 条目、
  队列 / 运行记录 / 最近使用 / 建议 / 累计用量 / 版本备份，并删除隐藏的 `awareness-*` 后台会话；
  保留监控目录、知识库路径、正文授权、模型配置与源文件。重置完成后自动恢复监听，但**不自动扫描
  或重建记忆**，避免意外消耗模型额度。状态文件版本为 `v4`，加载旧状态时丢弃过时的过程记录。
- **顶部流光**：主进程维护一个内部透明浮层，在文件进入 `extracting / analyzing / writing`
  阶段且提示条已启用、当前可见、未处于首次引导 / 勿扰 / 游戏模式时显示。浮层跟随
  `general.edgeBar.display` 的 `primary / cursor` 选择，横跨目标显示器 bounds 顶部并贴住第 0 像素，
  不因提示条左右贴边位置改变；鼠标穿透、不可聚焦，排队阶段与空闲阶段不显示。
  连续分析多个文件时，文件切换不广播空闲帧，极光保持连续显示；只有队列批次真正结束
  或停在模型 / 授权 / Agent 忙态门控时才退场。视觉层以竖向光幕为主，内部叠加两条宽而软的
  左→右流光带，颜色分布也沿同一方向循环流转；它们使用缓入缓出，不形成硬边扫描线。光幕本身缓慢呼吸和轻微漂移，
  出场时模糊淡出，再在约 680ms 后隐藏。连续分析期间不会重新播放入场。叠加层不截取或改变
  桌面窗口的真实像素。
- **只读 Agent 工具**：`awareness_status` 始终注册，说明启用状态、当前文件、队列、笔记数、
  过期数、冲突、后台模型错误与累计 token。`awareness_recent` / `awareness_search` / `awareness_read` 仅在
  自感知启用、已同意正文分析且知识库可用时注册，全部 `sensitivity: 'safe'`：前者返回最近理解，
  中者按关键词 / 格式 / 时间搜索已登记笔记，后者按 noteId 分页读取 Markdown。四者都只读，
  不提供扫描、分析、忽略或清历史；读取上限与截断状态如实返回，不接受任意路径。
  三件只读工具都只看到有效记忆；过期记录按 `noteId` 或 `sourcePath` 同步排除，避免从运行摘要侧泄漏。
- **与前台 Agent 串行**：任何非 `awareness-*` 的 Agent 请求处于活动状态时，自感知暂停启动新的
  分析任务；已排队文件保持不变，当前那份分析允许收尾。前台 Agent 全部结束后自动继续队列。
  此状态在 `awareness_status` 中显示为“等待 Agent”，不把自感知自己的后台会话算作忙态。
- **累计 token**：每次 `awareness-*` 后台分析的 provider `usage` 都累计到自感知状态；
  状态文件 v2 在首次升级时从既有会话 `meta.usage` 一次性回填，回填标记避免重复累计。
  provider 不返回 usage 时显示“暂无用量”，不估算；清空运行历史不重置该累计值。
- **队列**：单进程并发 1，按本地日期默认每日 20 个；队列持久化并在重启后续跑。首次接管把已有
  可解析图片 / 文档按修改时间从新到旧全部排队，安全上限 100,000 条，超限在状态中如实显示。
  状态额外返回当前文件的临时分析阶段（排队 / 提取 / 分析 / 写入），仅用于提示条进度展示，不持久化。
