# 06 · Agent 内核设计

状态：`已定稿`（v1 基线）

## 1. 目标

**可感知**（系统状态进上下文）、**可扩展**（Skill / MCP）、**可测试**（纯 Node，不依赖 Electron / DOM）。

## 2. 分层

| 层 | 职责 | 模块 |
|---|---|---|
| 提供者层 | 模型接入与流式输出 | `llm` |
| 会话层 | 消息历史、多窗口会话、持久化 | `session` |
| 执行层 | 工具调用循环 | `loop` |
| 能力层 | Skill、MCP 工具 | `skills`、`mcp` |
| 感知层 | 系统状态采集（主进程实现，内核消费） | `perception` |
| 编排层 | 上下文组装、主动引导 | `context`、`proactive` |

## 3. LLM 提供者

```ts
export interface LlmProvider {
  id: string;
  chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent>; // 流式
  listModels?(): Promise<ModelInfo[]>;
  testConnection(): Promise<TestResult>;
}
```

- 默认实现 `OpenAiCompatProvider`：`baseURL + apiKey + model`，兼容 DeepSeek / OpenAI / Ollama / vLLM 等（见 ADR-003）。
- 设置中可保存多组模型配置并切换默认；会话级可选模型；temperature 等参数可调。
- 可靠性：指数退避重试、单请求超时（默认 60s）、流式中断可取消（AbortSignal 贯穿到 IPC）。

## 4. 会话管理

- 会话划分（v1）：**快速会话**（服务窗 + 迷你窗共享）× 1，**完整会话**（AI 交互窗口）× 1，设置引导会话复用完整会话窗口。后续可扩展多会话列表。
- 持久化：`userData/sessions/*.json`（含工具消息），支持清空 / 导出。
- 上下文窗口管理：超长自动摘要压缩（P1）；v1 先按 token 上限截断旧消息并保留系统提示词。

## 5. 工具调用循环（Agent Loop）

- **系统提示词组装**：基础人设 + 当前模式片段（IMode.systemPrompt）+ 感知摘要 + 工具清单（Skill / MCP）+ 安全规则。
- **循环**：用户消息 → LLM → [工具调用 → 执行 → 结果回填] × N（上限 8 轮）→ 最终回复。
- 工具执行状态实时推送渲染层（运行中 / 成功 / 失败 + 输出摘要），渲染为执行卡片。
- 敏感工具（文件移动 / 删除、命令执行）需用户确认：一次性授权或逐次确认（P1 落地逐次确认）。

## 6. Skill 系统

- **结构**：`SKILL.md`（frontmatter：`name` / `description` / `when_to_use` + 正文指令）+ 可选 `scripts/`。
- **注册表**：内置 `skills/`（随安装包）+ 用户目录 `userData/skills/`（设置页管理：查看 / 添加 / 删除 / 启用）。
- **匹配**：以工具形式向 LLM 暴露 `use_skill`，由 LLM 依 description 自动选择；用户可显式 `@skill名` 或 `/skill名`。
- **v1 内置 Skill 规划**：
  - `file-classify`：分类管线专用（内容证据 → 科目判定）；
  - `system-status`：直接读取感知当前值（电量 / 网络 / 前台应用等）；
  - `timetable`：课程表查询与课前提醒数据。

## 7. MCP 子系统

- **McpClientHub**：维护多个 MCP 连接（`stdio` / `streamable-http`）；启动时按配置连接，失败降级并标记状态（设置页可见状态灯）。
- **工具注册**：MCP tools → Agent 工具表，命名 `mcp.<server>.<tool>`；与 Skill 冲突时 MCP 优先并记日志。
- **配置**：设置页添加 / 删除 / 编辑服务器（URL 或 command + args + env）；env 中凭据安全存储（见 08 §2）。
- **生命周期**：懒连接（首次使用）与启动即连两种策略，可在设置中切换。

## 8. 系统感知（Perception）

### 8.1 采集项（v1）

| 感知项 | 来源 | 频率 | 用途 |
|---|---|---|---|
| 当前时间 / 星期 / 日期 | 进程内定时器 | 分钟级 | 课程表、问候语 |
| 电源状态（AC / 电池 / 电量） | systeminformation | 状态变化 + 5min | 低电量提醒等主动服务 |
| 网络连通性 | 系统探测 | 变化触发 | 联网任务前置检查 |
| 前台窗口 / 应用 | active-win（PowerShell 回退） | 5s | 上下文感知（“我在写什么”） |
| 显示器 / 屏幕状态 | Electron API | 变化触发 | 窗口贴边策略 |
| 课程表（ClassRoom） | manual / ClassIsland | 事件驱动 | 课前提醒 |

### 8.2 实现与消费

- 统一 `PerceptionProvider` 接口，采集器注册制、独立调度（见 ADR-007）；数据存环形缓冲（当前值 + 最近 10 条）。
- **三类消费**：
  1. **上下文注入**：组装系统提示词时附感知摘要（时间、电量、网络、前台应用等）；
  2. **事件总线**：模式 / 触发器订阅（如课前 5 分钟事件）；
  3. **工具查询**：`system-status` Skill 直接读取当前值回答用户。

## 9. 主动引导（Proactive）

- 触发器注册表：首次安装未完成、模式引导未完成、分类完成通知、课前 5 分钟……
- 调度策略：单次最多触发一条（队列排队）；支持勿扰时段；全部触发器可配置开关。
- 载体：打开 / 聚焦 AI 交互窗口，以 AI 消息开场（对话式收集，见 05 §2）。

## 10. 安全

- **凭据**：API key / MCP env 用 safeStorage 加密落盘；日志与导出配置一律脱敏。
- **文件操作**：默认限于感知文件夹范围内；越界操作需用户确认。
- **网络**：LLM / MCP 支持系统代理（设置项 `advanced.proxy`）。
- **执行**：命令 / 文件操作前经工具权限分级校验，敏感级需确认。
