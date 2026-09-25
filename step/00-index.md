# 任务：Agent 工具面与 opencode 对齐（提示词规范 + edit/grep/glob + prompt caching + run_command 免确认模式）

- 任务标识：`opencode-parity`
- 项目根目录：`D:\AICOP\Projects\Aurora`
- 创建时间：2026-09-26 00:39
- 执行模式：全部
- 基线提交：`5f8339bab288e4214659209c346eb3ad37325fe1`
- 归档目录：（完成后填写：`step/archive/<YYYYMMDD-HHMMSS>-opencode-parity`）
- 归档时间：（完成后填写）

## 任务背景（为什么这么拆）

现状（v0.1.2）：内核 16 个工具里**没有任何一个能改代码**——`write_file` 只能整文件重写，
没有精确替换（`edit`）、没有内容检索（`grep`）、没有文件名匹配（`glob`）。
模型要改一个大文件里的两行只能整篇重写（token 翻几十倍且极易改坏），
要定位一个符号只能靠 `list_dir` 逐层翻目录。这是 Code Mode 至今是占位实现的直接技术原因。

同时有两处既有机制可以低成本补上：
`run_command` 是 `sensitivity: 'confirm'`，**每一条命令都弹一次确认卡片**，编码场景下会把人烦死；
而 `advanced.confirmSensitiveTools` 是全局开关，关掉等于把安全边界一起关掉——缺的是中间档。
系统提示词则有一个真实的缓存失效缺陷（见「现状与关键结论」第 5 条），
每轮都在重复计费一批**本可命中缓存**的静态文本。

本任务一次补齐这四件事。依据是调研结论：**不缝合 opencode 源码**（它是 Effect + Vercel AI SDK +
Bun 优先的体系，工具契约 `Tool.define` 返回 `Effect.Effect<Info, never, Truncate.Service | Agent.Service>`，
与 Aurora 的纯对象 `ToolDefinition` + 注入端口是两套世界观，中间没有适配层），
但**直接采用它的工具提示词作为规格**——那些 `.txt` 是纯文本，零依赖，且经过了大量真实使用验证。

**不在本次范围**（防止执行阶段顺手扩大）：`apply_patch`、LSP 诊断、git snapshot / revert、
doom-loop 检测、显式 `cache_control`、`websearch` / `question` / `plan` 工具、
把权限模型整体重构成 opencode 的 allow/ask/deny 三值键、Code Mode 实装、Anthropic 原生协议。

## 完成标准

- [ ] `pnpm typecheck && pnpm test && pnpm build` 全绿，且新增用例覆盖：
      glob 模式编译器、`edit_file` 的 EOL 保真与唯一性拒绝、allow 模式匹配器、
      配置迁移 v11 → v12（幂等）、缓存命中量的解析（两种字段名）、系统提示词静态前缀逐字节稳定。
- [ ] `$env:AURORA_SMOKE='1'; pnpm dev` 的 `%TEMP%\aurora-smoke-logs\AURORA_SMOKE_RESULT` 无 FAIL，
      且新增断言至少三条：三个新工具（`edit_file` / `grep` / `glob`）已注册且敏感级正确；
      命中 allow 模式的命令**没有**推送确认卡片（对比未命中的命令推了卡片）；
      同一会话连续两轮请求，假 LLM 服务端收到的**系统提示词静态前缀逐字节相同**。
- [ ] `$env:AURORA_CAPTURE="$env:TEMP\aurora-capture"; pnpm dev` 退出码 0、`report.json` 无 FAIL，
      「智能与工具」页探针报告 `agent.tools.terminal.allowPatterns` 与 `agent.tools.search.*` 字段存在；
      张数与探针条数以 `report.json` 实际条目为准，并同步 `AGENTS.md` 与 `docs/07 §5.3` 的计数。

## 现状与关键结论

1. **工具契约形状**：`packages/agent-core/src/tools/registry.ts:53` 的 `ToolDefinition` 是纯对象
   `{ name, description, parameters, sensitivity?, execute(input, ctx) }`，`execute` 返回 `Promise<ToolResult>`。
   `ToolContext`（同文件 `:23`）带 `sessionId` / `toolCallId` / `signal` / `emitProgress`
   —— **`sessionId` 可用于按会话维护「读过哪些文件」的状态**，无需为每个会话重建工具实例。
