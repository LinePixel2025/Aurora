# Aurora 项目文档

> **Aurora** —— 将 Windows 接入 AI 生态的系统级 Agent 工具，为用户提供无感的、自主的 AI 服务。

本目录存放 Aurora 项目的规划与设计文档，作为开发的**单一事实来源（SSOT）**。
代码结构、接口与交互以实现前的最新文档为准，如需偏离，先改文档再改代码。

## 当前实现状态

**开发中：Computer Use（配置 Schema v39）**——让 Agent 在用户显式授权后截屏并操控真实
鼠标 / 键盘 / 窗口 / UI Automation：常驻 PowerShell 输入宿主、虚拟光标与顶部光谱流光浮层、
顶部操作过程面板 / 对话状态条、`/computer` 用户入口与 `computer_start` Agent 入口、独立设置页、
按多模态模型与会话授权三层门控；Agent 任务完成调用 `computer_stop` 退出并把 Aurora 调回前台。
设计见 [06 §28](./06-agent-core.md)、[07](./07-ui-spec.md)、[08 §1](./08-settings-onboarding.md)。
未发布前不改变上一版安装包。

**当前发布 v0.5.8：Center 页面型插件面板参数修复 + 页面断流**（配置 Schema 仍为
**v38**，无迁移）——修复页面型面板在 Center 上调用参数被多包一层导致的「切视图无效 /
输入内容不生效」；Center 允许改桌面视图（共享插件 `ui` 状态）的口径写进文档；页面请求
超时对齐 25s，页面自行导航离开后断流并提示刷新。插件无需修改。Aurora Center 服务器
同步升级到 **0.5.2**（版本线独立）。完整更新点与验收结果见
[release-notes/v0.5.8.md](./release-notes/v0.5.8.md)。

**上一发布 v0.5.7：Center 插件侧栏面板镜像 + 提醒页聚合 + 插件用量统计**（配置 Schema 仍为
**v38**，无迁移）——桌面已启用插件的侧栏面板会按账号自动出现在 Aurora Center 工作台侧栏，
声明式面板可直接操作、页面型面板在沙箱 iframe 中经市场包资源加载，只镜像面板（小组件不上
Center）且只允许设备属主访问；「提醒」页新增「定时提醒」与「勿扰时段」两个聚合区组；插件新增
`ctx.usage` 本机用量统计（Token / 缓存命中 / 生图 / 语音，只存计数）。Aurora Center 服务器
同步升级到 **0.5.1**（版本线独立）。完整更新点与验收结果见
[release-notes/v0.5.7.md](./release-notes/v0.5.7.md)。

更早的逐版说明（**v0.5.6 及以前**）不再在本文维护，逐版见
[`release-notes/`](./release-notes/) 与 [04-roadmap.md](./04-roadmap.md) 的「实现说明」；
本文只保留最近两次发布，避免与发布说明重复增长。

**鼠标键盘模拟已由 Computer Use 落地**（v39 开发中，用户显式授权 + 多模态模型门控，
见 [06 §28](./06-agent-core.md)）；录屏、持久交互式 shell、命令黑名单、Anthropic 等
非 OpenAI 兼容协议**仍属后续范围**（截图另由 `screenshot` 工具承接，见 [06 §25](./06-agent-core.md)）。

仍待做：**OS 级沙箱**（三档权限与项目根 realpath 前缀校验**不是**沙箱 —— 没有作业对象 / 容器 /
受限令牌，`run_command` 仍是当前用户权限）、Code Mode 功能实现（Work 已于 0.0.1 初步实装）、
子代理的**递归派生 / 独立 `model·effort`**（多子代理 / 并行 / 可写已于 2026-10-18 落地，见
[06 §19.5](./06-agent-core.md)）、上下文压缩修正
（工具参数计入权重、摘要落盘、预算按真实 token 校准）、代码签名证书、启动耗时 / 内存优化、OCR、多语言。
（**多模态输入与 Responses API 已于 2026-10-01 落地**，见
[04-roadmap.md](./04-roadmap.md) 的「2026-10-01 多模态与 Responses API 轮」。）
详见 [04-roadmap.md](./04-roadmap.md) 的阶段状态与「实现说明」。
实际工程结构见根目录 [README.md](../README.md)；端到端验证见 `pnpm verify`、
`pnpm verify:release`、`pnpm verify:update` 与 `AURORA_SMOKE=1 pnpm dev`。

