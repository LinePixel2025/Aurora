---
date: 2026-10-05
title: 应用图标改设计稿，同时修掉托盘与 exe 图标在打包后丢失
tags: [图标, 打包, electron-builder, 坑]
source: 模型自动记录
---

# 应用图标与打包

## 现象

1. 装好的 Aurora 托盘里显示的是那颗内置的极光绿**圆点兜底图**，不是产品图标。
2. 安装目录里的 `Aurora.exe`、快捷方式、任务栏图标是 **Electron 默认的原子图标**。

## 原因

1. `apps/desktop/electron-builder.yml` 的 `files` 只收 `out/**` 与 `package.json`；
   托盘图标是 `apps/desktop/resources/tray.png`，**没进 `extraResources`**。
   打包后 `process.resourcesPath/tray.png`（`src/main/index.ts` 的 `resolveTrayIcon`
   第一候选）不存在，函数返回空串，`loadIcon` 于是用 `FALLBACK_ICON_DATA_URL`。
2. `win.signAndEditExecutable: false` 跳过的是**整个 exe 资源编辑步骤**，不只是签名 ——
   `win.icon` 因此从未写进 exe，图标与版本信息一起丢失。

## 影响

两条都只在**打包后**出现，`pnpm dev` 下看一切正常，所以很容易一路带到发布。
图标属于最外层的品牌信号，用户第一眼就会看到错的那张。

## 结论与做法

- 托盘的图片资产必须显式进 `extraResources`：
  `- from: resources/tray.png` / `to: tray.png`。`files` 的白名单不会顺带带上它。
- 「不签名」不要用 `win.signAndEditExecutable: false`，要用 **`win.signExecutable: false`**：
  前者连 exe 资源编辑一起跳，后者只跳签名、图标与版本信息照常写入。
- 资源编辑在 electron-builder 26.15.3 走自带 `app-builder`，**不会**触发 winCodeSign 下载
  （2026-10-05 实测：`%LOCALAPPDATA%\electron-builder\Cache` 里没有 winCodeSign，
  `electron-builder --win --dir` 仍成功并写入了图标）。winCodeSign 只在真正签名时才需要。
- 验证方式：`--dir` 打包后直接查 `release/win-unpacked/resources/tray.png` 是否存在，
  并用 `[System.Drawing.Icon]::ExtractAssociatedIcon('...\Aurora.exe')` 把 exe 图标导出成
  PNG 肉眼核对 —— 两项都比读配置可靠。

## 图标生成

- 设计稿唯一来源：`scripts/assets/aurora-icon.png`（811×778 8bit RGBA）。
  `pnpm icons` 居中裁成正方形后用**面积平均**重采样出 16/24/32/48/64/128/256，
  产出 `tray.png` / `tray-16/32.png` / `icon-64/256.png` / `icon.ico`（7 条目）。
- 缩到 16px 时一个目标像素要平均约 48×48 个源像素，**不能用最近邻**，否则托盘严重锯齿。
- 换图标 = 换那张 PNG 再跑 `pnpm icons`，不要手改派生出来的 PNG / ICO。
