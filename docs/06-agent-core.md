# 06 · Agent 内核设计

状态：`已定稿`（v1 基线；P3 已完成——会话 / 工具循环 / Skill 执行 / MCP 客户端均已落地，
"已定稿"指设计不变，实现细节见各节标注的 v1 / P3 范围）

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
- 设置中可保存多组模型配置并切换默认；会话级可选模型；temperature 等参数可调。
- 可靠性：指数退避重试、单请求超时（默认 60s）、流式中断可取消（AbortSignal 贯穿到 IPC）。
- `ChatRequest.reasoningEffort` 由 `llm.providers.<id>.reasoningEffort` 驱动，取值
  `auto | low | medium | high`；`auto`（默认）时**不下发** `reasoning_effort` 字段。

## 4. 会话管理

- 会话划分（v1）：**快速会话**（迷你窗）× 1，**完整会话**（AI 交互窗口）× 1，设置引导会话复用完整会话窗口。
  快速会话与完整交互窗**分离**（AI 服务窗已移除，迷你窗是快速会话唯一入口），后续可扩展多会话列表。
- 会话 id 由来源窗口映射（`quick` / `main` / `settings`），仅允许 `[A-Za-z0-9_-]`；非法值归一为 `settings`（防路径穿越）。
- 持久化：`userData/sessions/<sessionId>.json`（含工具消息），结构 `{ version, sessionId, updatedAt, messages }`，
  原子写 + 300ms 防抖（与 `SettingsStore` 同一套 `FileSystemPort` 约定），退出前 `flush()`；
  文件损坏时备份为 `<sessionId>.corrupt-<ts>.json` 并重建为空会话。系统提示词**不落盘**，每次请求重新组装。
- 渲染层挂载时通过 `chat:history` 水合消息列表，因此重启后交互窗仍能看到历史。
- 上下文窗口管理：超长自动摘要压缩（P1）；v1 先按 **字符上限（默认 60k）** 截断旧消息并保留系统提示词，
  且截断时保证「assistant(toolCalls) + 其后 tool 结果」成对保留。
- 同一会话并发请求返回 `E_BUSY`（不排队），避免历史交错。

## 5. 工具调用循环（Agent Loop）

- **系统提示词组装**：基础人设 + 当前模式片段（IMode.systemPrompt）+ 感知摘要 + Skill 清单 + 工具清单 + 安全规则。
  小节顺序固定，空片段自动省略；每次请求即时组装，不做缓存。
- **循环**：用户消息 → LLM → [工具调用 → 执行 → 结果回填] × N（**上限 8 轮**）→ 最终回复。
- 单轮出现多个工具调用时**按顺序执行**（不并发），保证 `chat:event` 工具卡片状态与结果顺序确定。
- 到达轮次上限仍未收敛：以已有文本收尾，`done` 事件带 `pending: true`（不报错、不丢输出）。
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

## 6. Skill 系统

- **结构**：`SKILL.md`（frontmatter：`name` / `description` / `when_to_use` + 正文指令）+ 可选 `scripts/`。
- **注册表**：内置 `skills/`（随安装包）+ 用户目录 `userData/skills/`（设置页管理：查看 / 添加 / 删除 / 启用）。
- **匹配**：以工具形式向 LLM 暴露 `use_skill`，由 LLM 依 description 自动选择；用户可显式 `@skill名` 或 `/skill名`。
- **执行范围（v1 / P3）**：`use_skill` 只把目标技能的正文指令与所在目录注入当前上下文
  （参数 `{ name }`，`enum` 取自已启用技能），**不执行任何脚本**、无需用户确认；
  技能自带 `scripts/` 时在返回文本中提示模型，由模型在需要时向用户说明用途。
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
  - **已知限制**：HTTP 传输暂不支持自定义鉴权头（Bearer / API Key），v1 的 MCP 凭据仅经 stdio `env` 注入。
