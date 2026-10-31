# Aurora 项目文档

> **Aurora** —— 将 Windows 接入 AI 生态的系统级 Agent 工具，为用户提供无感的、自主的 AI 服务。

本目录存放 Aurora 项目的规划与设计文档，作为开发的**单一事实来源（SSOT）**。
代码结构、接口与交互以实现前的最新文档为准，如需偏离，先改文档再改代码。

> **开源与发布**：项目以 [MIT License](../LICENSE) 开源；安装包、`latest.yml` 与
> `*.blockmap` 统一发布在本仓库 [GitHub Releases](https://github.com/LinePixel2025/Aurora/releases)。
> 2026-10-31 起不再使用独立的 `Aurora-releases` 仓库，拓扑见 [09 §1](./09-packaging-release.md)。

## 当前实现状态

**当前发布 v0.6.0：Computer Use v39.2 + 流光提醒大屏可读性 + 设置页视觉收敛**（配置 Schema
仍为 **v39**，无迁移；插件 API 仍为 **v1**）——顶部操作过程面板收敛为**两层状态胶囊**
（520×88、只留当前步骤与「下一步」、光带 48px、不列历史），Computer Use 结束时
`agent` / `user` / `idle` / `budget` / `error` 五种原因都**把主界面带回前台**；操作提示词改成
「截图 → 定位 → 同轮批量 2–4 步 → 截图验收」并补定位优先级、键盘前确认前台、失败先重看。
流光提醒的卡片宽度改为**按显示器 DIP 宽度比例**（0.24 / 0.36 / 0.46）并随卡片**流体放大字号**，
高度改由渲染层实测后收缩；提示音重写为三声上行音 + 复用 `AudioContext`，修复「有时不响」，
提醒设置页新增「试听」。设置页侧栏 5 组收敛为 3 组、统一页头与发丝线区组、品牌行加
`Line Production` 徽标，并修复左栏窄宽下 Center 药丸文字溢出。设计见
[06 §28](./06-agent-core.md)、[07 §2.2.3/§2.5](./07-ui-spec.md)、[08 §1](./08-settings-onboarding.md)；
完整更新点与验收结果见 [release-notes/v0.6.0.md](./release-notes/v0.6.0.md)。
Aurora Center 服务器不随本版升级（仍为 **0.5.2**，版本线独立）。

**上一发布 v0.5.9：Computer Use 桌面操控（配置 Schema v39）**——Agent 在用户显式授权后
截屏并操控真实鼠标 / 键盘 / 窗口 / UI Automation（常驻 PowerShell 输入宿主、虚拟光标与顶部
光谱流光、`/computer` 与 `computer_start` 双入口、三层门控）；同版含桌面小组件点击不抢前台 +
固定按钮、开源迁移（MIT / 单仓库）与插件开发工具包 v0.5.9。Aurora Center 服务器仍为 **0.5.2**。
完整更新点与验收结果见 [release-notes/v0.5.9.md](./release-notes/v0.5.9.md)。

更早的逐版说明（**v0.5.7 及以前**）不再在本文维护，逐版见
[`release-notes/`](./release-notes/) 与 [04-roadmap.md](./04-roadmap.md) 的「实现说明」；
本文只保留最近两次发布，避免与发布说明重复增长。

**鼠标键盘模拟已由 Computer Use 落地**（v39，随 v0.5.9 发布；用户显式授权 + 多模态模型门控，
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
