# AGENTS.md

面向在本仓库工作的 ZCode / 编码代理。**先读 [docs/README.md](docs/README.md) 了解设计（它是 SSOT）**，本文件只记录不读代码就容易踩的工程事实。

## 项目是什么

**Aurora** —— 把 Windows 接入 AI 生态的**系统级 Agent 工具**：常驻托盘，以「右侧提示条」提供无感 AI 服务。Electron + Vue 3 + TypeScript，pnpm workspace monorepo，所有文档与注释以中文为主。

## 目录与职责

```
apps/desktop/
  src/main/          Electron 主进程：托盘、窗口管理、配置、文件监听、分类管线、
                     系统感知、主动引导、Agent 装配、IPC 注册
  src/preload/       沙箱化 contextBridge 白名单（自包含，见下）
  src/renderer/      四个窗口入口：edge-bar / chat /
                     settings / onboarding + shared/ 共享组件
                     （chat 即主界面：1120×720 常驻三栏；可直接输入的快速对话在**提示条面板**
                     ——窗口 focusable 跟随展开/收起切换；主界面左栏固定项点击切 quick 会话；
                     主界面与设置有 Windows 式「最小化 / 关闭」caption 按钮，关闭 = 隐藏）
packages/shared/     配置 Schema、SettingsStore、IPC 契约、模式/窗口类型
  src/main/automation/ 自动化引擎：调度（trigger 评估）、操作组件执行、定义与历史存储、
                     内置自动化（课前提醒 / 课前打开科目文件夹，docs/13）
packages/agent-core/ Agent 内核：LLM / 会话 / 工具循环 / Skill / MCP / Prompt 组装
packages/modes/      IMode 框架、ClassRoom 完整实现、Work 初步实装（BetaV2）/ Code 占位
                     packages/modes/src/capabilities.ts：模式能力矩阵（docs/05 §6）
packages/center/     Aurora Center 服务器 + `aurora-center` CLI + Web UI（docs/12），
                     纯 Node 可跨端；构建 = tsc + vite（web/ → dist-web/）
skills/              内置 SKILL.md（file-classify / system-status / timetable）
scripts/             图标生成、验收、发布脚本
docs/                项目文档（SSOT，01–11 分册）
```

版本号以各 `package.json` 为准，**根 `README.md` 的版本与状态可能滞后**，当前进度看 `docs/README.md` 与 `docs/04-roadmap.md`。

## 常用命令

```bash
pnpm install          # 首次会下载 Electron 运行时（约 100MB）
pnpm dev              # Electron 开发（主进程 / preload / 渲染层 HMR）
pnpm build            # 三个包 + Electron 产物（apps/desktop/out）
pnpm typecheck        # 全仓 tsc / vue-tsc
pnpm test             # vitest 全量单测
pnpm lint             # ESLint        pnpm format  # Prettier
pnpm verify           # 真实磁盘配置层验收（需先 pnpm build）
pnpm package          # 构建 + electron-builder NSIS 安装包
# Aurora Center 服务器（docs/12）：开发态直接 node 跑
# node packages/center/bin/aurora-center.js start --port 8787 --data <目录>
# （数据目录默认 ~/.aurora-center；CLI 子命令 init/users/token/status/update）
```

- **跑单个/单包测试**：`pnpm vitest run <文件路径>`（如
  `pnpm vitest run packages/agent-core/src/session/store.test.ts`）；按目录过滤就写目录
  （如 `pnpm vitest run packages/agent-core/src`）。
  ⚠️ **别用 `pnpm --filter @aurora/agent-core test`**：根 `vitest.config.ts` 的 `include`
  是**根相对**路径，在包目录下执行会一个用例都匹配不到，直接以 `No test files found` 退出码 1 失败
  （2026-09-26 实测；各包 package.json 里的 `test: vitest run` 只在仓库根调用时才对）。
- **端到端自测（真实 Electron + IPC，离线可跑）**：PowerShell 下 `$env:AURORA_SMOKE='1'; pnpm dev`，结束后看 `%TEMP%\aurora-smoke-logs` 里的 `AURORA_SMOKE_RESULT`。调试渲染层加 `AURORA_DEVTOOLS=1`。
- **窗口截图核对（前端视觉验收）**：`$env:AURORA_CAPTURE="$env:TEMP\aurora-capture"; pnpm dev`，会把四个窗口、
  提示条两态、设置页各页与各条 DOM 探针场景（面板 / 收起 / 自动滚底 / 门控 / 拖动 / 思考等级 /
  模型列表与模型选择 / 真实写盘 / 提示条收尾图）截成一批 PNG ——
  BetaV2 起另有主界面三栏场景（左栏门控 / 右栏开关与 Work / 思考块 / 快速会话）、
  设置六页新门控与旧深链别名（`settings-legacy-tts-alias`）场景；
  **张数与具体构成以 `report.json` 的实际条目为准，不要按固定张数校验**，
  并写 `report.json`（渲染层 DOM 探针结果：
  面板按钮命中测试、点击竖条后的窗口状态、设置页 `data-field` 门控计数；探针返回 `pass` 时按 PASS/FAIL 落日志，
  有 FAIL 时进程退出码为 2）。
  只截部分窗口用 `$env:AURORA_CAPTURE_WINDOWS='edge-bar,chat'`。命令结束后进程自行退出；
  userData **自动隔离**（探针会改配置），无需再手动同开 `$env:AURORA_SMOKE='1'`。规则见 docs/07 §5.3。
