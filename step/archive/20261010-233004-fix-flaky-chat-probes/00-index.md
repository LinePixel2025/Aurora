# 任务：修掉桌面截图核对里 4 条抖动探针（chat-sidebar / chat-archive / chat.png / chat-stream-burst），让 capture 基线恢复可预期

- 任务标识：fix-flaky-chat-probes
- 项目根目录：D:\AICOP\Projects\Aurora
- 创建时间：2026-10-10 20:02
- 基线提交：249322fd8f08a389c9c6b504cbd9c9cdbe55b285
- 归档目录：step/archive/20261010-233004-fix-flaky-chat-probes
- 归档时间：20261010-233004

## 完成标准

1. `AURORA_CAPTURE`（`AURORA_CAPTURE_THEME=dark`）**连续 3 轮全量**的 `report.json` 里，失败项**只剩 `chat-model-picker.png` 这一条**（该条属本次范围之外，见下）；`AURORA_CAPTURE_THEME=light` 至少 1 轮全量同样只剩它。
2. 四条被修的探针各有**定向复跑**记录（命令 + `report.json` 摘录）与**反向复核**证据（证明"修完的判据仍然会因为真缺陷变红"，而不是被改松了）。
3. 凡改了阈值 / 等待策略的，必须在代码注释里写清「旧值 → 新值 + 依据 + 为什么仍能抓住真回归」。
4. `pnpm typecheck` 与 `pnpm test` 全绿；若动到产品代码，补齐对应单测并全绿。
5. 文档与记忆同步：`docs/07-ui-spec.md` §5.3（探针口径有变时）、`Memory/` 新增一条（四条抖动的根因与判据策略），基线数字（探针条数）若有变要回填 `AGENTS.md`。

## 现状与关键结论

- **四条抖动的实测分布（本机，同一个 HEAD）**：
  | 轮次 | 命令 | 结果 |
  | --- | --- | --- |
  | run1 dark | `AURORA_CAPTURE=…\aurora-capture` + `AURORA_CAPTURE_THEME=dark` | 93 探针 / **4 红：chat-model-picker、chat-archive、chat.png、chat-stream-burst** |
  | run2 dark | 同上（`aurora-capture-run2`） | 93 探针 / **2 红：chat-model-picker、chat-sidebar**（该轮 `contextCards=["任务清单","工作目录","系统状态"]`） |
  | light | `AURORA_CAPTURE_THEME=light` | 93 探针 / 1 红（只有 chat-model-picker） |
  | run3 dark | 同 run1（`aurora-capture-run3`） | 93 探针 / **2 红：chat-model-picker、chat-stream-burst**（chat.png 本轮通过） |
  改动前的同码基线（`git stash -u` 后重建再跑，`aurora-capture-baseline`）：**92 探针 / 1 红（只有 `chat-model-picker`）**；本轮改动只是 +1 条新场景。
- **两条会误导判读的工具事实（务必先读）**：
  1. **`AURORA_CAPTURE_ONLY` 是子串匹配**（`apps/desktop/src/main/capture.ts:12214` 的 `file.includes(token)`）→ 失败项 `chat.png` 会**连带命中 `theme-chat.png`**。今天 19:38 那次 `ONLY=failed` 因此跑了 5 个场景（theme-chat、model-picker、chat-archive、chat、stream-burst），**那不等于 theme-chat 失败过**：全量检索 `%TEMP%` 下所有 `aurora-capture*` 报告，`theme-chat.png` 从未 `pass=false`。同理 `ONLY='chat'` 会命中 **44** 个场景（日志 `s1-chatgrp-1` 的 `count:44`），把 44 个互相污染的现场当"定向跑"用。
  2. **`AURORA_CAPTURE` 指向同一目录时，后一轮会覆盖上一轮的 `report.json`**（19:38 那次就把 run1 的 93 条覆盖成 5 条）；且 `FileLogger` 在 `app.exit` 前不 flush，日志尾部的 `FAIL 截图探针` / 窗口截图完成行会丢。→ **每一轮都必须写进独立目录，判据只认 `report.json`**，不要拿日志找失败项、也不要复用同一目录做对照。
