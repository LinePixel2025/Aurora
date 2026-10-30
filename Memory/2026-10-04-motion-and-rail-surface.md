---
date: 2026-10-04
title: 工作台入场动效与侧栏玻璃材质
tags: [UI, 布局, 毛玻璃, 性能, 探针]
source: 模型自动记录
---

# 工作台入场动效与侧栏玻璃材质

## 现象

- 用户要求四个窗口与 Center Web 都有精美但不占性能的动画，并指出侧栏背景像「矩形套圆矩形」：外层一整块直线玻璃，内部又是一排圆角选中块。
- 设置页切换页面时会停在空过渡态（`pageOpacity: 0 / pageHeight: 0`），连续切换时多个页面都不挂载。
- 玻璃侧栏里的搜索框看起来没有背景；向下滚动后，笔记标题会从 sticky 筛选区后面透出来。

## 原因

- 旧基线只有局部 token / 组件过渡，缺少整窗、三栏和页面首次挂载的统一编排；直接从 `opacity: 0` 启动根级动画时，隐藏窗口、reload 或合成器恢复期间可能迟迟不推进，`AURORA_CAPTURE` 曾实测设置窗只截到透明背景。
- 平铺 `--glass-tint` + 通长 `border-right/left` 会把侧栏和内部圆角项切成两层不相干的盒子；给材质类补四边框会改变盒模型。
- 设置页用 `<Transition name="page" mode="out-in">` 时，新页必须等旧页 `transitionend` 才挂载；透明 body + 原生 Acrylic 的个别合成器状态下事件可能晚到。
- 搜索框第一版用 `--glass-surface`，外层 sticky `.note-filters` 又用「玻璃色 → transparent」渐变；即使换成 `--fill-2`，滚动内容仍会从渐变透明段和侧栏玻璃里透出。

## 影响

- 从全透明开始会让首帧闪烁，甚至让截图 / 低性能设备长时间看不到内容；rAF、常驻 `will-change`、逐条动画长列表会把视觉刷新变成性能事故。
- 补边框会静默挤掉标签 / 工具按钮的可用宽度；`out-in` 会让页面停在不可见状态。
- 搜索框看似坏了，容易先查 DOM / 事件 / IPC；实际只是背景太透明。

## 结论与做法

- 动效统一在 `packages/shared/src/browser/theme.css`：`.anim-window` / `.anim-shell-left` / `.anim-shell-right` / `.anim-pane` 只用于首次挂载；只动 `opacity + transform`（位移 ≤8px、缩放 ≤0.5%），250ms `--ease-smooth`；透明度下限保持 0.92–0.96；不写 `will-change`、不做无限循环、不逐条动画长列表。
- 侧栏材质：`.rail-surface` / `.rail-surface-end` 是左右侧栏、设置侧栏、记忆库笔记列与 Center 导轨的统一材质（连续纵向高光 + 直线内缘 + 渐隐 hairline）；不要再补通长边框、内缘大圆角或改变 `border-width`；内缘大圆角会在三栏接缝切出突兀弧形缺口。
- `prefers-reduced-motion` 继续由全局 1ms 兜底；减少透明度 / 高对比度下关闭侧栏渐变。
- 盒模型：材质类 `.glass-shell` / `.glass-bar` / `.glass-surface` 只写 `border-color`，不写 `border-width` / `border`；完整边框只允许出现在明确的 `.glass-panel` / `.glass` 浮层上。涉及标签条、工具栏、可拖侧栏的视觉改动必须量「可见数量 + 矩形 + 命中」，不能只看元素是否存在；回归锚点是 `chat-ctx-tabs` 的 visible / folded 与 `chat-preview-tool` 的 `toolbarOpened`。
- 设置页：不再使用 `<Transition mode="out-in">`；新页直接挂载，只挂一次性 `.anim-pane` 入场动画，页面能否显示不再依赖旧页动画完成。全局 `.page-*` 的透明度下限保持 0.94–0.96，避免其他页面过渡容器停在全透明。
- 截图：`AURORA_CAPTURE` 的默认 260ms settle 足够落位；若以后再加长入场动画，先确认截图不落在首帧。
- 玻璃侧栏里的固定输入控件必须用**实心底**表达可输入区域：记忆库搜索框用 `color-mix(in srgb, var(--bg-raised) 90%, var(--text-primary) 10%)`，聚焦时切 `--aurora-blue` 边框；不要只叠半透明 fill。
- sticky 筛选区本身必须是全宽不透明层：`.note-filters` 用 `--bg-raised` 实底，负 margin 铺满侧栏内宽并加一条底部分隔 hairline；不能在滚动容器上用透明渐变做 sticky 背景。`--glass-surface` 只适合融进玻璃的容器，不适合需要明确命中边界的独立表单控件。
- 探针：除「输入框存在」外，还要量筛选层的 `background-color` 与滚动后的 `elementFromPoint` 命中，避免只查 DOM 放过透明回归。

> 2026-10-25 合并自 2026-10-05-glass-rail-search-surface.md（原口径：搜索框与 sticky 筛选区并入本条）