- **CI 是按需触发的，不跟随 push / PR 自动跑**（`.github/workflows/ci.yml`，Windows）。
  日常验证靠本地 `pnpm typecheck && pnpm test && pnpm build`——与 CI 同一套检查、全量约 15 秒；
  需要干净环境时手动发起（Actions → Run workflow，或 `gh workflow run ci.yml`）。
  CI 内部顺序：`format:check → lint → typecheck → test → build`。策略原因见 docs/09 §2。

## 架构硬约束（改错会直接构建失败或线上炸）

1. **`agent-core` 与 `modes` 不得依赖 Electron / DOM**——保持纯 Node，可独立单测，也为将来换壳层留后路。
2. **preload 必须自包含**：它跑在 `sandbox: true` 的渲染进程里，无 Node 能力、无法解析 pnpm 工作区包，只能 `require('electron')` + 字面量通道表。改 IPC 契约时**同时**改 `packages/shared/src/ipc/channels.ts` 与 `apps/desktop/src/preload/channels.ts`（两者有编译期双向断言，漏改 `pnpm typecheck` 会报错）。
3. **主进程必须内联工作区包**：`@aurora/*` 是纯 ESM，主进程产物是 CJS，`require()` ESM 会抛 `ERR_REQUIRE_ESM`。因此 `electron.vite.config.ts` 把它们排除在 `externalizeDepsPlugin` 之外——不要「顺手」加回去。
4. **渲染层只允许类型导入**：从 `@aurora/shared` 取**纯常量/运行时值**必须走 `@aurora/shared/browser` 子路径，否则会把 `node:fs` 拉进浏览器 bundle 导致构建失败。`packages/shared/src/browser.ts` 的依赖链禁止出现任何 Node 内置模块。
5. **重任务走子进程**：文档内容提取等 CPU/IO 重活由 `utilityProcess.fork` 启动 `extract-worker`（`electron.vite.config.ts` 的第二个 main 入口），不阻塞主进程事件循环。
6. **IPC 命名**：通道用 `namespace:action`（如 `chat:send`、`mcp:status`）；事件推送 `on/off` 成对暴露；大 payload（文件全文）只在主进程 / worker 内流转，不进渲染进程。

## 编码与安全约定

- TypeScript strict，开启 `verbatimModuleSyntax`、`noUncheckedIndexedAccess`、`noImplicitOverride`。ESLint 强制 `consistent-type-imports`（用 `import type` / 内联 `type`），未用变量需 `_` 前缀。
- Prettier：**无分号**、单引号、`printWidth: 100`、尾逗号 all、LF（见 `.prettierrc.json` / `.editorconfig`）。
- **日志**：业务包只依赖 `@aurora/shared` 的 `Logger` 接口；落盘实现在 `apps/desktop/src/main/logger.ts`（`userData/logs/`，按天轮转保留 7 天），所有输出统一脱敏。不要 `console.log` 当正式日志。
- **凭据绝不落明文**：API Key / MCP env 经 Electron `safeStorage` 加密写入 `%APPDATA%/Aurora/config.json`；`settings:get` 与 `settings:changed` 两条通道都只回传 `apiKeySet` / `envSet` 标记。日志与「导出脱敏配置」中凭据一律 `***`。
- **文件/命令安全**：MCP 服务器以用户显式配置的 argv 数组启动、**绝不经过 shell**；Skill 的 `scripts/` 永不自动执行；敏感工具用 `sensitivity: 'confirm'` 标记，需确认后才执行（确认链路抛错按拒绝处理）。
- **配置改动**（当前 `CONFIG_VERSION = 21`）：Schema 在 `packages/shared/src/config/schema.ts`，改字段必须走版本迁移链（`migrations.ts`）并同步更新 `docs/08 §1`；`pnpm verify` 会断言 `version === CONFIG_VERSION` 与 `v0 → 当前版本` 的迁移条数，版本推进后必须复跑。

## 文档先行（Docs-first）

`docs/` 是**单一事实来源**：改配置 Schema、IPC 契约、窗口交互前**先改文档再改代码**。按主题查阅：

- 配置 / 引导 / 凭据 → `docs/08-settings-onboarding.md`
- Agent 内核（LLM / 会话 / 循环 / Skill / MCP / 感知 / 主动引导）→ `docs/06-agent-core.md`
- 模式系统与文件分类管线 → `docs/05-mode-system.md`
- 窗口体系与 UI 规格 → `docs/07-ui-spec.md`（视觉设计另见 `ui-ux-pro-max` / `frontend-design` skill）
- 进程 / 模块 / IPC 约定 → `docs/02-architecture.md`
- 打包发布与自动更新拓扑 → `docs/09-packaging-release.md`