2. **现有的「内核纯逻辑 + 主进程注入端口」分工**：内核文件只做参数校验与结果格式化
   （`packages/agent-core/src/tools/files.ts` / `terminal.ts`），真实 IO 在主进程
   （`apps/desktop/src/main/tools/file-port.ts` / `command-runner.ts`），后者**不 import electron** 因而能进 vitest。
   新工具必须沿用这个分工，否则会破坏「agent-core 不依赖 Electron / DOM」这条硬约束。
3. **`read_file` 目前只能读文件开头**：`FilePort.readText(path, maxBytes)`（`files.ts:24`）
   从字节 0 读起、超出 `maxBytes` 截断（默认 262 144 字节）且**没有 offset / limit 参数**，
   因此大文件的后半段根本无法读取。`file-port.ts` 的 `readHead()` 也只读头部。
4. **工具名常量与门控分派**：`COMPUTER_TOOL_NAMES` 在 `packages/shared/src/config/schema.ts:421`
   （当前 5 个名字），`schema.test.ts:186` 有**精确数组断言**（改数组必须同步改测试）。
   `apps/desktop/src/main/tools/index.ts` 的 `registerComputerTools.sync()` 是唯一开关落地点：
   先按名字全量 `unregister` 再按当前配置重建，`settings:changed` 时热生效。
5. **prompt caching 的真实缺陷（本次要修的核心）**：`buildSystemPrompt`
   （`packages/agent-core/src/context/systemPrompt.ts:59`）的小节顺序是
   人设 → 当前模式 → **系统状态（每轮都变：时间 / 前台窗口）** → **当前任务清单** →
   **更早对话的摘要** → 可用 Skill → 可用工具 → 工具使用规范 → Agent 可修改的设置 → 安全规则。
   即**易变内容排在第 3 位**，把它后面约 3000+ 字符的静态文本每轮都顶出服务端前缀缓存。
   另有第二处：`ToolRegistry.toLlmTools()`（`registry.ts:88`）按 Map 插入序返回，
   而 `sync()` 的「先摘除再重建」会把工具挪到数组末尾 → 任何一次设置变更都改变 `tools` 数组顺序
   → 前缀整体失效。请求侧已确认**无需改动**：`agentLoop.ts:119` 的
   `messages = [system, ...history, user, extraContext]` 里易变的 `extraContext` 已在尾部，
   `[system, ...history]` 本身就是稳定前缀。
6. **`TokenUsage` 是跨 IPC 的共享契约**：定义在 `packages/shared/src/ipc/types.ts`，
   agent-core 的 `llm/types.ts:8` 只是重导出。使用量在
   `openai-compat.ts:424` 的 `extractUsage`（**函数名是 `extractUsage`，不是 `parseUsage`**）解析，
   只取 `prompt_tokens` / `completion_tokens` / `total_tokens`，
   **丢弃了缓存命中字段**；渲染层由 `useChat.ts:230` 的 `usage` 事件累加、
   `ComposerContextBar.vue` 展示「上下文详解」。
7. **确认链路**：`agentLoop.ts:494` 只在 `tool.sensitivity === 'confirm'` 且 `confirmTool` 存在时调用钩子；
   主进程钩子由 `apps/desktop/src/main/index.ts:638` 的 `createConfirmTool({ proactive, enabled, logger })`
   构造（适配 `ProactiveScheduler`）。**allow 列表的判定放在这个钩子内即可，内核零改动**。
8. **opencode 的工具提示词原文**（本次的规格来源，MIT 许可，仅借用文本不借用代码）：
   已取得 `packages/opencode/src/tool/` 下 `read.txt` / `edit.txt` / `grep.txt` / `glob.txt` /
   `lsp.txt` / `todowrite.txt` / `task.txt`（仓库 `sst/opencode`，`dev` 分支，commit `adee738`，
   访问日期 2026-09-26；本机安装版本 1.18.10，远端当时 1.18.32）。
   关键约定：`read` 返回 `1: 内容` 行号前缀、默认 2000 行、支持 `offset`；
   `edit` 要求**改前必须先 Read**、`oldString` 命中多处要报错并要求扩大上下文、`replaceAll` 用于改名；
   `grep` 用正则 + `include` 过滤、返回路径与行号；`glob` 支持 `**/*.ts` 这类模式。
