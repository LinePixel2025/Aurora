# AGENTS.md

面向在本仓库工作的 ZCode / 编码代理。**先读 [docs/README.md](docs/README.md) 了解设计（它是 SSOT）**。
本文件只放**每次动手都要遵守的硬规则**；踩坑的完整现象 / 根因 / 实测证据、历史排查经验与"为什么"都在
[`Memory/`](Memory/README.md)。

## 会话开始先加载项目记忆（第一个动作）

**每次会话动手之前**先把记忆读进上下文：用 `skill` 工具加载 `memory-read`
（等价动作 = 读 `Memory/README.md` + `Memory/` 下全部 `.md`）——**没有这个技能就直接读文件**。
踩到新坑或确认长期口径时用 `memory-create` 落盘（一个主题一个 md、文件名带日期、同步更新 `Memory/README.md` 索引）。
两个技能装在**系统共享技能根**（`~/.agents/skills`，即 DSH 的 `agentsHome` 根 / rank 500，与 find-skills、step-planner 同层；
2026-10-03 从用户级根 `~/.dsh/skills` 移来），不随本仓库分发 —— 别人克隆后按上一句直接读文件即可。
**层级**：本文件的硬规则 > `Memory/` 的历史经验；任一条与当前实测冲突时，以实测为准并顺手更正记忆。

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
                     （chat 即主界面：1280×800 常驻三栏；可直接输入的快速对话在**提示条面板**
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
pnpm verify:plugin <目录|zip>   # 插件包独立校验（共用 shared 清单 schema；需先 build:packages）
pnpm package          # 构建 + electron-builder NSIS 安装包
# Aurora Center 服务器（docs/12）：开发态直接 node 跑
# node packages/center/bin/aurora-center.js start --port 8787 --data <目录>
# （数据目录默认 ~/.aurora-center；CLI 子命令 init/users/token/status/update）
```

- **跑单个 / 单包测试**：`pnpm vitest run <文件路径>`（如 `pnpm vitest run packages/agent-core/src/session/store.test.ts`；
  按目录过滤就写目录，如 `pnpm vitest run packages/agent-core/src`）。
  ⚠️ **别用 `pnpm --filter @aurora/<pkg> test`**：根 `vitest.config.ts` 的 `include` 是**根相对**路径，
  在包目录下执行会一个用例都匹配不到，直接以 `No test files found` 退出码 1 失败。
- **端到端自测（真实 Electron + IPC，离线可跑）**：`$env:AURORA_SMOKE='1'; pnpm dev`，
  结束后看 `%TEMP%\aurora-smoke-logs` 里的 `AURORA_SMOKE_RESULT`（调试渲染层加 `AURORA_DEVTOOLS=1`）。
  **全量约 40 秒、239 条断言应当全绿（2026-10-24 实测 `SUMMARY 239/239 passed`；
  v34 删掉「预算触顶落 paused」断言后由 204 → 203，此后多子代理 +3、内置浏览器 +8、
  v36 插件系统 +24、小组件与推送 +4 条断言）**——
  **先把基线修绿再动被测代码**。
  聚焦用 `$env:AURORA_SMOKE_ONLY='2.3'`；跨进程续跑用 `AURORA_SMOKE_PHASE='resume'` + `AURORA_SMOKE_WORKSPACE=<同一目录>`。
  **提交前仍必须跑全量**。
- **Center 网页端验收（视觉 + 行为）**：`pnpm --filter @aurora/center build && pnpm --filter @aurora/center verify:web`
  —— 真实服务器子进程（临时数据目录）+ 协议忠实的桩客户端 + 系统 Edge，逐场景截图 / 读 DOM 并写 `report.json`
  （口径同 `capture.ts`：任一条 `ok: false` → 退出码 2），当前基线 **102/102**（51 场景 × 暗/浅两档）。
  整轮开跑前会用假上游 + 临时 `AURORA_CENTER_SECRET` 灌 20 条真实用量明细当夹具（见 docs/12 §10）。
  开关：`AURORA_CWEB_ONLY`（子串过滤 / 特殊值 `failed`）、`AURORA_CWEB_THEME=dark|light`、
  `AURORA_CWEB_VIEWPORT=mobile`、`AURORA_CWEB_OUT`、`AURORA_CWEB_KEEP=1`（保留子服务器与数据目录排障）、
  `AURORA_CWEB_BROWSER`（找不到浏览器时明确 SKIP、退出码 0）。
  **改网页端 UI 别每次全量跑**：`pnpm --filter @aurora/center dev:web`（`/api` 与它的 WS 一起代理到本地 Center，
  `AURORA_CENTER_URL` 改目标）秒级迭代；生产托管方式不变（服务器吐 `dist-web`）。
- **窗口截图核对（前端视觉验收）**：`$env:AURORA_CAPTURE="$env:TEMP\aurora-capture"; pnpm dev`
  —— 四个窗口、提示条两态、设置页各页、主界面三栏与各条 DOM 探针场景截成一批 PNG 并写 `report.json`
  （有 FAIL 时退出码 2）。只截部分窗口 `$env:AURORA_CAPTURE_WINDOWS='edge-bar,chat'`；
  再细一级 `$env:AURORA_CAPTURE_ONLY='<PNG 名子串>'`（逗号分隔，特殊值 `failed` = 只重跑上次没过的）。
  **张数与构成以 `report.json` 为准；「截了没有」只看日志 count 与报告，退出码 0 不等于截到了**；
  ⚠️ 筛选跑会产生假 FAIL（看到 FAIL 先问"是不是筛选跑的"，再用全量确认）。userData 自动隔离。规则见 docs/07 §5.3。
  当前基线（2026-10-24 实测）：**全量 105 条 checks**（四窗 93 + onboarding 6 + memory/awareness-glow 3 +
  小组件 / 推送 3）。四窗 93 含 v36 插件场景 `chat-plugin-panel` / `chat-plugin-page` /
  `settings-plugins-installed` / `settings-plugins-marketplace` 与设置页 `settings-plugins`。
  桌面 widget 窗口不在 `WindowName` 里，走 `captureWindows` 的 `widgetWindow` 现取。
  唯一恒红项是范围外的 `chat-model-picker.png`；
  **2026-10-18 补充**：本机全量单轮会在 `onboarding-done` 卡住（onboarding 窗口被完成流程隐藏后
  `capturePage()` 不返回；与 `CHAT_COLLAPSE_CHECK` 注释同款 Windows 坑）。验收改用三轮覆盖全量 105 条：
  `AURORA_CAPTURE_WINDOWS='edge-bar,chat,settings,automation,widget'`（96 checks，仅 `chat-model-picker` 红）
  + `AURORA_CAPTURE_ONLY='onboarding'`（6 checks 全绿）+ `AURORA_CAPTURE_WINDOWS='memory,awareness-glow'`
  （3 checks 全绿）；这是 capture 环境问题，不是子代理改动的回归。
  失败判定 = `ok === false` **或**（`checked === true` 且 `result == null`）**或** `result.pass === false`
  （只按 `pass === false` 会把纯截图场景误判成失败）。`AURORA_CAPTURE_ONLY` 是**子串**匹配
  （`'chat.png'` 连带命中 `theme-chat.png`），且**每轮必须写独立目录**（同目录会覆盖上一轮 `report.json`）。
  **跑法预算（2026-10-10 用户口径）**：迭代期**只跑定向**（`AURORA_CAPTURE_ONLY`，7–15s/轮），
  **全量截图只在最后验收阶段跑**（代码冻结后一次性跑满足口径的轮次，1 轮约 2.5 分钟）；
  同理 `pnpm test` 迭代期只跑相关子集、全量放最后。验收口径本身不降级。
- **CI 按需触发，不跟随 push / PR**（`.github/workflows/ci.yml`，Windows）：顺序
  `format:check → lint → typecheck → test → build`。日常验证靠本地
  `pnpm typecheck && pnpm test && pnpm build`（与 CI 同一套检查、全量约 15 秒）；
  需要干净环境时手动发起（Actions → Run workflow，或 `gh workflow run ci.yml`）。策略原因见 docs/09 §2。

## 架构硬约束（改错会直接构建失败或线上炸）

1. **`agent-core` 与 `modes` 不得依赖 Electron / DOM**——保持纯 Node，可独立单测，也为将来换壳层留后路。
2. **preload 必须自包含**：它跑在 `sandbox: true` 的渲染进程里，无 Node 能力、无法解析 pnpm 工作区包，只能 `require('electron')` + 字面量通道表。改 IPC 契约时**同时**改 `packages/shared/src/ipc/channels.ts` 与 `apps/desktop/src/preload/channels.ts`（两者有编译期双向断言，漏改 `pnpm typecheck` 会报错）。
3. **主进程必须内联工作区包**：`@aurora/*` 是纯 ESM，主进程产物是 CJS，`require()` ESM 会抛 `ERR_REQUIRE_ESM`。因此 `electron.vite.config.ts` 把它们排除在 `externalizeDepsPlugin` 之外——不要「顺手」加回去。
4. **渲染层只允许类型导入**：从 `@aurora/shared` 取**纯常量 / 运行时值**必须走 `@aurora/shared/browser` 子路径，否则会把 `node:fs` 拉进浏览器 bundle 导致构建失败；`packages/shared/src/browser.ts` 的依赖链禁止出现任何 Node 内置模块。
   **渲染器与视觉资产是桌面 + Center Web 的单源**（Markdown 渲染器、`theme.css` 令牌、图标清单、吸底状态机都在
   `packages/shared/src/browser/`，依赖也只声明在 `packages/shared`）：**改这些 = 同时改两端界面**，改完两端截图都要跑；
   齿轮图标在 shared 里叫 **`SettingsGear`**（lucide 的 `Settings` 与配置类型同名）。
   详见 [Memory/2026-10-03-shared-renderer-single-source.md](Memory/2026-10-03-shared-renderer-single-source.md)。
5. **重任务走子进程**：文档内容提取等 CPU/IO 重活由 `utilityProcess.fork` 启动 `extract-worker`（`electron.vite.config.ts` 的第二个 main 入口），不阻塞主进程事件循环。
6. **IPC 命名**：通道用 `namespace:action`（如 `chat:send`、`mcp:status`）；事件推送 `on/off` 成对暴露；大 payload（文件全文）只在主进程 / worker 内流转，不进渲染进程。

## 编码与安全约定

- TypeScript strict，开启 `verbatimModuleSyntax`、`noUncheckedIndexedAccess`、`noImplicitOverride`。ESLint 强制 `consistent-type-imports`（用 `import type` / 内联 `type`），未用变量需 `_` 前缀。
- Prettier：**无分号**、单引号、`printWidth: 100`、尾逗号 all、LF（见 `.prettierrc.json` / `.editorconfig`）。
- **日志**：业务包只依赖 `@aurora/shared` 的 `Logger` 接口；落盘实现在 `apps/desktop/src/main/logger.ts`（`userData/logs/`，按天轮转保留 7 天），所有输出统一脱敏。不要 `console.log` 当正式日志。
- **凭据绝不落明文**：API Key / MCP env 经 Electron `safeStorage` 加密写入 `%APPDATA%/Aurora/config.json`；`settings:get` 与 `settings:changed` 两条通道都只回传 `apiKeySet` / `envSet` 标记。日志与「导出脱敏配置」中凭据一律 `***`。
- **Markdown 渲染安全基线**：输出必须先转义再套白名单标记（渲染器 `html:false`），
  **绝不允许裸 `v-html` 模型原文**；链接 scheme 走 markdown-it `validateLink`（`javascript:` 拒绝）；
  外链一律 `target=_blank` + `rel="noopener noreferrer nofollow"`；图片降级为链接（生产 CSP `img-src 'self' data:` 会拦远程图）。
- **文件 / 命令安全**：MCP 服务器以用户显式配置的 argv 数组启动、**绝不经过 shell**；Skill 的 `scripts/` 永不自动执行；敏感工具用 `sensitivity: 'confirm'` 标记，需确认后才执行（确认链路抛错按拒绝处理）。
- **配置改动**（当前 `CONFIG_VERSION = 35`）：Schema 在 `packages/shared/src/config/schema.ts`，改字段必须走版本迁移链（`migrations.ts`）并同步更新 `docs/08 §1`；`pnpm verify` 会断言 `version === CONFIG_VERSION` 与 `v0 → 当前版本` 的迁移条数，版本推进后必须复跑。
- **界面文案口径**（用户连续两轮点名「冗杂」）：区组说明段 **≤45 汉字**、字段 hint **≤40 汉字**，各只写 1 句；
  **不写 `docs/xx §n` 这类文档引用**；删的是冗余，**边界 / 后果 / 修复路径必须保留**；
  改文案后要同步核对断言了原文串的探针场景（`chat-composer-slash` 等）。
- **提交信息**用 Conventional Commits、描述用中文（`feat(v0.5.0): ...` / `fix: ...` / `docs: ...`）。
- **发布 tag（仅约束桌面安装包）**：每次打包安装包前必须相对上一版本 tag 汇总全部更新点，写入
  `docs/release-notes/vX.Y.Z.md`，并把它作为 annotated tag 的完整 message；禁止只写
  `Aurora vX.Y.Z`。（发布脚本会硬检查 `--notes-file` 与上一版本对比）
  **Aurora Center 自身的更新不创建 tag。**
- **发布双投（仅约束桌面安装包）**：每次上传桌面安装包时必须同时上传 GitHub Releases 与 Aurora Center
  更新源，三者 `installer / blockmap / latest.yml` 版本一致；只上传 GitHub 不算发布完成。
  **Aurora Center 自身的更新不适用双投：不上传 GitHub Releases、不创建 tag。**
- **Center 版本线独立**：Aurora Center 更新只升 `packages/center/package.json`
  （**不必与客户端版本号相同**，不动 root / apps/desktop），按
  `packages/center/deploy/README.md` §0 重新打包换装；不走 `scripts/release.mjs`。

## 文档先行（Docs-first）

`docs/` 是**单一事实来源**：改配置 Schema、IPC 契约、窗口交互前**先改文档再改代码**。按主题查阅：

- 配置 / 引导 / 凭据 → `docs/08-settings-onboarding.md`
- Agent 内核（LLM / 会话 / 循环 / Skill / MCP / 感知 / 主动引导）→ `docs/06-agent-core.md`
- 模式系统与文件分类管线 → `docs/05-mode-system.md`
- 窗口体系与 UI 规格 → `docs/07-ui-spec.md`（视觉设计另见 `ui-ux-pro-max` / `frontend-design` skill）
- 进程 / 模块 / IPC 约定 → `docs/02-architecture.md`
- 打包发布与自动更新拓扑 → `docs/09-packaging-release.md`

## 改代码前必看的硬规则与接线点（每条一行，现象 / 根因见 `Memory/`）

- **出网**一律走 `main/net.ts` 的 `netFetch`（否则 `advanced.proxy` 对该调用无效）；内核只接受注入，不 import electron。
- **跨 IPC 不传 Vue `reactive` / Proxy**：渲染层往主进程送对象前统一 `deepClone()`（`@aurora/shared/browser`）。
- **写前快照顺序不能换**：`resolveWithin` → `capture`（存**原内容**）→ 写盘；主写失败不回滚快照。
- **三处 `ensureLoaded`（会话 / 待办 / job）必须用 in-flight promise**；job 落盘前必须先 `ensureLoaded`。
- **续跑（`appendUserMessage = false`）前必须重读会话重算 `history` / `systemPrompt`**：该标志的语义前提是"提问已在 history 里"，不重算模型就会重复已执行的写 / 命令（v34 已删「自动续轮」与 attempt 循环，这条不变，回归护栏在 `agentHost.test.ts`）。
- **上限类配置以 getter 注入内核**（`agent.loop.*` 等），写成构造时常量就是"改设置要重启"的死字段。
- **`edit_file` 的「改前必须先读」守卫不许挪进 `sync()`**（会话级单例，建在 `registerComputerTools` 闭包里）。
- **新增密文路径要同步 5 处**：`SettingsStore` 的 `canonicalSecretPath` / `readSecretField` / `writeSecretField` / `toPersisted` + 主进程 `redactSettings`；派生字段名另补 `SENSITIVE_KEY_PATTERN`。
- **新增安全敏感设置分组必须显式进 `SETTINGS_READONLY_PREFIXES`**（覆盖表**不是**白名单）；`set_setting` 判定顺序 = 覆盖表放行 → 黑名单拒绝 → Schema 叶子默认可写。
- **项目根边界分两层**（弹卡用字符串判定；能不能碰由 realpath 前缀校验），`workspaceDir` **不是**安全边界；解析只走 `main/tools/session-project.ts` 的**会话级唯一口径**，别在执行链上再写一套。
- **样式**：给子组件写样式要么独占类名要么 `:deep()`，别指望 scoped 隔掉同名类；`.clamp-2` 不挂 `<td>`（挂内层元素）。
- **`.vue` 模板不写多语句内联处理器**；`prettier --write` 之后**必须重跑一次构建**再进截图。
- **改了 `packages/shared/src/**` 或 `packages/agent-core/src/**`**：先 build 该包再跑下游 typecheck；进端到端（dev / smoke / capture）前也要 build（它消费的是 `dist`）。
- **`task` 子代理并行**：`task` 声明 `parallel`，同轮多个 `task` 走 `SUBAGENT_MAX_PARALLEL = 3` / 会话的内核限流，写入类子代理**整段串行**（同会话写锁）。别只改 `parallel` 不加锁：会交错读改写同一文件、并让渲染层单槽位确认卡互相覆盖。上限是内核常量（与 512 同属防失控），不要加配置项。
- **`permission: 'write'` 只是请求**：实际授予看子表里是否真的进了 `write_file` / `edit_file`；快照 `permission` 与 UI 徽章必须按实际结果落（只读档父表根本没有写工具，不许显示「可读写」）。`subagentToolNames` 是内核预留钩子，**生产装配当前未注入**，别把它当已生效的额外闸门。
- **改 `packages/shared/src/browser/**`（渲染器 / 令牌 / 图标）= 同时改桌面与 Center Web**：两端截图都要跑。
- **CSP**：`main/index.ts` 的两条都要有 `media-src 'self' blob:`；`onHeadersReceived` 的注入**只作用自家窗口的页面**（按 `webContentsId` 判定）。
- **探针字符串**（`apps/desktop/src/main/capture.ts`）不写反引号（注释用「」），能不用带反斜杠的正则就别用；**判据只写一份**、**量矩形不量存在**。
- **测试**：冒烟基线不绿先修基线；口径变了必须同改夹具（否则以"恒红"持续收税）；全量 capture（3–5 分钟）不是排查探针。
- **跑 Electron 前先清 `ELECTRON_RUN_AS_NODE`**；无 TTY 时用 `pnpm --config.verify-deps-before-run=false exec …` 绕过（别写进 `package.json`）。
- **内置浏览器工具组**受 `agent.browser.enabled` 门控、**不受** `agent.tools.enabled`；`maxSessions` / `idleMinutes` 必须用 getter 现读，写成构造常量就是"改设置要重启"的死字段。
- **webview guest 必须由渲染层上报 `webContentsId`**，主进程校验 `hostWebContents` 归属（chat 窗口）后才接管；不要按 URL / 标题猜 guest。
- **`agent.browser` 整组在 `SETTINGS_READONLY_PREFIXES`**，AI 不得改；关闭能力（或切只读档）时必须结束全部 Agent 浏览器会话，别留下 Agent 徽章。
- **插件贡献必须写在 `manifest.json`**（工具 / Skill / 命令 / 自动化 / 面板 / 主题 / 配置），
  运行期不得动态注册；工具最终名必须 `plugin.<id>.<name>`（≤ 64），默认 `confirm`，
  只有用户「信任此插件」后清单里的 `safe` 才生效；只读档只注册 `readonly:true` 的插件工具。
- **`plugins` 设置组 AI 只读**：留在 `SETTINGS_READONLY_PREFIXES`，**不要**加进
  `tools/settings-port.ts` 的 `TOP_LEVEL_GROUPS`；插件配置不支持密文字段。
- **插件页面只能走 `aurora-plugin://` + `src/preload/plugin-page.ts`**：协议处理器必须
  逐 session 注册（插件用独立非持久 partition `plugin-<id>`，默认 session 的 `protocol.handle`
  不覆盖它）；`will-attach-webview` 只拦截该协议并强制 sandbox / contextIsolation /
  `nodeIntegration:false`，拒绝调用方自带 preload / partition；页面不得暴露 `window.aurora`。
- **桌面小组件窗口只在 `main/plugins/widgets.ts` 创建**（唯一 import electron 的 widget 模块）：
  无边框 / 透明 / 置顶 / 不占任务栏；位置、尺寸、显隐写 `<userData>/plugin-widget-layout.json`，
  **不进 settings、不升 `CONFIG_VERSION`**；桌面窗口总数上限 8（防失控常量）。
- **提示条小组件只接受声明式 schema**：`slot = "edge-bar"` 清单层就拒绝 `entry` / `defaultSize`；
  不要为了它改提示条窗口的 shape / 尺寸逻辑，也不要嵌 webview。
- **插件推送（`ui.panelEvent`）必须在主进程校验**：panelId / widgetId 二选一、目标在本插件清单、
  面板目标要 `ui.panels`、小组件目标要 `ui.widgets`、payload ≤ 64 KB、每插件每秒 ≤ 20 条（超出丢弃记 warn）；
  路由只投给发起插件自己的面板 / 小组件（桌面窗口走 `plugins:widgetEvent`，右栏面板走 `plugins:panelEvent`）。
- **页面型小组件的 guest 归属带 `widgetId`**：`plugins:pageRpc` 必须同时校验 guest 登记的小组件 id，
  且目标确实是该插件的页面型 widget；不要只按 pluginId 放行。
- **插件事件自动化有防自激守卫**：同一 `(pluginId, event)` 在自动化执行期间的重入会被忽略；
  不要移除 `AutomationEngine.pluginEventsInFlight`（否则动作里再 emit 会无限递归）。
- **插件进程不是 OS 沙箱**：文档 / 安装弹窗必须如实写「安装即信任」；不要宣称隔离。
- `agent-core` / `modes` 仍不得 import electron；插件相关的 Electron 代码只在
  `apps/desktop/src/main` 与 `main/plugins/`。

## 尚未生效 / 已知限制（别误当成 bug）

完整清单与原因见 [Memory/2026-10-03-known-limits.md](Memory/2026-10-03-known-limits.md)，速查：

- `Alt+Space` 注册失败是**预期路径**（Windows 系统占用），`hotkey.ts` 会回传原因，**不要"修"成静默成功**。
- 提示条可穿透性（`setIgnoreMouseEvents`）未接入；`general.language` 是死字段（Schema 保留仅为兼容旧配置）。
- **service-dock（v4）/ mini-chat（v6）已移除**；「关闭」= 隐藏窗口（流式回复不中止），别按旧窗口心智模型理解。
- 未配置 STT provider 时麦克风按钮**根本不渲染**（不是 disabled）；TTS「朗读」同款口径。
- **门控口径两组相反**：扩展工具六件套（`web_fetch` / `notify_user` / `clipboard_*` / `generate_image` / `show_preview`）**不受** `agent.tools.enabled`；
  电脑操控工具（含 `edit_file` / Office / `grep` / `glob`）**受**总开关与子开关门控；`todo_*` / `task` 不受门控。
- **Agent 内置浏览器不接管 `target="_blank"` 弹窗**：页面自己开的窗口仍按普通用户标签打开，Agent 不操作它；需要继续就对该 URL 重新 `browser_open`。
- 办公文件（docx / xlsx / pptx）已有 `office_read/help/create/edit/render/pdf/raw_edit` 专用工具：
  走 utilityProcess 中固定版 OfficeCLI；普通编辑禁止 raw/COM，默认另存、显式覆盖才写回并先做二进制快照。
- Markdown 渲染 P3（目录 / 折叠 / 脚注 / 引用 chip）唯一副本在 `git stash@{0}` —— **清 stash 前先落地或转分支**。
