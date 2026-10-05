# 04 · 实现路径与里程碑

状态：`进行中`——P0 / P1 / P2 / P3 / P4 / P5 已完成（v0.3.0 → v0.6.0），
P6 打包与自动更新完成、余下打磨项待做，**P6++ 电脑操控（终端 / 文件 / 打开路径工具 +
模型思考等级 + 「电脑操控」设置页与安全边界）已于 v0.7.0 落地**，
P7 的 **ClassIsland 联动已提前落地**；进度随开发更新

**窗口 UX 修复轮（v1.0 前）**：独立小窗已删除，「快速会话」并入交互窗侧栏（配置 Schema **v6**），
交互窗「收起」= 直接隐藏窗口 —— 历史阶段行仍按当时实现记录，能力以 §5 变更记录与 07 / 08 为准。

**2026-09 工具面扩充轮**（详见 §5 变更记录）：电脑操控工具由 5 个扩到 **8 个**
（新增 `edit_file` 精确替换与 `grep` / `glob` 检索），`read_file` 升级为**行窗口契约**
（行号前缀 + `offset` / `limit`，能读大文件后半段），`run_command` 补上**免确认命令模式**中间档，
并把系统提示词与 `tools` 数组做成**可缓存前缀**、把缓存命中量显示到界面上（配置 Schema → **v12**）。
其后是**Agent 生产化主线轮**（2026-09-26，配置 Schema → **v15**：项目机制 + 三档权限 + 写前快照与回滚 +
Task/Job 持久化与续跑），详见 §5 变更记录最后一条。

版本策略：v0.x 内部迭代 → **v1.0.0** 首个对外版本。优先级：P0 必须 / P1 尽量 / P2 后续。
工作量按 **1 名全职开发** 估算，共约 9～10 周到 v1.0.0；多人协作可并行压缩。

## 1. 阶段总览

| 阶段 | 内容 | 目标版本 | 预估 | 状态 |
|---|---|---|---|---|
| P0 | 项目初始化：monorepo 脚手架、CI、规范 | — | 0.5 周 | **已完成** |
| P1 | 基础壳与设置：托盘、设置窗、配置、首次引导 | v0.1.0 | 1 周 | **已完成** |
| P2 | 通用交互 UI：服务窗、提示条、交互窗、迷你窗 | v0.2.0 | 1.5 周 | **已完成**（含真实对话与工具卡片） |
| P3 | Agent 内核：对话、工具循环、Skill、MCP | v0.3.0 | 2 周 | **已完成** |
| P4 | 模式系统 + ClassRoom Mode：感知文件夹自动分类、对话引导 | v0.4.0 | 2 周 | **已完成** |
| P5 | 系统感知与主动引导：感知采集、上下文注入、课前提醒、敏感确认 | v0.5.0 | 1.5 周 | **已完成** |
| P6 | 打磨发布：打包、安装器、日志、文档 | v1.0.0 | 1 周 | **打包 / 自动更新 / 日志 / 文档已完成**；签名待证书、启动优化未做 |
| P6++ | 电脑操控：终端与文件操控工具、模型思考等级、「电脑操控」设置页与安全边界 | v0.7.0 | — | **已完成**（v0.7.0）；鼠标键盘模拟 / 录屏仍属后续范围（**截图已由 `screenshot` 工具落地**，受模型 vision 门控，见 06 §25） |
| P7 | 后期：Work/Code Mode、ClassIsland 联动 | v1.x | — | **ClassIsland 联动已完成**（v0.6.0）；Work/Code Mode 预留 |

### 已完成范围（截至 v0.3.0）

- P0：pnpm workspace monorepo、TS strict、ESLint/Prettier、vitest、GitHub Actions（windows-latest）。
- P1：托盘常驻与菜单、单实例锁、关闭即隐藏、设置窗六页、配置 Schema + 迁移链 + 原子写 +
  字段级回退 + 损坏备份重建、safeStorage 凭据加密（不可用时仅驻留内存）、首次安装引导
  （含真实「测试连接」与模型列表）、ClassRoom 四步对话式引导运行器（可中断续接）。
- P2：AI 服务窗（置顶输入框、`/` 与 `@` 浮层、状态点）、右侧提示条（悬停展开面板、
  状态灯、模式与最近消息）、完整对话窗（Markdown 渲染、流式输出、历史/工具卡片占位）、
  小 AI 交互窗；迷你窗与交互窗互斥、隐藏服务窗连带隐藏迷你窗、窗口位置跨启动记忆。
- P3 前置：OpenAI 兼容 Provider（SSE 流式、超时、指数退避、AbortSignal）、SKILL.md 解析
  与注册表（3 个内置技能）、工具注册表骨架、`chat:send` → `chat:event` IPC 契约与
  占位 AgentHost（返回真实感知摘要 + 下一阶段说明）。
- P3：**Agent 内核完整落地**（`packages/agent-core`）——  `session`（会话持久化 `userData/sessions/*.json`、原子写 + 防抖、损坏备份重建、字符预算截断且不拆散工具调用对）、
  `loop`（工具调用循环，轮次上限按 `agent.loop.maxRounds` 配置、默认 32、同轮工具顺序执行、失败回填不中断、abort 贯穿）、
  `context`（系统提示词组装：人设 / 模式 / 感知 / Skill / 工具 / 安全规则）、
  `skills/bridge`（`use_skill` 注入技能正文，**不执行脚本**；支持 `/skill`、`@skill` 显式调用）、
  `mcp`（自研最小 JSON-RPC 客户端 + stdio `Content-Length` 分帧 + streamable-http、`McpClientHub`
  多连接管理、`mcp.<server>.<tool>` 注册、失败降级为状态灯、`lazyConnect` 策略）、
  `host`（`KernelAgentHost`：会话装配、显式技能注入、事件映射、`E_NO_MODEL` / `E_BUSY` 降级）。
  渲染层接入真实流式回复、工具执行卡片（运行中/成功/失败）与会话历史水合（`chat:history`）；
  设置页 MCP 状态灯接入 `mcp:status` / `mcp:statusChanged`。
- P5 前置：时间/电源/网络感知采集，缺失项降级为 `unknown`。

**验证方式**：`pnpm test`（当前 2435 项单测）、`pnpm verify`（26 项真实磁盘验收）、
`AURORA_SMOKE=1 pnpm dev`（当前 183 项真实 Electron + preload + IPC 链路断言；使用临时 userData
与本地假 LLM 桩服务，**离线可跑**；含实时投放文件触发的分类管线与课前提醒端到端断言）。