9. **配置链现状**：`CONFIG_VERSION = 11`（`packages/shared/src/config/schema.ts:9`），
   迁移链最后一环是 `v10 → v11`（补 `llm.providers.*.contextWindow`，
   `migrations.ts:423`），因此本次新增迁移是 **v11 → v12**。
   `SETTINGS_READONLY_PREFIXES` 与 `READONLY_PREFIX_REASONS` 是一对**编译期强耦合**的常量
   （后者是前者元组的 `Record`，加前缀必须同时加中文原因，否则 `pnpm typecheck` 报错）；
   `WRITABLE_PATH_OVERRIDES` 是显式可写清单且**判定先于黑名单**，
   其中 `agent.tools.terminal.*` 只有逐条登记（`schema.ts:544`），**没有通配条目**——
   因此新增 `agent.tools.terminal.allowPatterns` 到黑名单不会被覆盖表放行。
10. **文档先行是仓库纪律**：改配置 Schema 先改 `docs/08`，改内核行为先改 `docs/06`，
    改设置页先改 `docs/07`，进度写入 `docs/04-roadmap.md`。
    本轮所有规格必须在步骤 1 一次写进 `docs/`，后续步骤只实现、只在发现偏差时就地订正。

## 假设与待确认

### 已由用户确认的决策（2026-09-26，一次问定）

- **prompt caching 只做「前缀稳定化 + 命中观测」**：不引入显式 `cache_control`，
  **不加任何配置字段**（因此无迁移、无新 UI）。理由：Aurora 只讲 OpenAI 兼容协议，
  DeepSeek / OpenAI / 硅基流动等主流网关的前缀缓存是服务端自动生效的；
  显式 `cache_control` 是 Anthropic 方言，写进请求体在不少网关会直接 400
  （与既有 `stream_options` 降级同一个坑）。
- **三个新工具全部纳入 `agent.tools.enabled` 总开关**：`edit_file` 归 `agent.tools.files`（与 `write_file` 同开关），
  `grep` / `glob` 新增 `agent.tools.search.{enabled, maxResults}` 组。
- **allow 模式列表用 glob 全串匹配**（`*` 任意字符含空、`?` 单字符、大小写不敏感、全串锚定），
  自写匹配器放在 `agent-core`（纯函数、可单测），判定在主进程 `confirmTool` 钩子内做，内核零改动；
  `agent.tools.terminal.allowPatterns` **加入 `SETTINGS_READONLY_PREFIXES`**（AI 改不动，防自我提权）。

### 假设

- **工具命名**：三个新工具取名 `edit_file` / `grep` / `glob`。`edit_file` 加 `_file` 后缀是为了与
  既有的 `read_file` / `write_file` 命名族一致；`grep` / `glob` 保持 opencode 原文名，
  因为它们是通用检索名词且模型对这两个名字的先验最强。
- **`edit_file` 不单独加开关**：与 `read_file` / `write_file` / `list_dir` 共用 `agent.tools.files.enabled`，
  避免设置页开关膨胀。
- **`edit_file` 的「改前必须先 Read」守卫恒开**（对齐 opencode），但实现为**可注入的守卫对象**：
  未注入时不拦截（未注入的形态供直接调用工具的单测使用，与 `confirmTool` 的既有模式一致），
  **不做成配置项**。
- **硬上限用内核常量而不是配置字段**（沿用 `MAX_TASK_RESULT_CHARS` / `MAX_WEB_FETCH_CHARS` 的先例）：
  `edit_file` 单文件上限 1 MiB（`MAX_EDIT_BYTES`）、搜索扫描预算、搜索默认忽略目录列表。
- **`read_file` 增加行号前缀与 `offset` / `limit`**：这是 opencode `read.txt` 的明确契约，
  且能修掉第 3 条「读不到大文件后半段」的真实缺口。既有的 `maxBytes` 语义保留（作为返回字节上限）。
- **同波可并行：无。** 原因见「步骤」小节末的说明。
- **本次不改版本号**：`package.json` 的版本提升属于发布步骤，本任务只写文档与代码。

### 待确认

无。

## 范围之外（明确不做）

