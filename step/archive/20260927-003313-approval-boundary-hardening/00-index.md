# 任务：修复批准出处不区分导致的 realpath 逃逸链，并对齐 openPath 按钮目录与清理安全加固 P3

- 任务标识：approval-boundary-hardening
- 项目根目录：D:\AICOP\Projects\Aurora
- 创建时间：2026-09-26 20:36
- 执行模式：（留空，执行阶段按剩余步数询问）
- 基线提交：009fa09f21251f76206d9242f56a70fc1e2b4275
- 归档目录：`step/archive/20260927-003313-approval-boundary-hardening`
- 归档时间：2026-09-27 00:33

## 完成标准

- [x] **逃逸链封堵**：`auto` 档根内机器放行、`allowPatterns` 命中、无项目全放行、会话级 `'always'` 短路这四种「没有真的弹卡并由用户本次批准」的路径，**都不再**给工具带 `allowOutside`——于是「根内建指向根外的 junction/符号链接、再对链接路径 `write_file`」在配了项目的 `auto` 档下被 `resolveWithin` 的 realpath 兜底拒绝，且不弹卡（零静默越权）。真根内的 `write_file` 在同样配置下照常成功（无 UX 回归）。
- [x] **仅当次用户卡片放行免校验**：用户在确认卡片上点「放行」（含首次 `'always'` 那一次）时，该次调用仍带 `allowOutside`（保持"越界确认后可写"语义）；`'always'` 被记住后的后续短路不再免校验。
- [x] **openPath 按钮与执行链同目录**：设置页「打开工作目录」按钮（`ipc.ts` case `'workspace'`）改走 `effectiveWorkspaceDir`，配了项目时打开项目根、与缺省 `cwd` 一致；分叉消除，相关 AGENTS.md/docs 的「已知例外/刻意未接」表述改为「已接」。
- [x] **安全加固收口**：settings-port 写后校验失败回滚后补广播；`advanced.readonlyPrefixes` 进黑名单（防 AI 自我 DoS）；`sync()` 内两次 `projectRoot()` 合并、`index.ts` 三份等价 `resolveProject` 闭包去重复用；冒烟 reject 行补「值逐字未变」断言；docs/08 §1 标题 v13→v15。
- [x] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm verify` 全绿（1515 passed / verify 26/26）；改 agent-core 后先 `pnpm --filter @aurora/agent-core build`；`AURORA_SMOKE` 端到端 **166/166**，含新逃逸场景 PASS（machine:true noCard:true blocked:true）。

## 现状与关键结论

本次调研以仓库内代码 + 上一任务归档 REPORT 为准（**未联网**；junction/symlink 的 realpath 穿透行为已由本仓库 `file-port.test.ts:1001-1007` 实测锚定「`fs.symlink(…, 'junction')` 不需管理员、realpath 穿透到目标」）。关键位置 2026-09-26 实测核对：

- **逃逸链根因**：`ConfirmDecision`（`packages/agent-core/src/loop/agentLoop.ts:34`）是 `boolean | 'always'`，机器放行与用户当次卡片放行都是裸 `true`，内核无法区分。`createConfirmTool`（`apps/desktop/src/main/agent-host.ts`）三条机器路径都 `return true`：allowPatterns（:311）、无项目 auto（:323）、auto 根内（:332）；卡片路径（:336）返回 `proactive` 的 `boolean|'always'`。`wrapConfirmTool`（`packages/agent-core/src/host/agentHost.ts:869`）对已记住的工具**短路 `return true`**。`agentLoop.ts:601-635`：只要 decision 非 `false` 就 `approvedByUser=true` → `ctx.approvedByUser=true`。四个工具（`files.ts:81-82` / `terminal.ts:119` / `edit.ts:142,211` / `search.ts:146,239`）据此透传 `allowOutside:true`，而 `file-port.ts:153` `if (allowOutside) return target` **整段跳过 realpath**（连判定都不做）。
- **最小改动面（关键结论）**：工具层只认 `ctx.approvedByUser`，**不认出处**——所以只要在 `agentLoop` 置位处收窄「仅用户当次卡片才置位」，四个工具文件 + `registry.ts:42` 的 `approvedByUser` 字段全部零改动。方案 = 给 `ConfirmDecision` 增加 `'machine'` 变体（表示"放行但不免边界"），机器路径与 `'always'` 短路返回 `'machine'`，`agentLoop` 仅在 `decision === true || decision === 'always'` 时置 `approvedByUser`。`agentLoop.test.ts` 既有用例返回 `true` 现语义即"用户本次放行"，**断言不变、继续绿**；`agent-host.test.ts` 机器放行用例需把期望从 `true` 改成 `'machine'`；`agentHost.test.ts` 既有 `'always'` 用例只断言 asked/executed 计数（改造后仍绿），需**新增**二次短路不带 `approvedByUser` 的断言。`ConfirmToolDecision`（`agent-host.ts:49`）直接引用 `ConfirmDecision`，类型扩展自动传导。
- **既有测试落点**：`agentLoop.test.ts:713,814`（`ctx.approvedByUser` 透传观察点、"未注入确认钩子保持 undefined"）、`agent-host.test.ts`（三档判定 describe，机器放行用例返回 true）、`agentHost.test.ts`（'always' 会话授权表）。端口层「指向根外的符号链接/junction 被穿透拒绝」已有真实目录用例（`file-port.test.ts:21,1001-1014`，建不了 link 时 skip）。
- **冒烟落点**：`apps/desktop/src/main/index.ts:1745-1802` 权限集成组——② auto 根内用 `{ approvedByUser: true }`（:1760）手工放行写 inside、③ auto 根外用无 ctx 拒写；本组固化了 `'always'/机器=true` 的旧语义，修复时 ② 应去掉手工 `approvedByUser`、改成"不带头衔也能写 inside"以证明无 UX 回归，并新增一条「auto 根内经指向根外的 junction 写 → 被拒」端到端场景。crash 矩阵 reject 行（:2625-2626，`agent.loop.maxRounds` / `agent.snapshots.enabled`）当前只测 `accepted=no`+盘可解析+toolKept，不锁「配置值逐字未变」。
- **openPath 分叉**：`ipc.ts:995-999` case `'workspace'` 用裸 `settings.agent.tools.workspaceDir.trim()`（空串→`app.getPath('home')`），项目根不参与，与执行链（`effectiveWorkspaceDir`，配了项目=项目根）分叉。`ipc.ts` 顶层 import electron → 不进 vitest（AGENTS.md 坑位 3），要把目标解析抽成纯函数才能测（`ipc.ts` 已 import `resolveProject`，:13）。
- **P3 项落点（重审已复核行号）**：`settings-port.ts:151-153` 写后校验失败回滚走 `settings.mutate`（不触发 `onSettingsChanged`，工具闭包停在坏值）；`readonlyPrefixes` 在 `schema.ts:461` 有默认值但 `'advanced.readonlyPrefixes'` 不在 `SETTINGS_READONLY_PREFIXES`（`:399` 起的数组；AI 可写→自我 DoS，虽只能追加不放宽）；`tools/index.ts:163` 与 `:230`（日志）各调一次 `deps.projectRoot()`；`index.ts` 三份等价 `resolveProject(...)` 闭包——`:676` 起 `projectRoot` getter 本体（调用在 :677）/ `:821`（`createConfirmTool` 的 `projectRoot` 参数内联）/ `:836`（`projectInstructions.resolveRoot` 内联）；`docs/08:5` §1 标题写「配置 Schema（config.json，v13）」但 `CONFIG_VERSION=15`（`schema.ts:9`）。
- **settings-port 测试的 electron 地雷（重审新发现，step 4 必须先拆雷）**：`settings-port.ts:22` 从 `'../ipc.js'` **值导入** `redactSettings`（定义于 `ipc.ts:828`，本体只依赖 `SettingsStoreLike`、无 electron），而 `ipc.ts:11` 顶层 `import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'`，`vitest.config.ts:10` 明文「只能测试不 import 'electron' 的模块」→ **直接新建 `settings-port.test.ts`（现不存在）会传递性加载 electron 而无法收集**。step 4 须先把 `redactSettings` 搬到独立 electron-free 模块（两处引用：ipc.ts 自用 + settings-port.ts:22），再写端口测试。
- **重审处置记录（2026-09-26 第二轮审查，直接逐锚点核对 + 反向复核子代理）**：修正 step-06 归档文件数 7→**8**（step-01..06 共 6 个 step，原稿算术错误、照做必 FAIL）；step-01 操作 5 补齐 6 条会翻红断言的逐条行号（:86/:197/:291/:453/:489 首条/:511）与 :314 日志子串保留告诫；step-02 ②b 补「自建 outsideDir（上文无现成根外目录）+ 先过 confirmTool 再执行」让「零弹卡」非空洞；step-04 新增 redactSettings 拆雷前置（见上条）；step-03 Writes 改明确清单。未采纳的反向复核意见：验收里 grep 存在性检查（行为证据已由反证用例与 step 5 冒烟覆盖）、step-03 无端到端点击自动化（shell.openPath 无法自动化，计划已如实声明）——均不构成执行阻塞。
- **上一任务已做、本次不重复**：quick 窗口窗外豁免句已写进 docs/06 §4.1（700e1ca），本次不改行为；§5.1「三件事」、docs/07 检索根句、判定端无-cwd 用例、错开根、systemPrompt 重算钉（265ae62/700e1ca）均已落。
- 验收基线：`pnpm test` 改动前 **1504 passed**（重审于 009fa09 复跑确认：79 文件 / 1504 用例全绿，2026-09-26 22:52）；`pnpm verify` 26/26；`AURORA_SMOKE` 165/165。提交习惯：Conventional Commits + 中文（`fix(scope):` / `test:` / `docs:`）。

