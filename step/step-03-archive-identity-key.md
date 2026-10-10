# Step 03 — 修 chat-archive：act 前置轮询 + 身份键换成稳定锚点

- Task: fix-flaky-chat-probes
- Step: 3 / 7
- Status: pending
- Depends on: step 1
- Produces: 冷窗可用的 `CHAT_ARCHIVE_ACT` 前置（含把就绪状态传进 check 的全局）+ `CHAT_ARCHIVE_CHECK` 用稳定身份键判定"那一条是否已挪到归档列表"
- Phase: 核心链路
- Writes: `apps/desktop/src/main/capture.ts`、`apps/desktop/src/renderer/chat/components/SessionRow.vue`（仅当选择加 `data-session-id` 锚点）、`docs/07-ui-spec.md`（仅当新增锚点需要记进行结构说明）
- Size: M
- Risk: ①只修身份键、不修 act 前置 —— 单场景跑仍恒红，验收全是假红；②用「标题文本」当身份键时**标题可能重复**（seed 里就多条「新会话」），换弱判据反而放过"挪错了行"。退法：保留"计数 ±1"这条硬断言作为主判据、身份键只作归属校验；重复标题下再补 `data-session-id`。
- Sources: 本次未联网

## 目标

让「归档 / 取消归档」这条往返在**冷窗**（单场景跑）与**热窗**（全量跑）下都能拿到有效现场，并且归属判定不受相对时间文本变化影响：act 轮询等前置、check 用稳定锚点 + 保留计数断言。

## 输入

- `step/step-01-reproduce-and-triage.md` 的「执行记录」里 `chat-archive` 那一条。
- **两条独立缺陷**（别只修一条）：
  1. **act 冷窗**（本轮已复现）：`CHAT_ARCHIVE_ACT`（`capture.ts:6486-6511`）在 `capture.ts:265-268` 的冷窗（`act` 前只等 60ms）里，`[data-field="chat.archive-toggle"]` 还没渲染（`SessionNav.vue:570` 的 `v-if="archivedSessions.length>0"`），act 返回 `ready:false`，而 **act 的返回值被直接丢弃**（`capture.ts:265-268` 只执行不合并，合并的只有 `mainAct`）→ 单场景跑恒红：`ONLY='chat-archive'` 实测 `ariaExpanded="false"`、`archiveRows:0`、problems 首条「归档分组未展开（aria-expanded=false）」。
  2. **身份键不稳**：`CHAT_ARCHIVE_CHECK`（`capture.ts:6529`）的身份键在 `:6573` 取整行文本 `textOf(targetRow.querySelector('.nav-item'))`，而 `.nav-item` 内含 `.item-time`（`SessionRow.vue:76` 的 `formatRelativeTime`，`:42` 的「刚刚」）→ 跨分钟时同一条会话的整行文本会变，`:6585 / :6590 / :6591` 的 `indexOf(movedTitle)` 两边都失配（旧报告里出现过 `{mainRows:2,archiveRows:2,inArchive:false,inMain:false}` 这一形态）。
- 行结构：`SessionRow.vue:55` `.nav-row` → `:56` `button.nav-item` → `:63` `.item-title`（稳定）/ `:76` `.item-time`（会变）；归档按钮动作锚点在 `:86`；当前**没有** `data-session-id`。
- 计数断言（`count(MAIN) === beforeMain - 1` / `count(ARCH) === beforeArchive + 1`）是这条探针的**主判据**，本次不动。
- 探针字符串硬规则：不写反引号（注释用「」）、不写带反斜杠的正则。

## 操作

1. **先修 act 前置**：`CHAT_ARCHIVE_ACT` 改成
   - 有界轮询等 `[data-field="chat.archive-toggle"]` 出现（例如 40 × 100ms），出现后再 click；
   - click 后有界轮询等 `[data-field="chat.archive-list"] .nav-item` 行数 ≥ 1；
   - 把 `ready` / `toggleFound` / `rows` / `attempts` 写进全局 `window.__auroraArchiveProbe`（**不要只靠返回值**，它会被丢弃）；等不到就 `ready:false` 并把诊断留在同一个全局里。
2. **把就绪状态接进判据**：`CHAT_ARCHIVE_CHECK` 读 `window.__auroraArchiveProbe`，`ready !== true` 时在 `problems` 里记「归档分组前置未就绪（act 未拿到 toggle / 行）」并判 FAIL —— 让"前置没准备好"变成**显式失败**，而不是像今天这样在冷窗里静默退化。
3. **换身份键**：`movedTitle` 改取 `targetRow.querySelector('.item-title')` 的文本；元素不存在时退回整行文本并在 `problems` 记一条"行结构变了：找不到 .item-title"（避免静默降级）。归属判定（`:6585` 的轮询条件、`:6590/:6591` 的 `inArchive`/`inMain`）与取消归档那一段（`:6620` 之后）一并改用新键；**计数断言保持**。
4. 若 step 01 的取证显示存在**标题重复**风险，则给 `SessionRow.vue:55` 的 `.nav-row` 加 `data-session-id="item.id"`，探针改用该属性；同步在 `docs/07-ui-spec.md` 的行结构说明里补这个锚点。
5. 把本步的改动与验证写进**本文件的「执行记录」**（执行阶段填写；全任务的汇总由 step 06 统一追加）。

## 验收标准

- [ ] `$env:AURORA_CAPTURE_ONLY='chat-archive'` **连续跑 3 次**（各自独立目录）：`result.pass` 三次均为 `true`，payload 里 `__auroraArchiveProbe.ready === true`，且 `afterArchive` 每次形如 `{mainRows: n-1, archiveRows: m+1, inArchive: true, inMain: false}`（贴三次 payload）。**这条验收同时是 act 前置修复的验收**：修复前它 4/4 恒红（`ariaExpanded="false"`）。
- [ ] **反向复核（可复现，两条各一）**：
  - act 前置：临时把第 1 步的轮询改回"直接 click"（即原实现），复跑 1 次应重现 `ariaExpanded="false"` 与「归档分组未展开」；测完恢复。
  - 身份键：临时把身份键改回整行文本，并在探针里**人为把 `.item-time` 文本改掉**（例如在 click 之后用 `textContent` 覆写该行的时间节点），确认 `inArchive`/`inMain` 双双失配 → 证明新键不会因此失配；测完恢复。
- [ ] 计数断言仍在：`afterArchive.mainRows` / `archiveRows` 与归档前相差 ±1，且 `problems` 为空。
- [ ] `pnpm vitest run apps/desktop/src/main/capture.probe-strings.test.ts` 通过；若动了 `SessionRow.vue`，`pnpm typecheck` 通过、`pnpm vitest run apps/desktop/src/renderer` 通过，且 `docs/07-ui-spec.md` 的锚点说明已更新。

## 交接

- 新的身份键表达式与行号；`window.__auroraArchiveProbe` 的字段名。
- 若引入了 `data-session-id`，把属性名与所在文件写清（后续探针都能复用这个锚点）。
- 给 step 06 的提醒：若本步改了 `docs/07-ui-spec.md`，step 06 的文档回填不要覆盖它。

## 交接

- 新的身份键表达式与行号；若引入了 `data-session-id`，把属性名与所在文件写清（后续探针都可以复用这个锚点）。
- 给 step 06 的提醒：若本步改了 `docs/07-ui-spec.md`，step 06 的文档回填不要覆盖它。