依赖关系：P0 → P1 → P2、P3 可并行 → P4（依赖 P2+P3）→ P5 → P6。P4 与 P5 部分可并行（分类管线 vs 感知采集互不依赖）。

## 2. 阶段明细与验收

### P0 · 项目初始化

- monorepo 骨架（pnpm workspace + electron-vite + Vue 3 + TS strict）
- 可运行空壳：托盘图标 + 一个测试窗口
- ESLint / Prettier / commitlint、vitest 基线、GitHub Actions（lint / typecheck / test / build）
- **验收**：`pnpm dev` 出现托盘与窗口；CI 全绿。

### P1 · 基础壳与设置（v0.1.0）

- 托盘菜单：显示服务窗 / 打开对话 / 设置 / 退出
- 设置窗口：常规页、AI 模型页（baseURL / API key / 模型名、测试连接）、模式选择页
- 配置 store：Schema、链式迁移、safeStorage 加密凭据（见 08）
- **首次安装引导**：欢迎 → AI 模型配置（必填）→ 模式选择 → 完成（见 08 §3）
- 单实例锁；开机自启（P1）
- **验收**：全新环境走完引导 → 配置落盘 → 重启保留；API key 加密存储；无模型配置时主功能不可用并提示。
- **实现说明（v0.1.0）**：
  - 配置层位于 `packages/shared`（`SettingsStore` + `config/schema.ts` + `config/migrations.ts`），
    主进程注入 Electron `safeStorage` 与 `userData`；safeStorage 不可用时凭据只驻留内存并显式告警。
  - 「测试连接」在设置页与引导窗均可触发：主进程解密凭据后调用 `@aurora/agent-core` 的
    `OpenAiCompatProvider`（先 `GET /models`，404/405 时退化为最小 chat 探测）。
  - 引导为「向导 + 表单」；ClassRoom 模式内的对话式引导由 `packages/modes` 的
    `GuideRunner`（四步、可中断续接）驱动。
  - 「开机自启」已实际生效：主进程用 `app.getLoginItemSettings()` / `setLoginItemSettings()`
    同步注册表项（幂等，仅状态不一致时写入）。
  - 「全局快捷键 `Alt+Space`」目前**仅保存配置值**，尚未注册系统级热键
    （`globalShortcut` 与冲突检测归入 P2 一并落地）；「系统通知」与「点击通知打开文件夹」
    的载体已按 P4 分类管线预留，当前只写日志。

### P2 · 通用交互 UI（v0.2.0）

- AI 服务窗：置顶输入框、`/` 快捷指令、点击拉起迷你窗
- 右侧提示条：贴边、状态灯、点击滑出 AI 交互窗（含展开动画）
- AI 交互窗口：Markdown / 代码渲染、流式输出、会话历史
- 小 AI 交互窗口：精简对话、与服务窗共享“快速会话”
- 窗口间状态机（服务窗 ↔ 迷你窗 ↔ 交互窗）、多显示器位置记忆（P1）
- **验收**：三种入口均可发起并完成一轮 mock 对话；窗口行为符合 07 规格。
- **实现说明（v0.3.0）**：四种窗口外壳 + 状态机 + 位置记忆（v0.1.0）；
  `/` 与 `@` 浮层已可用（`/chat`、`/mini`、`/settings`、`/hide`、`/clear`）。
  对话已是**真实模型流式回复**（P3 接入），并渲染工具执行卡片、挂载时经
  `chat:history` 水合历史；事件按 `sessionId` + `requestId` 双重过滤，避免
  「快速会话」在服务窗与迷你窗之间串窗。
  - **preload 约束（重要）**：preload 运行在 `sandbox: true` 的渲染进程里，
    既无 Node 能力也**无法解析 pnpm 工作区包**，因此必须是自包含产物——只
    `require('electron')` 加字面量通道表（`src/preload/channels.ts`，由类型
    断言与 `@aurora/shared` 的 `IPC` 双向对齐）。主进程则可内联工作区包
    （它们是纯 ESM，CJS `require()` 会抛 `ERR_REQUIRE_ESM`）。
  - 渲染层只允许 `import type`（或经 `@aurora/shared/browser` 引入纯常量），
    否则会把 `node:fs` 拉进浏览器 bundle 导致构建失败。

### P3 · Agent 内核（v0.3.0）

- LLM Provider 抽象 + OpenAI 兼容实现 + 流式 + 重试超时
- 会话管理：各窗口独立会话、历史持久化
- 工具调用循环（function calling / 结构化输出，见 06 §5）
- Skill 系统：注册表、匹配、内置 2～3 个示例 Skill
- MCP 客户端：stdio / http、设置页管理、工具注册
- **验收**：AI 可实际调用 Skill 与 MCP 工具完成任务；MCP 连接失败不阻塞主流程。
- **已完成前置（v0.1.0）**：`LlmProvider` 抽象与 `OpenAiCompatProvider`（流式 SSE、
  超时、指数退避、AbortSignal）；`SkillsRegistry` 扫描内置/用户 SKILL.md（含 3 个内置技能）；
  `ToolRegistry` 骨架（含 MCP 优先的同名冲突策略）；`chat:send` → `chat:event` IPC 契约。
- **实现说明（v0.3.0）**：`session` / `loop` / `context` / `mcp` / `host` 全部落地，
  占位 `PlaceholderAgentHost` 已由 `KernelAgentHost` + `DesktopAgentHost` 替换（渲染层契约不变）。
  详见「已完成范围」中的 P3 条目与 06 文档各节标注的 v1 / P3 范围。
  - **验收状态**：`AURORA_SMOKE=1 pnpm dev` 用本地假 LLM 桩服务端到端验证了
    「模型 → `use_skill` → 工具结果回填 → 最终回复 → 会话持久化 → 历史水合」全链路；
    MCP 路径由单测用真实子进程假 MCP server 覆盖（stdio 与
    streamable-http 两种传输）。
  - **已知限制**：MCP HTTP 传输暂不支持自定义鉴权头（凭据仅经 stdio `env` 注入）；
    敏感工具的用户确认交互归 P5（P3 仅标记 `sensitivity` 并日志留痕，且不执行任何 Skill 脚本）。

### P4 · 模式系统 + ClassRoom Mode（v0.4.0）