## 假设与待确认

- 假设 1（**用户已拍板**）：逃逸链修复采**严格语义**——只有用户**当次真的在卡片上点放行**（含首次 `'always'` 那一次）才带 `allowOutside` 免 realpath；`auto` 机器放行、`allowPatterns`、无项目、`'always'` 记住后的**后续短路**一律不免边界。方向 = 实现对齐 docs/06 §11.2 的承诺，而非把文档放宽成"机器放行也免校验"。
- 假设 2（**用户已拍板**）：openPath 按钮采**接线**方案（`case 'workspace'` 走 `effectiveWorkspaceDir`，配了项目时打开项目根），而非只改文案。
- 假设 3：`ConfirmDecision` 用「新增 `'machine'` 变体」实现出处区分（改动面最小、工具层零改）。若执行时发现 agent-core 有对外导出该类型被 modes 包消费，需同步——但 grep 显示 `ConfirmDecision` 只在 agentLoop/agentHost 内部 + desktop 使用，`modes` 包不引用。
- 假设 4：逃逸链端到端「真建 junction」用例在 CI/受限环境可能建不出符号链接——采「主断言 mock `resolveWithin` 收到 `allowOutside:false` 且拒绝」+「真实 link 用例（照 file-port.test.ts 风格，建不出即 skip）」双轨，不因环境 skip 而丢失回归护栏（mock 轨恒跑）。
- 待确认：无（两个产品决定已在拆解前问明）。

