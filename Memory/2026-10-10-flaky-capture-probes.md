---
date: 2026-10-10
title: 四条抖动截图探针的根因与判据策略（模式广播 / 身份键 / 有界等待 / 离群容忍）
tags: [测试, 探针, capture, 抖动, 坑]
source: 模型自动记录
---

# 四条抖动截图探针：根因与判据策略

## 现象

同一份代码连跑全量截图（`AURORA_CAPTURE`，93 条 checks），失败项组合每次都不同：
`chat-sidebar.png`（右栏卡片显示 work 的「工作目录」而不是「今日课程」）、
`chat-archive.png`（计数已正确迁移、归属查找却两边失配）、
`chat.png`（`followed` 一次是 1、一次是 1613 ≈ 填充块高度）、
`chat-stream-burst.png`（`maxFrameGapMs` 112.6–141.7 越过 110）。
`chat-model-picker.png` 是**恒红**的既存项，不属抖动。

## 根因（四条各不相同，别用一种直觉去套）

1. **`chat-sidebar` = 渲染层启动期永久丢 `mode:changed`**（产品缺陷，不是探针问题）。
   `renderer/shared/bootstrap.ts` 旧接线先 `await Promise.all([settings.load(), modes.load()])`
   再 `bind()`；落在两者之间的广播**没有任何补偿**（load 拿到的是切换**前**的快照），
   而 `mode.set` 在「主进程已是目标值」时提前 return、**不 emit**
   （`packages/modes/src/manager.ts`）→ 面板永久停在旧模式且自己回不来。
   触发条件：窗口恰好在 work 期间被建窗（`edge-bar-work` → `requestGuideIfNeeded` →
   proactive `showChat()` → `WindowManager.show()` 会 `ensure()`**建窗**）。
   **修法**：先订阅、再加载；各 store 用 `loadGate` 保证"晚到的首读应答不许盖掉更晚的广播"。
   复现率低（1/8），所以必须靠**哨兵**而不是概率：`CHAT_SIDEBAR_SCRIPT` 断言
   「面板卡片推出的模式 === `mode.list()` 报的模式」且 `forcedToggle === false`。
2. **`chat-archive` = 身份键取了会漂移的文本**。原先 `movedTitle = textOf(.nav-item)`，
   而 `.nav-item` 含 `.item-time` 的相对时间（`刚刚` → `N 分钟前`）：跨分钟时归属判定
   两侧都失配，**计数却是对的**（`afterArchive {mainRows:2,archiveRows:2,inArchive:false,inMain:false}`）。
   **修法**：身份键换成 `data-session-id`（挂在 `.nav-row` 上，`SessionRow.vue` 渲染）；
   标题文本只作排障。**另一条独立缺陷**：`CHAT_ARCHIVE_ACT` 在冷窗（act 前只等 60ms）
   拿不到 `v-if` 渲染的 toggle，**且 act 返回值被丢弃**（`capture.ts` 只合并 `mainAct`）
   → 单场景筛选跑 4/4 恒红。**修法**：act 有界轮询等 toggle、就绪状态写进
   `window.__auroraArchiveProbe`，check 读到 `ready !== true` 时显式 FAIL。
3. **`chat.png` = 一次性等待**。插入填充块后只 `await wait(150)` 就一次性读数，
   而吸底是观察者 + 一帧对齐才落位。**修法**：改成有界轮询（50ms 步进、上限 1000ms）
   等真实结果，`pass` 判据不变、只把最终读数与 `timedOut` 一起回传。
   **有界**是关键：吸底真坏掉时它永远不会跟上，而探针不派发输入事件、等多久都不会自愈
   （反向复核：人为关掉 `schedule()` → `followed 1966 / timedOut true`）。
4. **`chat-stream-burst` = 绝对最大值判据对单点离群敏感**。11 轮实测 `maxFrameGapMs`
   5 轮越过 110，而**第二大帧距只有 33–75**、`droppedFrames` 恒定 13–20、
   `heartbeatOverrunMs` 105–232 —— 失败轮与通过轮的整体代价几乎相同，越界全来自单个尖峰。
   **修法**：「离群容忍 + 灾难闸门」双闸门 —— 主判据 `secondMax*`（110 / 160）+
   闸门 `maxFrameGapMs 260` / `maxUnhiddenHeartbeatMs 300`；累计量（`droppedFrames 140` /
   `heartbeatOverrunMs 3600`）不动。**判别力交给闸门与累计量**，不要指望 `secondMax` 去抓
   「修复前 137.5」那种量级的单帧值。

## 关键教训

- **"双闸门"里若保留旧的最大值判据，新闸门就是死代码**（2026-10-10 独立审查发现的 P1）：
  `secondMax <= 110 && max <= 260` 在 `secondMax <= max` 恒成立的前提下 ≡ `secondMax <= 110`
  —— 闸门只对"单点"有效，而**另一条并行的旧判据** `max <= 160` 会先把所有 `max > 160` 判红，
  于是"离群容忍"在那一轴等于没做。**改判据时要检查同一轴上的旧规则是否还在**，
  否则注释里会写出"把闸门从 260 抬到 300 就不红了"这种**不成立的因果**（198.5 < 260）。