- ModeManager + `IMode` 框架 + 模式切换事件（见 05 §1）
- 智慧感知文件夹：配置、chokidar 监听、稳定判定、分类队列
- 分类管线：内容提取（utilityProcess）→ LLM 分类 → 科目映射 → 移动 + 通知 + 分类流水（见 05 §3）
- 分类历史 / 规则缓存；失败兜底“待分类”文件夹
- 对话式引导：切换到 ClassRoom Mode 后 AI 主动引导配置
- **验收**：新文件入感知文件夹 30s 内正确归类；常见文档分类准确率 ≥ 90%；引导流程可完整走通并可续接。
- **已完成前置（v0.1.0）**：`ModeManager` + `IMode` 框架 + 模式切换事件（含失败回滚）；
  ClassRoom 完整模式实现（激活时创建感知文件夹与科目文件夹、系统提示词片段、就绪度校验）；
  `GuideRunner` 四步对话式引导（校验、写配置、可中断续接、重置引导）；
  Work / Code 占位模式。
- **实现说明（v0.4.0）**：
  - **监听与稳定判定**：`main/file-watcher.ts`（chokidar，`depth: 0` + `awaitWriteFinish` + 忽略规则 +
    **抑制集**（分类落盘后由 `classification.ts` 经 `suppressPath` 回调登记目标路径）+
    **监听代次**（`stop()` / 换目录后旧 watcher 的迟到事件一律丢弃））。
    `ignoreInitial: false`——启动前已在文件夹里的文件同样归类。
    另有**根目录守卫**：目标目录解析后等于感知文件夹本身时（`folder` 配成 `"."`、`"./"`、`"a/.."`
    等）拒绝移动，否则同目录 rename 会触发新的 add 事件形成无限重分类（见
    `classify/paths.ts` 的 `resolvesToWatchRoot`）。
  - **提取**：`main/extract.ts`（纯逻辑）+ `extract-worker.ts`（**utilityProcess** 第二个构建入口）
    + `extract-pool.ts`（懒启动 / 15s 超时 / 崩溃重启）。用 **officeparser@7.8.0** 解析
    pdf / docx / pptx / xlsx / odt / rtf / epub；txt / md / csv 自读（UTF-8 / UTF-16 / GBK 嗅探）；
    图片给尺寸、压缩包给条目清单；证据按字节 head 70% + tail 30% 截断至 8KB。
    **提取失败一律降级为「文件名证据」，不中断管线。**
  - **⚠ 父子进程消息形状不对称（踩过的坑）**：Electron `utilityProcess` 的
    `message` 形状两侧不同——子进程 → 父进程是**裸 payload**，父进程 → 子进程才包在
    `{ data, ports }` 里。因此主进程侧**不能**照抄子进程的 `message.data`，
    否则每次提取都会静默等到 15s 超时并降级（表现为"分类结果总是只用文件名"，
    且日志里满是 `内容提取超时`）。`extract-pool.ts` 的 `unwrapChildMessage`
    同时兼容两种形状，并配有 `extract-pool.test.ts` 按**真实裸 payload** 回包做回归。
  - **分类**：规则优先（科目名 0.95 > 关键词 0.92 > 用户修正沉淀 0.90，不同科目并列时放弃交给模型
    → 省 token 且不误判），未命中才走 LLM 结构化输出（`response_format: json_object`，
    解析失败降温度重试一次）；低于阈值进「待分类」。**无可用模型时在提取之前就兜底**。
  - **落盘**：`rename` 优先、失败回退 `copy` + 大小校验后删源、重名加 ` (1)`；
    `classification.autoMove=false` 时只记流水不动文件。
  - **流水**：`userData/classification.json`（`ClassificationHistory`，上限 500 条、原子写 + 防抖 +
    损坏重建 + 写盘串行化）；**规则缓存不单独持久化**，启动时由用户修正记录重建。
  - **通知**：`NotificationService` 落地真实系统通知（分类完成 → 点击打开科目目录；
    兜底 → 点击打开「待分类」目录），3s 去重、不可用降级为日志。
  - **UI**：交互窗「分类流水」可折叠区块（水合 + 实时推送），支持就地修正与打开所在文件夹；
    设置页新增完整 ClassRoom 区（感知文件夹 / 科目增删改 + 关键词 / 课程表编辑 / 分类行为 / 流水）。
  - **已验证**：`AURORA_SMOKE=1 pnpm dev` 用**实时投放文件**（经自测专用通道写入感知文件夹）验证
    真实 `chokidar add` → 规则命中 → 移动 → 通知 → 事件推送全链路，并覆盖
    「低置信 → 待分类（含落盘目录断言）」「用户修正 → 沉淀规则 → 同类文件跳过模型」两条分支。
    **提取失败只降级不中断**由单测覆盖（`extract.test.ts` / `extract-pool.test.ts`）。
  - **已知限制**：`classification.autoMove=false`（或移动失败）时，停留在感知文件夹根的文件
    会在**每次监听重建**（模式切换 / 感知文件夹变更）时被重新处理，产生重复流水与通知；
    尚未按 (路径, 大小, 修改时间) 去重。

### P5 · 系统感知与主动引导（v0.5.0）

- 感知采集：时间 / 电源 / 网络 / 前台窗口 / 手动课程表（见 06 §8）
- 上下文注入：感知摘要进入系统提示词
- 主动触发器：模式引导提醒、分类完成通知、课前 5 分钟提醒并打开科目文件夹
- **验收**：询问“我电脑现在什么状态”时 AI 引用实时感知数据；课前提醒按课程表触发且打开对应科目文件夹。
- **已完成前置（v0.1.0）**：时间/星期、电源、网络连通性采集（`systeminfo` + DNS 探测，
  缺失项统一降级 `unknown`）；感知摘要已进入占位回复文本与设置页预览。
