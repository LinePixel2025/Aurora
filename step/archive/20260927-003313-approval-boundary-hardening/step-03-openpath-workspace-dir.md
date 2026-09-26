# Step 03 — openPath 按钮接 effectiveWorkspaceDir（抽纯函数可测）

- Task: approval-boundary-hardening
- Step: 3 / 6
- Status: done
- Depends on: step 1
- Produces: 「打开工作目录」按钮与执行链同目录（配了项目时打开项目根）；解析逻辑抽成**不 import electron 的纯函数**并带单测；AgentPage 文案（hint + 按钮旁说明）与 AGENTS.md/docs 的「已知例外/刻意未接」披露同步收口
- Phase: 集成
- Writes: `apps/desktop/src/main/ipc.ts`、`apps/desktop/src/main/tools/workspace-target.ts`（新建）、`apps/desktop/src/main/tools/workspace-target.test.ts`（新建；若执行时发现更就近的既有 electron-free 小模块，两文件可随之换位，但仍在 main/tools/ 下）、`apps/desktop/src/renderer/settings/pages/AgentPage.vue`（**仅文案字符串**：hint/placeholder/按钮说明，不得动 `data-field`、绑定、布局）、`docs/06-agent-core.md`（§5.1 例外句 + §11.1 若涉及）、`docs/07-ui-spec.md`（按钮描述，若提及目录语义）、`docs/08-settings-onboarding.md`（「工作目录」条的按钮分叉句）、`AGENTS.md`（workspaceDir bullet 的「⚠️已知例外（刻意未接）」段改为「已接线」）、`step/step-03-openpath-workspace-dir.md` 与 `step/00-index.md`（执行记录回填）
- Size: M
- Risk: ipc.ts 顶层 import electron → 直接改它进不了 vitest（AGENTS.md 坑位 3），所以**必须**把目标解析抽到独立纯函数文件测；AgentPage.vue 若误碰 `data-field`/门控结构会让 AURORA_CAPTURE 设置页探针 FAIL（上一任务 step-03 踩过此约束，务必只动字符串）。退法：回滚本步 commit，纯函数与 ipc 调用点是两条独立改动，可分别回滚

## 目标

设置页「打开工作目录」按钮（`openPath kind:'workspace'`）不再按字面 `workspaceDir` 两级解析，而是走与缺省 `cwd`/搜索根**同一个**三级回落 `effectiveWorkspaceDir`——配了当前项目时打开项目根，消除上一轮审查指出的用户可见分叉。

## 输入

- 现状：`apps/desktop/src/main/ipc.ts:995-999` `case 'workspace': { const configured = settings.agent.tools.workspaceDir.trim(); target = configured === '' ? app.getPath('home') : configured; break }`。项目根完全不参与。
- 执行链口径：`packages/agent-core/src/config/effectiveWorkspace.ts` 的 `effectiveWorkspaceDir(settings, projectRoot, homeDir)`（项目根 > `agent.tools.workspaceDir` > homeDir；已由 `@aurora/agent-core` 包入口导出，上一任务已接进装配层）。判定端 `ipc.ts:13` 已 import `resolveProject`（说明 ipc.ts 可 import agent-core 纯函数，无新依赖）。
- `ipc.ts` 依赖 Electron → vitest 不收（AGENTS.md「vitest 只收不 import electron 的主进程测试」）。要可测，抽出的解析函数**不能引用 `app.getPath` / `shell`**：把 `homeDir` 与 `projectRoot` 作为参数注入，函数体只做纯计算。
- 无项目等价性护栏：`effectiveWorkspaceDir` 无项目 + 空串 → homeDir；非空 → workspaceDir。与原 `case 'workspace'` 两级逻辑在无项目时逐字一致（原式：`configured === '' ? home : configured`）。差异仅在「配了项目时优先项目根」——这正是本次要接的行为。
- `resolveProject(settings, { cwd, logger }).root` 返回绝对路径或 undefined（现有 `ipc.ts:863/:1007` 已用同一函数，无项目返回 `{root: undefined}`）。
- 验证命令：`pnpm vitest run <纯函数测试文件路径>`、`pnpm typecheck && pnpm test && pnpm build`（build 过即证明 ipc.ts 调用点类型正确）。真实 `shell.openPath` 无法在 vitest/冒烟自动断「打开了哪个目录」，本步靠「纯函数单测 + 代码审查」双轨，**不承诺端到端点击测试**。

