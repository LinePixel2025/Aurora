# Step 04 — 回滚补广播 / readonlyPrefixes 进黑名单 / projectRoot 合并与闭包去重 / docs 版本

- Task: approval-boundary-hardening
- Step: 4 / 6
- Status: done
- Depends on: step 1..3（与 step 3 共享 AgentPage.vue 与 docs 文件，必须串行在其后）
- Produces: **`redactSettings` 从 `ipc.ts` 抽到 electron-free 模块（重审发现的拆雷前置）**；settings-port 写后校验失败回滚后补广播（消除工具闭包停坏值）；`advanced.readonlyPrefixes` 进 `SETTINGS_READONLY_PREFIXES`（防 AI 自我 DoS）；`sync()` 两次 `projectRoot()` 合并为一次 + `index.ts` 三份等价 `resolveProject` 闭包去重复用同一 getter；docs/08 §1 标题 v13→v15 及若干陈旧注释/相对时间措辞收口
- Phase: 安全与边界
- Writes: `apps/desktop/src/main/settings-redact.ts`（**新建**，redactSettings 搬入）、`apps/desktop/src/main/ipc.ts`（仅删 redactSettings 函数体 + 改 import）、`apps/desktop/src/main/tools/settings-port.ts`、`apps/desktop/src/main/tools/settings-port.test.ts`（**新建**）、`packages/shared/src/config/schema.ts`、`packages/shared/src/config/schema.test.ts`、`apps/desktop/src/main/tools/index.ts`、`apps/desktop/src/main/index.ts`（闭包去重约 :821/:836）、`apps/desktop/src/renderer/settings/pages/AgentPage.vue`（陈旧 hint 注释「v12 起新增的三类…」若涉及，仅文字）、`docs/06-agent-core.md`（§12.2 相对时间「本轮安全收紧」→ v15；§11.2 批准位机器不免责的残留披露已由 step 1 改，此处核对）、`docs/08-settings-onboarding.md`（§1 标题 v13→v15、`advanced.readonlyPrefixes` 段补「本字段自身也在黑名单」）、`AGENTS.md`（tts.providers bullet 那句「默认全量前缀」口径核对 + readonlyPrefixes 新条）、`step/step-04-security-hardening-misc.md` 与 `step/00-index.md`（执行记录回填）
- Size: M
- Risk: ①回滚补广播不能二次写盘或丢凭据（只在 `mutate` 后手动触发一次 `onSettingsChanged`，不重走 applyPatch）；②`readonlyPrefixes` 进黑名单后 `canWriteSettingPath('advanced.readonlyPrefixes')` 变 false，须确认没有任何既有生产/测试路径依赖「AI 可写该字段」；③闭包去重必须保持 `resolveProject` 入参（cwd/logger）逐处等价，否则项目根解析行为漂移。退法：三组改动彼此独立，可分别回滚

## 目标

收口上一任务遗留的安全加固清单里**低风险但确凿**的几处：消除回滚后的配置撕裂、堵住 AI 自我 DoS 写黑名单、去掉重复计算与等价闭包、修正陈旧版本标注。

## 输入