- **`chat-sidebar.png`（执行序 #9，第 2 个 chat 场景）**：探针 `CHAT_SIDEBAR_SCRIPT`（`apps/desktop/src/main/capture.ts:4301`）是**同步**脚本，一次性读 `.ctx-card .ctx-head strong`。失败态 `contextCards=["任务清单","工作目录","系统状态"]`＝面板处于 **work** 模式；通过态三跑恒为 `["任务清单","今日课程","系统状态"]`（classroom）。`ContextPanel.vue:203/242` 的 classroom 分支含**恒渲染**的「今日课程」卡，所以"没有今日课程"只可能是模式不是 classroom。根因（代码已核）：**渲染层启动期会永久丢掉 `mode:changed`** —— `apps/desktop/src/renderer/shared/bootstrap.ts:31-35` 先 `await Promise.all([settings.load(), modes.load()])` 才 `bind()`，这之间的广播没人接；而 `mode:changed` 的唯一来源是 `ipc.ts:1295-1297`（`deps.modes.onChange` → broadcast，**所有**窗口都发）。触发路径：`edge-bar-work` 切 work → `manager.ts:230-232` 因未完成引导触发 `requestGuideIfNeeded` → `index.ts` 的 proactive 调 `windows?.showChat()` → `window-manager.ts` 的 `show()` 会 `ensure()` **建窗**，于是 chat 窗口在 work 期间启动；随后还原 classroom 的广播落在 `load()` 与 `bind()` 之间 → 面板**永久**停在 work。run2 日志时间线佐证：`11:40:01.911 请求主动引导{"mode":"work"}` → `11:40:03.070 ClassRoom Mode 已激活` → `11:40:03.659 theme-chat` → `11:40:04.007 chat-sidebar`（距恢复 1.2s，中间还隔着整个 theme-chat 场景 —— 所以"120ms 窗口太短"不是有效解释）。
- **`mode.set` 在两个方向上都不产生事件**（改探针时必须知道）：主进程当前模式已是目标值时 `packages/modes/src/manager.ts:136-143` **提前 return 且不 emit**，`ipc.ts:542-547` 这条 handler 也不额外广播 → `window.aurora.mode.set('classroom')` 在"主进程已是 classroom、渲染层却是 work"的现场是**纯 no-op**，用它做探针前置会轮询到超时而判据照旧红。另外探针走裸 IPC **不会**更新 pinia 的 `modes.value`（只有 `renderer/shared/stores.ts` 的 `setCurrent` 会写）。
- **`chat-archive.png`（#34）**：`CHAT_ARCHIVE_CHECK`（`capture.ts:6529`）会轮询等计数变化（25×120ms，计数断言本身没问题），但**身份键取的是整行文本**：`movedTitle = textOf(targetRow.querySelector('.nav-item'))`（`capture.ts:6573`），而 `.nav-item` 里含 `.item-time`（相对时间，`SessionRow.vue:76` 的 `formatRelativeTime`）。**另一条独立缺陷**：`CHAT_ARCHIVE_ACT`（`capture.ts:6486-6511`）在冷窗（`capture.ts:265-268` 的 `act` 前只等 60ms）时 toggle 还没渲染（`SessionNav.vue:570` 的 `v-if="archivedSessions.length>0"`），act 返回 `ready:false`，而 **act 的返回值被直接丢弃**（`capture.ts:265-268` 只执行不合并，合并的只有 `mainAct`）→ 单场景跑恒红。本轮我自己复跑确认：`ONLY='chat-archive'` → `ariaExpanded="false"`、`archiveRows:0`、problems 首条「归档分组未展开（aria-expanded=false）」，**与身份键无关**。
- **`chat.png`（#45，`CHAT_AUTO_SCROLL_SCRIPT`，`capture.ts:801`）**：探针往 `.messages` 插一个 1600px 填充块后**只 `await wait(150)`** 就一次性判 `followed <= 4`（`capture.ts:825/874`）。失败态 `followed=1613`（≈填充高度，说明吸底一次都没跟上）、通过态 `followed=1`；同一条探针在 ② 步还会故意关掉跟随，收尾靠点「↓ 回到最新」胶囊还原（`capture.ts:857-869`）。定向跑用 `AURORA_CAPTURE_ONLY='chat.png'`（实测命中 `theme-chat.png` + `chat.png` 两个场景）。
- **`chat-stream-burst.png`（#88）**：阈值在 `BURST_LAG_LIMITS`（`capture.ts:5223`），标定史写在 `capture.ts:5185-5222`。**该常量只服务这一个场景**（`:5223` 定义 / `:5553-5556` 使用）；`chat-follow-burst.png` 用的是另一套 `CHAT_FOLLOW_BURST_SCRIPT`（`capture.ts:902`）自己的 `maxDistance <= 4`（`:955`），本次**不动它**。本机实测：`maxFrameGapMs` 112.6 / 133.3 / 141.7（**阈值 110**）、`maxHeartbeatMs` 107.9 / 152.4 / 177.7（**阈值 160**）、`heartbeatOverrunMs` 156–235（阈值 3600 ✓）、`droppedFrames` 17–24（阈值 140 ✓；**修复前是 238**）。关键事实：`maxFrameGapMs` 的 110 是按「修复前 137.5 / 修复后 29.2」定的（`capture.ts:5192`），**本机今天的实测最坏帧间隔已与修复前量级重叠** → 单纯抬这个绝对阈值会让判据失去判别力；payload 里能拿到的帧侧读数只有 `maxFrameGapMs` 与 `droppedFrames`（`capture.ts:5523-5526`，`topHeartbeatGaps` 是**心跳**序列），所以"离群容忍"必须先补一条帧距前若干大的记录。旁证：失败轮与通过轮的 `droppedFrames` 基本不变（17 / 17 / 18），支持"单点离群"而不是"整体劣化"。
- **验收命令（本机实测可用）**：
  - 全量：`$env:AURORA_CAPTURE="$env:TEMP\aurora-capture-<轮次>"; $env:AURORA_CAPTURE_THEME='dark'; pnpm dev`（约 4 分钟，93 探针；跑 Electron 前先 `Remove-Item env:ELECTRON_RUN_AS_NODE`）
  - 定向：加 `$env:AURORA_CAPTURE_ONLY='<png 文件名子串>'`（**子串匹配**，逗号分隔；特殊值 `failed`）。定向跑会命中所有含该子串的场景，且**会产生假 FAIL**（缺前置夹具）—— 每次都要在验收里写清"命中了哪几个场景"。
  - **每轮换独立目录**：同目录会被下一轮覆盖 `report.json`（见上面第 2 条工具事实）。
  - 读取判据：`report.json` 的 `checks[].result.pass`（`report.json` 是唯一事实来源；退出码 2 只表示"有失败项"）
  - 单测/类型：`pnpm typecheck`、`pnpm test`（本机 169 文件 / 2540 用例全绿）
  - `pnpm vitest run apps/desktop/src/main/capture.probe-strings.test.ts`（探针字符串护栏，改探针后必跑）
