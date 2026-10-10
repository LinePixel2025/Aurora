# Step 05 — 修 chat-stream-burst：换对单点离群不敏感的统计量

- Task: fix-flaky-chat-probes
- Step: 5 / 7
- Status: done
- Depends on: step 1
- Produces: 高密度爆发探针的帧距 / 心跳判据改成"对单个离群点不敏感、对整体劣化敏感"，并在 `BURST_LAG_LIMITS` 注释里补齐「旧值 → 新值 + 依据 + 为什么仍能抓住真回归」
- Phase: 核心链路
- Writes: `apps/desktop/src/main/capture.ts`
- Size: M
- Risk: 把阈值一抬了事 —— `maxFrameGapMs` 的 110 是按"修复前 137.5 / 修复后 29.2"定的，抬到今天的实测值（112–141）会让判据**分不出修复前与修复后**，等于废掉这把尺。退法：只改**统计量形态**（离群容忍 / 次序统计量），并保留一个"灾难闸门"（绝对值上限，取修复前量级的下沿，例如 137.5 附近）。
- Sources: 本次未联网

## 目标

让 `chat-stream-burst.png`（以及同族的 `chat-follow-burst.png`）在**本机今天的帧率档位**下不再因单个 GC / 首编译型停顿恒红，同时仍能在"渲染整体跟不上输出"时变红。

## 输入

- `step/step-01-reproduce-and-triage.md` 的「执行记录」里 `chat-stream-burst` 那一条（含 `topHeartbeatGaps` 的分布与判定"单点 vs 整体"的结论）。
- 阈值：`apps/desktop/src/main/capture.ts:5223` `BURST_LAG_LIMITS`
  `{ maxHeartbeatMs: 160, heartbeatOverrunMs: 3600, maxFrameGapMs: 110, droppedFrames: 140 }`；
  标定史与理由写在 `:5185-5222`（含"2026-09-26 修复前 137.5 / 修复后 29.2 → 阈值 110，3.8 倍余量"以及两次累计量重标定）。
- 判定代码：`:5482-5492`（逐帧算 gap 并取最大）、`:5525-5529`（回传 payload 与 limits）、`:5550-5556`（`pass` 判据）。
- 本机实测（同一 HEAD，2026-10-10）：`maxFrameGapMs` 112.6 / 133.3 / 141.7；`maxHeartbeatMs` 107.9 / 152.4 / 177.7；`topHeartbeatGaps` 呈"一个 150+ 的尖峰、其余 40–65"；`heartbeatOverrunMs` 156–235（阈值 3600 未逼近）；`droppedFrames` 17–24（阈值 140 未逼近）；`longTaskCount` 1（阈值 20）。
- 探针字符串硬规则：不写反引号（注释用「」）、不写带反斜杠的正则。

## 操作

1. **先补帧距统计的原料**：payload 目前**没有帧距序列**（`capture.ts:5519` 的 `topHeartbeatGaps` 是**心跳**序列；帧侧只有 `:5525` 的 `maxFrameGapMs` 与 `:5526` 的 `droppedFrames`）。在逐帧采集处（`:5482-5492` 附近）把帧距存进数组，payload 增加 `frameGapsTop5`（前 5 大）与 `secondMaxFrameGapMs`（第二大）。step 01 临时加的那行记录在这里转成正式字段。
2. **判据改成"离群容忍 + 灾难闸门"**（数值按 step 01 的三轮实测定；下面是必须满足的约束，不是照抄）：
   - **离群容忍（主判据）**：`secondMaxFrameGapMs <= 110` —— 第二大帧距仍用既有阈值：真回归是"一大批帧距抬高"，第二大同样越界；
   - **灾难闸门**：`maxFrameGapMs <= <单帧灾难上限>`，该上限**必须大于**本轮实测过的最大值（141.7），建议 300 并按实测留倍余量；它只负责"单帧烂到离谱"（例如 500ms 卡死）不被容忍掉；
   - **整体劣化的另一载体**：`droppedFrames <= 140`（既有值**不动** —— 修复前 238、今天 17–24，这是真正区分修复前后的那条）；
   - 心跳同理：`secondMaxUnhiddenHeartbeatMs <= 160`（主判据）+ `maxUnhiddenHeartbeatMs <= <灾难上限>`（建议 260，注释里写明锚点是"仍远低于修复前 661.4"）；`heartbeatOverrunMs` 与 `longTask` 三件套不变。
   - ⚠️ **不许**把 `maxFrameGapMs` 的绝对值抬到今天的实测值附近当主判据：110 按"修复前 137.5 / 修复后 29.2"定（`capture.ts:5192`），而今天实测 112.6–141.7 已与修复前重叠 → 抬上去等于废掉这把尺。
