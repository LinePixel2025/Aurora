# 03 · 技术选型与决策记录（ADR）

状态：`已定稿`（v1 基线）

原则：**优先 TypeScript 生态、优先成熟度、保证可测试性、避免供应商锁定。**

## 1. 选型总览

| 领域 | 选型 | 说明 |
|---|---|---|
| 桌面壳 | **Electron**（^31+） | 托盘 / 多窗口 / 置顶 / 贴边成熟 |
| 前端框架 | **Vue 3**（Composition API + `<script setup>`，^3.5） | 多窗口共享逻辑友好 |
| 构建 | **electron-vite + Vite** | 多 HTML 窗口入口、HMR |
| 状态管理 | **Pinia**（^2） | 渲染层轻量状态 |
| 语言 | **TypeScript**（strict，^5） | 全栈统一 |
| 包管理 / 工程 | **pnpm workspace**（monorepo，^9） | 见 ADR-009 |
| 测试 | **vitest** | agent-core / modes / shared 单测 |
| LLM 接入 | **OpenAI 兼容协议抽象**（自研轻量 client） | 见 ADR-003 |
| MCP | **@modelcontextprotocol/sdk** | 见 ADR-004 |
| 文件监听 | **chokidar**（^3） | 见 ADR-006 |
| 系统感知 | **systeminformation + active-win + PowerShell 封装** | 见 ADR-007 |
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

### ADR-004 MCP：@modelcontextprotocol/sdk

- 主进程内运行 MCP Client，支持 `stdio` 与 `streamable-http` 两种传输。
- 服务器工具自动注册进 Agent 工具表（命名 `mcp.<server>.<tool>`）；与 Skill 冲突时 MCP 优先并记日志。
- 服务器列表与凭据存本机配置，敏感 env 用 safeStorage 加密。

### ADR-005 Skill：SKILL.md 约定

- 采用类 Claude Code 的 `SKILL.md`（YAML frontmatter + 说明正文 + 可选 `scripts/`），零学习成本、外部技能生态可复用。
- 注册表扫描内置 `skills/` 与用户技能目录；按对话意图自动匹配 + 显式 `@skill` / `/skill` 调用。

### ADR-006 文件监听：chokidar

- 处理 Windows 下“文件仍在写入 / 复制”场景：`awaitWriteFinish` + 连续两次 stat 尺寸不变才判定稳定。
- 备选：原生 `ReadDirectoryChangesW`（复杂，性能需要时再替换，接口不变）。

### ADR-007 系统感知：分层采集

- v1 以现成库为主、PowerShell 兜底，统一封装为 `PerceptionProvider` 接口：
  - 电量 / 电源、网络、CPU / 内存：**systeminformation**（内部走 WMI / Win32，无需自写命令解析）；
  - 前台窗口：**active-win**（预编译原生）为主，PowerShell 封装为回退；
  - 时间 / 课程表：进程内定时器 + 课程表数据源（见 05 §3.4）。
- 后续高频 / 低开销需求可引入 Rust N-API 原生模块替换实现，接口不变。

### ADR-008 配置存储：自研 JSON store

- 路径：Electron `userData`（`%APPDATA%/Aurora/`）；带 `version` 字段与链式迁移函数；原子写 + 写防抖；API key / MCP env 存 safeStorage 加密值。
- 不引入 electron-store 等额外依赖，schema 与迁移逻辑集中在 `packages/shared` 可单测。

### ADR-009 工程组织：pnpm workspace monorepo

- `apps/desktop` + `packages/{agent-core, modes, shared}`；agent-core / modes 为纯 Node 包（vitest 单测）。
- CI：GitHub Actions（lint / typecheck / test / build 三平台矩阵，Windows 为主）。

## 3. 依赖风险清单

| 依赖 | 风险 | 缓解 |
|---|---|---|
| active-win | 原生预编译、杀软误报 | PowerShell 回退实现；接口隔离 |
| systeminformation | 命令开销 | 感知项独立调度，低频轮询 + 事件触发 |
| @modelcontextprotocol/sdk | 演进较快 | 锁定版本；MCP 层独立模块便于适配 |
| Electron | 大版本升级成本 | 锁定主版本；升级随 P6 打磨期统一评估 |
