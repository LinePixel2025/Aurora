---
date: 2026-10-05
title: 自感知后台模型必须严格、记忆过期只停用不删除
tags: [自感知, 模型, 记忆, 隐私, 坑]
source: 模型自动记录
---

# 自感知后台模型与记忆过期

## 长期口径

- `fileAwareness.backgroundModel.providerId` 为空时跟随全局 `llm.active`；显式选择后，
  后台分析必须严格使用该 provider + model。provider 被删除、模型为空、Base URL / Key
  缺失时**暂停队列并显示原因，不回落主模型**，避免把文件正文发给用户未选择的接收方。
- `visionReady`、提取图片开关与提示条模型标签都必须按**有效后台模型**计算，
  不能继续读全局主模型的 `vision`。
- 记忆过期策略只控制 Agent 可见性，**不删除**状态和 Markdown：
  `inherit` 按 `updatedAt + defaultMemoryTtlDays` 计算并在重新分析后续期；
  `never` 永不过期；`at` 是固定绝对时间，不随更新续期。
- 过期记忆仍可在记忆库和 `INDEX.md` 查看，但后台 `candidatesFor`、`awareness_recent` /
  `awareness_search` / `awareness_read` 都必须排除它；`awareness_recent` 还要按
  `noteId` / `sourcePath` 排除同源运行记录，否则会从运行摘要侧泄漏过期内容。

## 配置与状态

- `CONFIG_VERSION = 29`：`fileAwareness` 新增 `defaultMemoryTtlDays` 与
  `backgroundModel`，`v28 → v29` 迁移默认 `0` 与空串。
- `file-awareness/state.json` 版本为 `v3`；旧笔记缺 `expiry` 时归一为
  `{ mode: 'inherit' }`，默认天数 0 时行为与升级前一致。

## UI 约定

- 设置窗顶部必须是完整 32px `.titlebar-drag`，跨满窗口；窗口按钮在带内并 `no-drag`。
  不要再退回只有侧栏小条 / 内容区 10px 拖动带的局部实现。
- edge-bar 文件提醒标题与正文完整换行并撑高卡片；多条提醒只在列表自身滚动，
  不可重新加回单行省略或两行截断。

## 顺手修复的探针假红

Automation 历史弹窗在 Agent / Normal 快速切换时保留旧 `runs`，探针会把旧 Agent 记录
当成 Normal 记录。`openHistory()` 打开时先清空 `runs`，由 loading 态承接重读；
这不是产品行为回退，而是避免旧标签数据以新标签身份闪现。
