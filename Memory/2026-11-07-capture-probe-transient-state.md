---
date: 2026-11-07
title: 全量验收两处假红：探针别断言瞬时 busy 态；冒烟紧跟重负载后正文增量会被合并
tags: [测试, 探针, 截图, 冒烟, 事件合并, 口径, 坑]
source: 模型自动记录
---

# 全量验收两处假红

## 现象

2026-11-07 提交浏览器「按标签切换 UA + Agent 操控流光」那一轮，全量验收连撞两处红：

1. **截图**：`chat-browser-agent.png` 的 check 里新增两条流光判据
   （`glow.classList.contains('is-agent-busy')`、`getComputedStyle(glow, '::before').animationName`）
   每条都红，报告里是
   `glowClass: "bp-content-frame"`、`glowAnimation: "none"`，而同一场景的 runner 明细
   `main.pass: true`（截图 / 输入 / 点击 / console 全对）。
2. **冒烟**：`SUMMARY 280/281`，唯一红是
   `正文按增量逐条下发 — textEvents=1 deltas=["AURORA_STUB_OK 已按技能指令读取系统状态。"]`；
   同一条命令紧接着重跑一次就是 `281/281`。

## 原因

- 探针在 `mainAct` **之后**才跑。capture runner 的最后一步是 `screenshot()`，它在 `finally` 里
  把会话状态 emit 回 `ready`；等 check 读到 DOM 时 `agentBusy` 已经是 false，
  「忙」这个**瞬时状态**根本不在现场 —— 判据不是测错了对象，是测了一个已经过去的状态。
- 冒烟那条：桩服务把最后一段正文拆两片、间隔 `FRAME_GAP_MS = 40ms`，刻意大于主进程
  `event-buffer.ts` 的 16ms 合并窗口。但合并窗口的 `setTimeout` 会被负载推迟：
  刚跑完 `pnpm build` + 全量单测后机器正忙，flush 晚于第二片入队，两片就被合并成一条 ——
  断言只数 text 事件条数，于是随机红。

## 影响

- 「断言瞬时状态」的探针要么必然红（状态已过）、要么随机红（正好赶上），
  两种都会训练人忽略红，真回归混进去就没人看。
- 冒烟紧跟重负载跑出来的单条红，最容易被误判成自己改动的回归，白查半小时。

## 结论与做法

- **探针只断言稳定事实**：结构（父帧包住 guest）、空闲时的**负对照**（`ready` 时不许带
  `is-agent-busy`）、以及用**克隆节点**加上状态类去量应用自己那份 CSS
  （`getComputedStyle(clone, '::before')` 的 `animationName` / `borderTopWidth`）。
  克隆只验证样式接线，不冒充应用状态，也不改现场。
- 负对照必须真能失败：本例「空闲不许带 busy 类」在实现把类写死时就会红。
- 全量冒烟的「正文按增量下发」判据受机器负载影响：红了先隔离重跑（或先等机器空闲、
  把 `pnpm build` / 全量单测排到冒烟之后），不要直接改实现。
- 截图结论以 `report.json` 的 `result.pass` 为准：`checked: true` 的条目 `ok` 字段不含
  `result.pass`，只看 `ok` 会把失败项算成通过。