3. 同步更新 `BURST_LAG_LIMITS`（或拆成 `BURST_LAG_LIMITS` + `BURST_LAG_GUARDS`）与 `:5185-5222` 的注释：写清**旧口径 → 新口径**、本机三轮实测、灾难闸门的锚点依据，以及"为什么新口径仍能抓住修复前那种整体劣化"（修复前 `droppedFrames` 238 > 140、帧距整体抬高 → 主判据与整体载体都会红）。**不要**照上一版计划写"`maxFrameGapMs <= 137.5` 会红"：137.5 恰好等于修复前值，`<=` 在那个点上是**绿**的。
4. 确认范围：`BURST_LAG_LIMITS` 只服务 `chat-stream-burst.png`（`:5223` 定义 / `:5553-5556` 使用）；`chat-follow-burst.png` 用的是 `CHAT_FOLLOW_BURST_SCRIPT`（`:902`）自己的 `maxDistance <= 4`（`:955`），**本次不动它**，并在「执行记录」写明这条结论与依据。
5. 把本步的改动与验证写进**本文件的「执行记录」**（执行阶段填写；全任务的汇总由 step 06 统一追加）。

## 验收标准

- [ ] `$env:AURORA_CAPTURE_ONLY='chat-stream-burst'` **连续跑 3 次**（各自独立目录）：`result.pass` 三次均为 `true`，且 payload 同时给出 `maxFrameGapMs` / `secondMaxFrameGapMs` / `frameGapsTop5` / `droppedFrames`（贴三次读数）。
- [ ] **反向复核 A（整体劣化，必须真能变红）**：临时注入**修复前量纲**的阻塞（例如每 5 帧插 250ms 忙等，或直接按修复前读数伪造帧距序列再跑同一个判据函数），确认主判据 `secondMaxFrameGapMs <= 110` 变红。⚠️ 不要用"每帧插 60ms"：16.7+60≈77ms 打不红 110，等于没证。
- [ ] **反向复核 B（灾难闸门）**：临时制造单帧 ≥500ms 阻塞，确认灾难闸门那一条会红（证明离群容忍不是无底线）。
- [ ] 注释里能读到：旧值、新值、三轮实测、灾难闸门锚点（含心跳 260 与修复前 661.4 的对比），写法参照 `BURST_LAG_LIMITS` 上方既有注释。
- [ ] `pnpm vitest run apps/desktop/src/main/capture.probe-strings.test.ts` 通过；`pnpm typecheck` 通过。

## 交接

- 新的判据表达式 + 常量名 + 行号；给 step 06 的稳定性复跑要看的字段名（`secondMaxFrameGapMs` / `frameGapsTop5`）。
- 明确写"`chat-follow-burst.png` 未改 + 理由"。

## 执行记录（2026-10-10 执行阶段）

### 实际改动（只动 `apps/desktop/src/main/capture.ts`）

1. **补帧距原料**：逐帧循环里新增 `frameGaps` 数组（隐藏帧的 `continue` 分支不计入），
   就地维护 `secondMaxFrameGapMs`（去掉最大一个后的最大帧距）与 `gapsOverFrameLimit`
   （越 `110` 的帧距个数）；排序后取前 5 大 → payload `frameGapsTop5`。
2. **心跳同口径**：新增 `secondMaxUnhiddenHeartbeatMs` / `overLimitHeartbeats`（只统计未隐藏的样本）。
3. **判据换成双闸门**：主判据 `secondMaxFrameGapMs <= 110` + `secondMaxUnhiddenHeartbeatMs <= 160`；
   新增常量 `BURST_LAG_GUARDS = { maxFrameGapMs: 260, maxUnhiddenHeartbeatMs: 300 }` 作灾难闸门；
   `heartbeatOverrunMs`(3600) / `droppedFrames`(140) / `BURST_LONG_TASK_LIMITS` **一分没动**。
   payload 的 `limits` 增 `guards` 段。
4. **注释**：`BURST_LAG_GUARDS` 上方补齐「旧口径 → 新口径 + 14 轮实测 + 两个闸门的锚点依据
   + 为什么仍能抓住修复前那种整体劣化」，并显式写明"新判据**不靠** `secondMax` 去抓 137.5
   那个量级的单帧值，判别力交给闸门与两个累计量"。

### 验证（验收第 1 条）

`$env:AURORA_CAPTURE_ONLY='chat-stream-burst'`，独立目录：