- **工具注册**：MCP tools → Agent 工具表，命名 `mcp.<server>.<tool>`；与 Skill 冲突时 MCP 优先并记日志。
  全部 MCP 工具标记 `sensitivity = 'confirm'`（确认交互归 P5，见 §5）。
- **配置**：设置页添加 / 删除 / 编辑服务器（URL 或 command + args + env）；env 中凭据安全存储（见 08 §2）。
- **生命周期**：由 `mcp.lazyConnect` 决定——`false`（默认）启动即连，`true` 首次使用某工具时才连接。
  设置变更后 `reconfigure()` 幂等 diff（新增 / 移除 / 改动），单个服务器失败不影响其它服务器，
  子进程退出时其工具从注册表移除、在途请求全部失败。
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
- ClassIsland 联动（`provider: 'classisland'`，v0.6.0 落地）：读桥接插件写出的本地 JSON
  或本机回环端点，**读取失败一律降级为空课表、不抛错不阻塞**（见 05 §3.4）。
  未配置端点时仍走空实现——语义从「功能未实现」变为「已配置但尚未接线」。

### 8.2 实现与消费

- `PerceptionHub`（`apps/desktop/src/main/perception.ts`）逐项独立调度（见 ADR-007），
  且**不依赖 Electron**：前台窗口探针、显示器（`displayProvider`）、课程表（`scheduleProvider`）
  全部经构造参数注入；未注入或采集失败时该项保留在 `unknown`。
- **降级契约（ADR-007）**：任何采集失败都只记 debug 日志并把该项留在 `unknown`，
  `summary()` 永不抛错；采集成功的项一律从 `unknown` 中移除。
- **三类消费**：
  1. **上下文注入**：`contextSummary()` 生成系统提示词片段（时间 / 电源 / 网络 / 前台应用 / 显示器 / 今日课程）；
  2. **事件总线**：课前 5 分钟触发（§9）、模式 / 触发器订阅；
  3. **工具查询**：`system-status` / `timetable` Skill 直接读取当前值回答用户。

## 9. 主动引导（Proactive）

- 触发器注册表：首次安装未完成、模式引导未完成、分类完成通知、课前 5 分钟……
  调度策略：单次最多触发一条（队列排队）；支持勿扰时段；全部触发器可配置开关。
- 载体：打开 / 聚焦 AI 交互窗口，以 AI 消息开场（对话式收集，见 05 §2）。

### 9.1 已落地（P5）

| 触发器 | 实现 | 载体 |
|---|---|---|
| 课前 5 分钟 | `PreClassReminder`（`pre-class-reminder.ts`）+ 纯函数 `preClassTrigger` | 系统通知 + 自动打开科目文件夹 |
| 敏感工具确认 | `ProactiveScheduler`（`proactive.ts`）+ IPC `proactive:sensitiveTool` / `proactive:resolveSensitiveTool` | 交互窗确认卡片 |
| 模式引导 / 分类完成 | 模式系统（05 §1）与分类管线（05 §3.3）各自触发 | 交互窗 AI 消息 / 系统通知 |

- **敏感工具确认（§5）**：工具 `sensitivity === 'confirm'` 时（MCP 工具一律如此）先推送
  `SensitiveToolRequest`（`confirmId` / `expiresAt`），渲染层回执后放行或拒绝；
  **超时（默认 60s）、勿扰时段、卡片推送失败一律按拒绝处理**；应用**退出**时 `dispose()`
  会调 `rejectAll()` 让在途确认立即失败，避免工具永久挂起。
  ⚠️ **已知缺口**：`rejectAll()` 目前**没有**接到 `chat:abort`（会话中止只中断内核循环，
  在途确认卡片仍可点击、并在 60s 前一直有效）——所以「会话中止 = 确认作废」这句话目前不成立，
  待接线后才会。设置项 `advanced.confirmSensitiveTools` 关闭时直接放行（内核仍按 `sensitivity` 写日志留痕）。
