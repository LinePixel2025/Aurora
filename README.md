# Aurora

将 Windows 接入 AI 生态的**系统级 Agent 工具**：常驻系统托盘，以「AI 服务窗 + 右侧提示条」的轻量形态提供无感、自主的 AI 服务。

> 当前版本：**v0.3.0**（P0 脚手架 + P1 基础壳与设置 + P2 四种窗口外壳 + P3 Agent 内核）
> 需求源头见 [`Aurora.md`](./Aurora.md)，设计与验收标准见 [`docs/`](./docs/README.md)（单一事实来源）。

## 快速开始

```bash
pnpm install          # 首次会下载 Electron 运行时（约 100MB）
pnpm dev              # 启动 Electron：托盘 + 首次引导窗口
```

首次启动流程：欢迎 → **AI 模型配置（必填）** → 模式选择 → ClassRoom 设置 → 完成。
完成后 Aurora 常驻托盘并显示 AI 服务窗；配置写入 `%APPDATA%/Aurora/config.json`，API Key 使用系统安全存储加密。

> 若 `pnpm install` 时 Electron 二进制下载失败（企业代理 / 证书拦截），
> 可在 `apps/desktop/node_modules/electron` 下执行
> `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; node install.js`。

## 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 启动 Electron（主进程 / preload / 渲染层 HMR） |
| `pnpm build` | 构建三个包 + Electron 产物（`apps/desktop/out`） |
| `pnpm typecheck` | 全仓类型检查（含 `vue-tsc`） |
| `pnpm test` | vitest 单测（shared / agent-core / modes），256 项 |
| `pnpm verify` | 真实磁盘的配置层验收脚本（需先 `pnpm build`），26 项断言 |
| `pnpm lint` / `pnpm format` | ESLint / Prettier |
| `node scripts/generate-icons.mjs` | 重新生成占位图标（托盘 / 应用图标） |

### 端到端自测（真实 Electron + preload + IPC）

```powershell
$env:AURORA_SMOKE='1'; pnpm dev   # 启动后自动跑 52 项链路断言，结果见日志并自动退出
Get-Content "$env:TEMP\aurora-smoke-logs\aurora-*.log" | Select-String 'AURORA_SMOKE_RESULT'
```

自测使用**临时 userData 目录**（不污染 `%APPDATA%/Aurora`，退出时删除）与**本地假 LLM 桩服务**
（`src/main/smoke-llm.ts`，返回一次 `use_skill` 工具调用 + 最终答案），因此**离线可跑**，
且"桩服务收到 3 轮 chat 请求、其中一轮带回 tool 结果"即可证明工具调用循环真实执行。
日志固定写到 `%TEMP%\aurora-smoke-logs`（临时 userData 会随自测一起删除）。

覆盖：`window.aurora` 暴露面、配置读写、凭据加密落盘（磁盘无明文）、模式切换与四步引导、
窗口状态机（迷你窗/交互窗互斥、隐藏服务窗连带隐藏）、**真实对话流式 + 工具卡片 + 会话历史水合**、
MCP 状态接口、设置窗打开。

调试渲染层时可加 `AURORA_DEVTOOLS=1`（dev 模式下自动打开 DevTools；渲染层 console 始终会转发到主进程日志）。

## 目录结构

```
apps/desktop            Electron 壳（main / preload / renderer 六个窗口入口）
packages/shared         配置 Schema、SettingsStore、IPC 契约、模式与窗口类型
packages/agent-core     Agent 内核：LLM Provider、会话、工具循环、Skill 桥接、MCP 客户端
packages/modes          IMode 框架、ClassRoom 完整实现、Work/Code 占位、引导运行器
skills/                 内置 SKILL.md（file-classify / system-status / timetable）
scripts/                图标生成等构建脚本
docs/                   项目文档（SSOT）
```

## 本版本已实现（v0.3.0）

- **P0**：pnpm workspace monorepo、TS strict、ESLint/Prettier、vitest、GitHub Actions（Windows）。
- **P1 基础壳与设置**
  - 托盘常驻 + 菜单（显隐服务窗 / 打开对话 / 切换模式 / 重新引导 / 设置 / 打开配置与日志目录 / 退出）
  - 单实例锁；关闭窗口 = 隐藏，仅托盘可退出；**开机自启**已接入注册表（`app.setLoginItemSettings`）
  - 设置窗口六页：常规 / 模式 / AI 模型 / Skill / MCP / 高级
  - 配置 store：Zod Schema、版本迁移链、原子写 + 防抖、损坏文件备份重建、字段级回退默认值
  - 凭据安全：safeStorage 加密落盘；不可用时仅驻留内存并明确提示；`settings:get` 与
    `settings:changed` **两条路径**都经过脱敏（渲染层只看到 `apiKeySet` / `envSet` 标记）
  - **首次安装引导**：AI 模型（baseURL / API Key / 模型名 + 真实「测试连接」与模型列表）、模式选择、ClassRoom 表单式引导
  - ClassRoom 对话式引导运行器：四步（感知文件夹 → 科目列表 → 每科目标文件夹 → 课前提醒），可中断续接
