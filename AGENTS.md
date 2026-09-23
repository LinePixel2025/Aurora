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
                     （快速会话没有独立窗口，并入交互窗侧栏的「快速」栏）
packages/shared/     配置 Schema、SettingsStore、IPC 契约、模式/窗口类型
packages/agent-core/ Agent 内核：LLM / 会话 / 工具循环 / Skill / MCP / Prompt 组装
packages/modes/      IMode 框架、ClassRoom 完整实现、Work/Code 占位
skills/              内置 SKILL.md（file-classify / system-status / timetable）
scripts/             图标生成、验收、发布脚本
docs/                项目文档（SSOT，01–09 分册）
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
```

- **跑单个/单包测试**：`pnpm vitest run <文件路径>`，或 `pnpm --filter @aurora/agent-core test`。
- **端到端自测（真实 Electron + IPC，离线可跑）**：PowerShell 下 `$env:AURORA_SMOKE='1'; pnpm dev`，结束后看 `%TEMP%\aurora-smoke-logs` 里的 `AURORA_SMOKE_RESULT`。调试渲染层加 `AURORA_DEVTOOLS=1`。
- **窗口截图核对（前端视觉验收）**：`$env:AURORA_CAPTURE="$env:TEMP\aurora-capture"; pnpm dev`，会把四个窗口、
  提示条两态、设置页各页与各条 DOM 探针场景（面板 / 收起 / 自动滚底 / 门控 / 拖动 / 思考等级 /
  模型列表与模型选择 / 真实写盘 / 提示条收尾图）截成一批 PNG ——
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
- **配置改动**：Schema 在 `packages/shared/src/config/schema.ts`，改字段必须走版本迁移链（`migrations.ts`）并同步更新 `docs/08 §1`。

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

## 尚未生效 / 已知限制（别误当成 bug）

- 全局快捷键默认 `Alt+Space` **在 Windows 上常被系统占用**（它是系统窗口菜单键）。
  注册失败是预期路径：`main/hotkey.ts` 会把真实原因回传设置页，用户改绑即可 —— 不要"修"成静默成功。
- 提示条的 `可穿透性`（`setIgnoreMouseEvents`）尚未接入；`general.language` 是死字段（无 i18n 消费方），
  **已从设置页与引导页移除**（Schema 里保留字段仅为兼容旧配置，改它不生效）。
- **AI 悬浮窗（service-dock）已于本轮移除**，常驻入口为提示条 + 托盘；配置迁移到 v4
  （`v3 → v4` 删除 `general.windowState['service-dock']`）。提示条的悬停展开面板与点击呼出交互窗见 docs/07 §2.2。
- **独立小窗（mini-chat）已于本轮删除**：交互窗标题栏「收起」= **直接隐藏窗口**（正在进行的流式回复不中止）；
  「快速会话」（`sessionId = quick`）与历史会话列表都搬到交互窗侧栏（「快速 / 会话」双栏），
  提示条面板操作入口由 4 个减为 3 个；配置迁移到 v6（`v5 → v6` 删除 `general.windowState['mini-chat']`）。
- MCP HTTP 传输暂不支持自定义鉴权头（凭据仅经 stdio `env` 注入）。
- Skill 的 `scripts/` 永不自动执行（只注入指令正文）；图片 OCR 未启用（只取文件名与尺寸）。
- Work / Code Mode 为占位实现；多语言、ARM64 / 便携版、macOS / Linux 未开始。
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