- **既有硬规则（改探针必须遵守）**：探针是 template literal 字符串，**不写反引号**（注释用「」）、**别写带反斜杠的正则**，`apps/desktop/src/main/capture.probe-strings.test.ts` 三条护栏会查；量表矩形 / 计数而不只量存在；**每条场景自带前置与收尾**（`Memory/2026-10-03-capture-probe-gotchas.md`）；筛选跑会产生**假 FAIL**（同文件第 6 条）。
- **本次未联网**：改动全部落在本仓库探针/产品代码内，不需要外部版本或 API 事实。

## 假设与待确认

- 假设 1：`chat-sidebar` 的 work 卡片来自"**渲染层启动期丢广播**"（`renderer/shared/bootstrap.ts:31-35` 先 `load()` 再 `bind()`），触发条件是 chat 窗口在 work 期间被 `showChat()` 建窗（`edge-bar-work` → 未完成引导 → `requestGuideIfNeeded` → `showChat`）。执行阶段用 step 01 的复现实验证实/证伪；若证伪，仍以"启动期竞态 + `mode.set` 同值 no-op"这对机制为收敛方向（它们是唯一能让面板"永久"停在旧模式的路径）。
- 假设 2：`chat-archive` 的两条缺陷都成立（身份键含相对时间 + act 冷窗 ready:false 且返回值被丢弃）—— 第二条已由本轮单场景复跑证实（`ariaExpanded=false`），第一条待 step 01 用"跨分钟"现场证实或证伪。
- 假设 3：`chat-stream-burst` 的越界是单点离群而非整体劣化（旁证：`droppedFrames` 通过轮 17 与失败轮 17/18 基本不变）。因此走"补帧距前若干大 + 离群容忍 + 灾难闸门"，而不是抬 `maxFrameGapMs` 的绝对值。
- 待确认：无（范围、能否改判据、能否改产品三项已由用户拍板）。

## 范围之外（明确不做）

