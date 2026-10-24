# 03 · 技术选型与决策记录（ADR）

状态：`已定稿`（v1 基线）

原则：**优先 TypeScript 生态、优先成熟度、保证可测试性、避免供应商锁定。**

## 1. 选型总览

| 领域 | 选型 | 说明 |
|---|---|---|
| 桌面壳 | **Electron**（^44.5.1） | 托盘 / 多窗口 / 置顶 / 贴边成熟；Chromium 152 / Node 24 |
| 前端框架 | **Vue 3**（Composition API + `<script setup>`，^3.5） | 多窗口共享逻辑友好 |
| 构建 | **electron-vite + Vite** | 多 HTML 窗口入口、HMR |
| 状态管理 | **Pinia**（^2） | 渲染层轻量状态 |
| 语言 | **TypeScript**（strict，^5） | 全栈统一 |
| 包管理 / 工程 | **pnpm workspace**（monorepo，^9） | 见 ADR-009 |
| 测试 | **vitest** | agent-core / modes / shared 单测 |
| LLM 接入 | **OpenAI 兼容协议抽象**（自研轻量 client） | 见 ADR-003 |
| MCP | **自研最小 JSON-RPC 客户端** | 见 ADR-004 |
| 文件监听 | **chokidar**（^3） | 见 ADR-006 |
| 系统感知 | **systeminformation + PowerShell 封装**（前台窗口） | 见 ADR-007 |
| 配置存储 | **自研 JSON store**（schema 版本迁移） | 见 ADR-008 |
| 打包发布 | **electron-builder**（NSIS 安装器） | 签名 / 自动更新后期接入 |

## 2. 决策记录

### ADR-001 桌面壳选型：Electron（否决 Tauri 2 / WPF）

- **背景**：需要托盘、多窗口、置顶、屏幕贴边、文件监听、系统状态采集，且 AI 生态（MCP / Skill / LLM SDK）是核心。
- **决策**：Electron + TypeScript。
- **理由**：
  1. AI 生态事实标准在 TS/Node：MCP 官方 SDK、OpenAI 兼容 SDK、Skill 生态均为 Node-first；
  2. 主进程、Agent 内核、渲染层同一语言，类型与工具函数可共享，心智负担最低；
  3. 托盘 / 多窗口 / 置顶 API 成熟，社区资料丰富，迭代速度快。
- **代价与缓解**：包体与内存偏大 → 重任务走 `utilityProcess`、窗口按需创建；agent-core 不依赖 Electron，未来如需迁移 Tauri 2，成本可控。
- **备选**：Tauri 2（更轻量，但 Rust 侧需重建 MCP / 感知生态）；WPF / WinUI 3（系统集成最佳，但 AI 生态最弱、迭代最慢）。

### ADR-002 渲染层：Vue 3 + electron-vite

- Composition API 便于多窗口间共享组合逻辑；Vite HMR 迭代快；社区方案成熟。
- 备选 React 同样可行；团队无历史包袱，选择模板更轻、约定更统一的 Vue 3。

### ADR-003 LLM 接入：OpenAI 兼容协议抽象

- 定义 `LlmProvider` 接口（流式 chat / 模型列表 / 连接测试），默认实现 `OpenAiCompatProvider`，通过 `baseURL + apiKey + model` 即可接入 DeepSeek、OpenAI、Ollama（本地）、vLLM 等。
- 设置中可保存**多组模型配置**并切换默认；不绑定任何商业 SDK，避免锁定。

### ADR-004 MCP：自研最小 JSON-RPC 客户端（零新增依赖）

- 主进程内运行 MCP Client，支持 `stdio` 与 `streamable-http` 两种传输。
- **实现说明（v0.3.0 起）**：未引入 `@modelcontextprotocol/sdk`，而是自研最小 JSON-RPC 2.0
  客户端（`packages/agent-core/src/mcp`），只覆盖 v1 需要的协议子集：
  `initialize` → `notifications/initialized` → `tools/list` → `tools/call`。
  理由：协议子集很小，自研可避免 SDK 快速演进带来的升级成本，且能直接在 Node 里单测
  （stdio 用 `Content-Length` 分帧、http 复用 `llm/sse.ts` 的分帧解析）。
- 服务器工具自动注册进 Agent 工具表（命名 `mcp.<server>.<tool>`）；与 Skill 冲突时 MCP 优先并记日志。
- 服务器列表与凭据存本机配置，敏感 env 与 HTTP 自定义请求头（`headersEnc`，v9 起）用 safeStorage 加密。

### ADR-005 Skill：SKILL.md 约定

- 采用类 Claude Code 的 `SKILL.md`（YAML frontmatter + 说明正文 + 可选 `scripts/`），零学习成本、外部技能生态可复用。
- 注册表扫描内置 `skills/` 与用户技能目录；按对话意图自动匹配 + 显式 `@skill` / `/skill` 调用。

### ADR-006 文件监听：chokidar

- 处理 Windows 下“文件仍在写入 / 复制”场景：`awaitWriteFinish` + 连续两次 stat 尺寸不变才判定稳定。
- 备选：原生 `ReadDirectoryChangesW`（复杂，性能需要时再替换，接口不变）。

### ADR-007 系统感知：分层采集