- **课前提醒**：默认每 30s 检查一次课程表，命中「课前 5 分钟」窗口时发系统通知并自动打开
  该科目文件夹（`explorer`）。同一节课以 `<weekday>-<startTime>-<subject>` 去重、只提醒一次；
  支持**启动补偿**（启动时已进入窗口，例如只剩 2 分钟）与**跨天**（23:5x 时次日 00:0x 的课）；
  多节课同时进入窗口时按剩余时间升序提醒。勿扰时段静默跳过；通知 / 打开文件夹失败只降级为日志。
- **勿扰时段**：`isQuietHour` 纯函数判定（支持跨天，如 22:30–07:00）；时段缺失或时间非法时不静默。
- 未完成项：Work / Code Mode 的日程与待办类新触发器（P7）。
  ClassIsland 联动已于 v0.6.0 完成，其课程变更仍走 30s 轮询而非事件推送
  （桥接为单向数据源，没有反向事件通道）。

## 10. 安全

- **凭据**：API key / MCP env 用 safeStorage 加密落盘；日志与导出配置一律脱敏。
- **文件操作**：ClassRoom 分类管线只在「感知文件夹」内移动文件；Skill 只注入指令文本、永不执行
  `scripts/`。**v0.7.0 起的电脑操控工具是另一回事**：`read_file` / `write_file` / `list_dir`
  **不受感知文件夹限制**（`workspaceDir` 不是沙箱），边界见 §11.1。
- **网络**：LLM / MCP 支持系统代理（设置项 `advanced.proxy`）。
- **执行**：命令 / 文件操作前经工具权限分级校验，敏感级需确认。

## 11. 电脑操控工具（v0.7.0）

v0.7.0 起 Agent 从「只会说话」变为「能在本机动手」：新增 5 个内置工具，把命令执行与文件读写
接进 §5 的工具循环。工具定义（名称 / 参数 Schema / 敏感级）留在 `packages/agent-core`，
真正的系统调用落在主进程并**经构造参数注入**，内核仍不依赖 Electron / DOM（见 §2 分层）。

| 工具 | 参数 | sensitivity | 实现文件 |
|---|---|---|---|
| `run_command` | `{ command, cwd?, timeoutMs? }` | confirm | `packages/agent-core/src/tools/terminal.ts` + `apps/desktop/src/main/tools/command-runner.ts` |
| `read_file` | `{ path, maxBytes? }` | safe | `packages/agent-core/src/tools/files.ts` + `apps/desktop/src/main/tools/file-port.ts` |
| `write_file` | `{ path, content, mode?: 'overwrite' \| 'append' }` | confirm | 同上 |
| `list_dir` | `{ path, limit? }` | safe | 同上 |
| `open_path` | `{ target }` | confirm | `packages/agent-core/src/tools/files.ts` + `apps/desktop/src/main/tools/open-port.ts` |

- **工具语义**：`run_command` 执行单条命令并采集 stdout / stderr；`read_file` 按 UTF-8 读文本；
  `write_file` 写文本（`mode` 缺省 `overwrite`，`append` 追加）；`list_dir` 列目录项；
  `open_path` 交系统默认程序处理——`http(s)://` / `mailto:` 走 `shell.openExternal`，
  其它路径走 `shell.openPath`（由 Windows 关联程序决定打开方式，Aurora 不指定具体程序），
  都不等待目标程序退出。
- **参数钳制**：`read_file.maxBytes` 缺省取 `agent.tools.files.maxReadBytes`，钳到 `1024 .. 上限`；
  `list_dir.limit` 钳到 `1 .. 500`（缺省 200）；`run_command.timeoutMs` 钳到 `1000 .. 300000`。
  参数非法（缺必填 / 类型不对）一律返回 `isError` 且**不触碰**真实系统调用。
