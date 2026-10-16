---
date: 2026-10-16
title: 自感知流光改 Apple Intelligence 光谱 + 只保留顶边 + 删除光帘
tags: [自感知, 流光, UI, CSS, 口径, Apple Intelligence]
source: 模型自动记录
---

# 流光改 Apple Intelligence 光谱（2026-10-16）

## 最终口径（同日两轮迭代）

1. 配色从单色回到 Apple Intelligence 多色光谱（品红→紫→蓝→青→琥珀）；
2. **只保留顶部一条边带**，删除 bottom / left / right 三边；
3. **删除光帘（curtain）动画**，halo 只保留 color-flow。

## 现象

用户要求「重构极光特效，对齐目前 Apple 中 iOS 的极光特效」—— 即 Apple Intelligence / iOS Siri
激活时屏幕四周的「优雅弥散光芒」（官方描述：an elegant glowing light that wraps around the edge
of the screen）。这**推翻了 2026-10-11 的「单色强调色」口径**，回到多色光谱，但做法不同：
v33 之前的彩虹被批「太艳 / 像彩条」，这次对齐的是 Apple 的**液态弥散光** ——
色相之间没有硬边界，靠多层半透明色团 + 大半径高斯模糊 + 缓慢呼吸位移产生深度。

## 原因

- Apple Intelligence 的 Siri 边缘光本身**就是多色光谱**（品红 / 紫 / 蓝 / 青 / 橙），
  不是单色；2026-10-11 改单色是为了修「太艳」，但修过头了 —— 失去了 Apple 的核心视觉特征。
- 「太艳」的根因不是多色本身，而是：饱和度过高 + 模糊不够 + 层数太少 → 高斯模糊后在白底桌面上
  退化成硬边彩条。Apple 的做法是：每层 ≤36% 不透明度、blur 28px（bloom）/ 5–12px（其余）、
  5 段光谱色标首尾呼应（rose → violet → accent → cyan → amber → rose）形成无缝循环。

## 结论与做法

- **光谱调色板**（固定色相，不随强调色变）：
  `--glow-rose: #ff6b9d`、`--glow-violet: #bc82f3`、`--glow-cyan: #56d8ff`、`--glow-amber: #ffb347`；
  冷色主调仍引用 `--aurora-blue`（换强调色时光谱微微偏暖 / 偏冷，与 Apple 一致 —— 它的极光不随主题变色）。
- **四层结构不变**（bloom / halo / line / streak），但每层的色标从单色 mix 改为光谱渐变：
  - bloom：5 个 radial-gradient 沿边带分布（rose 8% / violet 28% / accent 50% / cyan 72% / amber 92%），blur 28px；
  - halo：linear-gradient 100deg 全光谱 + repeating-linear-gradient 白色纹理叠加，background-size 200%，
    color-flow 18s 无缝循环（`0% 0%` → `200% 200%`，双轴动画让左右边带也能纵向流动）；
  - line / streak：光谱高光带，flow 8.4s / flow-slow 11.5s，同样双轴 background-position。
- **左右边带 halo 换轴**（此前只有 line/streak 换轴，halo 没换 → 左右边带的光谱流动方向不对）：
  新增 `.glow-edge[data-edge='left'|'right'] .glow-halo { background-size: 100% 200%; background-repeat: repeat-y; }`。
- **类名与关键帧名一个都没改**：capture 探针按 `animationName`（curtain / color-flow / flow / flow-slow）、
  mask 的 `rgb(0, 0, 0) 0%`、bloom 含 `radial-gradient` 断言 —— 全部保持。
- **动画节奏放慢**（Apple 的极光是「环境光」不是「通知闪烁」）：bloom 9→10s、curtain 11.5→12s、
  color-flow 13→18s、sheen 6.4→7s、flow 7.6→8.4s、flow-slow 10.6→11.5s。

## 实测

- 定向 capture `awareness-glow` 场景：四边 `edgePass` 全 true、`motionChanged` 全 true、
  `meanFrameMs: 5.57`（≈60fps，光谱渐变无额外渲染代价）、`native.coversDisplay: true`。
- `pnpm typecheck` / `pnpm build` 全绿。
- docs/07 §2.2 与 docs/06 §26 已同步为「多色光谱极光 / 对齐 Apple Intelligence」。

## 与 2026-10-11 记忆的关系

`2026-10-11-awareness-glow-mono-accent.md` 记录的「单色强调色」口径**已被本条推翻**。
该文件保留作为历史（它记录了「为什么从彩虹改单色」的决策过程），但**当前生效口径以本条为准**。
浮层窗口接 `applyAppearance` 的做法仍然保留（`--aurora-blue` 参与光谱冷色主调）。