- 缝合或移植 opencode 源码（含它的 `tool.ts` / `truncate.ts` / `permission/` 实现）。
- `apply_patch`（补丁格式工具）、LSP 诊断与符号检索、git snapshot / revert / undo。
- doom-loop（死循环反复调用同一工具）检测。
- 显式 `cache_control` 断点与 `llm.providers.*.promptCaching` 配置项。
- 权限模型整体重构成 opencode 的三值（allow / ask / deny）+ 每工具键 + 外部目录检查。
- `websearch` / `question`（结构化反问） / `plan`（计划模式）工具。
- Code Mode 的实装；Anthropic / Google 原生协议；prompt 费用累计统计。
- `run_command` 的命令黑名单（仓库既有结论：黑名单必然漏，安全靠「逐次确认 + 输出上限 + 总开关」）。

## 步骤

> 同波可并行（写范围互不重叠）：**无** —— 见下方说明。

| # | 文件 | 标题 | 状态 | 依赖 | 写范围 |
|---|------|------|------|------|--------|
| 1 | step-01-contract-and-config.md | 工具契约与提示词基线（docs 先行）+ 配置 Schema v12 | done | - | `docs/06`、`docs/07`、`docs/08`、`packages/shared/src/config/**`、`apps/desktop/src/main/settings-hint.ts`、配置调用点 |
| 2 | step-02-read-file-contract.md | `read_file` 契约对齐：行号前缀 + `offset` / `limit` + 工具规范条目 | done | step 1 | `packages/agent-core/src/tools/files.ts`、`files.test.ts`、`packages/agent-core/src/context/systemPrompt.ts`、`systemPrompt.test.ts`、`apps/desktop/src/main/tools/file-port.ts`、`file-port.test.ts` |
| 3 | step-03-search-tools.md | 搜索层端到端：glob 模式编译器 + `grep` / `glob` 两个工具 + 主进程 walker + 设置页 | done | step 2 | `packages/agent-core/src/tools/globPattern.ts`、`globPattern.test.ts`、`search.ts`、`search.test.ts`、`files.ts`、`files.test.ts`、`packages/agent-core/src/index.ts`、`apps/desktop/src/main/tools/file-port.ts`、`file-port.test.ts`、`index.ts`、`index.test.ts`、`apps/desktop/src/renderer/settings/pages/AgentPage.vue`、`apps/desktop/src/main/capture.ts` |
| 4 | step-04-edit-tool.md | `edit_file`：精确替换 + EOL 保真 + 唯一性拒绝 + 读前守卫 | done | step 3 | `packages/agent-core/src/tools/edit.ts`、`edit.test.ts`、`files.ts`、`files.test.ts`、`packages/agent-core/src/index.ts`、`apps/desktop/src/main/tools/file-port.ts`、`file-port.test.ts`、`index.ts`、`index.test.ts`、`apps/desktop/src/main/index.ts` |
| 5 | step-05-command-allowlist.md | `run_command` 免确认模式列表（内核匹配器 + 主进程接线 + 设置页 + 审计） | done | step 4 | `packages/agent-core/src/tools/command-allow.ts`、`command-allow.test.ts`、`packages/agent-core/src/index.ts`、`packages/shared/src/config/schema.ts`、`schema.test.ts`、`apps/desktop/src/main/agent-host.ts`、`agent-host.test.ts`、`index.ts`、`smoke.ts`、`smoke-llm.ts`、`capture.ts`、`apps/desktop/src/renderer/settings/pages/AgentPage.vue` |
| 6 | step-06-prompt-caching.md | prompt caching：提示词前缀稳定化 + 工具顺序稳定 + 命中观测 + 全量文档收口 | done | step 5 | `packages/agent-core/src/context/systemPrompt.ts`、`systemPrompt.test.ts`、`packages/agent-core/src/tools/registry.ts`、`packages/agent-core/src/host/agentHost.ts`、`packages/agent-core/src/llm/openai-compat.ts`、`openai-compat.test.ts`、`packages/shared/src/ipc/types.ts`、`apps/desktop/src/renderer/shared/composables/useChat.ts`、`apps/desktop/src/renderer/chat/components/ComposerContextBar.vue`、`apps/desktop/src/main/smoke.ts`、`smoke-llm.ts`、`capture.ts`、`AGENTS.md`、`docs/04`、`docs/06`、`docs/07`、`docs/10`、`docs/11`、`docs/README.md` |
| 7 | step-07-archive.md | 归档清理 | pending | step 1..6 | `step/` |

