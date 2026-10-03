---
date: 2026-10-03
title: 本仓库的构建 / 运行环境坑（pnpm、Electron、dist 陈旧、无 TTY）
tags: [构建, 环境, pnpm, Electron, 坑]
source: 模型自动记录
---

# 构建与运行环境坑

## 现象

1. **`pnpm test` 前置的依赖校验以 `ERR_PNPM_IGNORED_BUILDS` 失败**：`pnpm-workspace.yaml` 里同时存在
   `allowBuilds` 与 `ignoredBuilds` 两处配置。
2. **Electron 二进制下载失败**（企业代理 / 证书拦截），`pnpm install` 装不上运行时。
3. **`apps/desktop/src/main/**/*.test.ts` 下的用例在 Node 环境加载失败**：它们 `import 'electron'`，
   而 `vitest.config.ts` 的 include 只收不依赖 Electron 的主进程测试。
4. **改了 `packages/shared/src/**` 或 `packages/agent-core/src/**` 后，`apps/desktop` 对着旧类型报错**：
   常见症状是共享包「no exported member」、agent-core 新加的方法在 `main/ipc.ts` 里报
   `TS2339 Property 'xxx' does not exist on type 'SessionStore'`（看着像自己写错了）。
5. **单测全绿、端到端却按旧行为走**（且无报错）：`pnpm dev`（含 smoke / capture）跑的也是两个包的 `dist`。
6. **`pnpm dev` / `AURORA_CAPTURE` 起不来**：Electron 表现成"打包产物坏了" —— 主进程在
   `!electron.app.isPackaged` 这行崩（`Cannot read properties of undefined`）。
7. **同一台机器上别的 dev server 占着 5173**，`electron-vite dev` 换到 5174。
8. **非交互环境（无 TTY）下 pnpm 的依赖校验会中止命令**：`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`。

## 原因

- pnpm 11 默认拦截依赖安装脚本，放行清单只认 `allowBuilds`；`ignoredBuilds` 是旧写法，两处并存即冲突。
- 两个工作区包的 `types` 都指向 `dist/*.d.ts`，`pnpm dev` 也消费 `dist`；`tsc` / `vitest` 走源码 ——
  于是"源码改了但没 build"这件事只会在下游以**旧类型 / 旧行为**的形式表现出来。
- `ELECTRON_RUN_AS_NODE=1` 时 Electron 把自己当纯 Node 启动，`require('electron')` 返回的是**二进制路径字符串**
  （某些 agent 运行时，如 DSH 的 shell，默认就带这个变量）。
- Electron 二进制走 `ELECTRON_MIRROR`；pnpm 在无 TTY 时无法交互确认删 `node_modules`。

## 影响

- 第 4/5 条最容易误判：报错看着像自己写错类型、行为看着像"没生效"，实际只是构建产物陈旧；
  本轮曾因此在旧产物上白跑两轮 smoke。
- 第 6 条会让人去查打包配置，实际只差一个环境变量。

## 结论与做法

- 依赖放行只写在 `pnpm-workspace.yaml` 的 `allowBuilds`（写 `false` = 显式拒绝），**不要再维护 `ignoredBuilds`**。
- Electron 下载失败时，在 `apps/desktop/node_modules/electron` 下执行：
  `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; node install.js`（npm 镜像见 `.npmrc`）。
- 跑单个测试用 `pnpm vitest run <文件路径>`（如 `pnpm vitest run packages/agent-core/src/session/store.test.ts`）；
  **别用 `pnpm --filter @aurora/<pkg> test`** —— 根 `vitest.config.ts` 的 `include` 是**根相对**路径，
  在包目录下执行会一个用例都匹配不到、直接以 `No test files found` 退出码 1 失败（2026-09-26 实测；
  各包 `package.json` 里的 `test: vitest run` 只在仓库根调用时才对）。
- 依赖 Electron 的行为**不写主进程单测**，靠 `AURORA_SMOKE` 端到端自测覆盖。
- **改了 `packages/shared/src/**` 或 `packages/agent-core/src/**`，先 build 那个包再跑下游 typecheck**：
  `pnpm --filter @aurora/shared build` / `pnpm --filter @aurora/agent-core build`；
  进端到端（dev / smoke / capture）前同样要先 build。
- 跑 Electron 前先查/清 `ELECTRON_RUN_AS_NODE`（`Remove-Item env:ELECTRON_RUN_AS_NODE`），逐条命令前清一次最稳。
- dev server 换到 5174 是正常行为，截图与探针不受影响，不要去"修"。
- 无 TTY 时用 `pnpm --config.verify-deps-before-run=false exec …` 绕过；
  这是给 CI / agent shell 的逃生口，**别写进 `package.json` 的脚本**。
- 用户数据位置（写文件一律原子写 + 防抖，与 `SettingsStore` 同一套 `FileSystemPort` 约定，
  退出前 `flush()`；损坏文件备份后重建）：配置 `%APPDATA%/Aurora/config.json`、会话 `sessions/*.json`、
  分类流水 `classification.json`、日志 `logs/`。
