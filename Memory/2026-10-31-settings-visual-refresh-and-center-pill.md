---
date: 2026-10-31
title: 设置页视觉重构（三组侧栏 / 单页头 / 发丝线区组）与左栏 Center 药丸溢出修复
tags: [UI, 设置页, 左栏, Center, 药丸, 容器查询, 截图, 探针, 坑, 口径]
source: 模型自动记录
---

# 设置页视觉重构 + 左栏 Center 药丸

## 现象

1. 用户：「设置页太过冗杂，重构设计，简约、高级」。现场：侧栏 5 个分组标题 + 12 个条目；
   内容区一页 6–7 张卡，每张卡「大标题 + 说明段 + 字段」，字段之间没有分隔；
   多数页面各自覆盖 `.page > .section-card` 的 `--radius-lg` / `shadow-hairline`；
   顶部橙色警示条压过页头；空态全是虚线框。会话管理页甚至没有页头（独立 `.sessions-page` 容器）。
2. 用户：「主界面左侧 session 栏的 `Center` 标识没对齐其他标识，仍会随侧栏宽度溢出」。
3. `ModesPage` 的自动游戏模式开关滑块写的是 `background: var(--surface-1)` —— 令牌表里
   没有这个名（theme.css 只有 `--fill-*` / `--glass-*` / `--bg-*` / `--surface` 不在册），
   滑块透明，开关看起来像一条没有圆点的蓝色胶囊。

## 原因

- 设置页的视觉噪音不是单个值的问题，而是**层级太多**：分组标题 → 卡片标题 → 说明段 →
  字段标签 → hint，再叠 5 个侧栏分组、每卡独立圆角投影、虚线空态。用户看到的是「一摞盒子」。
- `.item-tag`（Center / 模型徽标共用）原为 `flex: 0 1 auto` + `min-width: 0`，但**没有**
  `overflow: hidden` / `nowrap`：可收缩的只是盒子，文字照旧画到药丸外；左栏 200px 时
  行内容宽 ~128px，标题下限 3em + 相对时间已占大半，Center 药丸收缩后「Center」溢出到时间上。
- Center 会话也可能单独覆盖过模型 → 两枚药丸同时存在时必然挤压，原样式没有让位规则。

## 结论与做法

### 设置页（`settings/App.vue` + `settings/settings.css`）

- 侧栏分组 **5 → 3**：本机（通用 / 会话管理 / 模式 / 提醒）、智能（AI 模型 / 语音 /
  Agent 设置 / Computer Use / 文件自感知）、系统（Aurora Center / 插件 / 系统）。
  **条目顺序与标签不变**（`settings-overflow` 探针按 DOM 顺序读标签，断言仍全绿）。
- 侧栏 200 → 208px；条目 34px；分组标题中文不再 uppercase / 大字距；底部署名加发丝线。
- 一页只有一个页头：`.settings .page > header`（标题 `--text-xl` + 一句说明 + 下缘发丝线），
  页面列 `max-width: 780px; margin-inline: auto`，窗口放大后正文不贴右缘。
- 区组统一：`.section-card` 用 `--radius-md`、1px `--glass-border-soft`、**无投影 / 无内高光**；
  `.section-title` 13.5px、`.section-desc` 12.5px 弱色；字段行之间用 58% 透明度的
  `--border-subtle` 发丝线（`.section-card > .field + .field`，`.group-body` 同款）。
- 删掉 5 个页面各自覆盖的 `.page > .section-card { border-radius: --radius-lg; box-shadow: ... }`
  （General / Llm / Advanced / Modes / Notifications），圆角投影从此只在 settings.css 一处。
- 空态与 `data-empty` 退成无框弱色文案（不再虚线框 / 描边 —— 描边 + 填充会被读成输入框）；
  顶部常驻警示条退成「浅底 + 左侧 2px 语义色」；
  设置窗按钮收紧一档（`s-md` 36px、`s-sm` 30px），不位移、只换色。
- 会话管理页补 `class="page sessions-page"` + 页头（标题 / 说明），从此 12 页共用同一骨架。
- 提醒页的四个方式选项：未选中**不描边**（hover 才 fill-1），只在选中态浮出强调色描边。
- 模式卡片圆角对齐 `--radius-md`、去掉投影；开关滑块改 `var(--on-accent)`。

### 左栏 Center 药丸（`chat/components/SessionRow.vue`）

- 两枚药丸统一 `line-height: 18px`（对齐），`overflow: hidden` + `text-overflow: ellipsis`
  + `white-space: nowrap` 兜底。
- Center 药丸 `flex: 0 0 auto`（**不收缩**，否则先被挤成「C…」）；模型徽标
  `flex: 0 1 auto`（可收缩）。
- 容器查询按行内容宽三级让位：`≤190px` 有 Center 时整枚隐藏模型徽标；
  `≤160px` 隐藏 Center 药丸；`≤150px` 隐藏模型徽标。优先级：标题 > 时间 > Center > 模型。
- 探针 `CHAT_NAV_NARROW_CHECK` 扩展：真实行扫描加 `tagOut` / `tagOnTime`；压测同时注入
  Center + 模型两枚药丸，200px 断言两枚都让位，240px 断言 Center 完整（宽 ≥38）且模型让位；
  实测 240 时 Center 宽 48.3、`centerOut -41`、`itemScroll 0`。

## 验收与坑

- 提交前全量验收（2026-11-01 00:11）：`pnpm typecheck` / `pnpm test`（2979）/ `pnpm build`
  全绿；全量冒烟 **271/271**；截图 A 108 条（仅已知范围外 `chat-model-picker` 恒红）
  + onboarding 6 + memory/glow 3，合计 117 条与文档基线一致。
- `AURORA_CAPTURE_WINDOWS=settings` 单轮 38 条检查全 PASS；
  `chat-nav-narrow.png` PASS；`prettier --check` 通过。文档同步改 `docs/07` §2.3 / §2.5。
- **坑（本次修掉）**：全量设置页截图里 `settings-snapshot-list` 偶发 `rows:0` 假 FAIL
  （空态文案「还没有文件备份」），单跑该场景却通过。根因是 `FileSnapshotPort` 的
  `ensureLoaded` **首读即缓存**：场景的 `query.page='agent'` 会先 reload 一次、把
  Agent 页（含 `SnapshotList`）挂载并让主进程端口缓存空索引；`prepare` 之后才写
  `backups/`，运行中的端口不再重读。修法：在 `runCapture` 里、**任何窗口首读之前**
  调 `seedSnapshotFixture(app.getPath('userData'))`（与 `seedChatTtsHistory` 同一口径）。
  别把它当成样式回归，也别只单跑该场景就宣布绿。
- 截图基线数不变（settings 38 + chat 1），没有新增场景；Center 行的人工核对用临时
  `center-` 会话种子跑过一次，**已删除**，不要再把临时种子写回 `seedChatTtsHistory`。
- **另一个与本轮无关的 Windows 抖动**：`packages/center/src/store.test.ts` 的
  「并发 save 不互相踩 tmp」用例偶发 `EPERM: rename ...\tokens.json`（随机 3 次里 1 次失败，
  `--pool=forks` 时通过）。保存链本身是串行的，属系统在 rename 覆盖目标瞬间持有句柄，
  复跑 `pnpm test` 即可回到 2979/2979；别为了让这条绿去改 `JsonStore` 的原子写语义。