**为什么没有同波并行**（按修订后的 `Writes` 重新核过）：共享文件比初版估计的多，且**贯穿多步**——
`docs/06-agent-core.md` 被 step 1 / 4 / 5 / 6 改；
`apps/desktop/src/renderer/settings/pages/AgentPage.vue` 被 step 1（`TOOL_GATES` 与计数文案）/ 3 / 5 改；
`apps/desktop/src/main/capture.ts` 被 step 3 / 5 / 6 改；
`apps/desktop/src/main/index.ts`（smoke 断言宿主）被 step 4 / 5 / 6 改；
`smoke-llm.ts` 被 step 5 / 6 改；`packages/shared/src/config/**` 被 step 1 / 5 改。
同波并行必然撞同一批文件并互相覆盖，因此**按编号串行执行**。

**注意**：初版计划把并行理由写成"步骤 2–6 每一个都要改 `docs/06`"，那是错的
（step 2 / 3 的 `Writes` 里没有 `docs/06`），已按实际共享文件重述。
若执行阶段确实想并行，只有这一对是**源码级不重叠**的：**step 5 与 step 6**
（前者是命令权限链路 + 设置页，后者是提示词组装 + LLM 用量解析 + 对话渲染条）——
但必须先由主代理把上面那六个共享文件的改动**全部串行化**，
再派发两个只写源码的窄分片；收益不大，不推荐为此增加协调成本。

## 计划修订记录（落盘后做过一次只读对抗性复核）

本计划落盘后，派了一个**独立只读子代理**（干净上下文、非计划作者）做对抗性复核，
把「用户原话 + 落盘后的计划」交给它逐条挑毛病，并到仓库里核对每条断言。
复核发现的问题已**全部并入上面的 step 文件**，其中值得后续执行者知道的三条硬伤：

1. **`toLlmTools()` 的排序生效点在 `agentLoop.ts` 而不在 `registry.ts`**：
   `agentLoop.ts:132` 调的是同文件内私有的 helper（`:353`，内部用 `tools.list()`），
   而 `ToolRegistry.toLlmTools()`（`registry.ts:92`）在请求链路上**没有被调用**。
   初版计划只让改 `registry.ts` → 单测会绿但请求体毫无变化，属**假 PASS**。已改（见 step 6 操作 2）。
2. **`{a,*}` 能击穿免确认模式的"纯通配"检查**：字符串剥离 `*?{},` 后还剩 `a` 判为合法，
   但编译成 `(?:a|.*)` 等于**放行全部命令**。已在 step 5 整类拒绝花括号，并列为必测负例。
3. **`COMPUTER_TOOL_NAMES` 从 5 加到 8 会让 `AgentPage.vue:73` 的
   `TOOL_GATES: Record<ComputerToolName, …>` 直接编译失败**，而该文件初版不在 step 1 的 `Writes` 里
   → step 1 自己的验收达成不了。已改（见 step 1 操作 9 第 7 条）。

另外复核确认了一条**计划里原本没写、但会真的损坏文件**的路径：
`edit_file` 对**混合行尾**（同时含 CRLF 与 LF）文件会"把全套行尾按主导风格重写"，
等于改写了一整个文件的每一行 —— 已在 step 4 补成显式拒绝（操作 4.5）。

## 执行记录

（供执行阶段追加：每步的实际改动与验证结果、git 提交清单、代码审查结论与处置）

## 执行记录

### step 1 — 工具契约与提示词基线 + 配置 Schema v12

- 提交：`c320096`（计划落盘）、`f769e0a`（docs 规格）、`088b91b`（配置 Schema v12）
- 验收：`pnpm build:packages` / `pnpm typecheck` exit 0；`pnpm test` 66 文件 1094 用例全绿；
  `pnpm lint` 与 `pnpm exec prettier --check "**/*.{ts,md,json}"` 通过；
  `COMPUTER_TOOL_NAMES` 精确数组断言（`schema.test.ts:192`）8 元素；
  `allowPatterns` 恰好 2 处命中且未被覆盖表放行；`docs/06` 五个新节全部落盘。
