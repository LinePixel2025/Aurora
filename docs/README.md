# Aurora 项目文档

> **Aurora** —— 将 Windows 接入 AI 生态的系统级 Agent 工具，为用户提供无感的、自主的 AI 服务。

本目录存放 Aurora 项目的规划与设计文档，作为开发的**单一事实来源（SSOT）**。
需求源头为仓库根目录的 [`Aurora.md`](../Aurora.md)；代码结构、接口与交互以实现前的最新文档为准，如需偏离，先改文档再改代码。

## 当前实现状态

**v0.6.0**：P0（脚手架）、P1（基础壳与设置，含首次引导）、P2（四种窗口外壳）、
**P3（Agent 内核：真实对话、会话持久化、工具调用循环、Skill、MCP）**、
**P4（模式系统 + ClassRoom Mode：智慧感知文件夹自动分类、分类流水与就地修正、规则缓存）**、
**P5（系统感知与主动引导：前台窗口 / 显示器 / 课程表采集、课前提醒、敏感工具确认）** 均已完成；
**P6 打包与自动更新已完成**（NSIS 安装包 + 公开 releases 仓库 + electron-updater，见 [09](./09-packaging-release.md)）。

**v0.6.0 本轮新增**：

- **ClassIsland 联动**（原 P7 项提前落地）：`schedule.provider = classisland` 从占位改为真实实现 ——
  读桥接插件写出的本地 JSON（或本机回环端点），感知摘要 / 课前提醒 / `timetable` Skill
  三条消费链零改动复用；随仓库附带桥接插件源码（[`integrations/classisland-bridge`](../integrations/classisland-bridge/)）。
  配置 Schema 升到 **v3**（新增 `modes.classroom.schedule.classisland`，走迁移链）。
- **接线修复**——清掉「设置里能改、运行时没有消费方」的假开关：
  `general.hotkey` 真的注册全局快捷键（含冲突检测与状态回显）、
  `advanced.proxy` 真的接入模型 / MCP / 连接测试的网络栈、
  `advanced.logLevel` 支持热更新（含已存在的子 logger）、
  `skills.userDir` 生效（含重扫与扫描状态）、
  `general.edgeBar.opacity` 与 `general.edgeBar.quietHours` 生效、
  `app:openLogs` 死通道补齐 handler。
- **体验补齐**：对话窗多会话列表与切换、附件拖拽发送（复用现有内容提取）、
  `autoMove=false` 时按 `(路径, 大小, 修改时间)` 去重、长上下文自动摘要压缩（失败退回纯截断）。
- **文档**：新增 [10 用户手册](./10-user-guide.md) 与 [11 隐私说明](./11-privacy.md)。

**v0.7.0 本轮新增**：

- **模型思考等级**：设置页「AI 模型」每个 provider 的「高级参数与连接测试」新增「思考等级」
  （`auto` / `low` / `medium` / `high`），端到端下发为请求体的 `reasoning_effort`；
  `auto`（默认）= **不下发该字段**，以兼容不认该参数的厂商。配置在
  `llm.providers.<id>.reasoningEffort`。
- **终端与文件操控工具**（内核第一次具备真实操作本机的能力，配置在 `agent.tools.*`）：
  `run_command`（PowerShell，confirm）、`read_file`（safe）、`write_file`（confirm）、
  `list_dir`（safe）、`open_path`（用系统默认程序打开，confirm）。真实系统调用全在主进程实现，
  内核只认注入的端口；超时按**进程树**终止；输出 head 60% + tail 40% 截断；**不做命令黑名单**。
- **「电脑操控」设置页 + 全套安全边界**：侧栏第 7 项；总开关 / 工作目录 / 终端 / 文件 / 打开
  分开关，改完**立即生效**（无需重启）；敏感工具逐次确认（60s 不响应 / 勿扰时段按拒绝）；
  关闭「敏感工具确认」后不再逐次询问（能力等同用户自己敲同样的命令）。配置 Schema 升到 **v5**
  （`v4 → v5` 迁移补齐新字段，幂等且不覆盖用户已写值）。关键字段：`agent.tools.enabled`、
  `agent.tools.workspaceDir`、`agent.tools.terminal.{enabled,timeoutMs,maxOutputChars}`、
  `agent.tools.files.{enabled,maxReadBytes}`、`agent.tools.open.enabled`。
- **语音合成朗读（TTS）**：助手消息下方新增「朗读」按钮（播完/停止自动复位），设置页新增
  **「语音」页**（侧栏「AI 能力」组第 2 项）可添加 / 编辑 / 删除任意 **OpenAI 兼容**的
  TTS 服务，支持「自动朗读新回复」与单次字数上限。合成在**主进程**完成
  （`POST <baseUrl>/audio/speech`，走 `main/net.ts` 的 `netFetch` 以受系统代理影响），
  音频以 base64 过 IPC、渲染层转 Blob 播放；**渲染层与日志永远看不到明文密钥**。
  配置 Schema 升到 **v7**（新增 `tts.*` 段，`v6 → v7` 迁移幂等补齐、不覆盖用户已写值）。
  关键字段：`tts.enabled`、`tts.active`、`tts.autoRead`、`tts.maxChars`、
  `tts.providers.<id>.{baseUrl,model,voice,speed,format}`（凭据密文在 `apiKeyEnc`）。
  详见 [06-agent-core.md §13](./06-agent-core.md)、[08-settings-onboarding.md §6](./08-settings-onboarding.md)。
  **语音输入（STT）不在本轮范围**。

鼠标键盘模拟、截图录屏、持久交互式 shell、命令黑名单、Anthropic 等非 OpenAI 兼容协议
**仍属后续范围**。

仍待做：代码签名证书、启动耗时 / 内存优化、Work / Code Mode 功能实现、OCR、多语言。
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

## 阅读顺序建议

1. **了解项目是什么** → 01 项目总览
2. **了解怎么落地** → 04 实现路径（阶段与里程碑）
3. **了解怎么搭** → 02 系统架构、03 技术选型
4. **深入功能设计** → 05 模式系统、06 Agent 内核、07 窗口交互、08 设置与引导

## 文档约定

- 文档中的 **P0 / P1 / P2** 为优先级：P0 = v1 必须实现，P1 = v1 尽量实现，P2 = 后续版本实现。
- 文档状态标记：`已定稿` / `草稿` / `待更新`。技术决策变更必须同步更新 03 中的对应 ADR。
- 术语以 01 §3 名词表为准；配置字段以 08 §1 Schema 为准；接口签名以 05 / 06 中的 TypeScript 片段为准。