## 环境相关坑

- **pnpm 11 默认拦截依赖安装脚本**：需要放行的依赖写在 `pnpm-workspace.yaml` 的 `allowBuilds`（写 `false` 表示显式拒绝）。不要再维护 `ignoredBuilds`，两处并存会导致 `pnpm test` 前置的依赖校验以 `ERR_PNPM_IGNORED_BUILDS` 失败。
- **Electron 二进制下载失败**（企业代理 / 证书拦截）：在 `apps/desktop/node_modules/electron` 下执行 `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; node install.js`。npm 镜像配置见 `.npmrc`。
- **vitest 只收「不 import 'electron'」的主进程测试**（`vitest.config.ts` 的 include）：`apps/desktop/src/main/**/*.test.ts` 下的用例若引入 Electron 会在 Node 环境加载失败。依赖 Electron 的行为靠 `AURORA_SMOKE` 端到端自测覆盖。
- 用户数据：配置 `%APPDATA%/Aurora/config.json`、会话 `sessions/*.json`、分类流水 `classification.json`、日志 `logs/`。写文件一律原子写 + 防抖（与 `SettingsStore` 同一套 `FileSystemPort` 约定），退出前 `flush()`；损坏文件备份后重建。
- 提交信息用 **Conventional Commits**，描述用中文（如 `feat(v0.5.0): ...`、`fix: ...`、`docs: ...`）。
- **`pnpm dev`（含 `AURORA_CAPTURE`）在 Electron 里跑不了时先查 `ELECTRON_RUN_AS_NODE`**：
  它若是 `1`，Electron 会把自己当纯 Node 启动，`require('electron')` 返回的是**二进制路径字符串**，
  主进程在 `!electron.app.isPackaged` 这行崩（`Cannot read properties of undefined`）——
  看着像打包产物坏了，其实只差 `Remove-Item env:ELECTRON_RUN_AS_NODE`。
  某些 agent 运行时（如 DSH 的 shell）默认就带这个变量，逐条命令前清一次最稳。
- **同一台机器上可能有别的 dev server 占着 5173**：`electron-vite dev` 会自动换到 5174 并照常工作，
  不是错误（截图与探针都不受影响）。

## 诊断与验证的时间成本（2026-09-30 「跟丢」排查的教训）

那一轮把「自动跟随跟丢」查穿花了远超预期的时间，**大头不是难度而是排查方式**。
下次碰到"跑起来才知道对不对"的问题，先按这几条走：

- **别用全量 `AURORA_CAPTURE` 当探针**：一轮 3–5 分钟、且必须串行重建。
  排查阶段先用**最小复现**（一个临时 HTML + 同一段 JS，几秒一轮）把
  "浏览器到底会不会那样表现"钉死，再回到仓库里改实现 —— 本轮最贵的一次绕路就是
  用 20 多轮全量截图去问一个可以用 20 行 HTML 回答的问题。
- **"绿灯"会骗人**：`pnpm typecheck` / `pnpm test` / 大多数探针一路是绿的，行为却可以是坏的。
  UI 类问题先构造**能直接读出事实**的观测（引擎自己的读数 vs 探针 querySelector 的读数、
  计数器、节点身份标记），**一次性把仪器插全**再跑，而不是每轮只加一个数字。