- 偏差与「已登记、未修」详见 `step-01-contract-and-config.md` 的「执行记录」一节。

### step 2 — read_file 行窗口契约 + 工具规范三条

- 提交：`8aeb2cf`（read_file 行窗口契约）、`02b078e`（工具使用规范三条件条目）
- 验收：`pnpm build:packages` / `pnpm typecheck` exit 0；`pnpm test` 66 文件 **1122** 用例全绿；
  `pnpm lint` 与 prettier 通过；`grep "已按 maxBytes 截断"` 无残留；
  端到端（真实端口 + 真实内核工具）对 5000 行 CRLF 文件读第 4000–4002 行成功。
- 偏差与「已登记、未修」详见 `step-02-read-file-contract.md` 的「执行记录」一节。

### step 3 — 搜索层端到端（glob 编译器 + grep / glob + 主进程 walker + 设置页）

- 提交：`12430c1`、`5fd5ed9`、`e3b942e`、`c54913b`、`ed2241a`、`0f854f0`
- 验收：`pnpm build` / `pnpm typecheck` exit 0；`pnpm test` 67 文件 **1182** 用例全绿；
  `pnpm lint` 与 prettier 通过；
  `AURORA_SMOKE` **134/134 passed**（含 glob / grep 真实文件系统断言）；
  `AURORA_CAPTURE` 48 张 PNG / 48 条 checks / 0 FAIL、`settings-agent` 实测 `searchFields=2`。
- 偏差（`maxFileScanBytes` 只约束内容扫描、smoke 分片隔帧、smoke 断言改用已装配清单）与
  「已登记、未修」详见 `step-03-search-tools.md` 的「执行记录」一节。

### step 4 — edit_file（精确替换 + EOL 保真 + 唯一性 + 读前守卫）

- 提交：`5855a86`、`a3835c2`、`078b6bc`、`300e47b`
- 验收：`pnpm build:packages` / `pnpm typecheck` exit 0；`pnpm test` 69 文件 **1226** 用例全绿；
  `pnpm lint` 与 prettier 通过；`AURORA_SMOKE` **134/134 passed**（`edit_file` 已注册且 `confirm`）；
  `grep readWholeText` 三处命中（证明替换不走行窗口 API，不会静默截断）。
- 偏差（守卫建在装配器闭包内、设置页文案连带补 `edit_file`）与「已登记、未修」详见
  `step-04-edit-tool.md` 的「执行记录」一节。

### step 5 — run_command 免确认模式列表

- 提交：`28a554d`、`0a9c7ac`、`bb4a907`、`b5b6419`、`6910f6c`、`30ba8ad`
- 验收：`pnpm test` 71 文件 **1277** 用例全绿；`pnpm typecheck` / `pnpm lint` / prettier 通过；
  `AURORA_SMOKE` **143/143 passed**（含「命中免确认不弹卡片」与「负对照未命中仍弹卡片」成对断言，
  三轮一致）；`AURORA_CAPTURE` 48 张 / 48 条 / 0 FAIL、`terminalFields=4`、`allowPatternsFields=1`。
- 实现期自查抓到并修掉一个真 bug（纯通配判定写成恒真表达式，等于该规则没生效）；
  偏差（smoke 宿主改 `smoke.ts`、桩回显 stdout）与「已登记、未修」详见
  `step-05-command-allowlist.md` 的「执行记录」一节。

### step 6 — prompt caching（前缀稳定化 + 工具顺序 + 命中观测）+ 文档收口

- 提交：`35ec301`、`2ac3228`、`9a7b935`、`887ff08`
- 验收：`pnpm build:packages` / `typecheck` / `build` exit 0；`pnpm test` 72 文件 **1292** 用例全绿；
  `pnpm verify` **26/26**（迁移链 12/12）；`pnpm lint` 与 prettier 通过；
  `AURORA_SMOKE` **146/146 passed**（含三条新断言）；`AURORA_CAPTURE` 48 张 / 48 条 / 0 FAIL。
- 计划的两处规格错误已就地订正：最长公共前缀判据（标题行也在前缀里）、smoke 的相等判据
  （两轮提示词实测一字不差，用「≥ 首个易变位置」）。详见
  `step-06-prompt-caching.md` 的「执行记录」一节。
