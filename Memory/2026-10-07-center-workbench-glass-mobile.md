---
date: 2026-10-07
title: Center 后台工作台毛玻璃与移动端适配的接线口径（含 verify:web 86 基线）
tags: [Center, UI, 毛玻璃, 移动端, 探针, 坑]
source: 模型自动记录
---

# Center 后台工作台毛玻璃与移动端适配

## 现象

用户点名三件事：后台用量页显示不好、移动端适配不行、管理界面也要有官网同款毛玻璃。
重构落地后，一轮里确认了若干「看着能跑、其实会翻车」的接线点，以及一条新的验收基线。

## 原因

- 后台的半透明底（`--center-sidebar/--center-topbar` 约 0.92–0.98）之前磨不到任何东西：
  玻璃要「毛」，元素背后必须有内容——壳层没有氛围层时，`backdrop-filter` 只磨到纯色画布，视觉等于没开。
- 给壳层补氛围层时若顺手给侧栏 / `.workbench` 加 `position: relative; z-index: 1`，
  会把**既有 z 序整个抬走**：壳层 scrim（`--z-sticky=1`）与移动抽屉（`--z-flyout=20`）的
  盖压关系全部改变（workbench 变 z1 后与 scrim 同级、DOM 又在后，scrim 直接失效）。
- `usage-card--total` 若同时挂 `.ui-card`，Center 全局 `#app .ui-card` 是 **ID 选择器**，
  scoped 的背景声明（强调渐变底）永远输给它——样式静默不生效，还不报错。
- ECharts 组件的 `ResizeObserver` 若无条件 `chart.resize()`，滚动条出现 / 消失的宽度抖动
  会把重绘塞进每一帧（桌面端 2026-10-04 性能轮实测过 16 次 >50ms 长任务，网页端同坑）。

## 影响

- 毛玻璃「加了没效果」或「加了但抽屉 / scrim 层级错乱」，都容易被误判成 backdrop-filter 本身的问题。
- 卡片强调底写了不生效，容易在 scoped / 全局之间反复加 !important 乱修。
- 验收基线变了还按旧数字对账：verify:web 现在 **43 场景 × 明暗 = 86**（AGENTS.md 里的
  「74/74（37 场景）」早已滞后，勿按它对账）。

## 结论与做法

- **玻璃配方（与官网顶栏同源）**：`packages/center/web/src/style.css` 新令牌
  `--center-wb-glass`（暗 `rgba(28,34,36,.72)` / 浅 `rgba(255,255,255,.72)`）+
  `--center-glass-blur: blur(22px) saturate(1.4)`；侧栏 / 壳层顶栏 / 控制台 `.main-head` 共用；
  每处都要带 `@supports not (backdrop-filter: blur(1px))` 回退实底。
- **氛围层唯一写法**：`.app-shell:not(.app-shell--public)::before`（absolute inset 0 +
  `z-index:-1`）+ `.app-shell { isolation: isolate }`；**不给侧栏 / workbench 加任何
  z-index / 定位**，原有 scrim / 抽屉 z 序才不被打破。主区与控制台页背景必须透明
  （`.workbench-main`、`.console`），不透明会把光斑盖住。
- **浮在内容上的移动端浮层一律实底**：壳层侧栏抽屉（≤820px 回 `--center-sidebar`）、
  控制台双抽屉（`--bg-raised`，`mobile-single-column` 的 `drawerOpaque` 判据要求 rgb 无 alpha）、
  底部导航（`--center-sidebar`）。玻璃只存在于桌面文档流内的那一份。
- **移动底部导航**：`v-if="!isConsoleRoute"`（控制台有自己的底部标签，双层底栏是大忌）；
  `position: fixed` + **z-index auto**（定位层天然低于 scrim z1 / 抽屉 z20，开抽屉被 scrim 盖住）；
  `.workbench-main:not([data-route='console'])` 垫 `calc(64px + safe-area)`。
- **usage 主卡不挂 `.ui-card`**：独立类完整自绘（边框 / 圆角 / 渐变 / 内高光）。
- **图表 resize 两道闸**：宽度真变 + rAF 合帧，一帧最多一次 `chart.resize()`。
- **表格卡片化是 opt-in**：全局 `.ui-table--cards`（style.css，≤720px 藏 thead、
  `td[data-label]::before` 出字段名）；td 必须补 `data-label`，colspan 行不带属性自动退回块级。
  自动化页没开（保持 min-width 横向滚动）。
- **探针**：新增 `mobile-workbench` 场景钉住（导航 fixed 贴 viewport 底 ±2px、KPI 四卡、
  快捷 chips=3、管理表 thead 隐藏 + td[data-label]、控制台让位）；`usage` 场景 cards 断言 3→4
  （口径变了必须同改夹具）。
- **单测环境坑**：`packages/center/src/model-gateway.e2e.test.ts` 在 Windows 上有
  `ENOTEMPTY: directory not empty, rmdir %TEMP%\aurora-center-gateway-*` 的清理竞态
  （afterEach 删目录时句柄未放），复跑即过——先重跑再排查，别当回归。

## 部署记录（v0.4.6 → 阿里云）

- 线上 `120.24.223.65` 从 `aurora-center:0.4.5` 升级为 `aurora-center:0.4.6`；
  部署包 `/opt/aurora-center/aurora-center-0.4.6-workbench-20261007-171021.tar.gz`（37MB），
  流程同 deploy/README（构建 → `pnpm deploy --legacy` → tar → scp → `docker compose up -d --build`）。
- **SSH 免密必须带 `-i ~/.ssh/lineweb_aliyun`**：默认密钥直接 `Permission denied (publickey)`；
  该专用密钥自 2026-09-27 首次部署起使用，命令模板：
  `ssh -i ~/.ssh/lineweb_aliyun root@120.24.223.65 '<cmd>'`。
- 换装前备份：`backup-workbench-0.4.6-20261007-171517/`（package.json / bin / dist / dist-web /
  Dockerfile / compose + **`.env`**——服务器上确实存在 `.env`（含 AURORA_CENTER_SECRET），
  备份清单里必须包含它）。
- 验证证据：容器 `healthy`（次日复查 Up 20 小时无重启）；线上 CSS（`assets/index-*.css`）含
  `center-wb-glass` ×4 与 `wb-bottom-nav` ×3（新前端确实上线）；域名 200。
- 桌面更新源保持 **0.4.5**（`/api/updates/current` 仍返 0.4.5）——本版无桌面变更，属预期，
  不是漏发。桌面安装包与 blockmap 双投（GitHub + Center 源）本轮未做也不需要。
- 按用户指示**未推 GitHub**（本地 `main` 有新提交 + annotated tag v0.4.6，只完成云端部署）。

