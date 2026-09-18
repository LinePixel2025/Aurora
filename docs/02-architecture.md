# 02 · 系统架构

状态：`已定稿`（v1 基线）

## 1. 架构总览

```
┌────────────────────────── Electron 桌面应用（单实例）──────────────────────────┐
│ 主进程 Main Process（TypeScript）                                              │
│  ┌───────────┐ ┌──────────────┐ ┌───────────────┐ ┌────────────────────────┐  │
│  │ Tray      │ │WindowManager │ │SettingsStore  │ │ModeManager             │  │
│  │ 托盘菜单   │ │窗口/置顶/贴边 │ │配置读写/迁移   │ │模式注册/切换/引导       │  │
│  └───────────┘ └──────────────┘ └───────────────┘ └────────────────────────┘  │
│  ┌───────────┐ ┌──────────────┐ ┌───────────────────────────────────────────┐ │
│  │FileWatcher│ │Perception    │ │AgentHost ── 装配 agent-core               │ │
│  │智慧文件夹  │ │系统感知采集   │ │  ├ LlmProviders ├ Session ├ Loop(工具循环)│ │
│  └───────────┘ └──────────────┘ │  ├ Skills ├ McpClientHub ├ Context       │ │
│                                 │  └ Proactive(主动引导)                    │ │
│                                 └───────────────────────────────────────────┘ │
│ Preload：contextBridge 白名单 API（window.aurora.*）                           │
│ Renderer（Vue 3，每窗口一进程）：ServiceDock / EdgeBar / Chat / MiniChat /     │
│          Settings / Onboarding                                                │
└──────────┬────────────────────────┬────────────────────────┬──────────────────┘
           │                        │                        │
     LLM 服务(OpenAI 兼容)     MCP Servers(stdio/http)    系统(文件/电源/网络/前台窗口)
```

## 2. 进程与窗口模型

### 2.1 进程

- **主进程（Main）**：唯一入口。承载托盘、窗口管理、配置、文件监听、系统感知与 Agent 内核装配。v1 中 Agent 内核直接运行于主进程（异步 I/O，不阻塞事件循环）；**重任务**（文档内容提取、批量文件分析）走 `utilityProcess` 子进程隔离，避免卡顿。
- **渲染进程（Renderer）**：每个窗口一个进程（Vue 3）。所有系统能力通过 preload 暴露的 `window.aurora.*` 调用，启用 `contextIsolation` 与 `sandbox`。
- **单实例**：`app.requestSingleInstanceLock()`；二次启动时聚焦已有实例并唤起 AI 服务窗。

### 2.2 窗口清单

| 窗口 | 创建方 | 数量 | 形态与来源 |
|---|---|---|---|
| 托盘 Tray | 主进程 | 1 | 系统托盘图标 + 菜单（显示服务窗 / 打开对话 / 设置 / 切换模式 / 退出） |
| AI 服务窗 | WindowManager | 1 | 无边框、置顶、输入框形态 |
| 提示条 Edge Bar | WindowManager | 每显示器 1（v1 主屏 1） | 屏幕右缘超薄竖条，悬停 / 点击展开 |
| AI 交互窗口 | WindowManager | 1 | 完整对话窗，贴右缘滑出 |
| 小 AI 交互窗口 | WindowManager | 1 | 轻量对话窗，锚定服务窗 |
| 设置窗口 | WindowManager | 1 | 单窗口分栏 |
| 首次引导窗口 | WindowManager | 1 | 向导式 |

约定：业务窗口均 **`skipTaskbar` 隐藏任务栏图标**，统一由托盘管理生命周期；关闭按钮 = 隐藏（仅托盘“退出”真正退出）。

## 3. 模块划分

### 3.1 主进程（`apps/desktop/src/main`）

| 模块 | 职责 |
|---|---|
| `tray` | 托盘图标、菜单、状态徽标 |
| `window-manager` | 窗口创建 / 显隐 / 置顶 / 贴边 / 多显示器位置记忆 |
| `settings-store` | 配置读写、schema 校验、版本迁移、safeStorage 凭据 |
| `mode-manager` | 模式注册表、切换流程、引导状态（见 05） |
| `file-watcher` | 智慧感知文件夹监听、稳定判定、分类队列（见 05 §3） |
| `perception` | 系统感知采集器注册与调度（见 06 §8） |
| `agent-host` | 装配 agent-core 与 modes，向渲染层暴露统一 API |
| `ipc` | IPC 通道注册（契约见 §6） |

