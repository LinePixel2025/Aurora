---
date: 2026-10-07
title: Center Web 壳层与工作台：路由 / 玻璃氛围层 / 移动端
tags: [Center, UI, 毛玻璃, 布局, 坑]
source: 模型自动记录
---

# Center Web 壳层与工作台（2026-10-07，并入官网入口口径）

## 现象

旧 Center Web 未登录只显示一张登录卡，没有官网介绍与下载入口，登录后直接进控制台、顶层导航横排；首包把 ECharts、管理端、Markdown / Mermaid / KaTeX 与中文 TTF 全静态挂在入口。重构补了「官网 / 登录 / 设备授权」三段路由与登录后工作台，并把毛玻璃、移动端与首屏性能一起做掉；落地时确认了若干「看着能跑、其实会翻车」的接线点。

## 原因

- `App.vue` 静态 import 全部页面 → Vite 拆不出非首屏 chunk；Center Web 继承桌面 `theme.css` 的中文字体（命中中文会下载约 24MB TTF）。
- 后台半透明底（`--center-sidebar/--center-topbar` 0.92–0.98）磨不到东西：壳层没有氛围层时 `backdrop-filter` 只磨纯色画布。
- 给壳层补氛围层时若顺手给侧栏 / `.workbench` 加 `position: relative; z-index: 1`，会把既有 z 序整个抬走（scrim `--z-sticky=1`、移动抽屉 `--z-flyout=20`）。
- `usage-card--total` 若同时挂 `.ui-card`，Center 全局 `#app .ui-card` 是 ID 选择器，scoped 背景声明永远输给它。
- ECharts 的 `ResizeObserver` 无条件 `chart.resize()` 会把滚动条宽度抖动塞进每一帧。

## 影响

毛玻璃「加了没效果」、抽屉 / scrim 层级错乱、强调底不生效，都会被误判成 backdrop-filter 或 scoped 本身的问题；基线数字（74 → 84 → 86 → 88 → 102 → 106）散落多份记忆时还容易按旧数字对账。

## 结论与做法

- **路由**：未登录 `#/` 官网首页、`#/login`、`#/device`；官网只读 `GET /api/updates/current`，失败回落 GitHub Releases，不连 WS、不读客户端列表。登录后左侧 220px 固定导航 + 顶部状态条 + 工作区，控制台保留 `设备列表 | 会话流 | 控制面板` 三栏语义。
- **页面拆包**：`App.vue` 里所有非首屏页面一律 `defineAsyncComponent(() => import(...))`；官网首屏不能带 ECharts / 管理端 / Markdown 分包。`landing-page` 场景断言无重型 chunk、首屏 transfer budget 与 `headerGlass`（背景 alpha<1 且 backdrop 含 blur）+ `headerAboveContent`（headerZ > heroZ）。
- **官网顶栏毛玻璃**：`PublicHeader` 用 `--center-header-glass`（暗 `rgba(28,34,36,.72)` / 浅 `rgba(255,255,255,.72)`）+ `backdrop-filter: blur(22px) saturate(1.4)`；`@supports not (backdrop-filter)` 回落 `--center-hero-bg` 实底。层级用 `--center-header-z: 40`（高于内容、低于 tooltip 120 / toast 200；**不许复用 `--z-sticky`**）——此前「透明叠字」的真根因不是背景，而是 hero 与顶栏同为 `z-index: 1`。
- **玻璃配方（与官网同源）**：`--center-wb-glass`（暗 `rgba(28,34,36,.72)` / 浅 `rgba(255,255,255,.72)`）+ `--center-glass-blur: blur(22px) saturate(1.4)`；侧栏 / 壳层顶栏 / 控制台 `.main-head` 共用，每处带 `@supports not (backdrop-filter)` 实底回退。
- **氛围层唯一写法**：`.app-shell:not(.app-shell--public)::before`（absolute inset 0 + `z-index:-1`）+ `.app-shell { isolation: isolate }`；**不给侧栏 / workbench 加任何 z-index / 定位**。主区与控制台页背景必须透明（`.workbench-main`、`.console`）。
- **移动端浮层一律实底**：壳层侧栏抽屉（≤820px 回 `--center-sidebar`）、控制台双抽屉（`--bg-raised`，`drawerOpaque` 判据要求 rgb 无 alpha）、底部导航（`--center-sidebar`）。玻璃只存在于桌面文档流内。
- **移动底部导航**：`v-if="!isConsoleRoute"`（控制台有自己的底部标签）；`position: fixed` + **z-index auto**；`.workbench-main:not([data-route='console'])` 垫 `calc(64px + safe-area)`。
- **字体性能**：`packages/center/web/src/style.css` 覆盖系统优先字体栈，不回改桌面 / shared 资产；`font-system-performance` 断言不加载 HarmonyOS Sans SC。
- **长列表**：设备 / 会话 / 消息行用 `contain: layout paint style` 做重排隔离；**不要改回 `content-visibility: auto`**（会话面板实测滚到底最后一行够不着，`panel-sessions-scroll` 会红）。
- **usage 主卡不挂 `.ui-card`**（独立类完整自绘）；**表格卡片化 opt-in**：`.ui-table--cards`（≤720px 藏 thead、`td[data-label]::before` 出字段名），td 必须补 `data-label`。
- **图表 resize 两道闸**：宽度真变 + rAF 合帧，一帧最多一次 `chart.resize()`。
- **探针**：`mobile-workbench` 钉住导航 fixed 贴底 ±2px、KPI 四卡、快捷 chips=3、管理表 thead 隐藏 + `td[data-label]`；`usage` 场景 cards 断言 3→4（口径变了必须同改夹具）。基线以 `AGENTS.md` / `verify:web` 为准，当前 **106**。
- **测试装置**：`resetAuth()` 必须在哈希前加唯一 query 强制真实文档导航；只改 `window.location.hash` 会被路由守卫在 reload 前改回 console。
- 单测环境坑：`model-gateway.e2e.test.ts` 在 Windows 有 `ENOTEMPTY … rmdir %TEMP%\aurora-center-gateway-*` 清理竞态，复跑即过，别当回归。

> 2026-10-25 合并自 2026-10-07-center-official-site-workbench.md（原口径：v0.4.4/v0.4.5 逐次部署记录与 84 基线、同日顶栏四连包部署史已作废）