- **settings-port 测试的 electron 地雷（重审 2026-09-26 发现，必须最先拆）**：`settings-port.ts:22` 从 `'../ipc.js'` **值导入** `redactSettings`（定义于 `ipc.ts:828-856`，本体只依赖 `SettingsStoreLike` + `structuredClone`，无 electron），而 `ipc.ts:11` 顶层 `import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'`；`vitest.config.ts:10` 明文「只能测试不 import 'electron' 的模块」→ **直接新建 `settings-port.test.ts`（现不存在）会传递性加载 electron 而无法收集**。拆法：把 `redactSettings` 搬进独立模块 `apps/desktop/src/main/settings-redact.ts`（`import type { SettingsStoreLike } from './contracts.js'`——contracts.ts 已核实全 `import type`、无 electron），`ipc.ts` 与 `settings-port.ts:22` 两处引用同步改 import，**纯搬移零逻辑变化**。
- **回滚不广播**：`settings-port.ts:142-155`——写后 `SettingsSchema.safeParse(after)` 失败时走 `deps.settings.mutate((draft) => { Object.assign(draft, before) })` 回滚，但 `mutate` **不触发** `onSettingsChanged`（对比正常路径 `applyPatch` 才广播）→ 工具闭包（`registerComputerTools`/`confirmTool`/边界 getter）停留在坏值实例，直到下一次任意配置变更。修法：回滚 `mutate` 之后**补一次广播**。**优先方案**：给 `SettingsPortDeps` 增 `notifyChanged?: (s: Settings) => void`，装配处（`index.ts` 已有 `onSettingsChanged`）传入，回滚分支 `mutate` 后 `deps.notifyChanged?.(deps.settings.get())`。执行时先 grep `SettingsPortDeps` 与 `createSettingsPort` 调用点确认注入面。
- **readonlyPrefixes 自我 DoS**：`schema.ts:461` `readonlyPrefixes` 默认 `[...SETTINGS_READONLY_PREFIXES]`；`'advanced.readonlyPrefixes'` 自身**不在** `SETTINGS_READONLY_PREFIXES`（`:399` 起的数组），`WRITABLE_PATH_OVERRIDES` 也没登记它 → 按默认可写规则，AI 的 `set_setting` 能改这个黑名单字段（虽 `settingsReadonlyReason` 从不读用户配置、改它放宽不了任何默认前缀，但 AI 可往里塞路径**收紧**自己 = 自我 DoS；更微妙的是若将来有人误信「用户可配置黑名单」去读它就会被绕过）。修法：把 `'advanced.readonlyPrefixes'` 加入 `SETTINGS_READONLY_PREFIXES` + `READONLY_PREFIX_REASONS` 补中文原因（漏补原因表编译期失败——同上一任务 `agent.loop` 的护栏）。**副作用核对**：`settings-port.reasonOf`（:62-70）先查用户配置 `readonlyPrefixes` 数组、再无条件 `canWriteSettingPath`；把字段名进硬编码常量后，AI 改 `advanced.readonlyPrefixes` 会被 `canWriteSettingPath` 拒——用户仍走设置页 `settings:update`（不经黑名单）改，不破坏「只紧不松」语义。
- **projectRoot 双调用**：`tools/index.ts:163`（sync 计算 workspaceDir）与 `:230`（日志字段，`已同步电脑操控工具` 的 `projectRoot`）各调一次 `deps.projectRoot()`。`resolveProject` 在 `projects.current` 指向不存在 id 时 `logger.warn`（`packages/agent-core/src/config/project.ts:42` 附近）→ 每次 settings:changed 落两条相同 warn。修法：`const pr = deps.projectRoot()` 取一次复用。
- **resolveProject 闭包三份**：`index.ts:676` 起（`projectRoot` getter 本体，调用在 :677）、`:821`（`createConfirmTool` 的 `projectRoot` 参数内联）、`:836`（`projectInstructions.resolveRoot` 内联）。后两处与 getter 逻辑等价但各写一份 → 漂移面。修法：复用 `projectRoot` getter（注意它返回 `string | undefined`，确认 :821/:836 消费方接受同类型；`project:status` IPC（:863/:1007）是**渲染层查询用、含 logger 传参**，与本步装配内部 resolveRoot 用途不同，**不合并**那些）。**只合并装配内部等价且返回 root 的闭包，不动 IPC 查询路径**。
- docs/08 §1 标题现写「配置 Schema（config.json，**v13**）」（grep `^#.*v13` 或「配置 Schema」定位），实际 `CONFIG_VERSION=15`（schema.ts:9）。改标题 v13→当前版本口径；正文若逐处标 v13/v14/v15 的保留（那是字段级引入版本，正确）。
- 上一任务已做、**本步不重复**：§5.1「三件事」、docs/07 检索根句、判定端用例、错开根、systemPrompt 钉（已在 700e1ca/265ae62）。

## 操作

