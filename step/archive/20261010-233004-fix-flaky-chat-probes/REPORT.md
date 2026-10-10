# 归档报告：fix-flaky-chat-probes

- 任务：修掉桌面截图核对里 4 条抖动探针（`chat-sidebar` / `chat-archive` / `chat.png` / `chat-stream-burst`），让 capture 基线恢复可预期
- 任务标识：`fix-flaky-chat-probes`
- 项目根目录：`D:\AICOP\Projects\Aurora`
- 基线提交（任务开始前）：`249322fd8f08a389c9c6b504cbd9c9cdbe55b285`
- 归档时间：2026-10-10 23:30:04
- 归档路径：`step/archive/20261010-233004-fix-flaky-chat-probes/`

---

## 一、做了什么

**四条抖动探针**（各自独立提交）：

1. **`chat-sidebar`** —— 真根因是**渲染层启动期永久丢 `mode:changed`**（产品缺陷）：
   `renderer/shared/bootstrap.ts` 旧接线先 `load()` 再 `bind()`，落在两者之间的广播没有任何补偿，
   且 `mode.set` 相同值是 no-op → 右栏永久停在旧模式。
   修法：① 产品侧改「**先订阅、再加载**」，各 store 用 `loadGate` 保证"晚到的首读应答不许盖掉更晚的广播"
   （纯逻辑抽 `load-gate.ts` + 4 条单测）；② 探针侧 `chat-sidebar.png` 自带前置
   （`CHAT_SIDEBAR_ENSURE_CLASSROOM_ACT` 有界轮询等「今日课程」真的渲染出来）+ **模式一致性哨兵**
   （面板卡片推出的模式 === `mode.list()` 报的模式、`forcedToggle === false`）；③ `EDGE_BAR_WORK_CHECK`
   的还原从固定 `wait(120)` 改成轮询 `mode.list()` 直到 classroom 生效。
2. **`chat-archive`** —— 身份键取整行文本（含 `.item-time` 相对时间），跨分钟就失配，
   而**计数已正确迁移**（实测 `afterArchive {mainRows:2,archiveRows:2,inArchive:false,inMain:false}`）。
   修法：行身份改用 `data-session-id`（`SessionRow.vue` 的 `.nav-row` 新增），计数断言不动，
   标题/整行文本降为排障读数；另修 act 冷窗（对比 4/4 恒红的假 FAIL）并把就绪状态经
   `window.__auroraArchiveProbe` 传给 check，`ready !== true` 显式 FAIL。
3. **`chat.png`** —— 插入填充块后只 `await wait(150)` 就一次性读值。
   修法：改**有界轮询**（50ms 步进、上限 1000ms），`pass` 判据不变（仍以最终读数判 `followed <= 4`），
   payload 增 `awaitedMs` / `attempts` / `timedOut`。
4. **`chat-stream-burst`** —— 绝对最大值判据对单点离群敏感（11 轮里 `maxFrameGapMs` 5 轮越 110，
   而第二大只有 33–75、`droppedFrames` 恒定 13–20）。
   修法：「**离群容忍 + 灾难闸门**」双闸门 —— 主判据 `secondMaxFrameGapMs <= 110` /
   `secondMaxUnhiddenHeartbeatMs <= 160`，闸门 `BURST_LAG_GUARDS = { maxFrameGapMs: 200, maxUnhiddenHeartbeatMs: 260 }`；
   累计量（`heartbeatOverrunMs` 3600 / `droppedFrames` 140）与 longtask 三件套一分未动；
   payload 增 `secondMax*` / `frameGapsTop5` / `gapsOverFrameLimit` / `overLimitHeartbeats` / `limits.guards`。

**两条额外产品缺陷**（执行中发现，同属"抖动探针"范围）：

5. **整轮截图挂死**：三条滚动探针用裸 `requestAnimationFrame` 等两帧，而隐藏窗口下 Chromium 不派发 rAF
   → promise 永不 settle（实测 `g-full-dark-1` 在 `chat.png` 之后挂死 20 分钟、`report.json` 一张不写）。
   修法：`Promise.race(帧, 120ms)` + `document.hidden` 时走定时器快路径。
