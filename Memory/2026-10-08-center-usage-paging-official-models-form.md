---
date: 2026-10-08
title: Center 用量页明细分页与官方模型配置表单的接线口径（含 verify:web 夹具与 88 基线）
tags: [Center, UI, 分页, 模型, 验收, 坑]
source: 模型自动记录
---

# Center 用量分页与官方模型表单

## 现象

本轮做两件事：用量页「最近请求」只显示 15 条、其余翻页；管理端官方模型配置从「一堆只有
placeholder 的输入框」重做成有字段名 / 说明 / 校验的表单。过程中出现四个「看着能跑、其实会翻车」
的点，以及一条新的验收基线。

## 原因

1. **`v-for :key` 用可编辑字段**：模型行原本用 `` :key="`${index}-${item.id}`" ``。模型 ID 是输入框，
   每敲一个字符 key 就变 → Vue 重建 `<tr>` → 正在输入的 input **丢焦点**，结果只落下一个字符。
   验证场景「输入重复 id 应报错」直接红，顺带把一个脏模型（id = `v`）**保存进了服务端**，
   同一轮里 light 主题从被污染的状态起跑、连带失败一片。
2. **`<select v-model>` 遇到 `undefined` 一个都不选**：服务端的 llm 模型条目可以**没有**
   `reasoningEffort`（`normalizeModels` 只在值合法时写入），显示成空白下拉，管理员分不清
   「没设」和「设坏了」。另外 `modelSignature` 若用 `?? 'auto'` 抹平，会把「未指定 → auto」这类
   真实改动漏出脏点判定。
3. **`recent` 只有 `limit` 没有 `offset`**：区间明细默认只取 100 条，前端再分页也只能翻这 100 条，
   「剩下的」永远取不到；而 `daily` / `totals` 本来就是按全量算的，切片不影响 KPI。
4. **Center 全局 CSS 没有 `.ui-btn` / `.ui-input` 基础件**：只有 `style.css` 里几条 `#app .ui-*`
   覆盖（圆角），完整配方是**各页面 scoped 自持**的。`UsageView.vue` 与 `OfficialModelsAdmin.vue`
   此前没有这一套 —— 按钮/输入框其实是浏览器原生外观，这也是「官方模型填写简陋」的一部分。
   （`ReleaseAdmin.vue` 至今仍缺，属同一类，未动。）

## 影响

- 第 1、2 条都属于「症状不在报错处」：前者表现为「打字打不进去 / 只输入一个字符」，
  后者表现为「界面有个空下拉」；不记住会去查输入事件或 CSS。
- 第 3 条若用前端分页「糊」过去，用量稍大就会静默截断——界面看着有页码，实际只能翻已经取回的那些。
- 第 4 条会让人以为组件没用上设计令牌；实际是**缺基础件**，要在本页补一份而不是全局加
  （全局加会与各页 scoped 版本打架，且 `#app` ID 选择器会压过 scoped）。

## 结论与做法

- **可编辑字段绝不能当 `v-for` 的 key**：模型行用 `:key="index"`（配 `v-model` 的受控输入，
  删行不会串值）。同类表单（Provider / MCP / 自动化参数）都要按这条检查。
- **`<select>` 的"未指定"要显式建模**：给一个 `value=""` 的「未指定（按 auto）」选项，用
  `:value="item.x ?? ''"` + `@change` 手写赋值（不要 `v-model`，undefined 不会命中任何 option）；
  脏值判定里 `undefined` 与显式值必须分开（`modelSignature` 用 `'（未指定）'` 占位）。
- **用量明细分页走服务端**：`CenterUsageQuery` 增 `offset`、`CenterUsageResponse` 增 `recentTotal`
  （`filtered.slice(offset, offset+limit)` + `filtered.length`）；网页端每页 15 条
  （`limit=15` + `offset=(页-1)*15`），页码由 `recentTotal` 推出，筛选变化回第 1 页，
  目标页越界自动夹回末页并**只重取一次**；请求失败不提交页码、不动表格。
- **官方模型配置三条口径**：① `拉取模型` 是**合并**不是替换（既有条目含开放位/参数原样保留，
  上游新增的 id 默认**未开放**，手写新增默认开放）；② `adminConfig()` 的 `error`（主密钥缺失 /
  轮换解不开）必须在卡上展示——此前完全被忽略；③ 前端校验只是服务端规则的提前版，
  服务端报错原文照旧展示，别两边各写一半。
