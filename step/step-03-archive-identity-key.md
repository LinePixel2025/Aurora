# Step 03 — 修 chat-archive：act 前置轮询 + 身份键换成稳定锚点

- Task: fix-flaky-chat-probes
- Step: 3 / 7
- Status: done
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

## 执行记录（2026-10-10 执行阶段）

### 实际改动

| 文件 | 改动 |
| --- | --- |
| `apps/desktop/src/main/capture.ts`（`CHAT_ARCHIVE_ACT`） | 加**冷窗前置**：有界轮询等 `[data-field="chat.archive-toggle"]` 出现（最多 40×100ms）再 click，再轮询等归档列表出行；把 `{ready, toggleFound, rows, toggleAttempts, attempts, expanded, label, reason}` 写进 `window.__auroraArchiveProbe`（act 返回值会被丢弃，只能经全局变量传给 check）。 |
| `apps/desktop/src/main/capture.ts`（`CHAT_ARCHIVE_CHECK`） | ① 读 `window.__auroraArchiveProbe`，`ready !== true` 直接进 `problems` → **前置没就绪变成显式失败**；② **身份键换成 `data-session-id`**：`movedSessionId = targetRow.getAttribute('data-session-id')`，归属判定用 `rowBySessionId('[data-field="chat.archive-list"]', id)` / `rowInMain`，取消归档那一段同改；③ `movedTitle` 改取 `.item-title` 文本、另回传 `movedNavText`（旧口径整行文本）与 `movedNavTime`（相对时间那段）作为**排障读数**；④ 取不到 `data-session-id` 时**如实报 problem**，不静默降级。**计数断言一字未改**（`mainRows` ±1 / `archiveRows` ±1 / 分组计数一致）。 |
| `apps/desktop/src/renderer/chat/components/SessionRow.vue` | `.nav-row` 加 `:data-session-id="item.id"`（行身份的稳定锚点），组件头注释写清它为什么是唯一不漂移的键。 |
| `docs/07-ui-spec.md` | §2.3 行结构说明补 `data-session-id`；§5.3 的 `chat-archive` 口径补"身份键 = `data-session-id`、`movedTitle` 只作排障"与旧口径的失败形态。 |

### 验证（验收第 1、3 条）

`$env:AURORA_CAPTURE_ONLY='chat-archive'` × 4（独立目录 `v-s3single-1..4`，**修复前这条 4/4 恒红**）：

| 轮次 | `actProbe.ready` | `actProbe.rows` | `afterArchive` | `afterUnarchive` | `problems` | pass |
| --- | --- | --- | --- | --- | --- | --- |
| 1–4（逐字相同） | true（`toggleAttempts:4`、`attempts:2`） | 1 | `{mainRows:2,archiveRows:2,inArchive:true,inMain:false}` | `{mainRows:3,archiveRows:1,inMain:true,inArchive:false}` | `[]` | true |

另在 `chat-` 窗口组筛选跑（`v2-s3-1..3`，42 条 checks）里 `chat-archive.png` 也 **3/3 PASS**，
payload 与上表同形（`movedSessionId:"main"`、`movedTitle:"新会话"`、`movedNavText:"新会话刚刚"`、
`movedNavTime:"刚刚"`）。收尾后重跑 3 次（`v3-s3-1..3`）仍 3/3 PASS。

### 反向复核（验收第 2 条，两条都做了）

1. **act 前置**：单场景筛选跑在修复前是 `ariaExpanded:"false"` / `archiveRows:0` / 4/4 恒红
   （step 01 执行记录已贴），根因是 toggle 由 `v-if="archivedSessions.length > 0"` 渲染、
   act 只等 60ms。修复后同样条件下 `actProbe.ready:true`（等了约 400ms 才出现 toggle）。
2. **身份键（决定性）**：在探针里临时用**旧键**（click 前冻结的整行文本 `"新会话刚刚"`）走一遍
   归档，并等一次**真实的相对时间变化**（最多 65s；本轮 65s 内 `.item-time` 文本没变，如实记 `tempTimeChanged:false`）：

   ```
   "tempOldKeyMismatch":{"oldKey":"新会话刚刚","inArchive":false,"inMain":false,"newKeyInArchive":true}
   ```

   —— **旧键在"计数已正确迁移"的情况下两边都失配（`inArchive:false` / `inMain:false`），
   与 step 01 复现到的历史失败态逐字同形；而同一轮的新键 `newKeyInArchive:true` 正确命中**。
   即：新判据不是"被改松"了，而是把"身份键取错对象"这个真缺陷摘掉。取证后临时段已删除。

### 说明 / 遗留

- 本轮**没有**复现出"相对时间恰好跨分钟"这一条正向现场（`.item-time` 在 65s 内没变），
  但反向复核已给出同形证据，且 step 01 的全量复现（`inArchive:false` / `inMain:false`）
  就是这条漂移链的真实产物。机理在 `SessionRow.vue` 的 `formatRelativeTime`（`刚刚` → `N 分钟前`）。
- `movedNavText` / `movedNavTime` 是**排障读数**（不参与判定），保留成本极低、定位价值高，故留在 payload 里。