- **`chat-model-picker.png`**：用户明确划出本轮，**另开任务**。它是确定性红项（同码基线逐字复现），本计划的"只剩它一条"正是验收口径的一部分，**不要去修它**。
- **`theme-chat.png`**：全量检索证明它**从未失败**，19:38 那次只是被 `ONLY=failed` 的子串匹配（`chat.png` ⊂ `theme-chat.png`）连带重跑 —— 它不是抖动项，不改它、也不改 `ONLY` 的匹配语义（另开任务）。
- 不改 capture 探针的**文件组织**（不把探针拆到多个文件；这也是本计划串行的原因）。
- 不动 CI（`.github/workflows/ci.yml`）与 `BURST_LONG_TASK_LIMITS` 的既有语义（除非某条真回归判据必须联动，那要在对应 step 里写明依据）；不动 `chat-follow-burst.png` 自己的 `maxDistance <= 4` 判据。
- 不做与这四条无关的界面/功能改动。

## 步骤

> 本计划**全串行**：step 2–5 都要改同一个文件 `apps/desktop/src/main/capture.ts`（写范围重叠，不能并行）。第 1 波：1；第 2 波：2；第 3 波：3；第 4 波：4；第 5 波：5；第 6 波：6；第 7 波：7。

| # | 文件 | 标题 | 状态 | 依赖 | 写范围 |
|---|------|------|------|------|--------|
| 1 | step-01-reproduce-and-triage.md | 四条抖动复现与归属定性 | done | - | 只读 |
| 2 | step-02-sidebar-mode-pollution.md | 修 chat-sidebar：启动期丢广播 + 场景自带前置 | done | step 1 | `apps/desktop/src/main/capture.ts`、`apps/desktop/src/renderer/shared/bootstrap.ts`、`apps/desktop/src/renderer/shared/stores.ts`、`apps/desktop/src/renderer/shared/*.test.ts`、`docs/07-ui-spec.md` |
| 3 | step-03-archive-identity-key.md | 修 chat-archive：身份键换稳定锚点 + act 前置轮询 | done | step 1 | `apps/desktop/src/main/capture.ts`、`apps/desktop/src/renderer/chat/components/SessionRow.vue`（仅当需要 `data-session-id`）、`docs/07-ui-spec.md`（仅当新增锚点需要记进说明） |
| 4 | step-04-autoscroll-wait.md | 修 chat.png：吸底跟随改有界轮询 | done | step 1 | `apps/desktop/src/main/capture.ts`、`packages/shared/src/browser/composables/stickToBottomCore.ts`（仅当根因在产品侧） |
| 5 | step-05-burst-robust-metric.md | 修 chat-stream-burst：换对单点离群不敏感的统计量 | done | step 1 | `apps/desktop/src/main/capture.ts` |
| 6 | step-06-stability-and-docs.md | 稳定性复跑与文档记忆回填 | done | step 2,3,4,5 | `docs/07-ui-spec.md`、`Memory/`、`AGENTS.md` |
| 7 | step-07-archive.md | 归档清理 | done | step 1..6 | `step/` |

## 审查重点

- 每条修复都可能"把判据改松"而不是"把抖动治好"：审查时逐条看**反向复核证据**是否真的证明了判据仍会因真缺陷变红。
- 探针改动有没有越过仓库硬规则（反引号 / 反斜杠正则 / 只量存在性 / 场景互相污染）。
- `chat-stream-burst` 的统计量改法是否真的保留了对"渲染跟不上输出"的判别力（对照 `capture.ts:5185-5222` 的标定史）。
- 有没有顺手去修被明确排除的 `chat-model-picker`。

## 执行记录

（供执行阶段追加：每步的实际改动与验证结果、git 提交清单、代码审查结论与处置）

### 步骤状态与提交

| Step | 状态 | 提交 |
| --- | --- | --- |
| 计划落盘（step/ 生成） | — | `dfccea3 docs(step): 生成四条抖动探针修复计划（fix-flaky-chat-probes）` |
| 1 四条抖动复现与归属定性 | done（只读，无提交） | — |
| 2 修 chat-sidebar（启动期丢广播 + 哨兵 + 场景前置） | done | `00eb82c`（产品修复）、`a68ae90`（探针侧） |
| 3 修 chat-archive（身份键 + act 前置） | done | `0c1dea8` |
| 4 修 chat.png（吸底改有界轮询） | done | `1fd93e7` |
| 5 修 chat-stream-burst（离群容忍 + 灾难闸门） | done | `34ec468` |
| 4b 帧等待有界兜底（整轮挂死） | done | 见下「额外修复」 |
| 4c 窗口恢复可见时重启吸底巡检（`chat.png` 真红） | done | 见下「额外修复」 |
| 6 稳定性复跑与文档记忆回填 | done | 见本步 `docs(...)` 提交 |