- **实现说明（v0.5.0）**：
  - **感知扩展**：前台窗口 / 应用（PowerShell 内联探针 `GetForegroundWindow` + `GetWindowTextW`
    + 进程名，5s 轮询，中文标题正常）、主显示器（Electron `screen`，注入式采集器）、
    今日课程（`IScheduleProvider`）。`summary()` 按**实际采集结果**增删 `unknown`，
    任一采集项失败都降级为 `unknown` 且不抛错（ADR-007）；`contextSummary()` 增加
    「当前前台 / 显示器 / 今日课程」，随既有 `perceptionSummary` 路径进入系统提示词。
    **未引入 active-win**（原生模块 + 杀软误报），见 03 §ADR-007。
  - **课程表**：`main/schedule.ts` —— `IScheduleProvider`（`manual` 完整 + `classisland` 占位）、
    `parseClock` / `lessonKey` / `preClassTrigger`（窗口判定、跨天、去重、**启动补偿**）/
    `needsNextDayLessons`。
  - **课前提醒**：`main/pre-class-reminder.ts` —— 30s tick，命中后发系统通知并打开科目文件夹；
    先记 `firedKeys` 再执行副作用（失败不刷屏）；受 `preClassReminder` 开关与勿扰时段约束；
    **每次检查重新解析 provider**，设置页改完课程表即时生效（无需重启）。
  - **主动引导**：`main/proactive.ts` —— `ProactiveScheduler` + 纯函数 `isQuietHour`（支持跨天）；
    勿扰时段直接拒绝，确认超时 60s 按拒绝处理，`rejectAll` 用于会话取消 / 退出。
  - **敏感工具确认（原 P3 遗留）**：`AgentLoopOptions.confirmTool` 钩子落地——
    `sensitivity === 'confirm'` 的工具（含全部 MCP 工具）执行前经 `ProactiveScheduler` 请求确认，
    拒绝 / 超时一律**不执行**并以「用户拒绝执行」文本回填模型，循环继续；
    确认链路自身抛错时同样不执行，回填文本为「用户确认流程异常，已取消执行：…」；
    渲染层确认卡片带倒计时。未注入钩子时保持 P3 行为（不拦截、只留痕）。
    设置项 `advanced.confirmSensitiveTools` 可整体关闭（每次调用即时判断）。
  - **验证**：`AURORA_SMOKE=1 pnpm dev` 断言感知含前台窗口 / 显示器 / 课程表，
    以及课前提醒真实触发并指向正确科目目录（自测下「打开文件夹」换成回执，不弹资源管理器）。

### P6 · 打磨与发布（v1.0.0）

- electron-builder NSIS 安装包、图标 / 品牌、版本信息、数字签名评估
- 日志轮转与本地错误记录；启动时间与内存优化
- 用户文档（快速上手）、隐私说明（凭据仅本机加密存储）
- **验收**：全新 Windows 10/11 机器上“安装 → 引导 → 核心链路”全通，无崩溃。
- **实现说明（v0.3.0）**：
  - **打包已落地**：`apps/desktop/electron-builder.yml`（Windows x64 + NSIS，非 oneClick），
    产物 `Aurora-Setup-<version>.exe` + `latest.yml` + `*.blockmap`；
    `extraResources` 把内置 `skills/` 放到 `resources/skills`；
    设计稿 `scripts/assets/aurora-icon.png`，`scripts/generate-icons.mjs` 先居中裁成正方形、
    再套透明圆角矩形蒙版，直接产出 `icon.ico`（多尺寸，7 个条目）与各尺寸 PNG，
    另派生无底透明品牌标供主界面空态使用；打包不再依赖 winCodeSign 工具链。
  - **自动更新已落地（原 P7 项，随 P6 一起做）**：主进程 `UpdateService` 状态机 +
    electron-updater 适配层，设置页「更新」区与托盘入口；更新源为**公开 releases 仓库**，
    源码仓库保持私有，客户端不携带任何凭证（docs/09 §1）。
  - **发布流程**：`pnpm release`（本地，构建→打包→校验→打 tag→可选上传）与
    `.github/workflows/release.yml`（云端打包发布，**按需手动触发**；配置
    `secrets.RELEASE_TOKEN` 后可恢复 `v*` tag 自动触发）。
  - **不签名**（用户决策）：`win.signExecutable: false`（只跳签名，保留 exe 图标 /
    版本资源编辑），首装会出现 SmartScreen「未知发行者」提示，用户操作说明见
    docs/09 §4；接入证书时去掉该字段即可。
  - **已验证**：`pnpm verify:release`（产物 14 项，含 sha512/size 与实际文件一致性）+
    `pnpm verify:update`（**启动已打包应用对着本地更新源真的发现新版本**，5 项）。
  - **待做**：代码签名证书、启动耗时 / 内存优化。
  - **已完成（v0.6.0）**：日志轮转（`main/logger.ts`，按天写 + 保留 7 天）、
    用户文档与隐私说明（[10](./10-user-guide.md) / [11](./11-privacy.md)）。

### P6+ · v0.6.0 补齐「假开关」与体验缺口

v0.6.0 的重点不是新增大功能，而是**把"设置里能改、运行时没人消费"的配置真正接上**，
并把 ClassIsland 联动（原 P7 项）提前落地。

- **接线修复**（每一项此前都是死配置 / 死通道）：
  - `general.hotkey`：真的注册全局快捷键（`main/hotkey.ts`），含格式校验（拒绝无修饰键的裸按键）、
    冲突检测与可操作文案（`Alt+Space` 是 Windows 系统窗口菜单键，被占用属预期路径）、
    运行时可改绑、退出时注销；设置页显示**真实注册状态**而非期望值。
  - `advanced.proxy`：真的接入网络栈（`main/net.ts`）—— `session.setProxy` 统一生效，
    出网改用 Electron `net.fetch`（走 Chromium 网络栈）并保留 `globalThis.fetch` 回落；
    注入到 LLM provider、MCP HTTP 传输与「测试连接」，改完即时生效（含关闭残留连接）。
  - `advanced.logLevel`：`FileLogger` 级别改为**共享可变引用**，热改后整棵日志树同步生效
    （此前是构造期快照，改级别对已存在的子 logger 无效）。
  - `skills.userDir`：抽出 `SkillsService`（`main/skills.ts`）按设置解析用户技能目录并支持重扫，
    新增 `skills:rescan` / `skills:status`；设置页可填自定义目录并看到生效路径与解析告警。
  - `general.edgeBar.opacity` / `general.edgeBar.quietHours`：透明度即时应用；
    提示条有**独立的**勿扰时段（`main/edge-bar-scheduler.ts`），与 `advanced.quietHours`
    （管主动打扰）职责分离。
  - `app:openLogs`：补齐 handler（此前只有通道常量与 preload 镜像，调用会挂起）。
- **ClassIsland 联动**（详见 [05 §3.4](./05-mode-system.md)）：新增 `main/classisland.ts`
  （契约解析 + provider，任何失败降级为空课表并记告警）、`classisland:status` / `classisland:test`
  通道、设置页「数据来源 / 端点 / 超时 + 测试连接」；配置 Schema → **v3**；
  随仓库附带桥接插件源码 `integrations/classisland-bridge/`。
- **桥接插件实测**：`integrations/classisland-bridge` 用 ClassIsland **2.1.0.1** 的真实程序集
  编译通过，并装入 ClassIsland 实跑 —— 日志确认插件被加载、写出了符合契约的 `schedule.json`，
  Aurora 侧解析该真实文件零告警。修掉了一批「凭文档写、实际不存在」的 API 误用
  （`PluginBase.OnStartup/OnShutdown` 不存在、`AppBase.Services` 不存在、
  `TimeLayout.LayoutItems` 实为 `Layouts`）。CI 仍不编译该插件（无 .NET SDK）。
