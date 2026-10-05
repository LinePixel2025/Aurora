---
date: 2026-10-06
title: Agent 对话流按请求折叠，图片后置且流式期不能做最终消息分组
tags: [agent, 渲染, 性能, 会话, 坑]
source: 模型自动记录
---

# Agent 对话流请求级折叠

## 现象

- 同一轮 Agent 请求会产生多条助手消息：工具轮正文、工具卡、最终结论。
- 图片由 `show_image` / `generate_image` 挂在其工具轮上，旧实现会在最终结论之前直接出现。
- 如果流式期间对最后一段助手消息执行“选最终正文”分组，每个 text / reasoning 增量都会读取仍在增长的
  `content`，触发整段分组重算，爆发流下会放大帧间隔与主线程占用。

## 原因

- 展示层原先按“一条助手消息”折叠，缺少请求级边界。
- `requestId` 已在 `AgentEvent` 上存在，但没有随消息持久化；历史回放也不知道哪些助手消息属于同一请求。
- 最终结论只能在请求正常完成后确定；流式中的最后一段尚无稳定 final，提前计算既无意义又昂贵。

## 影响

- 过程输出和图片抢先于最终结论，阅读顺序错乱。
- 长请求会留下多把轨迹胶囊，无法给出一次请求的总用时。
- 若把流式最后一组也纳入分组计算，会把性能问题伪装成“分组功能本身慢”。

## 结论与做法

- `StoredMessage` / `NewMessage` / `ChatMessageDto` / `CenterSessionHistoryMessage` 带可选
  `requestId`；`AgentHost` 统一给同请求的用户 / 助手 / 工具消息注入，`SESSION_FILE_VERSION = 7`，
  旧历史缺字段时按相邻助手消息回退分组。
- 正常 `done` 后，以 `requestId` 为边界生成一个工作胶囊（摘要含去重步骤数与端到端总用时）；
  最终结论 = 最后一条正文非空的助手消息；该请求的全部 `displayImages` 去重后放在最终结论之后。
- 流式期间继续走逐消息实时轨迹，图片不提前显示；失败 / 取消 / 轮次或预算暂停不套用折叠，
  保留过程现场。
- **流式期间跳过最后一段的 `selectFinalAssistant`**：它只处理已完成段；否则每个增量都会读取
  growing content 并扩大渲染开销。两端共用 `packages/shared/src/browser/agentTurns.ts` 的纯分组语义。
- `capture` 中读取最终正文时要用 `.bubble > .md`，不能再用 `lastAssistant.querySelector('.md')`：
  展开体里的中间正文也是 `.md`，后者会先命中 `work-message`。