### 额外修复（执行中发现，同属"抖动探针"范围）

1. `fix(capture): 帧等待加有界兜底，避免隐藏窗口下整轮截图挂死` —— 三条滚动探针的裸
   `requestAnimationFrame` 在隐藏窗口下永不 settle（实测 `g-full-dark-1` 在 `chat.png`
   之后挂死 20 分钟、`report.json` 一张不写）。
2. `fix(renderer): 窗口恢复可见时重启吸底心跳巡检` —— `useStickToBottom` 的
   `onVisibility` 恢复可见时只 `refresh()`、不重排巡检，导致"MutationObserver 回调会停"
   那条已知失效路径失去兜底（实测 `k-full-dark-1` 的 `chat.png`：`followed:1613`、
   `timedOut:true`，而收尾 `stick()` 能恢复）。

### 最终全量验收（step 6）

**审查前**（`n-full-*`）与**审查后修复完毕**（`z2-full-*`）两批都达标：

| 批次 | 轮次 | 目录 | checks | 失败项 |
| --- | --- | --- | --- | --- |
| 审查前 | dark×3 + light×1 | `%TEMP%\n-full-dark-1..3` / `n-full-light-1` | 93 | 只有 `chat-model-picker.png`（范围外） |
| 审查后 | dark×3 + light×1 | `%TEMP%\z2-full-dark-1..3` / `z2-full-light-1` | 93 | 只有 `chat-model-picker.png` |

`pnpm typecheck` 全绿；`pnpm test` **171 文件 / 2546 用例全绿**（含新增 `bootstrap.test.ts` 顺序护栏）；
`pnpm vitest run packages/shared/src/browser` 68/68；Center `verify:web` **88/88**（改了 shared 渲染层，两端都验）。

### 独立代码审查结论与处置（step-runner 第 3 步）

派了 4 个干净上下文审查子代理（正确性+验收 / 安全边界+约定 / 独立复跑核对 / 对抗性复核）。
汇总：**有条件可交付**，无 P0；三条验收被独立复跑证实。发现并**已处置**的问题：
P1 心跳侧旧判据使新闸门成为死代码（删旧判据、与帧侧同口径）、P1 闸门是对着被污染读数标定的
（重标定 200/260）、P1 step-05 记录漏算两条红轮（已如实补记）、P2 探针"自愈"会改产品状态
（取消自愈、docs 同步）、P2 docs 数值/字段名过时（已改）、P2 反向复核引用错误（已改）、
P2 `restartGuard` 重复排链（先取消在途句柄）、P2 产品修复无护栏（新增 `bootstrap.test.ts`）、
P3 `loadGate` 错误写入时机（已改）。
**未处置（明确留给后续任务）**：`chat-ctx-empty-tools` 的探针缺 `pass` 字段（先于本次存在的判定盲点）。
详细清单见 `step/step-06-stability-and-docs.md` 的「8 独立代码审查与处置」。

### step 01 结论摘要（详见 step-01 执行记录）

- 基线（同 HEAD 三轮全量）：dark-1 红 = `chat-model-picker` + `chat-archive`；dark-2 只有 `chat-model-picker`；
  dark-3 红 = `chat-model-picker` + `chat-stream-burst`。
- 四条归属：`chat-sidebar` = 渲染层启动期丢广播（跨窗口广播 + 固定等待的竞态，低概率）；
  `chat-archive` = 身份键取整行文本（含相对时间）+ act 冷窗；`chat.png` = 一次性等待 150ms；
  `chat-stream-burst` = 绝对最大值判据对单点离群敏感。
- 工具事实两条：`AURORA_CAPTURE_ONLY` 是**子串**匹配（`chat.png` 会连带命中 `theme-chat.png`）；
  同一目录会被下一轮覆盖 `report.json`（每轮必须独立目录）。
- 判据口径：失败项 = `ok === false` **或**（`checked === true` 且 `result == null`）**或** `result.pass === false`。