6. **`chat.png` 的全量真红**：`useStickToBottom` 的 `onVisibility` 恢复可见时只 `refresh()`
   （只在 `following` 为真时排一帧对齐）、**不重排心跳巡检**，导致"MutationObserver 回调会停"
   那条已知失效路径失去兜底（实测 `k-full-dark-1`：`followed:1613 / timedOut:true`，而收尾 `stick()` 能恢复）。
   修法：恢复可见 / 重新获得焦点时 `restartGuard()`（先取消在途句柄再重排 + `core.onMutated()`）。

## 二、验收结果（最终状态）

| 项 | 结果 |
| --- | --- |
| `AURORA_CAPTURE` 全量 dark × 3（审查前 `n-full-dark-1..3`） | 各 93 checks，失败项**只剩** `chat-model-picker.png`（范围外） |
| `AURORA_CAPTURE` 全量 light × 1（`n-full-light-1`） | 93 checks，同样只剩它 |
| 审查修复后**重跑** dark × 3（`z2-full-dark-1..3`） | 各 93 checks，同样只剩它 |
| 审查修复后**重跑** light × 1（`z2-full-light-1`） | 93 checks，同样只剩它 |
| `chat-sidebar` 定向（`edge-bar-work,chat-sidebar` × 3） | 3/3 PASS：`contextCards=["任务清单","今日课程","系统状态"]`、`panelMatchesMain:true`、`forcedToggle:false` |
| `chat-archive` 定向（单场景 × 4 + `chat-` 组 × 3） | 7/7 PASS：`actReady:true`、`afterArchive{inArchive:true,inMain:false}`、`problems:[]` |
| `chat.png` 定向（× 3 + 修复后 × 4） | 7/7 PASS：`followed:1`、`awaitedMs:50`、`timedOut:false` |
| `chat-stream-burst` 定向（标定 5 + 最终 4 + 重标定后 3） | 全部 PASS；`secondMaxFrameGapMs` 最坏 74.9（限 110）、`secondMaxUnhiddenHeartbeatMs` 最坏 146.5（限 160） |
| `pnpm typecheck` | 全绿（5 个包） |
| `pnpm test` | **171 文件 / 2546 用例全绿** |
| `pnpm vitest run packages/shared/src/browser` | 68/68 |
| Center `verify:web`（改了 shared 渲染层，两端都验） | **88 场景 / 0 失败** |
| `pnpm exec eslint <改动文件>` | 0 problem |

**反向复核**（证明判据没被改松；全部有磁盘 payload）：

| 探针 | 复核方式 | 结果 |
| --- | --- | --- |
| `chat-sidebar` | 确定性注入"丢失广播后的陈旧 store" | `forcedToggle:true` → `pass:false`（哨兵抓到） |
| `chat-archive` | 旧身份键（整行文本）走一遍归档 | 旧键 `inArchive:false / inMain:false`（与历史失败态同形），同轮新键命中 |
| `chat.png` | 临时关掉吸底调度入口（`stickToBottomCore.schedule()`） | `followed:1966 / attempts:20 / timedOut:true` → FAIL |
| `chat-stream-burst` A | 爆发轮**每帧**插 130ms 忙等 | `secondMaxFrameGapMs:177 > 110`、`droppedFrames:233 > 140`、`frameGapsTop5` 整体抬高 → FAIL |
| `chat-stream-burst` B | 一次性 600ms 阻塞 | `maxFrameGapMs:609.8 > 200`、`maxUnhiddenHeartbeatMs:606.2 > 260`、`maxLongTaskMs:600` → FAIL |

## 三、独立代码审查结论与处置

按 diff 规模派了 **4 个干净上下文审查子代理**（正确性+验收 / 安全边界+项目约定 / 独立复跑核对 / 对抗性复核）。
汇总结论：**有条件可交付**，无 P0；"全量只剩 `chat-model-picker`"、"定向+反向复核"、"typecheck/test 全绿"
三条验收被独立复跑**证实**。发现并**已全部处置**：