### 3.2 Agent 内核（`packages/agent-core`，纯 Node，不依赖 Electron）

| 模块 | 职责 |
|---|---|
| `llm` | LLM Provider 抽象与 OpenAI 兼容实现（见 06 §3） |
| `session` | 会话 / 消息历史 / 持久化 |
| `loop` | 工具调用循环（Agent Loop，见 06 §5） |
| `skills` | Skill 注册表、匹配、执行 |
| `mcp` | MCP 客户端连接管理与工具注册 |
| `context` | 上下文组装（人设 + 模式片段 + 感知摘要 + 工具清单 + 安全规则） |
| `proactive` | 主动引导触发器注册与调度 |

### 3.3 模式包（`packages/modes`）

- `IMode` 接口定义 + `classroom` 完整实现 + `work` / `code` 占位实现（见 05）。

### 3.4 共享包（`packages/shared`）

- IPC 通道常量、DTO 类型、配置 Schema、事件定义（渲染层 / 主进程 / 内核三方共用）。

## 4. 目录结构（monorepo，pnpm workspace）

```
aurora/
├─ docs/                        # 项目文档（本目录）
├─ apps/
│  └─ desktop/                  # Electron 桌面壳（electron-vite）
│     ├─ src/
│     │  ├─ main/               # 主进程（§3.1 各模块）
│     │  ├─ preload/            # contextBridge 白名单 API
│     │  └─ renderer/           # Vue 3 应用
│     │     ├─ windows/         # 各窗口入口：service-dock / edge-bar /
│     │     │                   #   chat / mini-chat / settings / onboarding
│     │     └─ shared/          # 渲染层共享组件与样式
│     ├─ resources/             # 图标、托盘图标、安装器资源
│     └─ package.json
├─ packages/
│  ├─ agent-core/               # Agent 内核（纯 Node，vitest 单测）
│  ├─ modes/                    # 模式实现（classroom / work / code）
│  └─ shared/                   # 类型、IPC 契约、配置 Schema
├─ skills/                      # 内置 Skill（SKILL.md 包）
├─ scripts/                     # 构建 / 发布脚本
├─ Aurora.md                    # 需求原始记录
├─ package.json                 # workspace 根
└─ pnpm-workspace.yaml
```

**关键约束**：`agent-core` 与 `modes` 不得依赖 Electron / DOM，保证可独立测试，也为将来迁移壳层（如 Tauri）留后路。

## 5. 关键数据流

### 5.1 对话流

```
服务窗/交互窗输入 → renderer aurora.chat.send → preload → 主进程 AgentHost
  → agent-core（会话追加 + 上下文组装）→ LLM 流式 → 事件回推 renderer
      （流式文本 + 工具执行状态：运行中/成功/失败）
```

### 5.2 文件分类流（ClassRoom Mode）

```
chokidar 事件 → FileWatcher 稳定判定 → 分类队列（并发 2）
  → 内容提取（utilityProcess）→ LLM 分类（结构化输出）→ 科目映射
  → 移动文件 + 写分类历史 → 系统通知 + 交互窗分类流水推送
```

### 5.3 主动引导流

```
触发器（首次安装/模式切换/感知事件）→ Proactive 调度 → 打开/聚焦交互窗
  → 注入引导会话（AI 先发言）→ 用户逐步回复 → 收集配置 → SettingsStore 落盘
```

## 6. IPC 契约约定

- 通道命名：`namespace:action`，如 `chat:send`、`settings:get`、`classify:subscribe`。
- 跨进程类型统一定义于 `packages/shared`；preload 只暴露白名单方法。
- 事件推送使用 `on/off` 成对暴露，渲染层卸载时自动解绑。
- 大 payload（文件全文）只在主进程 / utilityProcess 内部流转，不进渲染进程。

## 7. 生命周期与容错

- 主进程异常统一捕获并写日志（`userData/logs/`，按天轮转）；渲染层崩溃不拖垮主进程。
- 降级策略：LLM 不可用 → 服务窗显示状态提示；分类失败 → 文件移入“待分类”；MCP 连接失败 → 标记状态并跳过，不影响主流程。
- 退出：托盘“退出”为唯一常规出口；所有窗口关闭仅隐藏。
