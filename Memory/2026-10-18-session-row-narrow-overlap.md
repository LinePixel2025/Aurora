---
date: 2026-10-18
title: 可拖窄左栏的会话行：flex 三件套的让位顺序与模型徽标容器查询
tags: [UI, chat, 左栏, flex, CSS, 模型徽标, 探针, 坑]
source: 模型自动记录
---

# 左栏会话行「窄栏文字重叠」

## 现象

用户截图：主界面左栏（拖到 200px 夹取下限）里带模型徽标的会话行「文字重叠」——
会话标题整条看不见，只剩模型徽标「deepseek-fl…」+ 时间「01:11」，时间尾部还压在
hover 才出现的归档图标底下。

## 原因

`.nav-item` 里的三件套是同一行 flex：`.item-title`（`flex: 1`，即 `1 1 0%`）、
模型 / Center 药丸（`flex: 0 0 auto`，`.item-llm` 另有 `max-width: 96px`）、
`.item-time`（`flex: 0 0 auto`）。

- 标题 basis 是 0 → **没有可收缩的量**：空间不够时它直接停在 0 宽（标题消失），
  腾出的空间全被固定不收缩的药丸占走；
- 药丸不收缩 + 时间不收缩 → 行内容总和超过 `.nav-item` 内容盒时，**相对时间从右侧溢出**；
- 归档钮是 `.nav-item` 的**兄弟节点**（`opacity: 0` 时也占 24px 位置），溢出部分正好画到它底下。

左栏 200px 时用 CDP 读真实窗口的量（`--nav-w: 200px`，item 宽 138 / 内容宽 118）：
标题 0、徽标 96、时间右缘 168.1 > 归档钮左缘 150 → **相交 18.1px**，
且 `item.scrollWidth − clientWidth = 18`。左栏缺省 240 时标题也只有 ~13px
（同一成因，只是没到 0）。

## 影响

- 用户描述是「文字叠在一起」，实际是标题被挤没 + 时间压到另一个按钮上；只按
  「元素在不在」写的探针全绿（标题、时间、归档钮在 DOM 里都在）。
- 模型徽标是 v0.3.3 起的功能（覆盖态才显示）；只要左栏被拖窄，任何带覆盖的会话行都会中招。

## 结论与做法

- **行内优先级**：标题 > 相对时间 > Center 药丸 > 模型徽标。
- 标题 `flex: 1 1 auto` + `min-width: 3em`（**永远不归零**）；相对时间 `flex: 0 0 auto` +
  `white-space: nowrap`；药丸 `flex: 0 1 auto`（可收缩）；`.nav-item` 加 `overflow: hidden` 兜底
  —— 行内容任何情况下都不许画到归档钮底下。
- 模型徽标用**容器查询**按「行内容宽」让位：`.nav-item` 上 `container-type: inline-size`，
  `@container (max-width: 150px) { .item-llm { display: none } }`。
  ⚠️ 容器查询量的是**内容盒**：实测 item 168（内容 148）隐藏、item 172（内容 152）显示，
  阈值 150 正好卡在内容盒上；别按 border-box 估算。
- 护栏：`chat-nav-narrow.png` 场景（左栏拖到 200 的现场）+ `CHAT_NAV_NARROW_CHECK`，
  200 / 240 两点各压测一次（240 那次是防「为了消重叠把徽标功能删了」）。
  夹具里没有覆盖态会话，压测行用「克隆同组件 `data-v-*` scoped 属性」的临时注入节点构造
  —— **JS 新建的元素不会自动带 scoped 属性**，不克隆就吃不到组件 CSS，探针会假绿。
- 前端视觉 bug 的取证捷径：dev 窗口带 `--remote-debugging-port=9222` 时，用 CDP
  `Runtime.evaluate` 量真实 DOM 矩形 / 读 computed style，`Page.captureScreenshot` 截图。
  窗口被 hide 时 `document.visibilityState === 'hidden'`：宽度过渡不推进、截图会挂起。