- **`<label>` 不要包住按钮**：API Key 字段带「显示 / 清除」按钮，容器用 `<div>` + `aria-label`
  （label 会把整行 hover / 点击代理给内部按钮，桌面端 `SettingField` 踩过同款坑）。
- **验收夹具（v0.4.7）**：`verify/run.mjs` 起假上游（`/v1/models`、`/v1/chat/completions` 带 usage），
  给子服务器临时 `AURORA_CENTER_SECRET`（只作用临时数据目录），管理员配好 llm 能力后用
  **桩机自己的 client token** 调 20 次网关灌真实用量；**不要**重新 `/api/client/login`（会顶掉桩机会话）。
  **每个主题开跑前把这份配置复位** —— 场景会改服务端状态，不回位就等于让第二档从被污染的起点起跑
  （本轮实测踩到）。
- **基线**：verify:web 从 86 → **88**（43 场景 × 暗浅两档 ＋ `theme-dark`/`theme-light` 两个单档场景）。
  `AGENTS.md` 里旧的 74 已更正；docs/12 §10 的场景清单与 §12.3/§12.4 同步补了分页与配置口径。
- 分页条本身用 `首页 / 上一页 / 第 x / y 页 · 共 N 条 / 下一页 / 末页`（`data-field="usage.page-label"`），
  边界与 loading 时禁用；截图证据在 `usage-pager-<theme>.png`、模型表在
  `official-models-table-<theme>.png`（场景内单独截图，标准截图为「结束时的整屏」）。

## 部署记录（v0.4.7 → 阿里云，2026-10-08）

- 本版只动 Center：`packages/center` 与 root / apps/desktop 一起升到 **0.4.7**
  （镜像 tag 跟版本号走，别在同一 tag 上覆盖），`docs/release-notes/v0.4.7.md` 已写；
  **桌面安装包未重新发布**，线上更新源仍是 0.4.5，属预期。
- 部署包：`/opt/aurora-center/aurora-center-0.4.7-usage-paging-20261008-134027.tar.gz`（36.3 MB），
  流程同 `deploy/README`：`shared build` → `center build` → `pnpm --filter @aurora/center deploy --prod --legacy`
  → 删 `src/web/verify/deploy/tsconfig*.json/vite.config.ts` → 拷 Dockerfile + compose → tar → scp
  → `docker compose up -d --build`。
- 换装前备份：`backup-usage-paging-0.4.7-20261008-134050/`（bin / dist / dist-web / package.json /
  Dockerfile / docker-compose.yml + **`.env`**）。容器 `healthy`、`restarts=0`、`/` 与
  `/api/updates/current` 均 200，`data/`（clients.json / model-services.json / releases）未被触碰，
  容器内 `AURORA_CENTER_SECRET` 长度 65（仍注入，值不记录）。
- **验证「新前端真的上线」要看懒加载分包**：`#/usage`、`#/admin` 是 `defineAsyncComponent` 拆出来的，
  标记（`usage-pager` / `official-models-table`）在 `UsageView-*.{js,css}`、`AdminView-*.{js,css}` 里，
  **不在首屏 `index-*.css`** —— 只查首屏 CSS 会误判成「部署没生效」。
- **GitHub 连通性是间歇的，别按一次探测就下结论**：本轮 `git ls-remote` 与 `ssh.github.com:443`
  两次探测都超时（与 2026-10-07 同一现象），但几分钟后重试 `git push` 直接成功
  （`ef6d16e..715c32d`，12 个提交）。做法：先提交、先把 Center 部署做完，末尾**重试一次**推送。
  断网期间**不要**给版本打 tag（release 脚本发布时会自己建，重复的 tag 会让发布流程卡住）；
  安装包未重新发布，故本版只有本地/远端提交 + 云端部署，没有 tag、没有 GitHub Release。
  > **2026-10-16 更正**：「重试即推送成功」只适用于偶发抖动窗口。`github.com` 被**整域掐断**时
  > HTTPS 重试无效（`api.github.com` / `codeload` 仍可达，`gh` 一切正常，容易误判成"再等等"），
  > 正确做法是改走 SSH 443 的一次性 URL —— 见
  > [2026-10-16-github-https-blocked-ssh443-push.md](2026-10-16-github-https-blocked-ssh443-push.md)。
- SSH 仍必须带 `-i ~/.ssh/lineweb_aliyun`；另外 **PowerShell 用管道把多行脚本喂给 `ssh 'bash -s'`
  会被截断**（只跑出第一段），要么写成单行命令、要么 scp 一个 .sh 再 `bash /tmp/x.sh`。
