---
date: 2026-10-03
title: 本仓库的构建 / 运行环境坑（dist 陈旧、Electron 环境变量、无 TTY）
tags: [构建, 环境, pnpm, Electron, 坑]
source: 模型自动记录
---

# 构建与运行环境坑

## 现象

1. 改了 `packages/shared/src/**` 或 `packages/agent-core/src/**` 后，`apps/desktop` 对着旧类型报错：常见是共享包「no exported member」、agent-core 新加的方法在 `main/ipc.ts` 里报 `TS2339`（看着像自己写错了）。
2. 单测全绿、端到端却按旧行为走且无报错：`pnpm dev`（含 smoke / capture）跑的也是两个包的 `dist`。
3. `pnpm dev` / `AURORA_CAPTURE` 起不来，主进程在 `!electron.app.isPackaged` 这行崩（`Cannot read properties of undefined`）。
4. Electron 二进制下载失败（企业代理 / 证书拦截），`pnpm install` 装不上运行时。
5. 同一台机器上别的 dev server 占着 5173，`electron-vite dev` 换到 5174。
6. 非交互环境（无 TTY）下 pnpm 的依赖校验会中止命令（`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`）。

## 原因

- 两个工作区包的 `types` 都指向 `dist/*.d.ts`，`pnpm dev` 也消费 `dist`；`tsc` / `vitest` 走源码 —— 于是「源码改了但没 build」只会在下游以**旧类型 / 旧行为**的形式表现出来。
- `ELECTRON_RUN_AS_NODE=1` 时 Electron 把自己当纯 Node 启动，`require('electron')` 返回二进制路径字符串（部分 agent 运行时 / shell 默认带这个变量）。
- Electron 二进制走 `ELECTRON_MIRROR`；pnpm 在无 TTY 时无法交互确认删 `node_modules`。

## 影响

- 第 1/2 条最容易误判：报错看着像自己写错类型、行为看着像「没生效」，实际只是构建产物陈旧。
- 第 3 条会让人去查打包配置，实际只差一个环境变量。

## 结论与做法

- 改了 `packages/shared/src/**` 或 `packages/agent-core/src/**`，先 build 该包再跑下游 typecheck：`pnpm --filter @aurora/shared build` / `pnpm --filter @aurora/agent-core build`；进端到端（dev / smoke / capture）前同样先 build。
- 跑单个 / 单包测试用 `pnpm vitest run <文件路径>`；别用 `pnpm --filter @aurora/<pkg> test` —— 根 `vitest.config.ts` 的 `include` 是根相对路径，在包目录下会一个用例都匹配不到、以 `No test files found` 退出码 1 失败。
- 跑 Electron 前先清 `ELECTRON_RUN_AS_NODE`（`Remove-Item env:ELECTRON_RUN_AS_NODE`），逐条命令前清一次最稳。
- 无 TTY 时用 `pnpm --config.verify-deps-before-run=false exec …` 绕过；这是给 CI / agent shell 的逃生口，别写进 `package.json` 的脚本。
- Electron 下载失败时，在 `apps/desktop/node_modules/electron` 下执行 `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; node install.js`（npm 镜像见 `.npmrc`）。
- dev server 换到 5174 是正常行为，截图与探针不受影响，不要去「修」。
- 依赖 Electron 的行为**不写主进程单测**，靠 `AURORA_SMOKE` 端到端自测覆盖。
- 用户数据：配置 `%APPDATA%/Aurora/config.json`、会话 `sessions/*.json`、分类流水 `classification.json`、日志 `logs/`；写文件一律原子写 + 防抖，退出前 `flush()`，损坏文件备份后重建。