- **P2 窗口外壳**：AI 服务窗（置顶输入框 + `/`、`@` 前缀浮层 + 状态点）、右侧提示条（悬停展开面板）、
  完整对话窗口（Markdown 渲染、流式输出、**工具执行卡片**、历史水合）、小 AI 交互窗口；迷你窗与交互窗互斥、隐藏服务窗连带隐藏迷你窗、位置跨启动记忆
- **P3 Agent 内核（本版本核心）**
  - `session`：`userData/sessions/*.json` 持久化（原子写 + 300ms 防抖 + 退出前 flush）、
    损坏文件备份重建、字符预算截断且**不拆散「工具调用 + 工具结果」对**
  - `loop`：工具调用循环（上限 8 轮、同轮工具顺序执行、工具失败回填不中断、abort 贯穿到 HTTP 流）
  - `context`：系统提示词 = 人设 + 模式片段 + 感知摘要 + Skill 清单 + 工具清单 + 安全规则
  - `skills/bridge`：`use_skill` 把技能正文注入上下文（**不执行脚本**）；支持 `/skill名`、`@skill名` 显式调用
  - `mcp`：自研最小 JSON-RPC 客户端（**零新增依赖**）+ stdio `Content-Length` 分帧 + streamable-http、
    `McpClientHub` 多连接管理与 `mcp.<server>.<tool>` 工具注册、失败降级为状态灯、`mcp.lazyConnect` 策略
  - `host`：`KernelAgentHost` 装配会话与工具，无模型配置返回 `E_NO_MODEL`、同会话并发返回 `E_BUSY`
  - 渲染层：真实流式回复、工具卡片三态、`chat:history` 水合、事件按 `sessionId` 过滤（修复快速会话串窗）
  - 设置页 MCP 状态灯接入 `mcp:status` / `mcp:statusChanged`；新增「懒连接」开关
- 系统感知（时间 / 电源 / 网络，缺失项降级为 unknown）已注入真实系统提示词

## 尚未实现（后续阶段）

| 阶段 | 内容 |
|---|---|
| P4 (v0.4.0) | 智慧感知文件夹监听（chokidar）+ 内容提取（utilityProcess）+ LLM 分类 + 移动/通知/分类流水 |
| P5 (v0.5.0) | 前台窗口、显示器、课程表感知；课前 5 分钟提醒并打开科目文件夹；敏感工具的用户确认交互 |
| P6 (v1.0.0) | electron-builder NSIS 安装包、品牌图标、日志轮转打磨、用户文档 |
| P7 | Work / Code Mode 功能、ClassIsland 联动、自动更新、多语言 |

> **已知限制（P3）**：MCP HTTP 传输暂不支持自定义鉴权头（凭据仅经 stdio `env` 注入）；
> 敏感工具（`sensitivity: 'confirm'`，MCP 工具一律标记）目前只写日志留痕，
> 逐次确认交互归 P5；Skill 自带 `scripts/` 不会被自动执行。
>
> 设置项中已有值但**尚未真正生效**的：全局快捷键 `Alt+Space`（待注册 `globalShortcut`）、
> 高级页的代理（消费方在 P3 的 LLM 层仍走 Node 默认代理）与勿扰时段（消费方在 P5）。

## 工程约束（改动前请先读）

- **preload 必须自包含**：它跑在 `sandbox: true` 的渲染进程里，没有 Node 能力，也无法解析
  pnpm 工作区包，只能 `require('electron')` + 字面量通道表（`src/preload/channels.ts`
  与 `@aurora/shared` 的 `IPC` 有编译期双向断言，改契约时同步改这里）。
- **主进程内联工作区包**：`@aurora/*` 是纯 ESM，CJS 主进程 `require()` 会抛
  `ERR_REQUIRE_ESM`，因此 `electron.vite.config.ts` 把它们排除在 `externalizeDepsPlugin` 之外。
- **渲染层只允许类型导入**：从 `@aurora/shared` 取纯常量请走 `@aurora/shared/browser`
  子路径，否则会把 `node:fs` 拉进浏览器 bundle（构建会直接失败）。
- 文档是 SSOT：改配置 Schema 或交互前先更新 `docs/`（见 [docs/README.md](docs/README.md)）。

## 安全说明

- API Key / MCP 环境变量使用 Electron `safeStorage` 加密后写入 `%APPDATA%/Aurora/config.json`；
  明文密钥永不落盘（安全存储不可用时只驻留内存）。
- 日志（`%APPDATA%/Aurora/logs/`，保留 7 天）与「导出脱敏配置」中的凭据一律替换为 `***`。
- 渲染进程启用 `contextIsolation` + `sandbox`，只能通过 preload 白名单调用主进程能力；
  `settings:get` 与 `settings:changed` 两条通道都只回传 `apiKeySet` / `envSet` 标记，不含密文。
- 会话记录（`%APPDATA%/Aurora/sessions/*.json`）包含对话原文与工具调用摘要，
  供重启后恢复历史；不会上传到任何第三方（除发送给用户自己配置的模型服务外）。
- MCP 服务器以**用户显式配置的命令**启动子进程，参数以 argv 数组传递、绝不经过 shell；
  Agent 不会自行执行任意命令（Skill 自带脚本在 v1 也不自动执行）。