- **体验补齐**：对话窗多会话列表与切换（`chat:sessions` / `chat:newSession`）、
  附件拖拽发送（preload `webUtils.getPathForFile` + 复用现有提取器）、
  `autoMove=false` 时按 `(路径, 大小, 修改时间)` 去重、
  长上下文摘要压缩（`compressHistory`，无 summarizer / 失败时退回纯截断）。
- **验证**：新增约 80 条单测（快捷键、代理归一、日志热改、Skill 目录、提示条勿扰、
  分类去重、摘要压缩含回落、ClassIsland 解析与降级、会话列表）；
  `AURORA_SMOKE` 扩展为走**真实桥接文件**驱动课前提醒，并覆盖快捷键状态、Skill 重扫、
  会话列表、日志目录通道。

### P6++ · v0.7.0 电脑操控与模型思考等级

本轮的重点是让内核第一次具备**真实操作本机**的能力（终端 / 文件 / 打开路径），
并把「思考等级」这一模型参数接到端到端。真实系统调用**全部落在主进程**，内核只认注入的端口。

- **模型思考等级**：设置页「AI 模型」每个 provider 的「高级参数与连接测试」新增「思考等级」
  （`auto` / `low` / `medium` / `high`），端到端下发为请求体的 `reasoning_effort`；
  `auto`（默认）**不下发该字段**，以兼容不认该参数的厂商。配置在
  `llm.providers.<id>.reasoningEffort`。
- **终端与文件操控工具**（配置在 `agent.tools.*`）：
  - `run_command`（PowerShell，`sensitivity: confirm`）；
  - `read_file`（`safe`）、`write_file`（`confirm`）；
  - `list_dir`（`safe`）、`open_path`（用系统默认程序打开，`confirm`）。
  - 超时按**进程树**终止；输出按 head 60% + tail 40% 截断；**不做命令黑名单**。
- **「电脑操控」设置页 + 全套安全边界**（侧栏第 7 项）：总开关 / 工作目录 / 终端 / 文件 / 打开
  分开关，改完**立即生效**（无需重启）；敏感工具逐次确认（60s 不响应、勿扰时段一律按拒绝处理）；
  关闭 `advanced.confirmSensitiveTools` 后不再逐次询问（能力等同用户自己敲同样的命令）。
  配置 Schema 升到 **v5**（`v4 → v5` 迁移补齐新字段，幂等且不覆盖用户已写值）。
  关键字段：`agent.tools.enabled`、`agent.tools.workspaceDir`、
  `agent.tools.terminal.{enabled,timeoutMs,maxOutputChars}`、
  `agent.tools.files.{enabled,maxReadBytes}`、`agent.tools.open.enabled`。
- **截图已由 `screenshot` 工具落地**（受模型 `vision` 门控，与本节的电脑操控工具不同族，见 06 §25）。
- **仍属后续范围**（**未实现**）：鼠标键盘模拟、录屏、持久交互式 shell、命令黑名单、
  Work / Code Mode 功能、Anthropic 等非 OpenAI 兼容协议。
- **验证**：`pnpm typecheck && pnpm test && pnpm build` 全绿（用例数随轮次变动，以实际输出为准）；
  `AURORA_SMOKE=1 pnpm dev` 新增「电脑操控」四条断言；`AURORA_CAPTURE` 18 张 PNG、无 FAIL。

### v0.2.0 · Aurora Center 与 Agent 能力增强（docs/12）

设计定稿于 [12 分册](./12-aurora-center.md)。两块内容：

**A. Aurora Center（网页控制中心）**

- **服务器**（`packages/center`，纯 Node 跨端 Windows/Linux）：单端口 HTTP+WS ——
  REST（登录 / 客户端 / 令牌 / 管理员 / 文件下载）、客户端 WS（Bearer 配对令牌 +
  hello 握手）、网页 WS（`?token=`）、流式文件上传、SPA 静态服务。
  鉴权：用户 scrypt 口令、配对令牌（SHA-256 落库、明文只现一次、一令牌一机）、
  网页会话令牌（内存 7 天）。管理员可见并可控制**全部**客户端（跨属主），
  用户只见自己的；`aurora-center` CLI（init / start / users / token / status /
  update / version）一键开服与 npm 通道自更新。
- **Web UI**（Apple 风格 SPA，`packages/center/web` → `dist-web`）：登录、
  客户端列表 + 远程会话（正文流式 / 思考折叠 / 工具卡 / 文件下载条）、
  管理员页（用户 / 配对令牌 / 全部客户端）。
- **客户端连接器**（`apps/desktop/src/main/center/`）：出站 WS + 指数退避重连 +
  心跳；远程会话走与 `chat:send` **同一条** `agent.send()` 通路（`origin: 'center'`，
  会话 id `center-*` 前缀）；远程配置走客户端侧**白名单**（模式切换 + agent 工具
  开关，`agent.permissionMode` / `allowPatterns` 刻意不在白名单内）；三个
  `allow*` 开关是命令类别的本机最终闸门。
- **Center 工具组**（`center_status` / `center_send_file`）：`center.enabled` 且
  serverUrl 非空才注册；`center_send_file` 逐次确认、走 `/api/ingest/files` 上传。
- **配置**：`center` 分组（CONFIG_VERSION 16，v15→v16 迁移）；`center.*` 整组
  只读前缀（连接目标是外发通道）；`center.token` 凭据链与 apiKey 同款 5 处。

**B. Agent 能力增强**

- **create_skill**：内置技能 `skills/create-skill/`——用户经对话创建自己的技能
  （收集名称 / 触发场景 / 正文 → 按内置同款 frontmatter 写入用户技能目录）；
  `SkillsService` 对技能目录挂 `fs.watch`（防抖 500ms）**自动重扫**，写完即生效。
- **模式能力对齐**（docs/05 §6）：模式差异只允许出现在「自主感知」与「特化功能」
  两处，工具集全模式一致；`packages/modes/src/capabilities.ts` 导出
  `MODE_CAPABILITY_MATRIX` 并由回归测试钉住。

验证口径：`packages/center` 26 用例（auth / hub 路由与越权 / 真实 HTTP+WS 端到端）；
desktop `main/center` 22 用例（连接状态机 / 命令闸门 / 会话桥 / 白名单）；CLI 与
真实服务器冒烟（init → start → 登录 → 建令牌 → 静态页 200）。

### P7 · 后期（预留，见 05 §4）