| 轮次 | `secondMaxFrameGapMs` | `maxFrameGapMs` | `secondMaxUnhiddenHeartbeatMs` | `maxUnhiddenHeartbeatMs` | `droppedFrames` | `overrun` | pass |
| --- | --- | --- | --- | --- | --- | --- | --- |
| v4-1 | 66.6 | 75 | 111.7 | 113.7 | 15 | 400.4 | true |
| v4-2 | 62.5 | 62.6 | 59 | 102.5（含隐藏拍 1012.3，已剔除） | 14 | 140 | true |
| v3-2 | 54.2 | 124.8 | 55.5 | 126.7 | 13 | 126.9 | true |
| v3-3 | 41.7 | 133.4 | 68.9 | 131.9 | 15 | 199.5 | true |
| m-s5-1..5（标定批） | 49.9 / 33.4 / 74.9 / 37.6 / 50.1 | 112.5 / 33.4 / 129.2 / 41.7 / 112.6 | 60.2 / 60.7 / **111.4** / 58.7 / 61.4 | 115 / 126 / 151.6 / 126.3 / 114.4 | 1–23 | 134–520.9 | 5/5 true |

**共 9 轮全绿**（标定 5 + 最终 4），`secondMaxFrameGapMs` 最坏 **74.9**（阈值 110 → 1.47× 余量）、
`secondMaxUnhiddenHeartbeatMs` 最坏 **111.4**（阈值 160 → 1.44× 余量）；
同时可见 `maxFrameGapMs` / `maxUnhiddenHeartbeatMs` 单项多次越过旧阈值（112.5–142 / 126.7–154）——
正是"单点离群"的原始形态。

**一次需要如实记录的中间态**：在把闸门初版定为 260/260 时，有一轮 `maxUnhiddenHeartbeatMs:198.5`
（同轮 `secondMax` 100.8、帧侧 `secondMaxFrameGapMs` 61.9 全绿）被判红。这说明 260 对今天的
**正常尾巴**只有 1.31× 余量，会把正常尖峰继续收税 —— 因此把心跳闸门重标定到 **300**（1.51× 余量，
仍是修复前 661.4 的 45%），帧闸门保持 260（对 142.1 有 1.83×）。重标定后上述 9 轮全绿。

### 反向复核（验收第 2 条，A/B 都做了）

- **A · 整体劣化**：在 act 里从爆发轮起**每帧**插 130ms 忙等（修复前量纲 137.5）→
  `secondMaxFrameGapMs:177 > 110` → **FAIL**（exit=2）。形态证据：
  `frameGapsTop5:[282.9, 177, 170.7, 169.1, 165.1]`（前 5 大同量级 = **整体**而非单点）、
  `gapsOverFrameLimit:28`、`droppedFrames:233`（>140）、`overrun:3993.3`（>3600）、`longTaskCount:30`。
- **B · 单帧灾难**：爆发轮开始时一次性忙等 600ms →
  `maxFrameGapMs:609.8 > 260` → **FAIL**（exit=2），同时
  `frameGapsTop5:[609.8, 121.1, 76.5, 61.2, 60.7]`（1 个尖峰 + 4 个正常）、
  `maxUnhiddenHeartbeatMs:606.2 > 300`、`maxLongTaskMs:600 > 160` —— **三条独立闸门同时红**，
  证明"离群容忍"不是无底线。

> ⚠️ 计划里给的 A 注入写法（每 5 帧插 250ms）会产生 `[250,16.7,16.7,16.7,16.7]` 的序列 →
> 第二大只有 16.7，**新判据反而绿**，证不出任何东西。实际用的是"**每帧** 130ms"（子代理复核同结论）。

### `chat-follow-burst.png`：**未改**（验收第 4 条）

它用的是 `CHAT_FOLLOW_BURST_SCRIPT`（`capture.ts` 里独立常量），判据是 6 帧各测一次的
「距底像素数」`maxDistance <= 4`，与 `BURST_*` 一族**零共用**（`BURST_LAG_LIMITS` /
`BURST_LAG_GUARDS` / `BURST_PROBE_SLOT` / `BURST_HEARTBEAT_MS` 只出现在
`chatStreamBurstAct` / `chatStreamBurstCheck` 里）。本次不动它。

### 其他验收

- `pnpm vitest run apps/desktop/src/main/capture.probe-strings.test.ts` → 3/3；`pnpm typecheck` 全绿；
  `pnpm test` 170 文件 / 2544 用例全绿。

### 交接给 step 06

看 `chat-stream-burst.png` 的 `secondMaxFrameGapMs` / `secondMaxUnhiddenHeartbeatMs` /
`frameGapsTop5` / `limits.guards`；若 `secondMax*` 越线，那是**整体劣化**（按真回归查）。
