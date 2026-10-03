---
date: 2026-10-03
title: 渲染器与视觉资产是桌面/Center 两端单源，动它必须两端一起验
tags: [shared, 渲染层, 设计令牌, 坑]
source: 模型自动记录
---

# 渲染器与视觉资产单源（桌面 + Center Web）

## 现象

1. **渲染层只允许类型导入**：从 `@aurora/shared` 取**纯常量 / 运行时值**必须走 `@aurora/shared/browser`
   子路径，否则会把 `node:fs` 拉进浏览器 bundle 导致构建失败；
   `packages/shared/src/browser.ts` 的依赖链禁止出现任何 Node 内置模块。
2. **两端的 Markdown 渲染器各有一份**（旧 `markdown.ts`），输出类名与样式会分叉。
3. **Center 的 `vite build` 报 unresolved import**：渲染器依赖（含 CSS / 字体）声明在别的包，
   pnpm 严格链接下宿主解析不到兄弟包的依赖。
4. **齿轮图标 TS2308**：lucide 的 `Settings` 与配置类型 `Settings` 同名，桶文件 `export *` 无法消歧。
5. **改一处令牌，另一端还是旧样子**：Center web 里曾有 `theme.css` / 图标清单 / 吸底状态机的旧副本。

## 原因

- 渲染层与 Center Web 共用 `packages/shared/src/browser/`：Markdown 渲染器
  （markdown-it + highlight.js 子集 + KaTeX/katex.min.css，图表两库**动态 import**）、
  设计令牌 / 暗浅主题 / `aurora-*` keyframes / 过渡预设 / 原子类（`browser/theme.css`）、
  图标清单 `icons.ts`、工具语义查表 `toolIcons.ts` / `toolLabels.ts`、
  吸底状态机 `composables/stickToBottomCore.ts` + `useStickToBottom.ts`、实测高度动画 `useCollapseTransition.ts`。
- 依赖解析按包的依赖声明走，不按"谁 import 谁"走；动态 import 的 chunk 在生产 CSP `script-src 'self'` 下
  能否加载取决于库本身有没有 `eval`。

## 影响

- 分叉一份副本 = 两端行为与视觉漂移，且改完一端自测全绿、另一端线上出错。
- 依赖声明放错包会在构建期以"unresolved import"这种看不出因果的报错出现。
- 齿轮写成 `Settings` 是编译期硬错（TS2308），但报错信息容易让人以为是自己导入写错了。

## 结论与做法

- 同一份实现**只留一份**：两端的旧 `markdown.ts` 已删除、center web 里的令牌 / 图标 / 吸底副本已删，
  不要再各自分叉。样式单源在 `packages/shared/src/browser/markdown/md.css`
  （经 `--md-*` 变量映射两端令牌）；**改输出类名必须同时对照 `MARKDOWN_CONTRACT_CLASSES` 与两端截图**。
- 渲染器依赖（含 CSS / 字体）只声明在 **`packages/shared`**；
  `lucide-vue-next` 与 `vue` 按同一条规矩声明在 `packages/shared` 的 devDependencies。
- 两库无 `eval`，生产 CSP `script-src 'self'` 下动态 chunk 可正常加载（已核 mermaid 12 / echarts 6 的 dist）。
- **改 `packages/shared` 里的视觉资产 = 同时改两端界面**：改完必须跑
  `AURORA_CAPTURE`（桌面基线 73/73）与 `pnpm --filter @aurora/center verify:web`（网页基线 74/74）两边核对。
- 齿轮图标在 shared 里叫 **`SettingsGear`**（要类型写 `Settings`、要图标写 `SettingsGear`）。