- Work Mode / Code Mode 功能实现
- ~~ClassIsland 联动（课程表自动获取）~~ —— **已于 v0.6.0 完成**
- ~~终端 / 文件 / 打开路径操控工具~~ —— **已于 v0.7.0 完成**（见 P6++）；
  ~~截图~~ —— **已由 `screenshot` 工具落地**（受模型 vision 门控，见 06 §25）；
  鼠标键盘模拟、录屏、持久交互式 shell、命令黑名单仍未做
- 多语言、macOS / Linux 评估、ARM64 / 便携版

## 3. 需求 → 阶段映射（可追溯性）

| 需求（Aurora.md） | 落点阶段 | 优先级 |
|---|---|---|
| 系统托盘常驻 + 点击显示设置等按钮 | P1 | P0 |
| 第一次安装时要求用户填写 AI 模型 | P1 | P0 |
| 设置中从三种模式中选择，选择后 AI 主动引导设置 | P1 / P4 / P5 | P0 |
| 顶置“AI 服务窗”，初期为输入框形式 | P2 | P0 |
| 桌面右侧提示条，点击拉出完整 AI 交互窗口 | P2 | P0 |
| 点击顶置服务窗拉起小 AI 交互窗口 | P2 | P0 |
| Skill 功能 | P3 | P0 |
| MCP 功能 | P3 | P0 |
| 自感知 Agent、实时感知系统状态的接口 | P5 | P0 |
| ClassRoom：智慧感知文件夹拖入新文件 → 智能分析 → 自动分类 | P4 | P0 |
| ClassRoom：选择模式后对话式主动引导设置 | P4 | P0 |
| 每科目上课前自动打开对应科目文件夹 | P5（手动课程表）/ **P6+（ClassIsland 联动，已完成）** | P1 / P2 |
| Work Mode / Code Mode（后期，预留接口） | P4 定义接口，P7 实现 | P2 |

## 4. 主要风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| LLM 分类准确率不达标 | 核心卖点受损 | 科目关键词 + 结构化输出 + 置信度阈值 + “待分类”兜底；规则缓存沉淀；支持用户修正反哺 |
| API 成本失控 | 持续费用 | 内容证据截断（上限 8KB）、规则缓存命中跳过 LLM、分类并发与频控 |
| 大文件 / 特殊格式解析失败 | 分类失败 | 失败兜底“待分类”+ 通知；解析走子进程防卡死；OCR 设为 P1 可选 |
| Windows 前台窗口获取兼容性差 | 感知能力打折 | active-win 为主 + PowerShell 回退；感知缺失降级为“未知”不报错 |
| Electron 常驻内存 / 启动慢 | 体验差 | 窗口按需创建、utilityProcess 隔离、启动仅加载托盘 |

## 5. 变更记录（追加）

- **2026-09（前端刷新）**：移除「AI 悬浮窗」（`service-dock`）——渲染层入口、主进程窗口规格与几何、
  IPC 通道、托盘 / 快捷键 / 启动接线一并删除，配置迁移到 **v4**（`v3 → v4` 移除
  `general.windowState['service-dock']`）。**提示条成为唯一常驻入口**：悬停展开面板、点击呼出完整交互窗，
  迷你窗改为锚定提示条左侧（提示条不可用时回落工作区右下角）。
  上述历史阶段行的描述（P2 等）保持当时原样，实际能力以本节与 07 / 08 为准。
- **2026-10（窗口 UX 修复 / 配置 v6）**：**删除独立小窗**（`mini-chat`）——渲染层 `renderer/mini-chat/`
  入口、主进程窗口规格与几何、`window:showMiniChat` IPC 通道、`WINDOW_NAMES` 与配置 key 一并移除；
  交互窗标题栏「收起」改为**直接隐藏窗口**（正在进行的流式回复不中止，不再拉起小窗）；
  「快速会话」（`sessionId = quick`）与历史会话列表并入交互窗侧栏，侧栏为「快速 / 会话」双栏；
  提示条面板操作入口由 4 个减为 **3 个**（打开对话窗口 / 设置 / 隐藏提示条）。
  配置迁移到 **v6**（`v5 → v6` 移除 `general.windowState['mini-chat']`）；截图清单去掉 `mini-chat.png`，
  新增交互窗 `chat-collapse.png` 探针（钉住「收起后窗口隐藏、`primary === null`」）。
  上述历史阶段行的描述（P2 等）保持当时原样，实际能力以本节与 07 / 08 为准。
- **2026-09（工具面扩充 + prompt caching / 配置 v12）**：电脑操控工具由 5 个扩到 **8 个**，
  内核第一次具备「改代码」的能力；同时把系统提示词与工具数组做成可复用前缀（对齐 opencode 的
  工具提示词契约，**只借用文本约定、不缝合它的代码**，对照表见 [06 §20](./06-agent-core.md)）。
  - **三条新工具**（`agent.tools.enabled` 总开关之下，各自还有子开关）：
    `edit_file`（**精确局部替换**：改前必须先 `read_file` 过该文件、`oldString` 命中多处即拒绝、
    `replaceAll` 供全局改名、EOL 保真、混合行尾与孤立 `\r` 拒绝；`sensitivity: confirm`，
    随 `files.enabled`）、`grep`（正则搜内容，返回 `路径:行号: 命中行`）与 `glob`（按文件名模式
    找文件）——后两者是 `safe` 级只读工具，新增 `agent.tools.search.{enabled,maxResults}` 组
    （缺省开启 / 单次 200 条、上限 1000）。搜索走**自写递归遍历**（零新增依赖），
    默认跳过 `node_modules` / `.git` / `dist` 等 8 个目录、不跟随符号链接，
    并有文件数与字节数双重预算（2 万文件 / 64 MiB），**绝不无限遍历**。
  - **`read_file` 契约升级**：内容每行带 `<行号>: ` 前缀（行号 1 起始、相对文件开头），
    新增 `offset`（1 起始）与 `limit`（缺省 2000、上限 5000）行窗口，单行超 2000 字符截断；
    关闭「只能读文件开头」的缺口 —— 大文件后半段现在读得到；超过 16 MiB 的文件只解析开头
    并提示改用 `grep` 定位。
  - **`run_command` 免确认命令模式**（`agent.tools.terminal.allowPatterns`，缺省空数组 =
    行为与从前完全一致）：glob **全串**匹配、大小写不敏感的**命令白名单**，命中即跳过确认卡片，
    但**仍写 `info` 级审计日志**。模式只允许字面字符 + `*` + `?`，含花括号（`{a,*}` 这类能
    编译成「放行全部」的绕过写法）或纯通配一律拒绝 —— **Schema 与匹配器双层拒绝**。
    该字段属 `SETTINGS_READONLY_PREFIXES`（AI 的 `set_setting` 一律拒绝，防自我提权），
    只能由用户在设置页维护。定位是「**减少打扰**」，**不是安全加固**（详见
    [06 §11.7](./06-agent-core.md)）。
  - **prompt caching：前缀稳定化 + 命中观测**：系统提示词改成「**静态在前、易变在后**」
    （易变三节 = 更早对话的摘要 / 当前任务清单 / 系统状态一律排末尾），
    `ToolRegistry.toLlmTools()` 按工具名**字典序**返回（`agentLoop` 与 `agentHost` 共用这一份
    有序清单），于是同一会话连续两轮的请求前缀逐字节相同；`TokenUsage` 新增 `cachedTokens`，
    认 `prompt_tokens_details.cached_tokens`（OpenAI 形态）与 `prompt_cache_hit_tokens`
    （DeepSeek 形态），在对话窗「上下文详解」条展示最近一轮的命中量与占比（缺省时整段不渲染）。
    **不引入显式 `cache_control`、不加任何配置字段**（见 [06 §21](./06-agent-core.md)）。
  - **配置 Schema → v12**：`v11 → v12` 迁移补齐 `agent.tools.search.*` 与
    `agent.tools.terminal.allowPatterns`（幂等、不覆盖用户已写值）；
    设置页「智能与工具」页新增「文件检索」与「免确认命令模式」两栏。
  - **验证**：`pnpm test` 72 文件 / **1292** 用例全绿（含 glob 模式编译器、`edit_file` 的 EOL
    保真与唯一性拒绝、免确认匹配器的花括号绕过负例、缓存命中的两种字段名解析、系统提示词的
    公共前缀断言）；`AURORA_SMOKE` **146/146 passed**（三条本轮新增断言：两轮系统提示词静态
    前缀逐字节相同、两轮 `tools` 顺序相同且已排序、`usage` 事件带 `cachedTokens=512`）；
    `AURORA_CAPTURE` 48 张 PNG / 48 条 checks / 0 FAIL。
  - **明确不做**：`apply_patch`、LSP 诊断与符号检索、git snapshot / revert、doom-loop 检测、
    显式 `cache_control`、命令黑名单、权限模型整体重构、Code Mode 实装、Anthropic 原生协议。
