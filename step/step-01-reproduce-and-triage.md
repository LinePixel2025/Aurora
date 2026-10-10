# Step 01 — 四条抖动复现与归属定性

- Task: fix-flaky-chat-probes
- Step: 1 / 7
- Status: pending
- Depends on: none
- Produces: 四条各自的复现命令、`report.json` 证据片段与归属结论（写在本文末「执行记录」里，供 step 2–5 直接引用）
- Phase: 基础与配置
- Writes: 只读
- Size: M
- Risk: 把**筛选跑的假 FAIL** 当成真失败（`chat-model-picker` 在只跑单场景时会因缺前置夹具而恒红）；把"这一轮没复现"当成"问题不存在"。退法：每条结论都必须给出**复现命令 + report 片段**，给不出就写"未复现"并列出已排除的可能。
- Sources: 本次未联网

## 目标

把四条抖动从"四次跑下来红项组合各不相同"收敛成四条**各自可复现、可归属**的结论：每条要么是「探针判据/等待策略问题」，要么是「场景互相污染」，要么是「产品行为缺陷」，并写清证据。后续四个修复步骤只照这份结论动手。

## 输入

- 计划：`step/00-index.md`（「现状与关键结论」已给出每条的失败 payload 与根因候选）
- 探针与阈值位置（逐字引用，不要凭记忆）：
  - `apps/desktop/src/main/capture.ts:4301` `CHAT_SIDEBAR_SCRIPT`（同步脚本，`.ctx-card .ctx-head strong`）
  - `apps/desktop/src/main/capture.ts:729` `EDGE_BAR_WORK_ACT` / `:744` `EDGE_BAR_WORK_CHECK`（还原后 `wait(120)` 在 `:754`）
  - `apps/desktop/src/renderer/shared/bootstrap.ts:31-35`（`await load()` 在 `bind()` 之前 —— 启动期丢广播的位置）
  - `packages/modes/src/manager.ts:136-143`（同值 `set` 提前 return、不 emit）、`apps/desktop/src/main/ipc.ts:542-547`（handler 无额外广播）、`ipc.ts:1295-1297`（`mode:changed` 的唯一来源）
  - `apps/desktop/src/main/capture.ts:6486-6511` `CHAT_ARCHIVE_ACT`、`:6529` `CHAT_ARCHIVE_CHECK`（身份键在 `:6573` 取整行文本）、`:265-268`（**act 返回值被丢弃**，只合并 `mainAct`）
  - `apps/desktop/src/renderer/chat/components/SessionRow.vue:63/76`（`.item-title` vs `.item-time`）
  - `apps/desktop/src/main/capture.ts:801` `CHAT_AUTO_SCROLL_SCRIPT`（`:825` 只等 150ms、`:874` 的 `pass` 判据）
  - `apps/desktop/src/main/capture.ts:12214`（`AURORA_CAPTURE_ONLY` 是**子串匹配**）、`:12225-12241`（`failedCaptureFiles` 只挑 `pass=false`/`ok=false`）
  - `apps/desktop/src/main/capture.ts:5223` `BURST_LAG_LIMITS`、标定史 `:5185-5222`、payload 字段 `:5519-5530`；`CHAT_FOLLOW_BURST_SCRIPT` 在 `:902`（自己的 `maxDistance <= 4` 在 `:955`，**不共用** `BURST_LAG_LIMITS`）
- 历史证据（本会话已实测，可直接引用）：
  - 改动前同码基线（`git stash -u` + 重建，`$env:TEMP\aurora-capture-baseline`）：92 探针 / 唯一红项 `chat-model-picker.png`
  - 本轮四轮：run1(dark) 4 红={model-picker, archive, chat.png, burst}；run2(dark) 2 红={model-picker, sidebar}；light 1 红={model-picker}；run3(dark) 2 红={model-picker, burst}
  - `chat-sidebar` 失败态 `contextCards=["任务清单","工作目录","系统状态"]`；`chat.png` 失败态 `followed=1613`；`chat-archive` 单场景跑失败态 `ariaExpanded="false"`、`archiveRows:0`、problems 首条「归档分组未展开」；burst 失败态 `maxFrameGapMs 133.3/141.7`、`maxHeartbeatMs 152.4/177.7`
  - `theme-chat.png` **从未失败**（全量检索 `%TEMP%` 下所有 `aurora-capture*` 报告）：19:38 那次 `ONLY=failed` 跑到它，只是因为失败项 `chat.png` 是它的**子串**
- 运行方式（每条命令前先 `Remove-Item env:ELECTRON_RUN_AS_NODE`）：
  - 全量：`$env:AURORA_CAPTURE="$env:TEMP\aurora-capture"; $env:AURORA_CAPTURE_THEME='dark'; pnpm dev`
  - 定向：在上述基础上加 `$env:AURORA_CAPTURE_ONLY='<png 文件名子串>'`（逗号分隔）
  - 读判据：`Get-Content "$env:TEMP\aurora-capture\report.json" -Raw | ConvertFrom-Json`，逐条看 `checks[].result.pass` 与 payload

## 操作

> 每一步都写进**独立目录**（`AURORA_CAPTURE="$env:TEMP\s1-<主题>-<序号>"`）：同一目录会被下一轮覆盖 `report.json`；
> 且日志在 `app.exit` 前不 flush，**失败项只认 `report.json`**，不要拿日志找 FAIL。

