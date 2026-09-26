# Step 01 — ConfirmDecision 加 'machine' 出处，仅当次用户放行免边界

- Task: approval-boundary-hardening
- Step: 1 / 6
- Status: done
- Depends on: none
- Produces: `ConfirmDecision = false | true | 'always' | 'machine'` 新契约；`createConfirmTool` 三条机器放行路径与 `wrapConfirmTool` 的会话授权短路全部返回 `'machine'`；`agentLoop` 仅在 `true | 'always'` 时置 `ctx.approvedByUser`；四个工具文件与 `registry.ts` 零改动；docs/06 §11.2/§5/§12.3 与 AGENTS.md 的「残留/不区分出处」披露改写为「已修复」机制描述；相关单测期望同步 + 新增出处用例
- Phase: 核心链路
- Writes: `packages/agent-core/src/loop/agentLoop.ts`、`packages/agent-core/src/host/agentHost.ts`、`apps/desktop/src/main/agent-host.ts`、`packages/agent-core/src/loop/agentLoop.test.ts`、`apps/desktop/src/main/agent-host.test.ts`、`packages/agent-core/src/host/agentHost.test.ts`、`docs/06-agent-core.md`（§5、§11.2、§12.3 区域）、`AGENTS.md`、`step/step-01-approval-provenance.md` 与 `step/00-index.md`（执行记录回填）
- Size: L
- Risk: 漏改任何一条机器路径（agent-host.ts:311/:323/:332 或 agentHost.ts:869）= 该条逃逸链未封堵；把 `'always'` 首次也误判成 machine = 用户点「总是允许」的那一次反而被 realpath 拦（UX 回归）。退法 = 回滚本步 commit，出处语义只在 decision 一处收敛，重改成本低

## 目标

让"免掉项目根 realpath 兜底"成为**只有用户当次真的看过确认卡片并点放行**才能触发的特权，封死 2026-09 独立安全审查指出的零弹卡逃逸链（auto 根内字符串 + 指向根外的 junction → 免校验写出根外）。

## 输入

- **现状证据链（2026-09-26 实测核对，与归档 REPORT step/archive/20260926-202830-agent-context-boundary-fixes/REPORT.md 遗留 1 同源）**：
  - `packages/agent-core/src/loop/agentLoop.ts:34` `export type ConfirmDecision = boolean | 'always'`；:594-636 消费逻辑：`decision === false` 拒绝，**其余一律 `approvedByUser = true`**，:635 `ctx.approvedByUser=true` 传给工具。:619-620 注释写明「'always' 的本会话不再问由上层包装层消化，这里看到的仍是一次放行」。
  - `apps/desktop/src/main/agent-host.ts` `createConfirmTool`（:286 起）：allowPatterns 命中 `return true`（:311）、auto 无项目 `return true`（:323）、auto 根内 `return true`（:332）、卡片路径 `return await options.proactive.requestSensitiveToolConfirm(...)`（:336-341，用户答 `boolean | 'always'`）、异常 `return false`（:347）。
  - `packages/agent-core/src/host/agentHost.ts` `wrapConfirmTool`（:857-878）：会话已授权 → `return true`（:869，**不再调用** deps.confirmTool）；答 `'always'` 记入 `sessionApprovals` 并原样返回（:871-875）。
  - `ctx.approvedByUser` 的全部消费点（**本步不改**）：`packages/agent-core/src/tools/registry.ts:42`（字段定义）、`files.ts:81-82`（outsideGuard）、`terminal.ts:119`、`edit.ts:142,211`、`search.ts:146,239` —— 全部是 `=== true → allowOutside:true`。`apps/desktop/src/main/tools/file-port.ts:153` `if (allowOutside) return target`（realpath 整段跳过处）；`command-runner.ts` 的 cwd 校验同理由请求上的 `allowOutside` 决定。