- **2026-09-26（Agent 生产化主线：项目机制 + 三档权限 + 写前快照 + Task/Job 续跑 / 配置 v15）**：
  这一轮把 Agent 从「能改代码」推到「可托付地跑长任务」——**知道自己工作在哪个项目、按用户选的档位动手、
  改动前留底、跑到一半停下还能接着跑**；配置 Schema **v12 → v15**（三条迁移
  `v12 → v13` / `v13 → v14` / `v14 → v15`）。
  - **项目机制（v13）**：顶层新增 `projects` 分组（`current` / `list[{id,name,root}]` /
    `maxAgentsBytes: 32768`）。当前项目同时决定**项目根**与**项目级约定注入** ——
    从**项目根到当前工作目录逐层**收集 `AGENTS.md`（同目录 `AGENTS.override.md` 优先），
    作为系统提示词的「项目约定」小节注入（在静态段之后、系统状态之前，见
    [06 §5.1 / §21.1](./06-agent-core.md)），单次收集上限 **24 层 / 32 KiB**、超限截断并标注。
    设置页新增「项目」区组、右栏新增「当前项目」卡（项目根不可用时标红并给「重新选择目录」）。
    `openPath` 新增 `kind: 'project'`（`kind: 'workspace'` 打开的是 `agent.tools.workspaceDir`，
    不是项目根，两者别混）。
  - **三档权限（v13，`agent.permissionMode ∈ {readonly, confirm, auto}`，默认 `auto` —— 2026-09-29
    起出厂即完全权限）**：
    `readonly` 档**根本不注册**写入 / 执行类工具（含 `todo_write`，保留 `todo_read`），
    因此不是"注册后再拒绝"；`confirm` 档恢复旧 auto 语义（根内直接执行、越界确认；
    无项目直接放行）；
    `auto` 档为**完全权限**：所有敏感工具直接放行、不再弹确认卡（写 `info` 级审计日志）。
    老的 `advanced.confirmSensitiveTools === false` 由 `auto` 档承接（与默认档镜像，出厂同为 `false`），
    且 **`readonly` 优先于该布尔**。确认卡片新增第三键「本会话都允许」
    （会话 × 工具名，仅内存、不落盘）。项目根边界是**两层**：`auto` 档「要不要弹卡」用**字符串级
    判定**（含 `..` 段、取不到目标路径的工具一律按越界）；「能不能真碰」由主进程对已存在的最近
    父目录做 **realpath 前缀校验**（越界即 `E_PATH_OUTSIDE_WORKSPACE`），六个文件类入口与
    `run_command.cwd` 都走它。该边界**只在配置了当前项目时启用**（无项目时行为与 v12 之前一致）。
    `auto` 档下 `run_command` 命令串里出现绝对路径时一律回到确认卡片（见
    [06 §11.1 / §11.2 / §12.2](./06-agent-core.md)）。
  - **写前自动快照与一键回滚（v14，`agent.snapshots.*`）**：`write_file` / `edit_file` 落盘**之前**
    把原内容存进 `<userData>/backups/<sessionId>/`（一条一个 `<ISO 时间戳>-<8 位内容哈希>.snap`
    + `index.json`）；两层淘汰 —— 每文件环形保留 `keepPerFile`（默认 20）+ 目录总预算
    `totalBudgetBytes`（默认 200 MiB）；单份超 `maxSnapshotBytes`（默认 512 KiB）跳过，
    且**在工具结果里如实说明**。右栏「文件备份」卡可两段式回滚，**回滚本身也先留一份快照**
    （可再撤回），`exists:false` 的快照回滚 = 删除该文件（见 [06 §11.8](./06-agent-core.md)）。
  - **Task/Job 持久化与可续跑（v15，`agent.loop.*`）**：一次请求 = 一条 job，落在
    `<userData>/jobs/<sessionId>.json`，每轮结束落游标；轮次用尽 / token 预算触顶 → 落 `paused`
    并给出原因（`max-rounds` / `budget`）。右栏「任务」面板可看进度（第几轮 / token / 步骤 / 待办）
    并点「继续」**接着上次的进度跑**（**不重复落盘**那条用户消息）；
    `agent.loop = { maxRounds: 8, maxTotalTokens: 0(不限), autoContinueRounds: 2 }`，
    预算内的自动续轮次数**持久化**（重启不会重新获得额度）；
    **应用重启后 `paused` 的 job 仍在面板里，可直接继续**（见 [06 §4.1](./06-agent-core.md)）。
  - **顺带修掉的既有 bug**：`SessionStore` 与待办清单端口的「首读竞态」（并发首读拿到空快照、
    随后一次写入把磁盘历史整体覆盖）—— 改成 **in-flight promise 共享**并在读回时与在途写入合并。
  - **验证**：`pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm build` / `pnpm verify`
    全绿（`verify` **26/26**，`version = 15`、`v0 → 当前版本` **15 条迁移**）；
    `pnpm test` **79 个文件 / 1496 个用例全绿**（本轮起点 72 文件 / 1307 用例）；
    `AURORA_SMOKE` **163/163 passed**，含六条跨特性集成断言（项目 `AGENTS.md` 进请求体且项目根
    **父目录**的不进 / `auto` 档根内写文件不弹卡且落盘且留快照 / `readonly` 档同一条提问写不动 /
    一键回滚还原且新增 `origin:'rollback'` 快照 / 事件类型白名单含新增的 `job` /
    为第二次启动留下 `paused` job）；`AURORA_CAPTURE` **53 张 PNG / 53 条 checks / 0 FAIL**
    （含 `chat-project-card.png` / `chat-permission-readonly.png` / `chat-snapshot-card.png` /
    `chat-job-panel.png` 与综合概览 `chat-agent-prod-overview.png`）。
  - **两次启动的续跑实测**：第一次启动留下 `paused`（游标 2、已完成步骤 2）→ 退出 →
    第二次启动读回同一条 job（`found=1 status=paused`）→ 继续后 `status=done`、
    `stepsDone 2→3`、`cursor 2→3`，会话里那条用户消息**仍只有一条**。
  - **明确未做**：**仍无 OS 级沙箱** —— 三档权限与项目根 realpath 前缀校验**不是**沙箱
    （没有作业对象 / 容器 / 受限令牌，`run_command` 仍是当前用户权限）；
    子代理能力加强、上下文压缩修正**均未开始**（属第二批）；Code Mode 仍是占位实现。
    （**多模态输入与 Responses API 已于 2026-10-01 落地**，见下方「2026-10-01 多模态与 Responses API 轮」。）
    另需说明：上面「第二次启动」的续跑验证走的是**自测专用开关**
    `AURORA_SMOKE_WORKSPACE` + `AURORA_SMOKE_PHASE=resume` 拉起的两次启动，
    它是验证手段，**不是面向用户的功能**——用户侧的正常用法是重启后在右栏「任务」面板点「继续」。