1. **redactSettings 搬出 ipc.ts（拆雷，先于一切）**：新建 `apps/desktop/src/main/settings-redact.ts`，把 `ipc.ts:828-856` 的 `export function redactSettings(settings: SettingsStoreLike, source: Settings): Settings` **连同其上方 JSDoc 原样搬入**（`import type { Settings } from '@aurora/shared'`、`import type { SettingsStoreLike } from './contracts.js'`，不 import electron）。`ipc.ts` 删原函数体、顶部加 `import { redactSettings } from './settings-redact.js'`（`redactSettingsForRenderer` 包装函数保留原地）；`settings-port.ts:22` 改 `import { redactSettings } from '../settings-redact.js'`。纯搬移：两侧调用点行为零变化。
2. **回滚补广播**：先 grep `SettingsPortDeps`、`createSettingsPort({`（index.ts:660 附近）确认注入面。给 deps 增可选 `notifyChanged`，index.ts 装配处传入 `notifyChanged: () => syncToolRegistries()`（或既有的 onSettingsChanged 句柄——以 index.ts 实际暴露的为准，目标：回滚后工具闭包按回滚值重建）。`settings-port.ts:151` 回滚 `mutate` 之后加 `deps.notifyChanged?.()`。写 `settings-port.test.ts`（第 1 条拆雷后才收得了）用例：桩一个「写后 safeParse 失败」触发回滚，断言 `notifyChanged` 被调用一次。
2. **readonlyPrefixes 进黑名单**：`schema.ts` 在 `SETTINGS_READONLY_PREFIXES`（:429 后）追加 `'advanced.readonlyPrefixes'` + 中文注释；`READONLY_PREFIX_REASONS`（:634 前）补一条「黑名单配置自身不允许通过工具修改（防自我收紧/DoS；放宽本就不生效）」。`schema.test.ts` 加断言：`canWriteSettingPath('advanced.readonlyPrefixes') === false` + 原因非「未知配置路径」；护栏：`agent.tools.workspaceDir` 仍可写（别误伤）。
3. **projectRoot 合并**：`tools/index.ts:163` 前 `const pr = deps.projectRoot()`，:163 与 :216 都用 `pr`。核对 sync 日志字段值不变。
4. **闭包去重**：`index.ts` 装配内部的等价 `resolveProject`（:821 `createConfirmTool` 参数 / :836 `projectInstructions.resolveRoot`）改引用 `projectRoot` getter；IPC `project:status` 路径（:863/:1007）不动。
5. **docs**：`docs/08` §1 标题 v13→v15；`advanced.readonlyPrefixes` 段补「本字段自身也在 `SETTINGS_READONLY_PREFIXES`，AI 一律拒绝，用户经设置页改不受影响」；`docs/06` §12.2 那句「本轮安全收紧」相对时间→「v15 配套」；核对 §11.2 已被 step 1 改好（不重复动）。`AGENTS.md`「默认全量前缀（含 agent.loop/agent.snapshots）」句补 `advanced.readonlyPrefixes`，并加一条 readonlyPrefixes 自身只读的 bullet。
6. 跑第 1 条的搬移验证 + 全链验证命令。

## 验收标准

- [ ] 拆雷验证：`pnpm vitest run apps/desktop/src/main/tools/settings-port.test.ts` 能**收集并全绿**（若 electron 仍被传递引入会直接收集失败）；`Select-String -Path apps/desktop/src/main/settings-port.ts -Pattern "../ipc.js"` 零命中；`Select-String -Path apps/desktop/src/main/settings-redact.ts -Pattern "from 'electron'"` 零命中；`git diff apps/desktop/src/main/ipc.ts` 仅剩删函数体 + import 改动（`redactSettingsForRenderer` 调用点 :627/:807 不在改动 hunk）。
- [ ] `pnpm --filter @aurora/shared build`（改 schema）成功；`pnpm vitest run packages/shared/src/config/schema.test.ts apps/desktop/src/main/tools/settings-port.test.ts apps/desktop/src/main/tools/index.test.ts` 全绿；新用例名（readonlyPrefixes 不可写、回滚补广播 notifyChanged 触发）逐字出现。
- [ ] `Select-String -Path packages/shared/src/config/schema.ts -Pattern "advanced.readonlyPrefixes"` 在 `SETTINGS_READONLY_PREFIXES` 数组与 `READONLY_PREFIX_REASONS` 两处均命中。
- [ ] 回滚用例证明「写后校验失败 → notifyChanged 被调一次」；且 `git diff` 显示回滚分支未新增二次 `applyPatch`/写盘（只多一次广播回调）。
- [ ] `grep -n "deps.projectRoot()" apps/desktop/src/main/tools/index.ts` 命中数比改前减一（合并为一次读取 + 复用）；装配内部 `resolveProject(` 出现次数下降（去重），且 `project:status`/`project` IPC 路径的 `resolveProject` 调用**保持不变**（`git diff` 里 :863/:1007 不在改动 hunk）。
- [ ] `pnpm typecheck && pnpm test && pnpm build` 全绿；`Select-String -Path docs/08-settings-onboarding.md -Pattern 'config.json，.*v13'` 对 §1 标题零命中（已改 v15）。

