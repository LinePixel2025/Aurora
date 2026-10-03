---
date: 2026-10-03
title: prettier --write 会把 .vue 模板里的多语句内联事件处理器改坏
tags: [构建, 格式化, Vue, 坑]
source: 模型自动记录
---

# prettier --write 会改坏 .vue 模板

## 现象

- `prettier --write` 会把 `.vue` 模板里的多语句内联事件处理器拆行并**吞掉分号**：
  `@click.stop="moreOpen = !moreOpen; newOpen = false"` 格式化后变成 `@click.stop="` + 两行语句
  （**没有分号分隔**）+ `"` → **模板编译报错**。
- dev 下 Vite 在窗口里弹错误遮罩，**整个截图流程卡死**：本轮实测全量截图停在某个场景 12 分钟不动，
  `report.json` 一张不写。
- 最阴的一点：**`tsc` 与 `vue-tsc` 全绿** —— 它们不校验内联处理器的 JS。

## 原因

- Prettier 把模板属性的值当普通文本折行处理，不解析其中的 JS 语句边界；本仓库 Prettier 配置是**无分号**，
  于是折行后的两条语句既没有分隔符、也不再是合法表达式。
- 类型检查器只看模板表达式的类型，不做模板编译期的完整语法校验；真正的编译发生在 Vite / 运行期。

## 影响

- 症状出现在**运行期**（窗口里一层 Vite 错误遮罩），而 `typecheck` / 单测 / 探针脚本校验三道全绿 ——
  很容易误判成"渲染坏了"或"探针卡住了"，白跑一轮全量截图才发现是模板没编译过。

## 结论与做法

- 模板里**不写多语句内联处理器**，一律抽成具名方法（`@click.stop="toggleMore"`）。
- `prettier --write` 之后**必须重跑一次构建**（`pnpm --filter @aurora/desktop build`）再进截图；
  本轮正是靠窗口上那层 Vite 错误遮罩才定位到的。
- 判断"截图流程卡住"时，先看窗口有没有 Vite 错误遮罩，别先怀疑 Electron / 探针。
