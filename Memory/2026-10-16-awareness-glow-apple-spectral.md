---
date: 2026-10-16
title: 自感知流光：Apple 光谱 + 只留顶边
tags: [自感知, 流光, UI, 探针, 配置]
source: 模型自动记录
---

# 自感知流光（Apple 光谱，2026-10-16 口径）

## 现象

- 用户要求对齐 iOS Apple Intelligence 的屏幕边缘光：多色、弥散、缓慢，既不是 v33 之前被批「太艳像彩条」的硬边彩虹，也不是 2026-10-11 的单色青绿。
- 2026-10-11 曾扩到四边；2026-10-16 同日两轮后收回为**只保留顶边**。
- 现状：`renderer/awareness-glow/App.vue:5` 为 `EDGES=['top']`，`capture.ts:5504` 为 `edgeNames=['top']`；无 curtain 关键帧。

## 原因

- 「太艳」的根因不是多色，而是饱和度过高、模糊不够、层数太少；Apple 的做法是每层 ≤36% 不透明度、大半径模糊、5 段光谱首尾呼应。
- 只保留顶边是同日最终口径；四边的摆位细节随三边删除不再适用，不要按旧记忆恢复。
- 浮层窗口不走 `bootstrapApp` / Pinia，不知道用户强调色，因此必须自己接 `applyAppearance`；`--glow-accent` / `--glow-soft` / `--glow-ink` 仍从 `--aurora-blue` 派生。
- 类名与关键帧名被截图探针按 `animationName` 断言，改名等于制造假红。

## 影响

- 恢复四边或恢复单色都会与当前口径冲突；只改色令牌而不改光谱结构会丢掉 Apple 观感。
- 不接 `applyAppearance` 会让 `--aurora-blue` 停在主题默认值，冷色主调不跟用户强调色。
- 改类名 / 关键帧名，或让 `color-mix` 的序列化差异进入断言，会让 `awareness-glow` 探针失败。
- 全屏透明浮层若改为不穿透或换窗口层级会挡住桌面点击；OS 级穿透目前只有真机手验，没有自动断言。

## 结论与做法

- 配色：`--glow-rose: #ff6b9d`、`--glow-violet: #bc82f3`、`--glow-cyan: #56d8ff`、`--glow-amber: #ffb347`；冷色主调引用 `--aurora-blue`，`--glow-soft` / `--glow-ink` 由强调色混白 / 混深。每层 ≤36% 不透明度，bloom 模糊 28px。
- 四层：bloom 是 5 个 `radial-gradient`（rose 8% / violet 28% / accent 50% / cyan 72% / amber 92%）；halo 是 100deg 全光谱 + 白色纹理叠加，`color-flow` 18s；line 用 `flow` 8.4s；streak 用 `flow-slow` 11.5s；两轴都动 `background-position`。整体节奏：bloom 10s、sheen 7s、入场 `awareness-glow-enter` 920ms。
- 只保留顶边：`EDGES=['top']`，`--glow-band: 72px`；删除 bottom / left / right 与 curtain（「曾扩四边」只作为 2026-10-11 的一句历史，不恢复摆位细节）。
- 浮层入口 `renderer/awareness-glow/main.ts`：`settings.get()` 读一次 + `settings.onChanged` 订阅，都喂 `applyAppearance`；不要引 `bootstrapApp` 或 Pinia。
- 类名 / 关键帧名冻结：`awareness-glow-bloom`、`awareness-glow-color-flow`、`awareness-glow-flow`、`awareness-glow-flow-slow`、`awareness-glow-enter`；`color-mix` 在 computed style 里序列化成 `color(srgb …)`，探针不依赖这个序列化串。
- 配置：`appearance.awarenessGlow` 默认 `true`（`schema.ts:122`，`AppearanceSchema` 唯一带 `.default(true)` 的字段）；v33 迁移 `v32 → v33`（`migrations.ts:1165`）、`WRITABLE_PATH_OVERRIDES`（`schema.ts:1322`）与 `set_appearance` 第 4 字段（`agent-core/src/tools/appearance.ts:24-29`）保持同步；`FileAwarenessStatus.glowEnabled` 是可选字段，缺字段按开启处理。
- 几何：`main/awareness-glow.ts` 的 `awarenessGlowBounds(displayBounds)` 返回显示器 `bounds` 整块矩形；`ensureAwarenessGlow` 与 `showAwarenessGlow` 必须同口径（建窗与重定位各一处），不要用 `workArea`。
- 探针：只量矩形不量存在 —— 顶边贴屏幕第 0 像素、水平覆盖 ≥95% 视口、厚度远薄于视口；`650ms` 前后 `background-position` 要有真实变化；主进程 `nativeCheck` 断言窗口矩形 ≥ 显示器 `bounds`（容差 1px，Electron 的这一像素差是既存行为）。
- 该场景**不新增 PNG**；OS 级穿透（`setIgnoreMouseEvents(true, { forward: true })` 覆盖整屏仍可点桌面 / 任务栏）已真机手验，但没有自动化断言；改穿透实现、窗口层级或透明窗口参数后需再手验。
- 性能：2026-10-16 定向 capture 量 85 帧，mean 5.57ms（≈60fps）；探针刻意不设阈值。
- CSS 坑：`inset` 简写不接受 `auto` 的写法会被整条丢弃；不要用 `rotate` 给边带摆位（`getBoundingClientRect()` 量的是变换后的盒）；`height: auto` 必须显式写回；探针 / 脚本注释里禁反引号。

> 2026-10-25 合并自 2026-10-11-awareness-glow-mono-accent.md（原口径：单色强调色已作废）
> 2026-10-25 合并自 2026-10-11-awareness-glow-four-edges-toggle.md（原口径：四边流光与摆位坑已作废）