1. **`chat-sidebar` 复现（启动期丢广播）**：先跑污染源 + 受害者两个场景，再跑一轮只受害者做对照。
   - 命令 A：`$env:AURORA_CAPTURE_ONLY='edge-bar-work,chat-sidebar'`（真实文件名：`edge-bar-work.png` 在 `capture.ts:11330`、`chat-sidebar.png` 在 `:11351`），**跑 3 次**，目录分别用 `s1-both-1..3`。
   - 命令 B：`$env:AURORA_CAPTURE_ONLY='chat-sidebar'`，目录 `s1-sidebar-only`。
   - 判据：`chat-sidebar.png` 的 `result.contextCards` 是否含 `工作目录`／缺 `今日课程`。
   - 次数说明：这条竞态依赖"chat 窗口在 work 期间被建窗"，**单次通过不构成反证**；3 次都没复现时，改用§4 的确定性构造。
2. **`chat-archive` 两条缺陷分开取证**：
   - 命令：`$env:AURORA_CAPTURE_ONLY='chat-archive'`，目录 `s1-archive-1`。
   - 记录 `ariaExpanded` / `archiveRows` / `seedInArchive` / `problems`：**首条 problem 是「归档分组未展开」→ 这是 act 冷窗问题，与身份键无关**（本轮已复现过：`ariaExpanded="false"`、`archiveRows=0`）。
   - 身份键那条要另取现场：在全量或带前置的跑里记录 `movedTitle` 与归档列表里同一条的目的文本，比对两者是否含**不同**的相对时间（`SessionRow.vue:76` 的 `formatRelativeTime`）。
3. **`chat.png` 吸底跟随**：命令 `$env:AURORA_CAPTURE_ONLY='chat.png'`，目录 `s1-autoscroll-1..5`。**注意这是子串匹配**：实测会命中 `theme-chat.png` + `chat.png` 两个场景（≈1 分钟/轮）；**不要用 `'chat'`** —— 那会命中 44 个场景（约 20 分钟）且现场互相污染。
   - 判据：`followed` 的二值分布（`1` = 跟上 / `≈1613` = 没跟上），以及同轮 `awaitedMs`（若探针已有该字段；没有就记 `scrolled`/`maxScroll` 作为"插入后读数的时机"旁证）。
4. **确定性构造竞态（第 1 条的兜底取证）**：给 `chat-sidebar.png` 场景临时加一个 `mainAct`：`await manager.reload('chat')` 之后**立刻**把模式切到 classroom（复刻"建窗/重载与广播赛跑"的时序），跑 `AURORA_CAPTURE_ONLY='chat-sidebar'`，看 `contextCards` 是否出现 work 卡片。这一步只用于取证，取证后删掉该 `mainAct`。
5. **`chat-stream-burst` 量纲**：命令 `$env:AURORA_CAPTURE_ONLY='chat-stream-burst'`，目录 `s1-burst-1..3`。抄下 `maxFrameGapMs`、`droppedFrames`、`longTaskCount`、`maxLongTaskMs`、`maxHeartbeatMs`、`heartbeatOverrunMs`。
   - **必须额外补一条现场读数**：payload 目前**没有帧距序列**（`capture.ts:5523-5526` 只有 `maxFrameGapMs`/`droppedFrames`；`topHeartbeatGaps` 是**心跳**序列）。因此本步要在探针里**临时**加一行记录"帧距前 5 大"（`frameGaps.slice(0,5)`），跑完把读数抄进「执行记录」；这行临时记录的去留由 step 05 决定（它要在正式判据里用到）。
   - 判据：第 2 大帧距与最大帧距的比值（单点离群：最大 ≫ 第二；整体劣化：两者同量级且都越 110）。
6. 把四条结论写进本文末「执行记录」，每条形如：
   `chat-sidebar：归属＝渲染层启动期丢广播；证据＝命令 A 第 k 次 payload X，对照 B payload Y，确定性构造 Z`。
   凡"未复现"的，写明跑了多少次、观察到什么、以及确定性构造的结果。

## 验收标准

- [ ] 四条各有至少一条**可被第三方复跑**的命令，且命令里出现的 PNG 子串在对应 `report.json` 的 `files` 里真实存在（贴出实际文件名与"命中几个场景"）。
- [ ] **每轮都写了独立目录**，且贴出的对照数据来自各自目录的 `report.json`（不是同一个被覆盖的文件）。
- [ ] 四条各有 `report.json` 的 payload 片段（关键字段即可），能支持"归属"这一结论；`chat-sidebar` 若 3 次未复现，必须给出第 4 步确定性构造的结果。
- [ ] `chat-stream-burst` 那条给出了**帧距前 5 大**的读数（临时记录），并说明最大 / 第二大的关系。
- [ ] 「执行记录」里四条结论齐备，每条都标了归属类型（探针判据 / 渲染层竞态 / 产品行为）与对应修复步骤编号。
- [ ] 没有把 `chat-model-picker` 或 `theme-chat` 的红当成这四条之一的证据（前者范围外、后者未失败过）。

## 交接

- 给 step 2–5 的是「执行记录」里的四条结论（含命令与 payload）；step 2–5 的「输入」直接引用本文件路径，不要重新推导。
- 若某条结论与 `step/00-index.md` 的根因候选不一致（例如 sidebar 其实不是 work 污染），在「执行记录」里显式写"改判"，并说明新证据；step 2 起按改判后的结论执行。
