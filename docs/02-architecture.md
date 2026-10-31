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
│  │Awareness  │ │              │ │                                          │ │
│  │智慧文件夹  │ │系统感知采集   │ │  ├ LlmProviders ├ Session ├ Loop(工具循环)│ │
│  └───────────┘ └──────────────┘ │  ├ Skills ├ McpClientHub ├ Context       │ │
│                                 │  └ Proactive(主动引导)                    │ │
│                                 └───────────────────────────────────────────┘ │
│ Preload：contextBridge 白名单 API（window.aurora.*）                           │
│ Renderer（Vue 3，每窗口一进程）：EdgeBar / Chat / Settings /                    │
│          Onboarding / Automation / Banner / Widget / Memory / PluginConfig 等   │
└──────────┬────────────────────────┬────────────────────────┬──────────────────┘
           │                        │                        │
     LLM 服务(OpenAI 兼容)     MCP Servers(stdio/http)    系统(文件/电源/网络/前台窗口)
```

## 2. 进程与窗口模型

### 2.1 进程

- **主进程（Main）**：唯一入口。承载托盘、窗口管理、配置、文件监听、系统感知与 Agent 内核装配。v1 中 Agent 内核直接运行于主进程（异步 I/O，不阻塞事件循环）；**重任务**（文档内容提取、批量文件分析）走 `utilityProcess` 子进程隔离，避免卡顿。
- **渲染进程（Renderer）**：每个窗口一个进程（Vue 3）。所有系统能力通过 preload 暴露的 `window.aurora.*` 调用，启用 `contextIsolation` 与 `sandbox`。
- **单实例**：`app.requestSingleInstanceLock()`；二次启动时聚焦已有实例并唤起主界面。

### 2.2 窗口清单

| 窗口                 | 创建方        | 数量                    | 形态与来源                                                                                                                                              |
| -------------------- | ------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 托盘 Tray            | 主进程        | 1                       | 系统托盘图标 + 菜单（打开对话 / 设置 / 切换模式 / 退出）                                                                                                |
| 提示条 Edge Bar      | WindowManager | 每显示器 1（v1 主屏 1） | 屏幕右缘超薄竖条，悬停展开面板、点击呼出主界面；始终置顶                                                                                                |
| 主界面（chat）       | WindowManager | 1                       | 1280×800 常驻三栏大窗（2026-10-03 二次修订）；唯一主对话窗口；标题栏右侧有 Windows 式「最小化 / 关闭」按钮，关闭 = 隐藏 |
| 设置窗口             | WindowManager | 1                       | 单窗口分栏；无系统标题栏，侧栏顶部可拖动 + Windows 式「最小化 / 关闭」按钮（关闭 = 隐藏，Esc 等效）                                                     |
| 记忆库窗口（memory） | WindowManager | 1                       | 文件自感知知识库的独立浏览器；左侧笔记列表 + 右侧 Markdown 预览，设置页只管配置与入口（关闭 = 隐藏）                                                    |
| 自动化窗口（automation） | WindowManager | 1                   | 自动化列表 / 独立编辑器 / 历史详情；关闭 = 隐藏                                                                                                        |
| 首次引导窗口         | WindowManager | 1                       | 向导式                                                                                                                                                  |
| 插件配置窗口         | WindowManager | 1                       | 单例；插件配置 / 桌面小组件 / 权限 / 管理动作（`plugin-config`），关闭 = 隐藏                                                                          |
| 流光提醒（banner-glow / banner-card） | WindowManager.showBanner | 各 1     | 两扇内部窗口：整屏穿透光带 + 可点卡片；统一走 `BannerService`，不进 `WINDOW_NAMES`、不写几何持久化                                                |
| 桌面小组件（widget） | `main/plugins/widgets.ts` | ≤ 8        | 插件贡献的无边框透明窗口；默认置顶、`focusable:false`、不占任务栏；布局写 `plugin-widget-layout.json`（不进 settings）                                  |
| 自感知流光浮层       | WindowManager | 1                       | 内部透明置顶浮层；仅在文件分析进行中、提示条可见且 `appearance.awarenessGlow` 未关闭时**覆盖目标显示器整块矩形**（v33 起四边流光，渲染层只在四条边画光带）。鼠标穿透、不可聚焦、不进 `WINDOW_NAMES` / 任务栏 / 窗口状态 |
| Computer Use 浮层（computer-use） | WindowManager | 每显示器 1 + 过程面板 1 | 首次操作时每块显示器一扇透明置顶窗（虚拟光标 + 顶部光谱流光）与顶部操作过程面板；鼠标穿透、不可聚焦、**不做内容保护**（远程桌面看不到），操作期间持续显示、实时更新；不进 `WINDOW_NAMES`、不写几何（v39，06 §28） |

约定：**主界面、设置、记忆库、自动化详情窗口与插件配置窗口**显示任务栏图标（`skipTaskbar: false`）且可最小化 / 最大化（Windows 式标题栏按钮，2026-09 前端重构起）；提示条与引导窗口仍隐藏任务栏图标。所有窗口的「关闭」= 隐藏（仅托盘“退出”真正退出），托盘仍是统一管理入口。

`awareness-glow`、`banner-glow` / `banner-card` 与桌面小组件是内部窗口例外：由主进程按
自感知状态 / 提醒队列 / 插件贡献创建，不暴露 `window:*` 操作；三者都不进 `WINDOW_NAMES`，
提醒窗口不持久化几何，桌面小组件的布局写在独立文件里。

## 3. 模块划分

### 3.1 主进程（`apps/desktop/src/main`）

| 模块                                          | 职责                                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `tray`                                        | 托盘图标、菜单、状态徽标                                                                           |
| `window-manager`                              | 窗口创建 / 显隐 / 置顶 / 贴边 / 多显示器位置记忆；Computer Use 浮层与 HUD（v39）                    |
| `settings-store`                              | 配置读写、schema 校验、版本迁移、safeStorage 凭据                                                  |
| `mode-manager`                                | 模式注册表、切换流程、引导状态（见 05）                                                            |
| `file-watcher`                                | 智慧感知文件夹监听、稳定判定、抑制自触发（见 05 §3.1）                                             |
| `file-awareness`                              | 递归文件监听、Windows 最近使用、持久队列、后台文档分析、Markdown 笔记与服务气泡（见 06 §26）       |
| `classification` + `classify/*`               | 分类队列、规则缓存、LLM 判定、科目映射与落盘（见 05 §3.2）                                         |
| `classification-history`                      | 分类流水持久化（`userData/classification.json`，见 08 §1.2）                                       |
| `extract` / `extract-worker` / `extract-pool` | 内容提取（utilityProcess 隔离、超时与降级）                                                        |
| `office-worker` / `office-pool`               | Office 结构化读写；在 utilityProcess 中调用包内固定版 OfficeCLI，负责批处理、校验、渲染与 PDF 合成 |
| `notifications`                               | 系统通知与点击打开路径（分类完成 / 待分类 / 课前提醒）                                             |
| `perception`                                  | 系统感知采集器注册与调度（见 06 §8）                                                               |
| `schedule` / `pre-class-reminder`             | 课程表 provider 与课前 5 分钟提醒（见 05 §3.4）                                                    |
| `proactive`                                   | 主动引导调度与敏感工具确认（勿扰时段、超时按拒绝，见 06 §9）                                       |
| `agent-host`                                  | 装配 agent-core 与 modes，向渲染层暴露统一 API                                                     |
| `browser-agent`                               | 内置浏览器 Agent 工具的主进程端口：会话登记、guest 归属校验、`loadURL` 导航与 CDP 驱动（见 06 §27） |
| `browser-agent-sessions`                      | Agent 浏览器会话的并发槽位与空闲释放（electron-free，可单测；上限与空闲时长走 live getter）        |
| `computer-use/*`                              | Computer Use（v39，06 §28）：常驻 PowerShell 输入宿主、坐标 / 应用策略 / 会话服务 / 截屏与浮层协调；工具与端口分层，纯逻辑可单测 |
| `center/*`                                    | Aurora Center 连接器：出站 WS、重连、远程命令处理（会话 / 配置 / 模式），见 12                     |
| `ipc`                                         | IPC 通道注册（契约见 §6）                                                                          |

### 3.2 Agent 内核（`packages/agent-core`，纯 Node，不依赖 Electron）

| 模块        | 职责                                                           |
| ----------- | -------------------------------------------------------------- |
| `llm`       | LLM Provider 抽象与 OpenAI 兼容实现（见 06 §3）                |
| `session`   | 会话 / 消息历史 / 持久化                                       |
| `loop`      | 工具调用循环（Agent Loop，见 06 §5）                           |
| `skills`    | Skill 注册表、匹配、执行                                       |
| `mcp`       | MCP 客户端连接管理与工具注册                                   |
| `context`   | 上下文组装（人设 + 模式片段 + 感知摘要 + 工具清单 + 安全规则） |
| `proactive` | 主动引导触发器注册与调度                                       |

### 3.3 模式包（`packages/modes`）

- `IMode` 接口定义 + `classroom` 完整实现 + `work` / `code` 占位实现（见 05）。

### 3.4 共享包（`packages/shared`）

- IPC 通道常量、DTO 类型、配置 Schema、事件定义（渲染层 / 主进程 / 内核三方共用）。

### 3.5 Aurora Center（`packages/center`，纯 Node，不依赖 Electron）

- 独立可部署的控制中心服务器 + `aurora-center` CLI + Web UI（构建产物随包静态服务），
  协议类型在 `packages/shared/src/center/protocol.ts` 三方共享。见 docs/12。
- 插件侧栏面板镜像链路：网页 → Center Hub（owner 校验 / 订阅 refcount）→ 桌面 Connector
  （`allowRemoteSession` 闸门）→ `readPluginPanelData`（与桌面 `plugins:panelData` 同一条
  链路）→ 回执 / `plugin.event` 原路返回；页面型面板的静态资源由 Center 从市场 zip 的
  `/p/` 直出。见 docs/12 §6.5。

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
│     │     ├─ windows/         # 各窗口入口：edge-bar / chat / automation /
│     │     │                   #   settings / onboarding；另有内部 awareness-glow
│     │     └─ shared/          # 渲染层共享组件与样式
│     ├─ resources/             # 图标、托盘图标、安装器资源
│     └─ package.json
├─ packages/
│  ├─ agent-core/               # Agent 内核（纯 Node，vitest 单测）
│  ├─ modes/                    # 模式实现（classroom / work / code）
│  ├─ center/                   # Aurora Center 服务器 + CLI + Web UI（纯 Node，见 12）
│  └─ shared/                   # 类型、IPC 契约、配置 Schema、Center 协议
├─ skills/                      # 内置 Skill（SKILL.md 包）
├─ scripts/                     # 构建 / 发布脚本
├─ package.json                 # workspace 根
└─ pnpm-workspace.yaml
```

**关键约束**：`agent-core` 与 `modes` 不得依赖 Electron / DOM，保证可独立测试，也为将来迁移壳层（如 Tauri）留后路。

## 5. 关键数据流

### 5.1 对话流

```
交互窗输入 → renderer aurora.chat.send → preload → 主进程 AgentHost
  → agent-core（会话追加 + 上下文组装）→ LLM 流式 → 事件回推 renderer
      （流式文本 + 工具执行状态：运行中/成功/失败）
```

### 5.2 文件分类流（ClassRoom Mode）

```
chokidar 事件 → FileWatcher 稳定判定 → 分类队列（并发 2）
  → 规则命中？（科目名 / 关键词 / 用户修正沉淀）
      ├─ 命中 → 科目目录（跳过 LLM，省 token）
      └─ 未命中 → 内容提取（utilityProcess）→ LLM 结构化分类 → 阈值判定
  → 移动文件 + 写分类流水 → 系统通知 + 交互窗分类流水推送
  → 低于阈值 / 失败 → 「待分类」兜底 + 请用户确认通知
```

> **实现说明（v0.4.0）**：队列、规则、判定、落盘、流水、通知各为一个可单测模块；
> 提取在 `utilityProcess` 内（第二个 main 构建入口 `out/main/extract-worker.js`）。
> 无可用模型时在提取**之前**即兜底；提取失败降级为「文件名证据」而不中断管线。

### 5.3 主动引导流

```
触发器（首次安装/模式切换/感知事件）→ Proactive 调度 → 打开/聚焦交互窗
  → 注入引导会话（AI 先发言）→ 用户逐步回复 → 收集配置 → SettingsStore 落盘
```

## 6. IPC 契约约定

- 通道命名：`namespace:action`，如 `chat:send`、`settings:get`、`classify:subscribe`。
- **右栏工具化通道（2026-10-03，docs/07 §2.3）**：`preview:read`（文件预览：路径受会话
  边界根 realpath 校验 + 文本 2 MB / 图片 10 MB 上限，实现 `main/file-preview.ts`）、
  `chat:compact`（手动压缩上下文 → 内核 `agent.compact`，06 §4）、
  `terminal:create / input / resize / kill` + 推送 `terminal:data / exit`
  （PTY 终端，`main/terminal-service.ts`；create 需要发起窗口的 `event.sender.id`，
  输出只推给创建窗口）。preload 白名单与 shared 双向断言同步更新。
- **内置浏览器 Agent 通道（v35，docs/06 §27）**：`browser_open` 等八个内置工具由主进程驱动
  右栏 chat 窗口里的 webview，四个通道的方向与语义如下（preload 白名单与 shared 双向断言同步）：

  | 通道 | 方向 | 语义 |
  |---|---|---|
  | `browser:agentOpen` | 主进程 → 渲染层（推送，on/off 成对） | 请求渲染层新建 / 复用本会话的 Agent 专属浏览器标签；payload `{ requestId, sessionId, url, title }`，主进程 15s 未收到回执按失败处理 |
  | `browser:agentReport` | 渲染层 → 主进程（invoke） | 上报创建结果：成功带 `webContentsId`（`tabId?`）、失败带 `error`（如标签达 12 上限）→ `Result<void>` |
  | `browser:agentStatus` | 主进程 → 渲染层（推送，on/off 成对） | 会话状态 `opening / ready / busy / released` 与徽章 `detail`；`focus: true` 时渲染层激活该标签（Agent 操作中 / 截图前），`released` 清映射 |
  | `browser:agentStop` | 渲染层 → 主进程（invoke） | 用户点「停止」或关闭标签时结束该会话的控制（标签页保留）→ `Result<void>` |

  标签的 `tabId` 由渲染层新建 / 复用后**自行记账**（只用于回执配对与状态展示，不作为信任依据）；
  主进程对上报的 `webContentsId` 查 `webContents.fromId` 并校验 `hostWebContents.id` 等于 chat
  窗口的 webContents id 后才登记并导航，**不按 URL / 标题猜 guest**。实现模块见 §3.1 的
  `browser-agent` / `browser-agent-sessions`。
- 窗口控制（`window:*`）：`show` / `hide` / `toggle` / `showChat` / `setPosition` /
  `setEdgeBarExpanded` / `minimize` / `toggleMaximize` / `getState`，事件推送 `window:stateChanged`。
  `minimize` 真最小化（进任务栏，chat / 设置 / 记忆库可用）；`toggleMaximize` 切换系统最大化
  （caption 按钮与拖动区双击）。Electron 44 起 Acrylic 与系统最大化兼容，不再做工作区缩放；
  最大化状态下几何不写入 `general.windowState`。
  `window:setEdgeBarExpanded` 驱动提示条两态宽度（收起 8px / 展开 328px，右缘固定，见 07 §2.2）；
  它只改窗口几何、不改可见性，因此**不广播** `stateChanged`。
- **文件自感知窗口联动**（2026-10）：`awareness:presentNote` 接收 `{ noteId }`，主进程先
  `show('memory')` 再向记忆库窗口推送 `awareness:notePresented`；事件只携带已登记的 noteId，
  不接受任意路径。提示条点击最近理解、设置页入口都走这条展示链，系统默认程序打开仍只走
  `awareness:openNote`（见 06 §26）。
- **ClassIsland 联动通道**（2026-09 新增 `classisland:notify`）：让 ClassIsland 弹出提醒。
  入参 `ClassIslandNotifyRequest`（`title` / `body` / `channel?`），出参
  `Result<ClassIslandNotifyResult>`（`ok` / `error?` / `elapsedMs`）——
  **`ok: false` 是业务结果不是异常**：桥接未装、命令通道关闭、回执超时都走这条路径，
  由设置页 / 工具如实回显原因。
  文件模式下主进程原子写 `<课表文件同目录>/command.json` 并轮询同目录 `command-result.json`
  （按 `id` 匹配，超时用 `modes.classroom.schedule.classisland.timeoutMs`）；
  HTTP 模式下 `POST <端点 origin>/notify`，出网走 `main/net.ts` 的 `netFetch`
  （因此 `advanced.proxy` 生效）。实现见 `main/classisland.ts` 的 `ClassIslandNotifier`；
  契约细节见 `05 §3.4 v3`。
- **流光提醒通道（2026-10-24，docs/07 §2.2.3）**：独立于系统通知（`NotificationService`）与
  ClassIsland 提醒的第三条提醒通道 —— 屏幕顶端流光 + 置顶卡片。
  `banner:show`（主进程 → banner 渲染层，推送，on/off 成对）携带 `BannerShowPayload`
  （`id` / `title` / `body` / 已解算的 `speak` / `sound` / `durationMs` / `level`）；
  `banner:dismiss`（渲染层 → 主进程，invoke）带回本次展示的 `id`，主进程**只认当前那一条**
  （迟到 / 重复回执返回 `dismissed: false`，否则上一张卡片的超时回执会关掉刚弹出的新卡片）。
  三个来源（Agent 工具 `notify_banner`、插件 `ctx.banner`、`ask_user` 的旁路播报）全部汇聚到
  主进程 `main/banner.ts` 的 `BannerService.show()`；排队 / 去重 / 超时兜底只在那一处实现。
  两个内部窗口由 `WindowManager.showBanner()` 驱动（光带窗整屏穿透、卡片窗可点），
  不经过 `WINDOW_NAMES` 状态机、不写几何持久化。
- 跨进程类型统一定义于 `packages/shared`；preload 只暴露白名单方法。
- 事件推送使用 `on/off` 成对暴露，渲染层卸载时自动解绑。
- **`chat:event` 事件带 `seq` 与 `round`**（2026-09）：`seq` 是会话内单调序号（主进程 `emit`
  统一分配），`round` 是本次请求的工具调用轮次。渲染层据此排序消息、丢弃陈旧请求的迟到事件、
  把思考链绑到正确的助手消息上（口径见 `06 §16.1`）。
- **会话项目通道 `chat:setSessionProject`**（v17，2026-09）：绑定 / 解绑**单个会话**的项目
  （入参 `{ sessionId, projectId }`，`projectId` 空串 = 清除绑定）。状态写在会话文件自身的
  `meta.projectId`（与 `chat:archiveSession` 同一条路，**不是配置项**、不进迁移链）；
  绑定到 `projects.list` 里不存在的项目返回 `{ ok: false }` 而不静默。
  主进程 await 落盘完成后才返回，渲染层随后拉 `chat:sessions` 读回显（沿用「写后拉取」惯例，
  会话列表没有推送通道）；解析链与消费方见 `06 §5.1`。
- **会话标题推送 `chat:sessionTitleChanged`**（2026-10-05）：首条用户需求发出后，主进程异步
  生成标题并写入会话文件 `meta.title`；成功后向所有窗口广播 `{ sessionId, title }`。chat
  渲染层据此原位更新会话列表与主区标题，不重新水合消息、不切换会话。生成失败不广播，
  继续沿用首条消息的 24 字回退标题；具体口径见 `06 §4`。
- 大 payload（文件全文）只在主进程 / utilityProcess 内部流转，不进渲染进程。

## 7. 生命周期与容错

- 主进程异常统一捕获并写日志（`userData/logs/`，按天轮转）；渲染层崩溃不拖垮主进程。
- 降级策略：LLM 不可用 → 提示条 / 交互窗显示状态提示；分类失败 → 文件移入“待分类”；MCP 连接失败 → 标记状态并跳过，不影响主流程。
- 退出：托盘“退出”为唯一常规出口；所有窗口关闭仅隐藏。
