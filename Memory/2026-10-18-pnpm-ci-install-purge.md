---
date: 2026-10-18
title: pnpm 的 verify-deps-before-run + CI=true 会真的清空 node_modules；dev 占着 electron 时 install 必 EPERM
tags: [构建, pnpm, node_modules, Electron, 坑, 环境]
source: 模型自动记录
---

# `CI=true` 重试 `pnpm install` 会把 node_modules 清成半截（2026-10-18）

## 现象

- 子代理跑 `pnpm --filter @aurora/shared build`，pnpm 的 `verify-deps-before-run` 自动插入
  `pnpm install --production`；无 TTY 先报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`。
- 按旧提示改 `CI=true` 重试后，install **真的开始删依赖**（-660），删到一半时：
  `[ERR_PNPM_EPERM] rename electron_tmp_... -> electron` —— 因为同一时刻有队友的
  `pnpm --filter @aurora/desktop dev`（electron-vite + 6 个 electron 进程）占着
  `node_modules/.pnpm/electron@44.5.1.../node_modules/electron`。
- 结果：`node_modules` 只剩 `.bin/.pnpm/.vite/.modules.yaml` 等骨架，各 workspace 链接全丢；
  全队 vitest/typecheck/build 同时报模块找不到。

## 根因

1. 本仓库根 `package.json` 的 `verify-deps-before-run` 会在每次 `pnpm <script>` 前做依赖校验；
   无 TTY 时它倾向于要求重装，`CI=true` 只是跳过确认，不是“只校验”。
2. Windows 上 Electron 目录在 dev 进程运行期间被锁；pnpm 的原子 rename 失败 → 半截树。
3. 半截树不会自己恢复；后续任何 `pnpm install` 只要 dev 还在就继续 EPERM。

## 处置顺序（实测有效）

1. **先停 dev**：找到 `pnpm --filter @aurora/desktop dev` 的整棵进程树
   （cmd → pnpm → electron-vite → electron），`taskkill /PID <根> /T /F`；
   不要只杀 electron 子进程，cmd 会把它拉起来。
2. 确认 `.pnpm/electron@*/node_modules/electron` 没有句柄后，跑：
   `$env:CI='true'; pnpm install --frozen-lockfile`
   本次 12s 补回 664 包（`.pnpm` store 还在，主要是重建链接与 root devDeps）。
3. 恢复后**不要**再在无 TTY 会话里裸跑 `pnpm <script>`；统一用
   `pnpm --config.verify-deps-before-run=false <script>` 或 `pnpm exec <bin>`。
4. 需要 dev / capture 时确认只有一个实例；截图验收跑完再让其他人 build/test。

## 长期口径

- **日常构建/测试不要设 `CI=true` 去“绕过” TTY 提示**：它不是 dry-run，会执行安装。
- 迭代期一律 `--config.verify-deps-before-run=false`；只有确实要装依赖时才显式
  `CI=true pnpm install --frozen-lockfile`，且先停掉 Electron。
- 本次事故与用户需求无关，但会把所有子代理的验证结果变成“模块找不到 / 基线红”，
  排查时先看 `node_modules` 是否只剩骨架。

## 追加（2026-10-18 发 v0.4.9 时实测）：**改 `package.json` 版本号也会触发这条自动安装**

- 现象：版本号从 0.4.8 改到 0.4.9 后跑 `node scripts/release.mjs`，它在第 2 步
  `pnpm build` 里被 pnpm 的 `verify-deps-before-run` 插入一条 `pnpm install --production`，
  无 TTY 立刻 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` → 整个 release 中断
  （tag 未创建、GitHub / Center 都没上传）。而此时 `pnpm install --frozen-lockfile`
  明确显示 **Already up to date** —— 依赖其实一个都没变，只是 `.modules.yaml` 里的
  “依赖状态”与新的 `package.json` 对不上。
- 判定：release 日志里出现 `runDepsStatusCheck` / `install --production`，且失败点在
  `$ pnpm build` 的**第一条**输出（不是编译错误）。
- 处置（实测有效，≈1s）：先跑一次 `pnpm install --frozen-lockfile` 刷新状态，再重跑
  `release.mjs`；整条发版链路不再被打断。
- 额外注意：`ELECTRON_RUN_AS_NODE` 要清；本机发版时用户自己的 dev 实例可能正占着
  `node_modules/.pnpm/electron`（实测当时还有 6 个 electron 进程），`--frozen-lockfile`
  显示 up-to-date 时不会写盘，所以不冲突；但**绝不能用 `CI=true` 去强行 install**（会真清）。