## 文档索引

| 编号 | 文档 | 内容 | 定位 |
|---|---|---|---|
| 01 | [01-overview.md](./01-overview.md) | 项目总览、设计原则、核心概念、范围与非目标、验收标准 | 产品基线 |
| 02 | [02-architecture.md](./02-architecture.md) | 系统架构、进程/窗口模型、模块划分、目录结构、数据流 | 技术基线 |
| 03 | [03-tech-stack.md](./03-tech-stack.md) | 技术选型与决策记录（ADR） | 决策依据 |
| 04 | [04-roadmap.md](./04-roadmap.md) | 实现路径、阶段划分、里程碑、验收标准与风险 | 执行计划 |
| 05 | [05-mode-system.md](./05-mode-system.md) | 模式系统框架、ClassRoom Mode 详细设计、ClassIsland 联动与 Work/Code 接口预留 | 功能设计 |
| 06 | [06-agent-core.md](./06-agent-core.md) | Agent 内核：LLM、会话、工具循环、Skill、MCP、系统感知、主动引导 | 核心设计 |
| 07 | [07-ui-spec.md](./07-ui-spec.md) | 窗口体系（提示条 / 交互窗 / 设置 / 引导）、设计令牌与动效规范 | 界面规格 |
| 08 | [08-settings-onboarding.md](./08-settings-onboarding.md) | 配置 Schema、存储安全、首次安装引导、设置页设计 | 配置设计 |
| 09 | [09-packaging-release.md](./09-packaging-release.md) | 打包（NSIS）、双仓库发布拓扑、自动更新、SmartScreen 说明 | 发布运维 |
| 10 | [10-user-guide.md](./10-user-guide.md) | 用户手册：安装、引导、各窗口、ClassRoom、ClassIsland、代理、排障 | 用户文档 |
| 11 | [11-privacy.md](./11-privacy.md) | 隐私说明：数据位置、凭据加密、出网场景、权限清单 | 合规说明 |
| 12 | [12-aurora-center.md](./12-aurora-center.md) | Aurora Center：网页控制中心（服务器 / Web UI / CLI / 客户端连接器 / Center 工具） | 远程控制 |
| 13 | [13-automation.md](./13-automation.md) | 自动化：Agent Mode / Normal Mode、触发器与操作组件、内置自动化、Center 远程管理 | 功能设计 |
| 14 | [14-plugin-system.md](./14-plugin-system.md) | 插件系统：清单、权限、进程 / RPC、面板与页面、主题、市场与安全模型 | 扩展契约 |
| 15 | [15-plugin-development-guide.md](./15-plugin-development-guide.md) | 插件开发指南：快速开始、API 参考、面板 / 页面、打包校验与 Agent 提示词模板 | 开发者文档 |

## 阅读顺序建议

1. **了解项目是什么** → 01 项目总览
2. **了解怎么落地** → 04 实现路径（阶段与里程碑）
3. **了解怎么搭** → 02 系统架构、03 技术选型
4. **深入功能设计** → 05 模式系统、06 Agent 内核、07 窗口交互、08 设置与引导
5. **写插件** → 14 插件系统（契约与安全边界）、15 插件开发指南（快速开始与 API）

## 文档约定

- 文档中的 **P0 / P1 / P2** 为优先级：P0 = v1 必须实现，P1 = v1 尽量实现，P2 = 后续版本实现。
- 文档状态标记：`已定稿` / `草稿` / `待更新`。技术决策变更必须同步更新 03 中的对应 ADR。
- 术语以 01 §3 名词表为准；配置字段以 08 §1 Schema 为准；接口签名以 05 / 06 中的 TypeScript 片段为准。
- 里程碑编号：P6+ / P6++ 见 04 §1；历史段落里的 `v0.6.0` / `v0.7.0` / `v0.8.0` 是 2026-09-25
  版本体系重构前的编号，**不是真实 tag**；实际发布版本见 `release-notes/`。