- **设计（用户已拍板"严格"语义）**：`ConfirmDecision` 增加 `'machine'` 变体——语义「放行执行，但**不是**用户当次卡片批准，不得免项目根边界」。置位规则：`true | 'always'`（卡片本次批准，含首次 always）→ 置 `ctx.approvedByUser`；`'machine'`（auto 根内 / 无项目 / allowPatterns / 已记住 always 的短路）→ 不置位、照常执行、realpath 兜底保留。**工具层与端口层一字不改**（出处在 decision 一处收敛，散到四个工具是反模式）。
- **既有测试观察点**：`agentLoop.test.ts:699-730`（harness 收集 `ctx.approvedByUser` 进 `approvals` 数组）、:814「放行时把 approvedByUser 透传给工具；未注入确认钩子时保持 undefined」——该用例 confirm 返回 `true` 的语义就是"用户当次放行"，**不改也应继续绿**；`agent-host.test.ts` 三档判定 describe（约 :441-530）机器放行用例断言 `toBe(true)`，本步改为 `'machine'`；`agentHost.test.ts` 的 `'always'` 授权表用例（grep `sessionApprovals` / `总是允许`）。
- 契约类型引用面 grep 结论：`ConfirmDecision` 仅出现在 agentLoop.ts、agentHost.ts、agent-host.ts(desktop)、agentLoop.test.ts 与 docs —— `packages/modes` 不消费，无跨包涟漪。
- 文档锚点：`docs/06-agent-core.md` §5（confirmTool 契约小节，grep `ConfirmDecision` 定位）、§11.2（「项目根边界（两层…）」与紧随其后的「⚠️ approvedByUser 不区分出处」残留段——上一任务刚写的披露，本步改为已修复机制）、§12.3（确认链路）；`AGENTS.md` 三档 bullet 末尾的残留段（「且两层之外还有一条已披露未封堵的逃逸…」）。
- 验证命令（仓库根）：`pnpm --filter @aurora/agent-core build`（改 agent-core 必须重建再看下游 typecheck）、`pnpm vitest run packages/agent-core/src/loop/agentLoop.test.ts packages/agent-core/src/host/agentHost.test.ts apps/desktop/src/main/agent-host.test.ts`、`pnpm typecheck`、`pnpm test`。冒烟整跑留给 step 5。

## 操作

1. **先改文档（docs-first）**：
   - `docs/06-agent-core.md` §11.2：把「⚠️ approvedByUser 不区分出处（残留）」整段改写为机制正文——decision 四态（`false` / `true`=当次卡片放行 / `'always'`=当次卡片放行且记住该工具名 / `'machine'`=无人参与或历史授权的机器放行），**仅 `true|'always'` 置 `ctx.approvedByUser` 并免 realpath**；`'machine'` 照常执行但边界兜底保留，「根内链接指向根外」在这条路径下被 realpath 拒绝；同时写明该设计顺带兜住「用户中途切项目 → 按新根判定、按旧实例烘焙目录执行」的竞态（fail-closed）。保留 `'always'` 交互（按钮产生、超时/勿扰=拒绝）的既有表述不动。
   - §5 / §12.3：confirmTool 契约处同步四态语义（`boolean | 'always'` 字样处）。
   - `AGENTS.md`：三档 bullet 的残留段改为「已封堵（2026-09）：`approvedByUser` 仅当用户当次卡片/首次『总是允许』置位，机器放行保留 realpath 兜底；docs/06 §11.2」；不要在多处重复展开。
