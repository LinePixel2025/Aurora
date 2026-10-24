---
date: 2026-10-24
title: 插件 / MCP 的点号工具名原样发给严格网关会整请求 400，必须在出站边界换成线路名
tags: [agent-core, 工具, 插件, MCP, LLM, provider, 坑, 口径]
source: 模型自动记录
---

# 点号工具名 → 整请求 400

## 现象

对话直接失败，返回：

```
HTTP 400 Invalid 'tools[39].name': string does not match pattern.
Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'
```

安装带工具的插件后**每条消息**都失败（不是只在调用该工具时）；
`tools[39]` 恰好是按名字排序后的第一个 `plugin.com.classmanagement.board.*` 工具。
当时生效 provider 为 `deepseek`（`openai-responses`），并非用户提问内容的问题。

## 原因

- 插件工具注册名是 `plugin.<id>.<name>`、MCP 是 `mcp.<server>.<tool>`，
  内部靠点号前缀做 `unregisterByPrefix` 与审计，**故意带点号**。
- OpenAI 官方与部分严格网关（含 DeepSeek Responses）只接受
  `^[a-zA-Z0-9_-]+$`（长度 ≤ 64）；而 `openai-compat.ts` / `responses.ts`
  当时把 `tool.name` 原样写进请求体。
- 服务端在**调用模型之前**校验 tools 数组，所以与模型、提示词、权限都无关，
  只要工具面里有一个非法名字，整个会话不可用。
- 同一问题也潜伏在历史 `tool_calls[].name` 的重放里：只改 tools 数组不够。

## 影响

- 装一个带工具的插件 / MCP 就足以让严格 provider 的所有对话 400；
  排查时容易误判成插件工具实现、模型配置或提示词问题。
- 只按 index 猜名字没用：工具集合随模式 / 设置变化，必须从**名字字符集**本身定位。

## 结论与做法

- **内部名不迁就服务端**：注册表、落盘、UI、确认链、前缀摘除继续用点号名；
  只在**出站边界**归一。
- 唯一实现 `packages/agent-core/src/llm/toolNames.ts` 的 `createToolNameCodec()`：
  - 非法字符替换为 `_`，截断到 64；同批工具冲突时按排序追加 `_2` / `_3`（确定性，保前缀缓存）；
  - 三处必须同时换：请求体 `tools[].name`、消息历史 `tool_calls[].name`、
    系统提示词里的工具清单（`describeTools`）——提示词写点号、请求体写下划线会诱导模型调用不存在的名字；
  - 模型回传的 `tool_call.name` 在进入循环时解码回内部名，之后落盘 / 事件 / UI 全是内部名。
- **不要**只在 `openai-compat.ts` 或 `responses.ts` 里各写一份：两套协议共用循环层这一道，
  也不会漏掉历史重放。
- 回归护栏：`packages/agent-core/src/llm/toolNames.test.ts` 与
  `packages/agent-core/src/loop/agentLoop.test.ts` 的「插件点号工具名」用例。
- 新接严格 provider 时，先用 `createToolNameCodec()` 打印一遍实际工具名自检；
  真实插件工具集（12 个 classmanagement + 内置工具）已确认全部匹配 `[a-zA-Z0-9_-]+` 且 64 个名字唯一。
