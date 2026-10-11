---
date: 2026-10-11
title: 自感知流光改四边（全屏浮层 + CSS 布局摆位）、appearance.awarenessGlow 开关（v33）
tags: [自感知, 流光, UI, CSS, 配置, 探针, 坑]
source: 模型自动记录
---

# 四周流光与流光开关（v33，2026-10-11）

用户要求：流光效果改为**屏幕四周都有**，并让用户**可以选择是否开启**。选定口径：开关放「通用 → 外观」
第 4 项（AI 也能经 `set_appearance` 改），四边用同一套极光（不加四角光团）。

## 结构口径（改这里之前先读）

- **主进程**：`main/awareness-glow.ts` 的 `awarenessGlowBounds(displayBounds)` 现在返回**显示器 bounds
  的整块矩形**（`round` 后），不再有 72px 高度参数。渲染层只在四条边上画光带，中部完全透明；
  窗口继续 `setIgnoreMouseEvents(true, { forward: true })` + `alwaysOnTop(screen-saver)`，所以
  「覆盖整屏」不等于「挡住整屏」。`ensureAwarenessGlow` 与 `showAwarenessGlow` **必须同口径**
  （建窗几何与重新定位各一处，改一处要改两处）。
- **渲染层**：`renderer/awareness-glow/App.vue` 用 `v-for` 出四条 `.glow-edge`（`data-edge="top|bottom|left|right"`），
  每条内是同一套 `glow-bloom / glow-halo / glow-line / glow-streak`；基础规则与关键帧**只写一份**，
  差异靠两处：① 上下边带 `background-position-x` 流动、左右边带 `background-position-y` 流动；
  ② 摆位（见下面三条坑）。`--glow-band: 72px` 是唯一的厚度来源。
- **可见性**：`shouldShowAwarenessGlow()` 多一条 `awarenessGlow`；调用方 `index.ts` 用
  `current.appearance.awarenessGlow !== false` 兜底（缺字段 = 开）。渲染层页面同时读
  `awareness.status().glowEnabled`（`FileAwarenessStatus.glowEnabled?` 是**可选**字段，避免波及旧夹具）。

## 三个踩过的坑（都会静默失败，值得单独立一条）

1. **CSS `inset` 简写不接受 `auto`**：`inset: 0 auto auto 0` 整条声明非法被丢弃，回落到基准规则的
   `inset: 0 0 auto`，纵向边带被 top+bottom 夹成 **72px 方块**（实测左/右边带只有左上角发光）。
   要 `auto` 就必须用 `top` / `right` / `bottom` / `left` 长手属性。
2. **别用 `rotate` 给边带摆位**：`getBoundingClientRect()` 量的是**变换后**的盒，rotate 摆位时布局盒
   在屏幕外（量到 `left: -72`），探针会报「边带跑到屏幕外」的假失败，而且没法用矩形证明"贴住屏幕边"。
   现在的做法：四条边**全部用布局定位**（纵向边带 `top:0; bottom:0; width:72px; height:auto`），
   只有下边带保留一个 `scaleY(-1)`（把「光幕向屏内渐隐」翻过来）；左右边带改**横向遮罩**适配换轴。
   还要注意 `height: auto` 必须显式写回，否则基准规则的 `height: 72px` 会把纵向边带又压回去。
3. **探针串里写反引号 = 提前终止 template literal**（AGENTS.md 已记，我这次又踩了一次）：
   在探针内部的注释里写了 `` `meanFrameMs` ``，`capture.probe-strings.test.ts` 立刻报
   `第 N 行：'*/' expected.` —— 探针内部的注释一律用「」或单引号。

## 探针与验收口径（v33 起）

- `awareness-glow` 场景的渲染层探针**只量矩形不量存在**：四条 `[data-edge]` 各自贴边、沿边轴覆盖
  ≥95% 视口、垂直方向远薄于视口，且 650ms 前后 `background-position` 真有变化；主进程侧
  `nativeCheck` 断言窗口矩形**≥ 显示器 bounds**（容差 1px：Electron 给的这一像素差是既存行为，
  贴边看 `>=` 而不是逐像素相等）。
- 探针顺带量了帧成本（`meanFrameMs` / `worstFrameMs`，85 帧窗口，**刻意不设阈值**）：
  2026-10-11 实测全屏浮层下 **mean 4.81ms / worst 8.2ms**（≈60fps），四边流光没有肉眼可见的渲染代价。
- 该场景**不新增 PNG**：张数与既有基线一致（本轮全量各 94 项）。
- 「关掉后不出流光」的自动化覆盖在 `main/awareness-glow.test.ts`（可见性）与 `smoke.ts`
  （`appearance.awarenessGlow` 默认 true + 关闭后 `awareness.status().glowEnabled === false` + 还原）。
- **全屏浮层不影响系统级输入（2026-10-11 用户真机确认）**：流光显示时提示条悬停展开、桌面 / 任务栏
  点击、点到下层窗口都正常 —— `setIgnoreMouseEvents(true, { forward: true })` 对「覆盖整屏的透明窗口」
  同样成立，所以「覆盖整屏」不等于「挡住整屏」，这条不是待验风险。
  但这**没有自动化断言**（要 OS 级输入才行：主进程 `sendInputEvent` 到真实屏幕坐标）；
  若将来改动穿透实现、窗口层级或透明窗口的创建参数，需再手验一次上面三项。

## 配置口径

`appearance.awarenessGlow`（v33，默认 `true` = 保持 v33 之前的行为）：
`CONFIG_VERSION 32 → 33`、`AppearanceSchema` 里**唯一**带 `.default(true)` 的字段（`settings:update`
对 `appearance` 是整组浅合并，设置页/工具可能回传"按旧字段集构造的完整对象"，没默认值会被
`SettingsSchema.parse` 判非法 → 整份配置备份重建）、`WRITABLE_PATH_OVERRIDES` 新增一条
（覆盖表判定先于黑名单）、`set_appearance` 增第四字段（`PATHS` / `FIELD_LABELS` / 参数 / `parseAppearance`）、
`settings-hint.ts` 与 docs 06 §12.1、07 §2.2/§5.1、08 §1/§2 同步。

## 本轮实测基线（2026-10-11）

| 项 | 结果 |
| --- | --- |
| `pnpm typecheck` / `pnpm lint` | 全绿 |
| `pnpm test` | **171 文件 / 2554 用例全绿** |
| `node scripts/verify-p1.mjs` | **26/26**，`version=33`、迁移 **33/33** |
| `AURORA_SMOKE=1` | **204/204**（新增 3 条：默认开启流光、关闭后 `glowEnabled=false`、重新开启恢复；另有还原断言改口径） |
| 定向截图（edge-bar / settings-general / awareness-glow） | 全 PASS（`nativeGlass=true`、`appearanceAwarenessGlow=1`、四边 `edgePass` 全 true） |
| 全量截图 dark | **94 项**，失败 2 项且都是既存红：`chat-model-picker.png`（10-10 起就红）+ 本机固有抖动 `chat.png`（自动滚底） |
| 全量截图 light | **94 项**，失败 1 项（`chat-model-picker.png`）；`chat.png` 本轮绿 |
| Center `verify:web` | **88 场景 / 0 失败**（两端未改 `packages/shared/src/browser/**`，跑一遍确认没连带影响） |