| 级别 | 问题 | 处置 |
| --- | --- | --- |
| P1 | 心跳侧保留旧主判据 `maxUnhiddenHeartbeatMs <= 160`，因 `secondMax <= max` 恒成立，新闸门**永远不可达**（死代码）→ "离群容忍"在心跳侧等于没做，三条单拍尖峰轮（198.5 / 234.1 / 182.1）仍被判红 | 删除旧判据，与帧侧统一为「`secondMax <= 160` + 闸门」；改掉注释里不成立的因果 |
| P1 | 闸门 260/300 是对着**被探针/产品缺陷污染的读数**标定的；仪器修好后今日尾巴只有 54.2 / 182.1，放宽无必要证据，且 110–260 的单帧回归成为盲区 | 重标定 `BURST_LAG_GUARDS = { 200, 260 }` |
| P1 | `step-05` 的"9 轮全绿"漏算同期两条红轮、且引用的数字与磁盘不符 | 在 step-05 记录里如实补记（13 轮中 11 绿 2 红，红的都是上述心跳旧判据所致） |
| P2 | 侧栏 check 的"自愈"会**真实切两次模式**（走 `requestGuideIfNeeded`，可能建窗/抬引导），与文档"本场景不改任何状态"冲突 | **取消自愈**（只记录并判 FAIL），`docs/07` 同步 |
| P2 | `docs/07` 的闸门数值与 payload 字段名过时（`260` / `topFrameGaps`） | 按终版改为 200/260 与 `frameGapsTop5` |
| P2 | `capture.ts` 注释引用的反向复核（阻塞 400ms）被 step-04 自己否掉 | 改引真正有效的对照（关掉吸底调度） |
| P2 | `restartGuard` 不取消在途句柄 → 每次 focus / visibilitychange **永久多一条巡检链** | 先 `cancelAnimationFrame` / `clearTimeout` 再重排，并加 `document.hidden` 早退 |
| P2 | 「先订阅再加载」这条产品修复**没有任何测试守着**（改回旧序 2544 用例仍全绿） | 新增 `apps/desktop/src/renderer/shared/bootstrap.test.ts`（AST 断言 `bind` 早于 `load`，覆盖 settings/modes/windows） |
| P3 | 被闸门拦下的首读仍会写 `error.value`（"新数据 + 旧报错"） | `loadGate.write` 按生效结果决定是否写 error |
| P3 | `chat-ctx-empty-tools` 的探针 payload **没有 `pass` 字段** → 任何失败判定口径对它失效（先于本次存在） | **不在本轮范围**，已记入遗留并另开任务 |
| P3 | `chat.png` 的判定窗口由 150ms 变 ≤1000ms（1s 内的"慢"不再判红） | 已知取舍，记入 Memory；`awaitedMs/attempts/timedOut` 已落盘 |

## 四、提交清单（`249322f..HEAD`，14 条）

```
docs(step): 生成四条抖动探针修复计划（fix-flaky-chat-probes）
fix(renderer): 启动期改为先订阅再加载，避免永久丢掉 mode:changed
fix(capture): chat-sidebar 场景自带 classroom 前置并加模式一致性哨兵
fix(capture): chat.png 吸底跟随改成有界轮询
fix(capture): chat-stream-burst 判据换成离群容忍 + 灾难闸门
fix(capture): chat-archive 身份键换 data-session-id 并补 act 冷窗前置
fix(capture): 帧等待加有界兜底，避免隐藏窗口下整轮截图挂死
fix(renderer): 窗口恢复可见时重启吸底心跳巡检
docs: 记录四条抖动探针的根因与判据策略，并回填截图基线
docs(step): 回填 Center verify:web 88/88 两端验收记录
fix: 处理独立审查发现的判据/边界问题
```

（完整 SHA 见 `00-index.md` 的「执行记录」章节。）

## 五、遗留问题（后续任务）

1. **`chat-model-picker.png`**：既存红项（同码基线逐字复现），用户明确划出本轮 —— **另开任务**。
2. **`chat-ctx-empty-tools.png` 的探针缺 `pass` 字段**（只有 `{ok, reason, detail}`）：
   按任何失败判定口径它都不可能被判失败（先于本次存在的盲点）—— 另开任务。
3. **`chat.png` 的判定窗口语义**：由"150ms 内跟上"变成"1s 内跟上"（已知取舍，已记入 Memory）。
4. **`chat-sidebar` 的产品竞态正向复现仍是低概率**（回退实验 0/3）：本轮靠哨兵 +
   `bootstrap.test.ts` 顺序护栏守，而非靠概率撞。

## 六、文件清单

本目录共 9 个文件：`00-index.md`、`step-01`–`step-07` 七份步骤文件、`REPORT.md`（本文件）。
步骤状态：step 1–6 `done`（验收全部满足），step 7（归档）`done`。