- **配置字段（不改名）**：`agent.tools.enabled`（总开关）、`agent.tools.workspaceDir`（命令的默认 cwd，
  见 §11.1）、`agent.tools.terminal.{enabled,timeoutMs,maxOutputChars}`、
  `agent.tools.files.{enabled,maxReadBytes}`、`agent.tools.open.enabled`。各子开关只决定对应工具
  是否注册；`false` 时该工具不出现在工具清单里（非"注册后拒绝"）。

### 11.1 安全边界

- **逐次确认**：`run_command` / `write_file` / `open_path` 三个 `sensitivity = 'confirm'` 的工具，
  **每一次调用**都走 §5 的 `confirmTool` 钩子（主进程侧由 §9.1 的 `ProactiveScheduler` 承载；
  应用内恒注入该钩子，未注入时内核不拦截——这是内核的可测试性设计，不是可配置项）。
  **超时（默认 60s）与勿扰时段一律按拒绝处理**，拒绝后不执行、以「用户拒绝执行」文本回填模型、
  工具卡片置 `error`、循环继续。
- **总开关**：`agent.tools.enabled = false` 时 5 个工具**完全不注册**——模型在工具清单里看不到
  它们，系统提示词里也没有相应说明，因而不可能产生确认卡片或任何本机副作用。
- **`workspaceDir` 只是默认工作目录，不是沙箱**：它只作为 `run_command` 的缺省 `cwd`
  （为空串时回落用户主目录），工具**不限制**模型访问该目录之外的位置。越界**不静默**：
  工具结果里回带解析后的绝对路径（命令的实际 `cwd`、文件的实际路径），
  确认卡片展示的则是模型的**原始参数**（要解析出绝对路径就得先执行，因此卡片里看到的是
  相对路径原文；解析结果在工具执行结果里回带）。
  **`read_file` / `write_file` / `list_dir` 不读 `workspaceDir`**：它们的相对路径按**主进程 CWD**
  解析（`file-port.ts` 的 `resolve()`）——打包应用从开始菜单启动时 CWD 并不可预期，
  因此文件类工具实际上只适合用绝对路径（`workspaceDir` 只影响命令的缺省 `cwd`）。
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

### 11.2 `advanced.confirmSensitiveTools = false` 时的语义

沿用既有行为（§5 / §9.1）：**直接放行**，不推送确认卡片，内核仍按 `sensitivity` 写日志留痕。
此时代码路径与用户自己在 PowerShell 里敲同样的命令**能力相当**（甚至略宽：命令以
`-NoProfile -NonInteractive -ExecutionPolicy Bypass` 启动，比默认执行策略更宽松，但同样**不是**管理员提权）
——`run_command` / `write_file` / `open_path` 会在无人确认的情况下执行，
包括删除文件、改注册表、装软件这类不可逆操作。
因此该开关的定位是「减少打扰」，**不是安全加固**；需要安全边界时保持默认 `true`。

### 11.3 非目标（v0.7.0 明确不做）

- **鼠标 / 键盘模拟**：不做 `SendInput` / UI 自动化，Agent 不得代替用户点击、输入界面。
- **截图 / 录屏**：不采集屏幕像素，视觉输入不在本轮范围。
- **持久交互式 shell**：不为会话维持长驻 shell；每次 `run_command` 都是独立进程。
- **命令黑名单**：见 §11.1——不做字符串级别的命令过滤。

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
- `read_file` 单次读取上限为 `agent.tools.files.maxReadBytes`（下限 1024），超出部分不返回并标注
  `…（已按 maxBytes 截断）…`；`list_dir` 单次最多 500 项、缺省 200，超出部分不返回并标注已截断。
- **文件类工具的相对路径按主进程 CWD 解析**（不是 `workspaceDir`）：模型应传绝对路径；
  只有 `run_command` 的缺省 `cwd` 用 `agent.tools.workspaceDir`。
- `write_file` 的 `overwrite` 是「同目录临时文件 + `rename`」原子写；`append` 直接追加。