2. `packages/agent-core/src/loop/agentLoop.ts`：`ConfirmDecision` 加 `'machine'`；:619-626 拒绝分支不动，置位改 `if (decision === true || decision === 'always') approvedByUser = true`；`'machine'` 走执行路径但 ctx 不带 `approvedByUser`；更新 :597-600 注释（"真的问过、且没被拒"→"用户当次批准（含首次 always）"）。
3. `apps/desktop/src/main/agent-host.ts` `createConfirmTool`：:311（allowPatterns）、:323（auto 无项目）、:332（auto 根内）三处 `return true` → `return 'machine'`；三处 `logger.info` 文案补「边界校验仍生效（不带 allowOutside）」字样；卡片路径与异常路径不动。`ConfirmToolDecision` 返回类型别名（如有）随之更新。
4. `packages/agent-core/src/host/agentHost.ts` `wrapConfirmTool`：:869 已授权短路 `return true` → `return 'machine'`（用户当次没看卡片）；:868 的防御分支 `if (confirm === undefined) return true` 一并改 `'machine'`（实际不可达——`run()` 只在 `deps.confirmTool` 存在时才包装——改它是为了让「`true` = 用户当次批准」这一不变量在该函数内穷尽）；:871-875 记录 `'always'` 后**原样返回 `'always'`**（首次仍是用户批准）；函数注释（①条"直接返回 true"）同步改写。
5. 测试：
   - `agent-host.test.ts`：会翻红的是**对 createConfirmTool 返回值**的 6 条断言，逐一改 `true` → `'machine'`——:86（allowPatterns 命中）、:197（命令 trim 后命中；用例名不含「免确认」字样，**易漏**）、:291（无项目 auto）、:453（auto 根内）、:489（run_command cwd 在根内——**仅该用例首条断言**翻红，:491-493 绝对路径走卡片、保持绿）、:511（不带显式 cwd 的判定端配对用例）。卡片透传类（:100/:117/:233/:244/:258/:272/:276/:380/:409/:471-476/:493/:526）**全部不动**；:314 审计日志断言 `toContain('免确认模式')`——操作 3 是**追加**文案，不得整句重写抹掉该子串；「仍免弹卡」断言改为「decision ≠ false 且无在途卡片」；confirm 档卡片放行用例保持 `true`/`'always'` 期望。
   - `agentHost.test.ts`：会话授权 `'always'` 用例（:707/:725/:747/:768 一组）——既有断言只查 `asked` / `executed.count`（短路改造后**仍绿，无需改期望**）；需**新增**断言：第二次调用不问 confirmTool 且工具拿到的 `ctx.approvedByUser` 为 `undefined`（可扩展现有 `registerDanger` 让它捕获 ctx），首次调用仍置 `true`。
   - `agentLoop.test.ts`：新增用例「confirmTool 返回 'machine' 时执行工具但 ctx 无 approvedByUser」（复用 :699-730 的 approvals 收集观察点，期望 `approvals` 收到 `undefined`）；既有返回 true 的用例不动。
   - 三档判定回归护栏：上一任务加的「auto 档 + run_command 不带显式 cwd」用例期望同步为 `'machine'`。
6. 跑 `pnpm --filter @aurora/agent-core build` → 定向三文件 → `pnpm typecheck` → `pnpm test`。全绿即本步完成；冒烟行为验证留 step 2/5。

## 分片建议

- 片 A（内核契约）：操作 2+4 与 `agentLoop.test.ts`、`agentHost.test.ts` 同步（agent-core 两源文件 + 两测试文件）。
- 片 B（判定层）：操作 3 与 `agent-host.test.ts`（desktop 两文件）。片 A 完成后才能做片 B 的测试期望（`'machine'` 类型先存在）。
- 片 C（文档）：操作 1（docs/06 + AGENTS.md），与片 A/B 并行可做，措辞以本 step「目标+设计」段为准。
- 主代理：集成、复跑验收链、回填与提交。

## 验收标准

- [ ] `pnpm --filter @aurora/agent-core build` 成功；`pnpm typecheck` 全仓绿。
- [ ] `pnpm vitest run packages/agent-core/src/loop/agentLoop.test.ts packages/agent-core/src/host/agentHost.test.ts apps/desktop/src/main/agent-host.test.ts` 全绿，且新增「返回 'machine' 执行但 ctx 无 approvedByUser」用例名在 verbose 输出中逐字出现。
- [ ] `git diff --stat` 证明 `packages/agent-core/src/tools/` 下**零文件被改**（出处收敛在 decision 一处的结构性证据）。
- [ ] 反证（必做）：临时把 agent-host.ts:332（auto 根内）改回 `return true`、保留新用例 → 跑定向套件必须至少一条红；还原后复绿。贴出红用例名。
- [ ] 全仓 `pnpm test` 绿（较基线 1504 只增不减）；`Select-String -Path packages/agent-core/src/loop/agentLoop.ts,packages/agent-core/src/host/agentHost.ts,apps/desktop/src/main/agent-host.ts -Pattern "'machine'"` 三文件均有命中。
- [ ] docs/06 §11.2 与 AGENTS.md 不再含「不区分出处」「待专门工单」字样（Select-String 零命中），且新正文含「仅…当次…置 `approvedByUser`」与「`'machine'` 保留 realpath」两条。

## 交接