- v1 以现成库为主、PowerShell 兜底，统一封装为 `PerceptionProvider` 接口：
  - 时间 / 星期 / 日期：进程内定时器（分钟级）；
  - 电量 / 电源、网络、CPU / 内存：**systeminformation**（内部走 WMI / Win32，无需自写命令解析）；
  - 前台窗口 / 应用：**PowerShell 内联探针**（`GetForegroundWindow` + `GetWindowTextW` + 进程名），
    5s 轮询。**实现说明（v0.5.0）**：原本规划的 `active-win` 未引入——它是原生预编译模块，
    需要额外的构建放行与打包处理，且存在杀软误报风险（见 §3 依赖风险清单）；
    PowerShell 探针零依赖、可离线自测，接口不变，后续若性能不足可平滑替换。
  - 显示器 / 屏幕状态：Electron `screen` API（由主进程注入采集器），变化触发；
  - 课程表（ClassRoom）：`IScheduleProvider`（manual / ClassIsland 桥接），事件驱动。
    **实现说明（v0.6.0）**：ClassIsland 是 .NET 应用，跨进程能力走命名管道、无 HTTP API，
    Node 侧无法直接消费；因此改为读「桥接插件写出的本地 JSON / 回环端点」（见 05 §3.4），
    Aurora 只认一份四字段契约，桥接由随仓库附带的 C# 插件提供。
- 采集器注册制 + 独立调度；任一采集项失败一律降级为 `unknown`，**绝不抛错**。
- 后续高频 / 低开销需求可引入 Rust N-API 原生模块替换实现，接口不变。

### ADR-008 配置存储：自研 JSON store

- 路径：Electron `userData`（`%APPDATA%/Aurora/`）；带 `version` 字段与链式迁移函数；原子写 + 写防抖；API key / MCP env 存 safeStorage 加密值。
- 不引入 electron-store 等额外依赖，schema 与迁移逻辑集中在 `packages/shared` 可单测。

### ADR-009 工程组织：pnpm workspace monorepo

- `apps/desktop` + `packages/{agent-core, modes, shared}`；agent-core / modes 为纯 Node 包（vitest 单测）。
- CI：GitHub Actions（Windows，`lint / typecheck / test / build`），**按需手动触发**、不跟随 push / PR（见 09 §2）。

### ADR-010 插件运行时：独立 `utilityProcess` + 白名单 RPC（v36）

- **决策**：一个启用插件一个 `utilityProcess`（上限 8），结构化克隆消息 + 关联 id + 超时 / 取消 /
  帧上限；贡献在 `manifest.json` 声明，运行期不动态注册。
- **理由**：崩溃 / 死循环 / OOM 隔离；主进程不必等进程 ready 就能注册工具表；清单可被安装器、
  Center 市场与校验脚本共用。
- **代价**：内存随插件数增长（上限 8 + lazy 启动）；跨进程调用有序列化成本。

### ADR-011 插件权限是 API 门控，不是 OS 沙箱（v36）

- **决策**：权限按宿主 API 逐条校验；插件进程仍有当前用户权限，**安装 = 信任**。
- **理由**：OS 沙箱（AppContainer / 受限令牌）在 Windows 上工程量大、兼容性风险高；
  v1 先解决"扩展能力 + 可展示的权限 + 崩溃隔离"，并在安装 UI / 文档中如实披露边界。
- **代价**：恶意插件可绕过 API 直接读文件 / 外发数据；签名与发布者认证留待后续。

### ADR-012 插件界面：声明式优先 + 沙箱 webview（v36）

- **决策**：常规面板用受控组件 schema（无 HTML / v-html）；需要任意 HTML 时用
  `aurora-plugin://` + 专用 preload + 独立非持久 partition 的 webview，并施加严格 CSP。
- **理由**：声明式没有脚本注入面、观感统一；webview 给复杂界面留出口，同时不暴露 `window.aurora`
  与 Node。
- **代价**：两套面板 API；webview 的协议处理器必须逐 session 注册（自定义 partition），
  页面拿不到宿主令牌（需自行配色）。

## 3. 依赖风险清单

| 依赖 | 风险 | 缓解 |
|---|---|---|
| officeparser（v7.8.0，锁主版本） | 体积较大（含 pdfjs-dist / tesseract.js / `@napi-rs/canvas` 预编译二进制），原文抽取质量受文件影响，可能被杀软误报 | 只在 `utilityProcess` 内 `import()` 懒加载（用户不放文档就不付成本）；提取失败一律降级为「文件名证据」，分类管线不受影响；OCR 默认不启用（其 postinstall 仅赞助请求，已在 `pnpm-workspace.yaml` 显式放行 false 避免联网）；当前 Electron 44 内置 Node 24.18.1 已满足 v8 的 engines 要求，但 v8 仍待在真实文档夹具上单独验证，验证前保持 v7.8.0 |
| tesseract.js（officeparser 传递依赖） | 体积与安装期联网 | `allowBuilds: false` 拒绝其 postinstall；本轮不启用 OCR |
| systeminformation | 命令开销 | 感知项独立调度，低频轮询 + 事件触发 |
| @modelcontextprotocol/sdk | 演进较快 | **v1 未引入**：MCP 客户端为自研最小 JSON-RPC 实现（见 06 §7），零依赖、可单测 |
| Electron | 大版本升级成本 | 锁定主版本；升级随 P6 打磨期统一评估 |
