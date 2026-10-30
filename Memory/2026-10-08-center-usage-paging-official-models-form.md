---
date: 2026-10-08
title: Center 用量明细分页与官方模型配置表单的接线口径
tags: [Center, UI, 测试, 坑]
source: 模型自动记录
---

# Center 用量分页与官方模型表单（2026-10-08）

## 现象

用量页「最近请求」只显示 15 条、其余无法翻页；管理端官方模型配置是一堆只有 placeholder 的输入框。重做过程中出现四个「看着能跑、其实会翻车」的接线点。

## 原因

1. **`v-for :key` 用可编辑字段**：模型行原用 `` :key="`${index}-${item.id}`" ``，模型 ID 是输入框，每敲一个字符 key 就变 → Vue 重建 `<tr>` → 正在输入的 input **丢焦点**，只落下一个字符；验证场景还把一个脏模型（id=`v`）保存进了服务端。
2. **`<select v-model>` 遇到 `undefined` 一个都不选**：服务端 llm 模型条目可以**没有** `reasoningEffort`（`normalizeModels` 只在值合法时写入），显示成空白下拉，分不清「没设」和「设坏了」；`modelSignature` 若用 `?? 'auto'` 抹平，会把「未指定 → auto」这类真实改动漏出脏点判定。
3. **`recent` 只有 `limit` 没有 `offset`**：区间明细默认只取 100 条，前端再分页也只能翻这 100 条；而 `daily` / `totals` 本来就按全量算，切片不影响 KPI。
4. **Center 全局 CSS 没有 `.ui-btn` / `.ui-input` 基础件**：完整配方是各页面 scoped 自持的，`UsageView.vue` 与 `OfficialModelsAdmin.vue` 此前没有这一套——按钮 / 输入框其实是浏览器原生外观，这也是「官方模型填写简陋」的一部分。

## 影响

前两条的症状不在报错处（打字打不进去 / 界面有个空下拉），容易去查输入事件或 CSS；分页若用前端「糊」过去，用量稍大就静默截断；缺基础件会让人以为组件没用上设计令牌，实际要在本页补一份而不是全局加（全局加会与各页 scoped 版本打架，且 `#app` ID 选择器会压过 scoped）。

## 结论与做法

- **可编辑字段绝不能当 `v-for` 的 key**：模型行用 `:key="index"`（配 `v-model` 的受控输入，删行不会串值）。同类表单（Provider / MCP / 自动化参数）都按这条检查。
- **`<select>` 的「未指定」要显式建模**：给一个 `value=""` 的「未指定（按 auto）」选项，用 `:value="item.x ?? ''"` + `@change` 手写赋值（不要 `v-model`，undefined 不会命中任何 option）；脏值判定里 `undefined` 与显式值必须分开（`modelSignature` 用 `'（未指定）'` 占位）。
- **用量明细分页走服务端**：`CenterUsageQuery` 增 `offset`、`CenterUsageResponse` 增 `recentTotal`（`filtered.slice(offset, offset+limit)` + `filtered.length`）；网页端每页 15 条（`limit=15` + `offset=(页-1)*15`），页码由 `recentTotal` 推出，筛选变化回第 1 页，目标页越界自动夹回末页并**只重取一次**；请求失败不提交页码、不动表格。
- **官方模型配置三条口径**：① `拉取模型` 是**合并**不是替换（既有条目与开放位 / 参数原样保留，上游新增的 id 默认**未开放**，手写新增默认开放）；② `adminConfig()` 的 `error`（主密钥缺失 / 轮换解不开）必须在卡上展示——此前完全被忽略；③ 前端校验只是服务端规则的提前版，服务端报错原文照旧展示，别两边各写一半。
- **`<label>` 不要包住按钮**：API Key 字段的「显示 / 清除」容器用 `<div>` + `aria-label`（label 会把整行 hover / 点击代理给内部按钮，桌面端 `SettingField` 踩过同款坑）。

## 验收

- `verify/run.mjs` 起假上游（`/v1/models`、`/v1/chat/completions` 带 usage），给子服务器临时 `AURORA_CENTER_SECRET`（只作用临时数据目录），管理员配好 llm 能力后用**桩机自己的 client token** 调 20 次网关灌真实用量；**不要**重新 `/api/client/login`（会顶掉桩机会话）。**每个主题开跑前把这份配置复位**——场景会改服务端状态，不回位就等于让第二档从被污染的起点起跑。
- 分页条文案：`首页 / 上一页 / 第 x / y 页 · 共 N 条 / 下一页 / 末页`（`data-field="usage.page-label"`），边界与 loading 时禁用；截图证据 `usage-pager-<theme>.png`、`official-models-table-<theme>.png`（场景内单独截图）。
- 基线：`verify:web` **106**（以 `AGENTS.md` 为准），别再按 88 / 102 对账。