## 交接

- 给 step 5：本步含 `docs/08 §1 标题` 与 readonlyPrefixes 口径，回归核对表里列「AI 改 readonlyPrefixes 被拒」为新增完成项。

## 执行记录

（执行后填写：实际改动、验证结果、遗留问题）

**执行日期**：2026-09-26（全部连续执行模式，主代理亲自执行）

**实际改动**：
1. **拆雷（redactSettings 搬移）**：新建 `apps/desktop/src/main/settings-redact.ts`（函数体 + JSDoc 原样搬入，`import type` 自 `@aurora/shared` 与 `./contracts.js`，无 electron）；`ipc.ts` 删原函数体、改 `import { redactSettings } from './settings-redact.js'`（`redactSettingsForRenderer` 包装与 :628/:808 调用点原地不动）；`settings-port.ts` import 从 `'../ipc.js'` 改 `'../settings-redact.js'`。纯搬移。
2. **回滚补广播**：`SettingsPortDeps` 增可选 `notifyChanged?: () => void`（含 JSDoc 说明为何 mutate 不广播）；回滚分支 `mutate` 后调 `deps.notifyChanged?.()`；`index.ts` 装配处传 `notifyChanged: () => syncToolRegistries()`。新建 `settings-port.test.ts` 3 用例：写后校验失败 → 回滚 + notifyChanged 恰一次 + 值已写回；正常写入不触发 notifyChanged（广播归 applyPatch，不重复）；未注入不抛错。
3. **readonlyPrefixes 进黑名单**：`schema.ts` 的 `SETTINGS_READONLY_PREFIXES` 追加 `'advanced.readonlyPrefixes'`（含注释）+ `READONLY_PREFIX_REASONS` 补中文原因；`schema.test.ts` 新增用例「只读黑名单的配置自身不可由 AI 修改（自我收紧 / DoS，v15）」（断言不可写、原因非「未知配置路径」、`advanced.logLevel` 与 `agent.tools.workspaceDir` 仍可写护栏）。
4. **projectRoot 合并**：`tools/index.ts` sync 内 `const projectRoot = deps.projectRoot()` 取一次，`effectiveWorkspaceDir` 与 sync 日志字段复用。
5. **闭包去重**：`index.ts` 的 `createConfirmTool.projectRoot` 与 `projectInstructions.resolveRoot` 两份内联 `resolveProject` 改为复用上方 `projectRoot` getter（:679 本体保留）；`project:status` IPC 查询路径（ipc.ts）未动。
6. **docs**：docs/08 §1 标题 v13→v15、`advanced.readonlyPrefixes` 段补「本字段自身也在黑名单（v15）」；docs/06 §12.2「本轮安全收紧再起」→「v15 配套的安全收紧再新增」并补 readonlyPrefixes 条目；AGENTS.md 只读前缀 bullet 补 readonlyPrefixes 自身只读句。计划提到的「默认全量前缀」句在 AGENTS.md 中 grep 无命中（此前已改写），无需改。

**验证结果**：
- `pnpm vitest run settings-port.test.ts`（能收集 = 地雷已拆）3 passed；schema.test 42 passed（含新用例）；tools/index.test 38 passed（sync 行为不变）。
- grep 验收：settings-port.ts 无 `'../ipc.js'`；settings-redact.ts 无 `from 'electron'`；schema.ts 两处命中；tools/index.ts `deps.projectRoot()` 2→1；index.ts `resolveProject(settings` 3→1。
- `pnpm format:check && pnpm typecheck && pnpm test（1515 passed / 81 文件）&& pnpm build` 全绿。

**遗留问题**：无。

**提交**：`184762d`（fix(security): settings-port 回滚补广播；readonlyPrefixes 进黑名单；redactSettings 拆出 ipc；装配去重；11 文件 +231/−53）
