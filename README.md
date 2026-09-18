# Aurora

将 Windows 接入 AI 生态的**系统级 Agent 工具**：常驻系统托盘，以「AI 服务窗 + 右侧提示条」的轻量形态提供无感、自主的 AI 服务。

> 当前版本：**v0.1.0**（P0 脚手架 + P1 基础壳与设置 + P2 四种窗口外壳）
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
| `pnpm test` | vitest 单测（shared / agent-core / modes） |
| `pnpm verify` | 真实磁盘的 P1 验收脚本（需先 `pnpm build`），26 项断言 |
| `pnpm lint` / `pnpm format` | ESLint / Prettier |
| `node scripts/generate-icons.mjs` | 重新生成占位图标（托盘 / 应用图标） |

### 端到端自测（真实 Electron + preload + IPC）

```powershell
$env:AURORA_SMOKE='1'; pnpm dev   # 启动后自动跑 29 项链路断言，结果见日志并自动退出
Get-Content "$env:APPDATA\Aurora\logs\aurora-*.log" | Select-String 'AURORA_SMOKE_RESULT'
```

覆盖：`window.aurora` 暴露面、配置读写、凭据加密落盘（磁盘无明文）、模式切换与四步引导、
窗口状态机（迷你窗/交互窗互斥、隐藏服务窗连带隐藏）、对话流式事件、设置窗打开。

调试渲染层时可加 `AURORA_DEVTOOLS=1`（dev 模式下自动打开 DevTools；渲染层 console 始终会转发到主进程日志）。

## 目录结构

```
apps/desktop            Electron 壳（main / preload / renderer 六个窗口入口）
packages/shared         配置 Schema、SettingsStore、IPC 契约、模式与窗口类型
packages/agent-core     LLM Provider（OpenAI 兼容）、Skill 注册表、工具表骨架
packages/modes          IMode 框架、ClassRoom 完整实现、Work/Code 占位、引导运行器
skills/                 内置 SKILL.md（file-classify / system-status / timetable）
scripts/                图标生成等构建脚本
docs/                   项目文档（SSOT）
```

## 本版本已实现（v0.1.0）

- **P0**：pnpm workspace monorepo、TS strict、ESLint/Prettier、vitest、GitHub Actions（Windows）。
- **P1 基础壳与设置**
  - 托盘常驻 + 菜单（显隐服务窗 / 打开对话 / 切换模式 / 重新引导 / 设置 / 退出）
  - 单实例锁；关闭窗口 = 隐藏，仅托盘可退出
  - 设置窗口六页：常规 / 模式 / AI 模型 / Skill / MCP / 高级
  - 配置 store：Zod Schema、版本迁移链、原子写 + 防抖、损坏文件备份重建、字段级回退默认值
  - 凭据安全：safeStorage 加密落盘；不可用时仅驻留内存并明确提示；日志与导出全程脱敏
  - **首次安装引导**：AI 模型（baseURL / API Key / 模型名 + 真实「测试连接」与模型列表）、模式选择、ClassRoom 表单式引导
  - ClassRoom 对话式引导运行器：四步（感知文件夹 → 科目列表 → 每科目标文件夹 → 课前提醒），可中断续接
- **P2 窗口外壳**：AI 服务窗（置顶输入框 + `/`、`@` 前缀浮层 + 状态点）、右侧提示条（悬停展开面板）、
  完整对话窗口（Markdown 渲染、流式输出、历史/工具卡片占位）、小 AI 交互窗口；迷你窗与交互窗互斥、隐藏服务窗连带隐藏迷你窗、位置跨启动记忆
- **Agent 内核最小可用**：OpenAI 兼容 Provider（SSE 流式、超时、指数退避重试、AbortSignal）、SKILL.md 解析与注册表、
  工具注册表骨架、系统感知（时间 / 电源 / 网络，缺失项降级为 unknown）

## 尚未实现（后续阶段）

| 阶段 | 内容 |
|---|---|
| P3 (v0.3.0) | 接入真实对话循环：会话持久化、工具调用循环、MCP 客户端、Skill 执行；窗口显示模型真实回复 |
| P4 (v0.4.0) | 智慧感知文件夹监听（chokidar）+ 内容提取（utilityProcess）+ LLM 分类 + 移动/通知/分类流水 |
| P5 (v0.5.0) | 前台窗口、显示器、课程表感知；上下文注入；课前 5 分钟提醒并打开科目文件夹 |
| P6 (v1.0.0) | electron-builder NSIS 安装包、品牌图标、日志轮转打磨、用户文档 |
| P7 | Work / Code Mode 功能、ClassIsland 联动、自动更新、多语言 |

> 当前四种窗口的"发送消息"返回的是**占位回复**（真实感知摘要 + 下一阶段说明），
> 用于验证窗口状态机、流式渲染与 IPC 契约；IPC 通道已按 P3 设计，替换实现时渲染层无需改动。

## 安全说明

- API Key / MCP 环境变量使用 Electron `safeStorage` 加密后写入 `%APPDATA%/Aurora/config.json`；
  明文密钥永不落盘（安全存储不可用时只驻留内存）。
- 日志（`%APPDATA%/Aurora/logs/`，保留 7 天）与「导出脱敏配置」中的凭据一律替换为 `***`。
- 渲染进程启用 `contextIsolation` + `sandbox`，只能通过 preload 白名单调用主进程能力。