- 给 step 2：`'machine'` 语义已生效，逃逸链端到端用例（真/假 junction、竞态 fail-closed）在此契约上写；冒烟 `index.ts:1745-1802` 的 ② 仍带手工 `{ approvedByUser: true }`，由 step 2 改造。
- 给 step 3/4：`ConfirmDecision` 已扩展，若其文案/日志需提"机器放行仍受边界校验"，用 `'machine'` 一词保持一致。

## 执行记录

（执行后填写：实际改动、验证结果、遗留问题）

**执行日期**：2026-09-26（全部连续执行模式，主代理执行片 A/B + 测试，片 C 派 general-purpose 子代理）

**实际改动**：
- `packages/agent-core/src/loop/agentLoop.ts`：`ConfirmDecision = boolean | 'always' | 'machine'`（含四态语义与设计动机注释）；置位收敛为 `if (decision === true || decision === 'always') approvedByUser = true`（agentLoop.ts:641），注释改写为「用户当次批准（含首次 always）」口径。
- `packages/agent-core/src/host/agentHost.ts`：`wrapConfirmTool` 两处短路（confirm 未注入防御分支 :868、会话授权表命中 :869）`return true` → `return 'machine'`；`'always'` 首次仍原样返回；函数 doc 注释三条口径同步改写。
- `apps/desktop/src/main/agent-host.ts`：`createConfirmTool` 三条机器路径（allowPatterns :311、auto 无项目 :325、auto 根内 :334）`return true` → `return 'machine'`；三条 `logger.info` 文案追加「（边界校验仍生效，不带 allowOutside）」——保留「免确认模式」子串（审计日志断言 :314 依赖）。
- 测试：`agent-host.test.ts` 6 条机器放行断言 `toBe(true)` → `toBe('machine')`（:86 命中模式、:197 trim 后命中、:291 无项目 auto、:453 auto 根内、:489 首条 cwd 根内、:511 不带显式 cwd）；卡片透传与 confirm 档用例未动。`agentHost.test.ts`：`registerDanger` 扩展可选 ctx 捕获；新增用例「首次 'always' 是用户当次批准（ctx 带 approvedByUser），记住后的二次短路不再带」——首次 `true`、二次 `undefined`。`agentLoop.test.ts`：新增用例「confirmTool 返回 'machine'（机器放行）→ 工具照常执行，但 ctx 不带 approvedByUser」（approvals 收到 `[undefined]`）。
- 片 C（子代理，general-purpose）：docs/06 §5（新增四态 decision bullet）、§11.2（「不区分出处」披露段整段替换为「已区分出处」机制正文，含 junction 逃逸封堵与切项目竞态 fail-closed）、§12.3（confirmSensitiveTools 关闭 = 'machine' 机器放行）；AGENTS.md 三档 bullet 残留段改为「已封堵（2026-09）」。残留 grep：「不区分出处」「待专门工单」在两文件均为 0 命中。
- Prettier 对 agent-host.ts 长日志行做了 1 处换行整理；无其他计划外改动。`packages/agent-core/src/tools/` 与 `registry.ts` 零改动（`git diff --stat` 0 文件，出处收敛的结构性证据）。

**验证结果**：
- `pnpm --filter @aurora/agent-core build` 成功；`pnpm typecheck` 全仓绿。
- 定向三文件 123 passed（含 2 条新增用例）。
- `pnpm test` 全量 **1506 passed / 79 文件**（基线 1504，+2 新增，只增不减）。
- `pnpm format:check`、`pnpm lint` 绿。
- 反证：临时把 auto 根内改回 `return true` → 定向套件 3 条红（「auto 档 + 项目根内」「auto 档 + run_command cwd 根内」「auto 档 + run_command 不带显式 cwd」）；还原后复绿。
- `'machine'` 三源文件 grep：agentLoop.ts ×6、agentHost.ts ×5、agent-host.ts ×3。

**遗留问题**：无。冒烟行为验证按计划留 step 2/5（index.ts 权限集成组仍带手工 `approvedByUser: true`，由 step 2 改造）。

**提交**：`df9a05c`（fix(agent-core): ConfirmDecision 增加 'machine' 出处，approvedByUser 仅当用户当次批准置位；8 文件 +151/−55）