- **`capture.ts` 里的探针是 template literal 字符串**：字符串**内部**的注释写反引号 `` ` ``
  会提前终止字符串，直接 `TS1005` 且报错位置极具误导性。本轮在这个坑上反复栽了十几次 ——
  写注释用「」或单引号。这条在文件里已写过一次，**但教训是"每次改都要自查"**，不是"记住了就行"。
- **探针之间会互相污染**：本轮 `chat-follow-burst` 长时间 FAIL，根因是它前面那条
  `CHAT_AUTO_SCROLL_SCRIPT` 把跟随关掉后没恢复。每条场景都要**自带前置与收尾**，
  用应用自己的入口按钮恢复状态，不依赖别人的自律。
- **同一段语义的判据只写一份**：`pass` 与 `conditions` 表漂移过一次 —— 报告里每条都 `true`、
  探针恒定 FAIL。让 `pass` 直接取那一张表的乘积。
- **量事实，别量解析值**：`border-left-color` 在"没有左边框"时解析成 `currentColor`；
  展开动画中途的 `border-width` 是 `0.666667px`。判据要取"有没有这条边"（宽度）而不是颜色，
  且必须在**正确的时机**量（折叠态、点击之前）。


## 尚未生效 / 已知限制（别误当成 bug）

- 全局快捷键默认 `Alt+Space` **在 Windows 上常被系统占用**（它是系统窗口菜单键）。
  注册失败是预期路径：`main/hotkey.ts` 会把真实原因回传设置页，用户改绑即可 —— 不要"修"成静默成功。
- 提示条的 `可穿透性`（`setIgnoreMouseEvents`）尚未接入；`general.language` 是死字段（无 i18n 消费方），
  **已从设置页与引导页移除**（Schema 里保留字段仅为兼容旧配置，改它不生效）。
- **AI 悬浮窗（service-dock）已于本轮移除**，常驻入口为提示条 + 托盘；配置迁移到 v4
  （`v3 → v4` 删除 `general.windowState['service-dock']`）。提示条的悬停展开面板与点击呼出交互窗见 docs/07 §2.2。
- **独立小窗（mini-chat）已于早轮删除**；2026-09 重构起标题栏是 Windows 式 caption 按钮——
  「关闭」= **直接隐藏窗口**（正在进行的流式回复不中止），「最小化」真最小化进任务栏；
  「快速对话」（`sessionId = quick`）的输入入口在提示条面板（左栏固定项点击切会话），历史会话列表在左栏，
  提示条面板操作入口由 4 个减为 3 个；配置迁移到 v6（`v5 → v6` 删除 `general.windowState['mini-chat']`）。
- MCP HTTP 传输已支持自定义请求头（含鉴权头，`mcp.servers.<id>.headersEnc`，凭据链路与 env 同款，见 docs/08 §1）。
- **语音输入（STT）已实装（v0.0.1）**：对话窗 composer 的麦克风按钮（`data-field="chat.mic"`）
  门控口径同 TTS —— `stt.enabled` + `stt.active` 指向一个 `baseUrl`/`model` 齐全的 provider
  **才渲染按钮，未配置时连按钮都不渲染**（不是 disabled）——这是文档门控口径，别当 bug 修
  （TTS「朗读」按钮同款口径，见 docs/07 §2.3）。
- **电脑操控工具已由 5 个扩到 8 个**（2026-09 新增 `edit_file` / `grep` / `glob`，
  见 docs/06 §11.5 / §11.6）：三者都在 `agent.tools.enabled` 总开关与各自子开关
  （`edit_file` 随 `files.enabled`、`grep` / `glob` 随 `search.enabled`）之下 ——
  与「扩展工具五件套不受门控」的口径**相反**，别按五件套理解它们。
- **三档权限与项目根边界已落地（2026-09-26），但仍无 OS 级沙箱**：`agent.permissionMode` 取值
  `readonly` / `confirm` / `auto`（**默认 `auto` = 完全权限**，2026-09-29 起出厂档；镜像的老开关
  `advanced.confirmSensitiveTools` 出厂同为 `false`）—— `readonly` 档**不注册**写入 / 执行类工具
  （含 `todo_write`，保留 `todo_read`），`auto` 档在**当前项目根之内**免确认、越界仍逐次确认、
  未配置项目时只写日志留痕；
  v0.2.4 起两处放宽（Codex 式，docs/06 §11.2）：`center_send_file` **直接发送不逐次确认**
  （闸门在配置层 `center.enabled` / `allowFileTransfer` / `maxFileMb`，别再给它加确认），
  `confirm` 档下 `write_file` / `edit_file` 落在会话边界根内**免确认**（`run_command` 等仍逐次）；
  边界根的回落链见下面「会话级项目的解析唯一口径」（含 Work 模式工作目录一级）；
  项目根边界分**两层**：`auto` 档「要不要弹卡」用**字符串级判定**（含 `..` 段、取不到目标路径的
  工具一律按越界）；「能不能真碰」由主进程对**已存在的最近父目录**做 realpath 前缀校验
  （`file-port.resolveWithin`，越界即 `E_PATH_OUTSIDE_WORKSPACE`，六个文件类入口与
  `run_command.cwd` 都走它）。
  但**没有作业对象 / 容器 / 受限令牌**，`run_command` 仍是当前用户权限 —— 别把这两层说成"沙箱"。
  早前的确认判定逃逸**已封堵（2026-09）**：确认判定改为四态 decision，
  `approvedByUser` 仅当用户**当次**卡片批准 / 首次「总是允许」置位，机器放行不置位、
  realpath 兜底保留（根内链接指向根外在机器放行路径下被 realpath 拒绝且不弹卡）；
  详见 docs/06 §11.2。
- **`agent.tools.workspaceDir` 仍然只是"默认 cwd / 搜索根"，不是安全边界**：缺省工作目录 / 搜索根按
  三级回落——**当前项目根（配置了当前项目时）> `workspaceDir` > 用户主目录**，这条链**已按 docs/06 §5.1
  的 `effectiveWorkspaceDir` 接线**（**工具执行链的唯一口径**，别在执行链上再写一套）：配了
  当前项目后，不显式传 `cwd` 的 `run_command` 与不传根的 `grep` / `glob` 落在**项目根**；
  无项目时行为与之前一致。设置页「打开工作目录」按钮（`openPath kind:'workspace'`，`ipc.ts`）
  **也已接同一链**（2026-09，解析抽在 `main/tools/workspace-target.ts` 纯函数）：配了项目时打开项目根、
  与命令缺省落地目录一致，早前的分叉已消除；不要误改成 `kind:'project'`（那是固定打开项目根的另一个入口）。
  真正的安全边界是**「当前项目根」**，且**只有配置了当前项目时才生效**
  （无项目时行为与 v12 之前完全一致）。
  想当然地拿 `workspaceDir` 当护栏、或把 `openPath` 的 `kind: 'workspace'` 当成项目根，都是错的
  （项目根走 `kind: 'project'`，见 docs/06 §5.1 / §11.1）。
- **ClassIsland 桥接读取有默认路径回落（v0.2.4）**：文件源端点读取失败时自动按插件默认输出
  `%APPDATA%\ClassIslandurora-bridge\schedule.json` 重试一次，成功则告警提示对齐两端配置
  （`classisland.ts` 的 `fallbackFilePath`，主进程注入；默认路径常量别散落第二份）。
  桥接读取失败按「错误是否变化」分级记日志（变化才 warn，持续同一错误 debug），别改回全量 warn。
- **自动化（Automation，v0.2.5）已落地两种模式（docs/13）**：**Agent Mode** 触发后跑一次
  完整 Agent 会话（专属会话 id = runId = `auto-<ts36>-<n>`，`origin: 'automation'`），
  **Normal Mode** 触发后按预设操作组件执行（**封闭清单**：系统通知 / ClassIsland 提醒 /
  打开文件夹 —— 没有命令、没有任意写，这是它与 Agent Mode 的安全分界）。
  定义与历史落在 `<userData>/automations/{automations.json,history.json}`（**不是配置**、
  不进迁移链；历史上限 500 条）。ClassRoom 既有的**课前提醒 / 课前自动打开科目文件夹**由
  **内置自动化**（`builtin.pre-class-notify` / `builtin.pre-class-open-folder`）承接，
  行为逐字保留（同一提前窗口 / 文案 / 勿扰 / `lessonKey` 去重），旧 `PreClassReminder`
  服务已**删除**（`schedule.ts` 的 `preTrigger`/`needsNextDayLessons` 纯函数保留给条件评估用）；
  **自动分类不在迁移范围**（仍是独立管线）。`auto-` 前缀会话**不进主界面左栏**（只过滤展示，
  只从「自动化 → 历史」进入）。`automations.*` 整组在 `SETTINGS_READONLY_PREFIXES`
  （AI 只能经 `automation_*` 六件套工具增删，写类四个是 `confirm`）。
- Skill 的 `scripts/` 永不自动执行（只注入指令正文）；图片 OCR 未启用（只取文件名与尺寸）。
- Code Mode 为占位实现；Work Mode 已初步实装（guide + systemPrompt；v0.2.4 起 `modes.work.workspaceDir`
  已接进工具执行链的统一回落链，不再是仅提示词引用的死字段）。
  多语言、ARM64 / 便携版、macOS / Linux 未开始。
- `integrations/classisland-bridge` **CI 不编译**（流水线没有 .NET SDK）。
  它已用 ClassIsland 2.1.0.1 的真实程序集在本机编译并实跑验证过（见该目录 README 的「已验证程度」），
  改动后请在装有 .NET SDK 与 ClassIsland 的机器上重新验证：
  `dotnet build -c Release -p:ClassIslandDir="<ClassIsland 安装目录>"`。
  注意 ClassIsland 的程序集**不在**安装根目录，而在 `app-<版本>/` 子目录（csproj 会自动往下一层找）。

## 几个容易踩的接线点（改之前先看这里）

- **网络出网统一走 `main/net.ts` 的 `netFetch`**：它优先用 Electron `net.fetch`（走 Chromium
  网络栈 → 才受 `session.setProxy` 的代理影响），并保留 `globalThis.fetch` 回落。
  新增任何出网调用都要注入它，否则 `advanced.proxy` 对该调用无效。
- **`agent-core` / `modes` 不得 import electron**：代理、快捷键、窗口、日志实现全在主进程，
  内核只接受注入（`fetchImpl` / `summarize` / `confirmTool` 都是这个套路）。
- **配置字段"能写"不等于"生效"**：本轮修掉的就是一批死字段。新增配置项时要么接上消费方，
  要么在本文档里明确标注为未生效。
- **跨 IPC 不能传 reactive 代理**：`ipcRenderer.invoke` 用结构化克隆传参，Vue `reactive` / `ref` 产出的
  **Proxy 不可克隆**，会抛 `DataCloneError: An object could not be cloned.`——若在异步 handler 里
  await 它，表现就是「点了没反应、也不报错」（`settings:update` 与 `chat:send` 的附件列表都踩过）。
  注意 `{ ...reactiveObj }` 这类展开只让**顶层**变纯，嵌套子对象仍是 Proxy。
  渲染层往主进程送对象前统一走 `deepClone()`（`@aurora/shared/browser`，内部 structuredClone →
  JSON 回落，正好把 Proxy 变成纯数据）；只传字面量 / 字符串的通道不用处理。
- **ClassIsland 联动只认 `main/classisland.ts` 的 JSON 契约**，桥接端的实现细节不得泄漏到
  provider 与消费链；桥接数据的一切异常都必须降级为空课表 + 告警。
- **渲染层播放合成音频依赖 CSP 的 `media-src 'self' blob:`**（`main/index.ts` 两条 CSP 都要有）：
  生产 CSP 的 `default-src 'self'` 会拦掉 `blob:`，而开发态 `default-src` 里本来就带 `blob:` ——
  漏掉生产那条的症状是「**开发能播、打包不能播**」，属最难排查的一类假阳性。
  TTS 出网必须走 `main/net.ts` 的 `netFetch`（否则 `advanced.proxy` 对它无效），
  `TtsSynthesizer` 用 `resolveFetch` 注入；它**不得 import electron**，否则 vitest 收不了它的单测。
- **`tts.providers` 是凭据路径**，已进 `SETTINGS_READONLY_PREFIXES`（AI 的 `set_setting` 一律拒绝）。
  新增任何 shared 的密文路径时，`SettingsStore` 的 4 处（`canonicalSecretPath` / `readSecretField` /
  `writeSecretField` / `toPersisted`）**外加**主进程 `redactSettings` **必须同时改**：
  漏改 `writeSecretField` = 凭据静默丢失，漏改 `redactSettings` = 密文泄漏进渲染层。
  另注意 `SENSITIVE_KEY_PATTERN` 原本是**整体锚定**的，`apiKeyEnc` 这类**派生字段名**不命中 ——
  它已补 `.*api[-_]?key.*` 分支，日志脱敏才盖得住密文。
  v9 起新增的 `mcp.servers.<id>.headersEnc` 与 `envEnc` 同款、位置并列（同样要过这 5 处）。
- **`agent.tools.terminal.allowPatterns`（免确认命令模式）属只读前缀**：AI 的 `set_setting` 一律拒绝
  （否则 AI 给自己加一条 `git*` 就等于摘掉自己的确认闸门 = 自我提权），
  只能由用户在设置页的「免确认命令模式」栏里维护（设置页走 `settings:update`，不受该黑名单影响）。
  命中即跳过确认卡片、但仍写 `info` 级审计日志 —— 语义是「减少打扰」而非安全加固（见 docs/06 §11.7）。
- **`edit_file` 的「改前必须先读」守卫是会话级单例、建在 `registerComputerTools` 的闭包里
  （`sync()` 之外）**：`read_file` 与 `edit_file` 共享同一份「本会话读过哪些文件」的记录
  （键是**解析后的绝对路径**，按会话裁剪、只留最近 16 个会话）。`sync()` 会在每次
  `settings:changed` 时重建**全部工具实例**（这是让上限 / cwd 热改的必要设计）——
  **不要把这个守卫挪进 `sync()`**：挪进去后用户改一个无关开关（比如关掉终端）就会清空读记录，
  模型刚 `read_file` 过的文件立刻被 `edit_file` 拒绝「修改前必须先读」，看起来像工具坏了。
  守卫是内核的可注入端口（未注入时不拦截，供单测直接调工具），见 docs/06 §11.6。
- **写前快照的钩子在 `file-port.writeText` 内部，顺序不能换**（v14）：顺序是 `resolveWithin`
  （项目根 realpath 前缀校验）→ `capture`（把**原内容**存进 `<userData>/backups/<sessionId>/`）
  → 真正写盘。换成"先写再备份"就等于"改完才备份"，回滚拿不到改动前的内容；
  主写失败**不回滚快照**（文件可能已被部分改写，那份快照才是唯一退路），
  改成把快照 id 带进错误信息（见 docs/06 §11.8）。
- **`ensureLoaded` 的三处（会话 / 待办清单 / job 存储）都必须用 in-flight promise**：
  写成"先置 `loaded` 再 `await` 读盘"会让并发首读拿到**空快照**，随后那一次写入
  把磁盘上的历史**整体覆盖**（本仓库已修过两次，别再改回去）。job 存储还多一条：
  **落盘前必须已 `ensureLoaded`**，否则内存里的空表会冲掉盘上数据。
- **自动续轮的 history / systemPrompt 必须在 `for (;;)` attempt 循环内、每 attempt 重算**（2026-09 修复，docs/06 §4.1）：
  `agentLoop` 在 `appendUserMessage = false` 时**既不落盘也不 push** 用户消息，其语义前提是「提问已在 history 里」——
  只有每轮重读会话组装才成立。整块外置到循环之前 = 续轮拿**请求前**的旧快照，第二轮既没有本轮提问、
  也没有上一 attempt 的工具结果，模型会重复已执行的写 / 命令操作。回归护栏：
  `agentHost.test.ts` 的「自动续轮的请求带本轮提问与上一轮工具结果」用例。
- **`agent.permissionMode` 是只读前缀**（AI 的 `set_setting` 一律拒绝：改档位等于自我提权，
  与 `agent.tools.terminal.allowPatterns` 同款）。`agent.snapshots.*` / `agent.loop.*` 同为
  **`SETTINGS_READONLY_PREFIXES` 中的只读前缀**（用户可在设置页调，AI 一律拒绝）：
  让 AI 给自己放大轮次 / token 预算，等于绕过"该停下来问用户"的那道闸门；关掉写前快照
  等于拆掉回滚保险。`advanced.readonlyPrefixes`（黑名单配置自身）也已进黑名单（v15）：
  AI 往里追加等于自我收紧（自我 DoS），放宽本就不生效。
- **`agent.loop` 的三个上限是以 getter 注入内核的**（`() => settings.get().agent.loop.maxRounds`
  这种形式）：写成构造时常量值就变成"改设置要重启才生效"的死字段 ——
  与上面「配置字段"能写"不等于"生效"」是同一个坑，本仓库已修过一批。
- **BetaV2 新能力的注册口径**：STT / 生图 / 新工具五件套（`web_fetch` / `notify_user` /
  `clipboard_read` / `clipboard_write` / `generate_image`）**不走 `agent.tools.enabled` 门控**
  （那个总开关管的是 8 个电脑操控工具），敏感项靠 `sensitivity: 'confirm'` 逐次确认；
  ⚠️ **反例与它们同期**：2026-09 新增的 `edit_file` / `grep` / `glob` **是电脑操控工具、受总开关门控**
  （分别随 `files.enabled` / `search.enabled`，见「尚未生效 / 已知限制」那条）——
  不要因为"同期落地"就把它们也当成不受门控的扩展工具；
  `set_setting` 的判定顺序是：命中 `WRITABLE_PATH_OVERRIDES` 显式放行（先于黑名单）→ 命中
  `SETTINGS_READONLY_PREFIXES` 拒绝 → **Schema 登记过的叶子路径默认可写**。覆盖表是
  「黑名单内的显式放行 + 可写面清单」，**不是白名单**：新增安全敏感分组必须**显式进黑名单**，
  只「不登记进覆盖表」挡不住——要新增「Agent 可写的设置路径」先改该表，
  再同步 `set_setting` 的工具 description 与 systemPrompt 的 settingsHint。
  v9 起 `todo_write` / `todo_read` / `task` 由 `registerAgentCoreTools` 注册（见 docs/06 §18 / §19），
  同样**不受 `agent.tools.enabled` 门控**。
- **主界面 `chat` 窗口是 1120×720、`alwaysOnTop=false` 的常驻大窗**（三栏布局 + 右栏模式感知，
  关闭仍 = 隐藏），别按旧版 420×640 侧弹交互窗的心智模型理解它的几何、层级与探针坐标。
- **输入卡有两条硬口径（2026-09-29 减负轮，docs/07 §2.3），别再改回去**：
  ① 权限 / 模型 / 思考三枚控件一律 `--control-h-xs`（28px）+ pill 圆角 + **静止态零边框**
  （悬停才浮 `--fill-2`），三者的尺寸与状态样式**逐字对齐** —— 40px + 逐枚边框会把输入卡
  顶成一条设置工具栏；② 占位文案只留一句（`输入消息…`），键位提示挂工具行右侧的
  `.composer-hint` —— textarea 的高度由**内容**决定（空内容 = 一行），占位串一旦换行，
  第二行就看不见了（用户实测「文字超出组件」的成因）。
- **改了 `packages/shared/src/**` 或 `packages/agent-core/src/**` 之后必须先 build 那个包再跑下游 typecheck**：
  两个包的 `types` 都指向 `dist/*.d.ts`，不重建的话 `apps/desktop` 会对着**旧类型**报错 ——
  常见症状是共享包「no exported member」、agent-core 新加的方法在 `main/ipc.ts` 里报
  `TS2339 Property 'xxx' does not exist on type 'SessionStore'`（看着像自己写错了，其实只是没编译）。
  命令：`pnpm --filter @aurora/shared build` / `pnpm --filter @aurora/agent-core build`。
- **Aurora Center（docs/12，v16）的四处坑**：
  ① `packages/center` 的 CLI `start` 必须**常驻**（`await` 信号后才 return）——
  bin 启动器在 `runCli` 返回后 `process.exit`，写成"注册完信号处理器就 return"服务器会秒退；
  ② `ws` 库**手动** `handleUpgrade` 时回调**替代**了 `'connection'` 事件
  （库内只有自动挂 upgrade 监听的那条路径会 emit），服务器端客户端握手是
  `beginClientSession(ws, token)` 直调，别改成依赖 `clientWss.on('connection')`；
  ③ `center.token` 是凭据路径（`center.token` ⇄ `center.tokenEnc`），与 apiKey 同款
  5 处同步；`center.*` 整组在 `SETTINGS_READONLY_PREFIXES`（连接目标是外发通道），
  但 Center 的**远程配置**走 `main/center/remote-control.ts` 的独立白名单
  （`CENTER_REMOTE_CONFIG_PREFIXES`），两条通道语义不同别混改；
  ④ 远程补丁应用前必须先在 `structuredClone` 副本上演练——`SettingsStore.mutate`
  的 draft 是**活对象**，失败半写会污染内存态。
  ⑤（2026-09 扩展轮）确认卡网页批复：**只有 `center-` 前缀会话**的敏感工具确认会经
  connector 推 Center（`confirm.request`），网页批复下发 `confirm.resolve` 命令最终调
  `proactive.resolve`（对已结算 confirmId 幂等，本地卡与网页卡先到先得）；v0.2.4 起
  `center_send_file` 直接发送不产生确认卡，本地会话不再有推网页端的确认；
  设备授权登录
  （`center:deviceLogin` IPC）与账号密码直登的**凭据落库路径共用同一函数**，改落库只改一处；
  上传文件 24h TTL 清理在 `packages/center/src/files.ts`（启动 + 每 15 分钟一轮）。
- **远程会话与本地发送是同一条链**：Center 的 `session.input` → `SessionBridge` →
  `agent.send({ origin: 'center' })`（`SendMessageRequest.origin` 已放宽）。
  只转发 `center-` 前缀会话的事件；别在别处再写一条"远程专用"发送通路。
- **会话级项目的解析唯一口径**（2026-09，v0.2.4 加模式级一级，docs/06 §5.1）：
  `main/tools/session-project.ts` 的
  `createSessionProjectResolver` —— 回落链是**会话绑定项目（`SessionMeta.projectId`）>
  `projects.current` > 激活模式工作目录（当前只有 Work 模式读 `modes.work.workspaceDir`，
  从 settings 现读不需要注入模式管理器）> `agent.tools.workspaceDir` > 主目录**；
  工具缺省 cwd / 搜索根、file-port 边界、confirmTool 的 auto 档根内免确认与 confirm 档
  根内写免确认、AGENTS.md 指令注入**全部按会话现解析**
  （getter 注入，同 `agent.loop` 上限套路）。不要在执行链上再写第二套项目根解析，
  也别把会话项目塞回全局设置或 CONFIG_VERSION 迁移链（它是会话数据）。
  Work 模式的 systemPrompt 描述的就是这条链（docs/05 §4.1）——别在提示词里另立「工作目录」口径。
- **SkillsService 的目录监听**（`startWatching`）：改 `skills.userDir` 走 `reconfigure`
  时会 `rearmWatcher`，新增监听路径时记得同样处理；create-skill 技能写文件后
  依赖这个监听自动重扫，没有任何"刷新"仪式。

- **自动化引擎（`main/automation/engine.ts`）的三处接线要点（docs/13 §3）**：
  ① 事件订阅在**构造期**建立（不是 `start()`）—— 否则「构造完成 → start() 之间」落下的
  `done` / `error` 会让历史永远停在 `running`（引擎只对 Agent 模式的运行做事件驱动收尾）；
  ② `firedKeys` **按自动化隔离**（两条内置共用同一个 `lessonKey`，共用一个集合会互相挡），
  条目 48h TTL（`lessonKey` 每周重复，不 TTL 会误挡下周同一节课）；
  ③ **手动触发与定时触发必须走同一条分派**（`runDefinition`）—— Agent 模式的定义没有
  `actions`，`runNow` 若只执行操作组件会落一条永远「进行中」的历史且从不调用 Agent
  （v0.2.5 的 smoke 实测就是这个症状，回归护栏在 `engine.test.ts`）。
  另注意：**引擎在 bootstrap 时就启动并首读 store**（in-flight 缓存），所以自测夹具在启动后
  写盘时必须调 `automationEngine.reload()` 重读 —— capture 的 `seedAutomationFixture` 就是这么用的。
- **`AgentEvent` 里 `auto-` 会话的确认卡走既有确认链**：无人值守时 60s 超时按拒绝处理；
  自动化**没有自己的权限体系**，也**不应用勿扰时段**（勿扰只门控内置自动化 / 既有课前提醒）。
  给自动化会话免打扰的正路是把权限档设为 `auto` 或在会话里点「本会话都允许」，
  **不要**为自动化新增静默放行通道。
- **capture / smoke 的探针改配置时注意两个缓存**：`SettingsStore.init()` 启动即把 `config.json`
  读进内存并长期缓存 —— 启动后**写文件对运行中的进程无效**，改配置只能走 `settings:update` IPC；
  而 `SessionStore` 是按会话**惰性**读盘且首次读即缓存，种会话文件必须赶在窗口第一次
  `chat:history` **之前**（`runCapture` 里、`captureWindows` 之前）。两者时机相反，容易搞混。
- **`capture.ts` 里那些探针是 template literal 字符串**：字符串**内部**的注释写反引号 `` ` ``
  会提前终止字符串，直接 `TS1005` 且报错位置极具误导性。写注释用「」或单引号。