## 2026-10-01 多模态与 Responses API 轮（配置 Schema v22）

兑现路线图里最后两项「第二批」能力的**第一项**：让模型真正看得见图，并支持第二套接口协议。
逐条口径见 [06 §3.1 / §3.2](./06-agent-core.md)、[08 §1](./08-settings-onboarding.md)、
[07 §2.3](./07-ui-spec.md)。

- **多模态输入（图片进模型）**：
  - 内核线上形状 `ChatRequestMessage.images?: LlmImageInput[]`（`mimeType` + 裸 base64）；
    非空时请求体的 `content` 由字符串变成 **content parts 数组**（正文 + 每张图一段
    `image_url`），**没有图片时形状逐字不变**（老网关不受影响）。
  - 落地链只加一条：主进程按扩展名把 `png / jpg / jpeg / webp / gif / bmp` 从附件里挑出来，
    路径经 `agent.send({ images })` 透传，内核用注入的 `loadImages` 端口读盘 ——
    图片**不走文本提取**，与文档附件可以同轮并存。
  - **会话历史存路径不存内容**（`StoredMessage.images`，`SESSION_FILE_VERSION` 2 → 3，无迁移脚本）：
    `sessions/*.json` 不被 base64 撑大，跨轮次续聊按路径重读，用户追问「刚才那张图」时仍看得到；
    文件被删 / 读不出时该轮跳过并记 warn（不编造内容，也不阻断请求）。
  - **能力开关 `llm.providers.<id>.vision`（出厂关）**：模型是否支持视觉因模型而异，
    且本仓库不做内置能力表（同 `contextWindow` 的口径）。关闭时图片降级为一行
    「内容未读取（当前模型未开启图片输入）」，请求体里不出现图片分片 ——
    对不支持视觉的模型发图片会被服务端 400，这个开关就是那道闸。
  - **附件缩略图**（`chat:readAttachment`，只回 `data:` URL、上限 2 MiB）：图片 chip 显示
    24×24 缩略图，非图片 / 超限 / 读失败退回纯文字 chip，不显示裂图。
- **Responses API（`llm.providers.<id>.type = 'openai-responses'`）**：
  新增 `OpenAiResponsesProvider`（`POST {baseUrl}/responses`，`store: false` 恒定下发）。
  请求映射：首条 system 消息 → `instructions`，其余 system 消息留在原位（前缀缓存不破）；
  工具调用与结果是**独立条目**（`function_call` / `function_call_output`，用 `call_id` 配对，
  不是条目 id）；`tools` 是扁平形状。事件映射：`response.output_text.delta` /
  `response.reasoning_*.delta` / `response.output_item.done` / `response.completed`（用量与收尾原因）/
  `response.failed` / `response.incomplete`。可靠性（超时 / 取消 / 退避重试 / 错误码 /
  列模型 / 连接测试）抽到共享传输层 `llm/transport.ts`，两套协议逐字一致。
- **顺带修掉的一个既有 bug**：`AURORA_CAPTURE=<dir> pnpm dev`（文档里的**全量**截图用法，
  不带 `AURORA_CAPTURE_ONLY`）会把场景清单过滤成空 —— 空字符串被解析成「一个都不匹配」的
  过滤条件，于是**静默一张都不截、退出码仍是 0**。现在空串 = 不过滤（`count: 71`）。
- **验证**：`pnpm typecheck` / `pnpm lint` / `pnpm build` 全绿；`pnpm test`
  **119 文件 / 2140 用例全绿**；`pnpm verify` **26/26**（`version = 22`、`v0 → 当前版本` **22 条迁移**）；
  `AURORA_SMOKE` **177/177 passed**（新增一条跨链路断言：开启时图片作为 `image_url` 分片下发且
  历史只存路径、关闭时不下发图片分片）；`AURORA_CAPTURE` **71 张 PNG / 71 条 checks / 0 FAIL**
  （新增 `settings-llm-multimodal.png`：接口类型与图片输入两枚控件在折叠区里、真值来自配置并写回原值）。
  另有一条**反向复核**：把「开关关闭时不得解析缓存里的图」那行守卫去掉，
  `agentHost.test.ts` 的「中途关闭开关」用例实测 FAIL（`expected [...] to be undefined`）。
