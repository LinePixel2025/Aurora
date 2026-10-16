---
date: 2026-10-11
title: 自感知流光改强调色单色（与提示条卡片同源）、浮层窗口要自己接 applyAppearance
tags: [自感知, 流光, UI, CSS, 口径]
source: 模型自动记录
---

# 流光单色强调色口径（2026-10-11）

> **⚠️ 已被推翻（2026-10-16）**：配色口径改回多色光谱，对齐 Apple Intelligence。
> 当前生效口径见 [2026-10-16-awareness-glow-apple-spectral.md](2026-10-16-awareness-glow-apple-spectral.md)。
> 本文件保留作为历史决策记录（「为什么从彩虹改单色」），但不再代表当前实现。
> 浮层窗口接 `applyAppearance` 的做法仍然有效。

## 现象

用户点名 v33 的四边彩虹流光「有点丑」（截图里顶部边带青→蓝→紫→粉→橙太艳），选定改法：
**四边都保留**，配色换成提示条「正在感知」卡片那种**青绿单色柔光**。

## 原因

- 彩虹渐变跨色相太大，高斯模糊后在白底桌面上像彩条；左右边带又把近横向渐变压进 72px 竖条，
  观感退化成静态色带。
- 卡片的青绿不是固定色，而是 `--aurora-blue`（该用户强调色 = teal `#14b8a6`）；
  流光浮层不走 `bootstrapApp` / Pinia，此前根本不知道强调色，只能硬编码彩虹。

## 影响

- 把流光**硬编码成青绿**是错的：换强调色后四边光幕与卡片分叉成两套色。
- 浮层窗口**不接 `applyAppearance`** 也不行：`var(--aurora-blue)` 会永远停在主题默认蓝。

## 结论与做法

- 配色唯一色源 = `--aurora-blue`：`--glow-accent` 直接引用，`--glow-soft` = 42% 混白（薄荷高光），
  `--glow-ink` = 72% 混深色（波谷）；四个图层（bloom / halo / line / streak）的色标全部
  `color-mix(..., transparent)`，**明暗起伏替代色相流转**做层次。
- `renderer/awareness-glow/main.ts` 里直接接：`settings:get` 读一次 + `settings.onChanged` 订阅，
  都喂给 `applyAppearance`（浮层保持零 Pinia 开销，别为它引 bootstrapApp）。
- **类名与关键帧名一个都不许改**：capture 探针按 `animationName`（curtain / color-flow / flow /
  flow-slow）、mask 的 `rgb(0, 0, 0) 0%`、bloom 含 `radial-gradient` 断言；`color-mix` 在
  computed style 里序列化成 `color(srgb …)`，不碰这些子串。
- 实测：定向 awareness-glow 场景 `edgePass` / `motionChanged` 全 true，meanFrameMs 5.53
  （≈60fps，`color-mix` 无渲染代价）；docs 07 §2.2 与 06 §26 已同步为「单色极光」。