## 操作

1. 新建纯函数（推荐 `apps/desktop/src/main/tools/workspace-target.ts`，命名以就近一致为准）：
   ```
   export function resolveWorkspaceOpenTarget(
     settings: Settings,
     deps: { projectRoot: () => string | undefined; homeDir: () => string },
   ): string {
     return effectiveWorkspaceDir(settings, deps.projectRoot(), deps.homeDir())
   }
   ```
   —— 不 import electron；`effectiveWorkspaceDir` 从 `@aurora/agent-core` 引入。**无项目 + 空串必须返回 homeDir**（三级函数已保证）。
2. `ipc.ts` case `'workspace'` 改为调用它：`target = resolveWorkspaceOpenTarget(settings, { projectRoot: () => resolveProject(settings, { cwd: process.cwd(), logger: deps.logger }).root, homeDir: () => app.getPath('home') })`。保留/更新注释：不再是「展示入口、刻意未接」，而是「与执行链同走 §5.1 三级回落，配了项目即项目根」。
3. 新建 `workspace-target.test.ts`（进 vitest，因不碰 electron）：
   - 无项目 + `workspaceDir:''` → 返回 homeDir；
   - 无项目 + `workspaceDir:'D:\\ws'` → 返回 `'D:\\ws'`；
   - 有项目（`projectRoot()` 返回绝对根）+ `workspaceDir:'D:\\ws'` → 返回项目根（第一级优先，与命令缺省 cwd 一致）；
   - 空白根 `projectRoot()` 返回 `'  '` → 视为无项目回落（照 effectiveWorkspace.test 已有的同类护栏，此处可只验一层，深层由纯函数既有单测兜）。
4. AgentPage.vue **仅改字符串**：hint「留空 = 用户主目录（配置了当前项目时以项目根优先）；只作用于命令的缺省 cwd」→ 补上「（按钮『打开工作目录』与此目录一致）」并把「只作用于命令的缺省 cwd」校正为「作用于命令缺省 cwd 与检索缺省根」（消除上一轮审查记录的 hint/检索区矛盾句）；`Select-String` 确认 `data-field="agent.tools.workspaceDir"` 等门控属性一字未动。
5. 文档同步：`docs/06-agent-core.md` §5.1 的「⚠️ 已知例外（刻意未接：openPath kind:'workspace'）」整段改写为「按钮已接 `effectiveWorkspaceDir`（`ipc.ts`），展示与执行链同目录；解析逻辑抽为纯函数 `resolveWorkspaceOpenTarget` 可单测」；`AGENTS.md` workspaceDir bullet 的「⚠️已知例外/刻意未接」句同改为「已接线，行为与命令缺省目录一致」；`docs/08-settings-onboarding.md`「工作目录」条若提到按钮分叉一并收口；`docs/07-ui-spec.md` 若描述了该按钮，核对措辞。

## 验收标准