- **闸门要对着"仪器修好之后"的尾巴标定**：本轮的 260/300 是对着（后来被证明是探针/产品缺陷造成的）
  112–198 读数定的；仪器修好后正常尾巴只有 54.2 / 182.1 → 重标定到 200/260，把
  110–200 那段单帧回归重新纳入判据。**修完仪器要回头看阈值是不是为旧噪声定的**。
- **等固定毫秒不是保证，等真实结果才是**。三条修复里有两条（侧栏 / 归档前置）就是把
  "等一会儿"改成"等到那个事实成立为止"，并给上限 + 超时如实回报。
- **隐藏窗口里没有 rAF**：三条滚动探针原先都用裸 `requestAnimationFrame` 等两帧，
  而 Chromium 在隐藏页面**不派发 rAF** → promise 永不 settle → **整轮 capture 挂死、
  `report.json` 一张不写**（实测挂死 20 分钟才发现）。统一改 `Promise.race(帧, 120ms)`
  + `document.hidden` 时走定时器。**任何在渲染层"等帧"的探针都要有这条兜底**。
- **窗口恢复可见时要把心跳巡检重启**：`useStickToBottom` 的 `onVisibility` 端口恢复可见时
  只回调 `refresh()`（`following` 为真才排一帧对齐，**不重排巡检**），而隐藏期间 rAF 暂停、
  定时器节流 → 巡检可能停在"已排帧但帧永不推进"；此时"MutationObserver 回调会停"那条
  已知失效路径就没有兜底了，表现为内容变高完全不跟随、`stick()` 才恢复。
  修法是恢复可见 / 获得焦点时额外 `restartGuard()`；**注意先取消在途句柄再重排**
  （直接丢句柄会让旧回调继续跑，每次 focus / visibilitychange 永久多一条链）。
- **探针的"自愈"不要改产品状态**：`mode.set(...)` 会走 `requestGuideIfNeeded`（可能建窗 / 抬引导），
  `location.reload()` 又会掐掉 check 脚本 —— 两者都比"如实 FAIL"更糟。**前置归 act，判定归 check**。
- **产品修复必须有测试守着**：「先订阅再加载」这条只写在注释里时，改回旧顺序 2544 条用例全绿
  （capture 哨兵只在 1/8 概率的竞态下才红）→ 补一条"读源码 / 解析 AST 判顺序"的护栏
  （`renderer/shared/bootstrap.test.ts`），与 `capture.probe-strings.test.ts` 同款思路。
- **筛选跑会产生假 FAIL**：`AURORA_CAPTURE_ONLY` 是**子串**匹配
  （`'chat.png'` 会连带命中 `theme-chat.png`），且缺前置场景时会出现
  `no .thread/.messages` 一族假红。**看到红先问"是不是筛选跑的"**。
- **判据口径要按 `report.json` 的真实字段**：失败 = `ok === false` **或**
  （`checked === true` 且 `result == null`）**或** `pass === false`。
  只按 `pass === false` 会把 `checked:false` 的纯截图场景误判成失败。
  ⚠️ 另有一个**先于本轮存在**的盲点：`chat-ctx-empty-tools` 的探针 payload 只有
  `{ok, reason, detail}`、**没有 `pass` 字段** → 按上述任何口径都无法判它失败（待修）。
- **同一目录会被下一轮覆盖 `report.json`**，每轮必须独立目录。
- **反向复核要人为制造缺陷，而不是等它自己复现**：等复现的代价极高（1/8 概率）。
  本轮四条各有可复现的对照：确定性注入陈旧 store（侧栏）、旧身份键跑一遍归档（归档）、
  关掉吸底调度（吸底）、每帧插 130ms / 一次性 600ms（爆发）。
- **反向复核的注入必须落在被测链路上**：在探针里叠一段与链路无关的主线程阻塞（400ms）
  什么也证不出（阻塞期间定时器排队，结束后吸底已落位，旧判据也绿）。
- **标定要看"今天的正常尾巴"**：爆发探针的心跳闸门初版取 260、后来重标定到 300，但真正让
  198.5 / 234.1 / 182.1 那几轮判红的**不是闸门**而是并行的旧判据 `maxUnhiddenHeartbeatMs <= 160`
  （见上面第一条教训）—— 删掉旧判据后按今日尾巴 182.1 把闸门定在 **260**（1.43× 余量）。
- **全量跑期间不要改源码**：`electron-vite dev --watch` 会在编辑中途重建，
  被改到一半的产物会让某一轮以 `App threw an error during load` 之类的方式假红；
  等冻结后再跑验收轮，并给每轮**独立目录**。
- **未完成的提交拆分不要留半成品**：`capture.ts` 一个文件承载四条修复时，
  `git add -p` 的 hunk 交错、`git stash` 会连带风险；可行做法是先把最终版抓成补丁，
  再按 step 逐段重建（每段都跑 `typecheck` + 探针字符串护栏）。