## 范围之外（明确不做）

- 不做 OS 级沙箱 / 作业对象 / 受限令牌（AGENTS.md 既有声明）。
- 不改 `'always'` 会话级授权表本身的**存在**（用户仍可点「总是允许」跳过后续弹卡，只是后续调用不再免边界校验）；不改确认超时/勿扰语义。
- 不改 `containsAbsolutePath` 的匹配面（`%USERPROFILE%\` 不识别属逃逸链一环，出处修复后由 realpath 兜底，无需扩正则）。
- 不动「项目根被删时 `command-runner` 回落 `process.cwd()`、`file-port` 视不存在根为不可用」这一 v13 既有语义（AGENTS.md「不是沙箱」条）。
- 不改 quick 会话滑动窗口行为（只保留上一任务已写的文档豁免句）。
- 不推进 `CONFIG_VERSION`（保持 15）、不加配置迁移（`'advanced.readonlyPrefixes'` 进黑名单走硬编码常量，老配置照样生效，同上一任务 `agent.loop` 的结论）。

## 步骤

> 同波可并行（写范围互不重叠）：无 —— 全部串行：step 1 是骨架与前置；step 2 依赖 step 1 改的类型；step 3/4 与 1/2 有共享文件（docs/06、AGENTS.md），step 3 与 step 4 还共享 AgentPage.vue 与 docs/08，必须串行执行。

| # | 文件 | 标题 | 状态 | 依赖 | 写范围 |
|---|------|------|------|------|--------|
| 1 | step-01-approval-provenance.md | ConfirmDecision 加 'machine' 出处，仅当次用户放行免边界 | done | - | `packages/agent-core/src/loop/agentLoop.ts`、`packages/agent-core/src/host/agentHost.ts`、`apps/desktop/src/main/agent-host.ts`、`packages/agent-core/src/loop/agentLoop.test.ts`、`apps/desktop/src/main/agent-host.test.ts`、`packages/agent-core/src/host/agentHost.test.ts`、`docs/06-agent-core.md`（§5/§11.2/§12.3）、`AGENTS.md` |
| 2 | step-02-escape-chain-regression.md | 逃逸链端到端回归用例 + 冒烟权限组改造 | done | step 1 | `apps/desktop/src/main/tools/file-port.test.ts`、`apps/desktop/src/main/index.ts`（冒烟权限组 1745-1802 + crash 矩阵 reject 行 2625-2626 补值断言）、相关 `agent-host.test.ts` / 新增逃逸用例文件 |
| 3 | step-03-openpath-workspace-dir.md | openPath 按钮接 effectiveWorkspaceDir（抽纯函数可测） | done | step 1 | `apps/desktop/src/main/ipc.ts`、`apps/desktop/src/main/tools/workspace-target.ts`（新建）、`apps/desktop/src/main/tools/workspace-target.test.ts`（新建）、`apps/desktop/src/renderer/settings/pages/AgentPage.vue`（仅文案）、`docs/06-agent-core.md`（§5.1/§11.1 例外句）、`docs/07-ui-spec.md`、`docs/08-settings-onboarding.md`、`AGENTS.md` |
| 4 | step-04-security-hardening-misc.md | 回滚补广播 / readonlyPrefixes 进黑名单 / projectRoot 合并与闭包去重 / docs 版本 | done | step 1..3 | `apps/desktop/src/main/settings-redact.ts`（新建）、`apps/desktop/src/main/ipc.ts`（仅 redactSettings 搬出）、`apps/desktop/src/main/tools/settings-port.ts`、`apps/desktop/src/main/tools/settings-port.test.ts`（新建）、`packages/shared/src/config/schema.ts`、`packages/shared/src/config/schema.test.ts`、`apps/desktop/src/main/tools/index.ts`、`apps/desktop/src/main/index.ts`（闭包去重 ：821/:836）、`docs/06-agent-core.md`（§12.2）、`docs/08-settings-onboarding.md`（§1 标题 + readonlyPrefixes 段）、`AGENTS.md` |
| 5 | step-05-integration-verify.md | 集成验证：全量链 + 冒烟 + 逃逸/always/竞态场景核对 | done | step 1..4 | （只跑验证；除修复失败项外不改生产代码） |
| 6 | step-06-archive.md | 归档清理 | done | step 1..5 | `step/` |

## 审查重点

- **出处三分是否真的只剩「用户当次卡片」一条路能置 `allowOutside`**：逐一核 `'always'` 短路（agentHost.ts:869）、allowPatterns（agent-host.ts:311）、无项目（:323）、auto 根内（:332）四条机器路径全部改成 `'machine'`，且 `agentLoop` 的置位条件覆盖 `true` 与 `'always'` 首次、不含 `'machine'`；漏改任一条 = 逃逸未封堵。
- **工具层是否确实零改**：files/terminal/edit/search 仍以 `ctx.approvedByUser` 决定 `allowOutside`，不应有人去改这四个文件（改了就是把安全判定散到四处、迟早漂移）。
- **无 UX 回归**：真根内的 write_file/edit_file 在 auto 档、机器放行（不带 approvedByUser）下，经 realpath 判定仍在根内 → 照常写成功；不能因为去掉 allowOutside 把根内正常写也拦了。
- **拒绝方向**：机器放行命中越界链接时是「端口 fail-closed 拒绝 + 不弹卡」，绝不能变成「弹一张注定该免的卡」或「静默放行」。
- **openPath 纯函数可测性**：case 'workspace' 抽出的解析函数不得 import electron，能进 vitest；接线后无项目时行为与原 `home` 回落逐字一致。
- **回滚补广播**：settings-port 回滚 `mutate` 后必须触发一次 `onSettingsChanged`（或走带广播的路径），否则工具闭包停在坏值；但不能因此二次写盘或丢凭据。
- **readonlyPrefixes 进黑名单**：不得破坏 `settings-port.reasonOf` 的「用户名单先判 + 硬编码常量后判」双遍语义，也不影响用户经设置页 `settings:update`（不经黑名单）配置它。
- **redactSettings 搬移不变形（重审新增）**：`settings-redact.ts` 与原 `ipc.ts:828-856` 实现逐字一致（llm/tts/stt/imagegen 四组密文折叠 + MCP env/headers 折叠），两侧调用点（`settings:changed` 广播 / `settings:get` / `set_setting` 脱敏）行为零变化；出现两个脱敏真相源 = 凭据泄漏风险。

## 执行记录

（供执行阶段追加：每步的实际改动与验证结果、git 提交清单、代码审查结论与处置）

- **step-01（2026-09-26，提交 df9a05c）**：四态 ConfirmDecision 落地，三条机器路径 + 'always' 短路改返 `'machine'`，置位仅剩 `true|'always'`；工具层零改动。定向 123 绿、全量 1506 passed（基线 1504 +2）、typecheck/format/lint 绿；反证（auto 根内临时改回 true）3 条红后复绿。docs/06 §5/§11.2/§12.3 与 AGENTS.md 已改「已封堵」机制描述，残留字样 0 命中。详见 step-01 执行记录。
- **step-02（2026-09-26，提交 08d5ad4）**：端口轨核实已覆盖（file-port.test.ts:992-1034）；command-runner 新增切项目竞态 fail-closed 用例（反证带 allowOutside 翻红）；冒烟 ② 去手工批准头衔、新增 ②b junction 逃逸场景（SKIP 兜底）、crash 矩阵两条 reject 行补值断言。全量 1507 passed、typecheck/build 绿。偏差记录：②b 根外目录自建专用 `smoke-escape-target`（计划的 `join(outsideFile,'..')` 即 userData，不可删）。详见 step-02 执行记录。
- **step-03（2026-09-26，提交 7e6adfd）**：openPath `kind:'workspace'` 接 `effectiveWorkspaceDir`（纯函数 `resolveWorkspaceOpenTarget` + 4 条单测），配了项目时按钮打开项目根；AgentPage 仅改 hint 文案（data-field 计数 21 不变）；docs/06 §5.1、docs/07、AGENTS.md 收口「已接线」，docs/08 核实无分叉句。全量 1511 passed、typecheck/build/format 绿。详见 step-03 执行记录。
- **step-04（2026-09-26，提交 184762d）**：redactSettings 纯搬移到 settings-redact.ts（拆雷，settings-port.test.ts 3 用例可收集）；回滚分支补 notifyChanged（index.ts 注入 syncToolRegistries）；`advanced.readonlyPrefixes` 进黑名单 + 原因表 + schema.test 用例；tools/index.ts projectRoot 双调合并；index.ts 两份等价闭包复用 getter；docs/08 §1 标题 v15、docs/06 §12.2、AGENTS.md 收口。全量 1515 passed、typecheck/build/format 绿。详见 step-04 执行记录。
- **step-05（2026-09-26，无提交，零生产代码改动）**：全链零退出码（format/lint/typecheck/test 1515/build/verify 26-26）；AURORA_SMOKE **166/166** 零 FAIL，②b 端到端 `machine:true noCard:true blocked:true`（junction 真建出、无 SKIP），crash 矩阵两行 effect=ok。完成标准逐条勾销，行为核对表见 step-05 执行记录。

### 代码审查结论（2026-09-27，3 个独立 Reviewer 并行）

- **① 正确性与测试质量：可交付**。逐路径核对四条机器路径 + 置位收敛 + openPath 等价 + 加固四项全部成立；确认测试无削弱（'machine' 6 处为语义更新非断言放松、竞态用例时序差真实、假 applyPatch 手法合理且断言回滚写回）。
- **② 安全边界与项目约定：可交付**。redactSettings 与原实现逐字比对 `VERBATIM_IDENTICAL`、单一真相源；无第 5 条机器放行路径；用户可选取值类型上不可能伪造出处；fail-closed 成立；readonlyPrefixes 双遍语义未破坏；回滚补广播无二次写盘/丢凭据。
- **③ 验收独立复跑：5/5 PASS**。定向套件 123+64 全绿且新用例名逐字命中；对抗性检查（confirmTool 链无 `return true`、工具层 diff 为空、授权表短路先于内层 confirmTool、6 处 allowOutside 消费端均仅认 `ctx.approvedByUser === true`）全部通过。

**P0/P1：无。P2：无。P3 共 5 条（去重后）**：
1. settings-port.ts:52-58/160-163 回滚分支注释不准确：`mutate` 实际经 store `onChange` 触发渲染层广播与托盘刷新（行为无缺口），不触发的只是 `onSettingsChanged` 副作用回调（applyPatch 成功时刻已按坏值执行过一次，生产不可达）——改注释措辞即可。
2. index.ts:1850/1874 冒烟 detail 硬编码 `noWaiver:true` 标签非计算值，误导排障（真实证据在 execute ctx 形态上）——删掉或改为计算值。
3. index.ts:1797-1800 冒烟 ②b 的 SKIP 兜底把「建不出链接」记 PASS，该环境下端到端护栏缺失（另有 3 处单测兜底）——可改为独立 SKIP 状态。
4. docs/08:220 存量句「CONFIG_VERSION 已是 12」滞后（基线就有，本次改动使其显眼）——顺手改 15。
5. ipc.ts:963-966 openPath 自建一次 `resolveProject` 调用未复用 index.ts getter（无行为分叉，ipc 层拿不到装配闭包属结构限制）——可不改。