- [ ] `pnpm vitest run <workspace-target.test.ts 路径>` 全绿，含「有项目时返回项目根（与命令缺省一致）」用例名逐字出现。
- [ ] `Select-String -Path apps/desktop/src/main/tools/workspace-target.ts -Pattern "from 'electron'"` 零命中（纯函数不碰 electron → 证明其可进 vitest）；`git diff` 显示 `ipc.ts` case `'workspace'` 已改调 `resolveWorkspaceOpenTarget`。
- [ ] 无项目等价护栏：workspace-target.test 的「无项目 + 空串 → homeDir」「无项目 + 非空 → workspaceDir」两条绿（证明未配项目时行为与原两级逐字一致）。
- [ ] `pnpm typecheck && pnpm test && pnpm build` 全绿。
- [ ] `git diff -- apps/desktop/src/renderer/settings/pages/AgentPage.vue` 的改动全部落在字符串/注释内，`Select-String -Path apps/desktop/src/renderer/settings/pages/AgentPage.vue -Pattern 'data-field'` 命中数与改前一致（门控结构未动）。
- [ ] `Select-String -Path AGENTS.md,docs/06-agent-core.md -Pattern '刻意未接|已知例外'` 对 openPath 相关处零命中（分叉已消除）。

## 交接

- 给 step 5：按钮行为靠纯函数 + 代码审查证明，无端到端点击自动化；step 5 若跑 capture 设置页探针，确认 AgentPage `data-field` 计数不 FAIL。
- 与 step 1/4 关系：本步只动 `ipc.ts`/新纯函数/AgentPage/docs；不动 agent-host.ts / settings-port.ts，写范围与 step 4 不重叠（可并行，但都碰 AGENTS.md/docs → 若同波，文档改动由主代理合并）。

## 执行记录

（执行后填写：实际改动、验证结果、遗留问题）

**执行日期**：2026-09-26（全部连续执行模式，主代理亲自执行）

**实际改动**：
- 新建 `apps/desktop/src/main/tools/workspace-target.ts`：`resolveWorkspaceOpenTarget(settings, { projectRoot, homeDir })` 纯函数，内部调 `@aurora/agent-core` 的 `effectiveWorkspaceDir`；不 import electron（grep `from 'electron'` 0 命中）。
- `ipc.ts` case `'workspace'` 改调它：`projectRoot` 注入 `resolveProject(settings, { cwd: process.cwd(), logger }).root`、`homeDir` 注入 `app.getPath('home')`；注释从「展示入口、刻意未接」改写为「与执行链同走三级回落，分叉已消除」。
- 新建 `workspace-target.test.ts`：4 条用例（无项目+空串→homeDir / 无项目+非空→workspaceDir / 有项目→项目根 / 空白根→回落工作目录）。
- AgentPage.vue 仅两处字符串：hint 改为「作用于命令缺省 cwd 与检索缺省根（按钮『打开工作目录』与此目录一致）」，`openWorkspace` 的 JSDoc 注释同步三级回落口径；`data-field` 计数改前改后均为 **21**（门控未动）。
- 文档：docs/06 §5.1 例外句改写为「已接同一链（2026-09）」+ 纯函数落点 + `kind:'workspace'`/`kind:'project'` 两入口区分；AGENTS.md workspaceDir bullet 同步收口；docs/07 当前项目卡处对 `kind:'workspace'` 的描述更新为「打开生效工作目录（三级回落）」；docs/08 无按钮分叉句（grep 核实），无需改。

**验证结果**：
- `pnpm vitest run workspace-target.test.ts` 4 passed，verbose 确认「有项目时返回项目根（与命令缺省 cwd 一致…）」用例名逐字出现。
- `pnpm format:check`（先修了 ipc.ts 一处长行换行）、`pnpm typecheck`、`pnpm test`（**1511 passed / 80 文件**，较 step-02 再 +4）、`pnpm build` 全绿。
- `grep '刻意未接|已知例外' AGENTS.md docs/06-agent-core.md` → 0 命中。

**遗留问题**：无端到端点击自动化（shell.openPath 无法自动断言打开目录），按计划以纯函数单测 + 代码审查双轨覆盖；step 5 若跑 capture 探针可复核 data-field 计数。

**提交**：`7e6adfd`（feat(settings): 「打开工作目录」按钮接 effectiveWorkspaceDir，与执行链同目录；7 文件 +101/−16）
