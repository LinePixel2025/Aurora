---
date: 2026-10-25
title: memory-summary 技能：记忆只增不减的解法与技能名必须 kebab-case 的静默丢弃
tags: [记忆, 技能, 坑]
source: 模型自动记录
---

# memory-summary：记忆整理技能与命名陷阱

## 现象

- 记忆只增不减：截至 2026-10-25 已 **84 条 / 356 KB / 5281 行**，`memory-create` 没有任何删除 / 合并通道。
- 结构漂移比体量更严重：只有 **52/84** 条是标准的四段结构（现象 / 原因 / 影响 / 结论与做法），其余堆了 **136 个**自定义二级小节（「追加：…」/「2026-10-xx 修订」/「结果」/「验证基线」）—— 同一主题的结论被拆在多个日期小节里，读的时候要自己拼。
- 索引 `Memory/README.md` 被 `AGENTS.md` 引用；盘点脚本若不把索引本身算作「存在」，会报假死链。
- 技能名写成 `memory-Summary`（大写 S）时**不会报错**：`SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/`，`parseSkillFile` 校验失败只 `logger.warn` 然后 `return`，目录里文件在、模型侧清单里没有。

## 原因

- `memory-create` 的定位是「沉淀知识」，写入侧天然只增；整理需要按项目现状取证（文件还在不在、口径有没有被后一条推翻），这一步没有技能承载，就没人做。
- 记忆的写法约定只有「四段」，但追加式修订更省事：新结论直接开一个日期小节，旧结论原地不动 —— 这正好是最难读的形态。
- 技能发现是「扫固定根 + 校验 frontmatter」，校验失败是**静默**的（只有日志 warn，没有用户可见的诊断），所以命名不合规 = 技能凭空消失。

## 影响

- 不整理：读一条记忆的成本每年递增；`memory-read` 已改相关性优先，索引主题写得含糊 = 那条记忆**直接失去被召回的机会**。过期数字继续骗人，比没有记忆更糟。
- 命名不合规：以为装好了技能，实际 `/memory-summary` 不存在，排查会跑到「技能根放错」上。

## 结论与做法

1. 整理记忆 = `memory-summary`（`~/.agents/skills/memory-summary`，与 `memory-read` / `memory-create` 同层 rank 500）：只能用户手动触发 —— frontmatter 写 `disable-model-invocation: true` + `user-invocable: true`（四组合里只有这一种既不出现在模型清单、又能被 `/name` 调用）；`userInvocable` 默认 true，要「只手动」必须显式关掉 model 侧。
2. 新技能 / 改名一律 kebab-case 全小写（`memory-summary`，不是 `memory-Summary`）；放好后用 `skill` 工具解析一次看 `Base directory` 是否出现，别只看目录在不在。
3. 整理流程的硬顺序：`scripts/audit.mjs` 取机械事实（规模 / 结构漂移 / 索引死链与漏登记 / 同主题候选 / 标签频次 / 文档引用）→ 逐条判定（失效 / 被推翻 / 过期数字 / 冗杂 / 仍有效 / 存疑，每条都要证据）→ 出清单等用户确认 → 删并 → 精简 + 结构归一 → 重建索引 → 复跑 audit 自检。
4. 删改记忆前先查引用：`AGENTS.md` 挂着 `Memory/2026-10-03-known-limits.md`、`Memory/2026-10-03-shared-renderer-single-source.md`、`Memory/README.md` —— 被引用的那条**改内容不改名**。
5. 三个技能的分工写进 `AGENTS.md`「会话开始先加载项目记忆」：读 `memory-read`、写 `memory-create`、整理 `memory-summary`（手动）。
