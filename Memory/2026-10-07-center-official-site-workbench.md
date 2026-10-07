---
date: 2026-10-07
title: Center 官网入口、登录后工作台与首屏性能的长期口径
tags: [Center, UI, 官网, 性能, 字体, 坑]
source: 模型自动记录
---

# Aurora Center：官网入口与工作台重构

## 现象

旧 Center Web 无论是否登录都直接进入控制台，未登录只显示一张登录卡片；顶层导航是横排按钮，
官网介绍与下载入口不存在。页面还可以正常使用，但首包把 ECharts、管理端、Markdown /
Mermaid / KaTeX 等全部静态挂在入口，加上共享 `theme.css` 里的中文字体 TTF，首屏体积和加载成本
明显高于实际需要。

## 原因

- `App.vue` 静态 import 全部页面，Vite 无法把非首屏视图拆成动态 chunk。
- Center Web import 桌面同源 `theme.css`，也继承了 HarmonyOS Sans SC 三个完整字重；
  浏览器命中中文文本后会下载约 24MB TTF。
- 会话列表、设备列表和长消息流原先没有布局隔离；同时有 `TransitionGroup` 与全量重渲染风险。

## 结论与做法

- **未登录路由**：`#/` 是官网首页，`#/login` 是登录 / 注册，`#/device` 是设备授权。
  官网只读 `GET /api/updates/current`，展示版本与安装包入口；接口失败或未发布时回落
  GitHub Releases。官网不连接 WebSocket、不读取客户端列表。
- **登录后路由**：左侧 220px 固定导航 + 顶部状态条 + 工作区；控制台仍保留
  `设备列表 | 会话流 | 控制面板` 三栏语义，但页面样式改为 Center 自己的控制面视觉，
  不再与官网首屏使用同一强度的装饰。
- **页面拆包**：`App.vue` 里所有非首屏页面一律 `defineAsyncComponent(() => import(...))`。
  官网首屏不能带 ECharts、管理端、Markdown / Mermaid / KaTeX 分包；`landing-page`
  验证场景同时断言无重型 chunk 与首屏 transfer budget。
- **官网顶栏必须有完全不透明实底**：`PublicHeader` 使用 `--center-hero-bg` 实底，
  顶部仅叠加不透明渐变高光，不能用半透明 `background` 或仅靠 `backdrop-filter`。
  否则滚动时下方 hero 内容会透出并叠字。`landing-page` 的 `headerOpaque` 判据负责回归。
- **字体性能**：Center Web 在 `packages/center/web/src/style.css` 覆盖为系统优先字体栈，
  不回改桌面 / shared 字体资产。`font-system-performance` 断言不加载 HarmonyOS Sans SC
  资源；若以后要用随包字体，先解决中文 TTF 体积或子集化，不要直接删这条探针。
- **长列表**：设备行、会话行、消息行使用 `contain: layout paint style` 做重排隔离。
  **不要改回 `content-visibility: auto`**：会话面板实测 `scrollTop = scrollHeight`
  后最后一行仍因项目尺寸重新估算而够不着，`panel-sessions-scroll` 会红。
- **测试装置**：`resetAuth()` 必须在哈希前加唯一 query 强制真实文档导航；只改
  `window.location.hash` 会被应用的路由守卫在 reload 前改回 console。

## 验证基线

- Center 单测：`pnpm vitest run packages/center/src`，129/129 通过。
- 全仓单测：2515/2515 通过；全仓 typecheck 通过。
- Center 网页验收：`AURORA_CWEB_OUT=... pnpm --filter @aurora/center verify:web`，
  42 场景 × 明暗两档 = **84/84** 通过。
- 构建产物的入口 JS 从约 1.34MB 降到约 655KB；首屏不再加载中文 TTF、ECharts 或 Markdown
  重型分包。

## 2026-10-07 阿里云部署记录

- 线上 `120.24.223.65` 从 `aurora-center:0.4.4` 升级为 `aurora-center:0.4.5`，
  部署包为 `/opt/aurora-center/aurora-center-0.4.5-ui-20261007-142841.tar.gz`（约 37MB）。
- 升级前备份目录：`/opt/aurora-center/backup-ui-0.4.4-20261007-142934`，
  含旧代码、依赖、`data/` 与 `.env`。
- 部署后 `docker inspect` 健康状态为 `healthy`；外网验证：
  `/`、`/aurora-console-preview.png`、`/api/updates/current` 均返回 200，
  当前 release 仍为 `0.4.5`，`latest.yml` 与安装包资产未受前端升级影响。
