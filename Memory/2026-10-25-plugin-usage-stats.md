---
date: 2026-10-25
title: 插件用量统计（ctx.usage）：本机按日账本、权限口径与面板取数的坑
tags: [插件, 用量, Token, 生图, 语音, 隐私, 探针, 坑, 口径]
source: 模型自动记录
---

# 插件用量统计（`ctx.usage`，2026-10-25）

## 现象

插件需要读取「用户近 30 天的 Token 用量（总量 + 缓存命中）」与「生图次数 / 语音模型使用次数」。
项目里已有两种看似可用的数据，实际都不够：

- `SessionStore.usageTotals(prefix)` 只有**跨会话累计值**，没有逐日时间戳；
- Center 的 `usage` 只记录经 Center 网关的请求，本机直连 provider 的用量不在里面。

## 原因

`meta.usage` 是「每会话累计」，会话文件只有 `updatedAt`；把整个会话的累计值按 `updatedAt`
归到某一天会把两个月前的消耗算成今天，属于伪造数据（与本项目「provider 没回传 usage 就
不伪造 0」的口径冲突）。因此必须新建**逐日计数账本**，从引入接口的版本开始累积，不回溯。

## 影响

- 若改成从会话累计值反推，插件面板上的「近 30 天」会与实际用量严重不符；
- 若把 Token 统计只做在 Center，本机模型用户会看到全 0；
- 若漏掉 `tokens.background`，后台自感知的消耗会与用户主动对话混在一起，无法解释。

## 结论与做法

### 接口与权限

- 新权限 **`usage`**（安装确认可见）：`ctx.usage.summary({ days? })`；
  `days` 缺省 30、夹取 1–90；RPC 调用名 `usage.summary`。
- 返回 `{ days, from, to, tokens: { promptTokens, completionTokens, totalTokens,
  cachedTokens, rounds, cacheHitRate, background }, images: { generated },
  voice: { tts, ttsChars, stt, sttChars }, daily: [{ date, tokens, images, voice }] }`。
- `daily` 含窗口内**每一天**（空白日为 0），前端可直接画折线。
- 只返回计数：不含提示词 / 回复 / 图片 / 音频 / 文件名 / 凭据。

### 账本

- `apps/desktop/src/main/usage-stats.ts` → `<userData>/usage-stats.json`
  （`version:1`，`days: { 'YYYY-MM-DD': {...} }`），本地日期分桶，保留 90 天。
- 记录点：`createProviderFactory` 的 `onUsage`（包住 `LoopProvider.chat`，每轮流收尾按
  `done.usage` 记一次；主对话 / 子代理 / 摘要 / 后台自感知都覆盖，背景按 `awareness-`
  前缀拆 `background`）；`imageGenService.generate` / `sttService.transcribe` /
  `tts.synthesize` 三处 wrapper 的**成功返回**后计数（失败 / 回落失败的中间态都不计）。
  ⚠️ 不要改回只订 `AgentHost` 的 `usage` 事件：子代理 / 摘要的轮次不转发该事件，会漏计。
- 内存态 + 1s 防抖原子写；退出 `shutdown()` 里必须 `flush()`（`usage-stats.json` 独立于
  settings，不升 `CONFIG_VERSION`）。
- 历史不回溯：账本从本版本开始累积，文档要如实写明。

### 测试 / 探针

- 单测：`usage-stats.test.ts`（分桶、命中率、窗口夹取、90 天清理、损坏归化）+
  `manager.test.ts`（权限拒绝、`days` 透传、非法 `days`）。
- 冒烟：示例插件加 `hello-usage` **action 命令**读取 `ctx.usage.summary` 并回一句话；
  基线从 262 → **263/263**。
- ⚠️ `plugins.panelData` 只回 `schema` / `toast`，**不回 `data`**（页面型面板走 `plugins:pageRpc`）；
  想在冒烟里拿插件返回的数据，要么用 action 命令的 `summary`，要么走页面 RPC，
  不要对 `panelData` 断言 `data`。

### 容易漏的接线

- 独立工具包 `plugin-dev-kit/tools/check-plugin.mjs` 自带一份 `PERMISSIONS` 集合，
  新增权限要同步（它不依赖 Aurora 工作区）；`scripts/verify-plugin.mjs` 走 shared schema，不需改。
- 改 `packages/shared/src/plugin/**` 后先 build shared，再跑下游 typecheck / dev / smoke。
- 文案同步：`docs/14`（权限 + §4.1）、`docs/15`（权限 + `ctx.usage` + §4.1.2）、
  `docs/11-privacy.md`（账本文件与只读聚合）、`plugin-dev-kit/docs/01|02` 与三份
  `types/aurora-plugin.d.ts` 副本。
