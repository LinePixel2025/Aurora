---
date: 2026-10-05
title: Center Web 的 mobile-single-column 探针读在动画中途，基线就红
tags: [center, 验收, 探针, 坑]
source: 模型自动记录
---

# mobile-single-column 的 offCanvasWhenClosed 恒红

## 现象

`pnpm --filter @aurora/center verify:web` 每次都红两条（dark / light 各一条），
场景固定是 `mobile-single-column`，失败判据只有一条 `offCanvasWhenClosed`：

```
hidden = { left: 3, width: 318, opacity: "0.923", pointerEvents: "none",
           transform: "matrix(0.997, 0, 0, 0.997, -7.7, 0)" }
```

断言要 `left < 0 或 opacity === 0`，读数两条都不满足。

## 原因

探针在 `await fresh(ctx)` 之后**立刻**调用 `railOf()` 读抽屉几何，**不等收起动画跑完**
（见 `packages/center/verify/scenarios.mjs` 的 `mobile-single-column`）。
opacity 0.92 / translateX -7.7px 正是动画刚起步的中途值，不是"抽屉没关"。
机器越忙越容易拍到，属于竞态而不是产品回归。

2026-10-06 v0.4.3 定向复跑又发现真实叠加因：移动抽屉挂了共享 `.anim-shell-left/right`
入场动画，而该动画的 `animation-fill-mode: both` 会在动画结束后继续用终帧
`opacity: 1 / transform: none` 覆盖抽屉自己的关闭态。探针刚跑时读到的是动画中途值，
等满后反而稳定读到“视觉打开、pointer-events: none”。因此这里既有探针读太早，
也有真实的 CSS 状态覆盖缺陷。

## 证据

把 `packages/shared/src/browser/theme.css` 与 `packages/center/web/src/App.vue` 用
`git stash` 撤回基线、重建 shared + center 后再跑同一条场景，读数几乎一模一样
（dark `0.923`、light `0.937`）—— 所以**与当次的图标 / 品牌标改动无关**，基线本来就红。

## 结论与做法

- 看到这条红先别改产品代码：它是**探针读太早**，不是抽屉真的没收起。
- 要修就修探针：测量前等一次"收起态成立"（`opacity === '0'` 或 `transitionend`），
  **不要靠 `sleep(200)` 碰运气** —— 那是把竞态换成另一个竞态。
- 2026-10-06 v0.4.3 发布验收已按上述方式落地：`scenarios.mjs` 在 `railOf()` 前等待
  `[data-field="rail-container"]` 的 computed opacity 变为 `0`，超时才判 FAIL；
  `ConsoleView.vue` 同时给移动端 `.rail-drawer` / `.panel-drawer` 加 `animation: none`，
  让关闭态由抽屉自己的 `opacity / transform` 决定。dark / light 定向复跑应回到全绿。
- 这条与 `apps/desktop` 的 `chat-follow-burst` 假 FAIL 是同一类问题：
  **筛选跑 / 时序跑的 FAIL 先用全量或基线复现确认**，别直接当成回归。
