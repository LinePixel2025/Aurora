# Step 03 — 缺省 cwd / 搜索根接上三级回落（项目根 > workspaceDir > 主目录）

- Task: agent-context-boundary-fixes
- Step: 3 / 5
- Status: done
- Depends on: step 2
- Produces: `registerComputerTools` 的缺省工作目录改走 `effectiveWorkspaceDir` 三级回落，`run_command` 缺省 cwd 与 `grep` / `glob` 缺省搜索根在配置了当前项目后落在**项目根**；`agent-host.ts` 的 `auto` 档免确认判定与实际执行目录重新对齐；docs/06、docs/08、docs/10、设置页文案、承重注释的旧口径统一
- Phase: 安全与边界
- Writes: `apps/desktop/src/main/tools/index.ts`、`apps/desktop/src/main/tools/index.test.ts`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/main/agent-host.ts`（仅注释）、`apps/desktop/src/main/tools/command-runner.ts`（仅注释——86–88 行「只有请求里显式给了 cwd 才校验」的说法与 `terminal.ts:108` 恒传绝对 cwd 的现实矛盾，属承重注释纠偏，不改逻辑）、`docs/06-agent-core.md`（§11.1 / §11.5 区域，约 507 / 520 / 605 / 658 行）、`docs/08-settings-onboarding.md`（约 297 / 597 行）、`docs/10-user-guide.md`（约 320 / 324 / 472 行「留空即主目录」句）、`apps/desktop/src/renderer/settings/pages/AgentPage.vue`（**仅提示文案**，约 28 / 426 / 432 / 783 行「留空 = 用户主目录」——不得动 `data-field`、门控与布局，避免影响 AURORA_CAPTURE 设置页探针）、`AGENTS.md`、`step/step-03-default-workspace-root.md` 与 `step/00-index.md`（执行记录回填）
- Risk: ① 无项目时行为被顺带改变（必须逐字等同今天：`workspaceDir` 或空串回落主目录）——新增用例锁定，退法 = 回滚；② **已知残留（不修，防误判为回归）**：配置的项目根**不存在**时，`file-port.ts:190–199` 把根视为不可用 → 跳过边界校验，`command-runner.ts:119–124` 在 cwd 不存在时回落 `process.cwd()`，`auto` 档免确认判定照旧按根内放行——这是 v13 既有语义（根不存在不该让所有文件工具失效），00-index「范围之外」已记录；③ 渲染层只改 AgentPage.vue 文案字符串，误碰门控结构会让设置页探针 FAIL——改完立刻 `pnpm typecheck`，视觉核对留给 step 4。

## 目标

「配了当前项目后，缺省工作目录 / 搜索根仍在项目根之外」不再发生：不指定 `cwd` 的 `run_command` 与不指定根的 `grep` / `glob` 默认落在当前项目根，三种权限档位下的行为一致且可解释。

## 输入

- 根因（已实测核对，2026-09-26）：`apps/desktop/src/main/tools/index.ts:153` `sync()` 里
  `const workspaceDir = cfg.workspaceDir.trim() === '' ? deps.homeDir() : cfg.workspaceDir.trim()`
  ——只二级回落到主目录，**项目根从不参与**；`run_command` 用它作 `defaultCwd`（164 行），`grep`/`glob` 用它作 `defaultRoot`（201 行）。三级回落纯函数 `packages/agent-core/src/config/effectiveWorkspace.ts`（`effectiveWorkspaceDir(settings, projectRoot, homeDir)`：项目根 > `agent.tools.workspaceDir` > 主目录，v13 就写好了）**在生产代码里零消费方**（只有自身单测），docs/06 §5.1（约 240 行）声称的行为即出自它。
- 越界链条：`packages/agent-core/src/tools/terminal.ts:108` `cwd = parsed.cwd ?? options.defaultCwd` 永远带绝对路径主目录 → `apps/desktop/src/main/tools/command-runner.ts:91-93` 对显式 cwd 做 `resolveWithin`（`file-port.ts:147`，realpath 前缀校验）→ 配了项目时默认根目录在根外：未获放行则回「cwd 在项目根之外」失败；`grep` / `glob` 同理（`search.ts:129/232` `root = 传入 path ?? defaultRoot` → 端口 `files.searchText` / `files.findFiles` → `file-port.ts:544/594` 对 `options.root` 校验）。而 `apps/desktop/src/main/agent-host.ts:365-373`（`reasonWithinRoot`）按「缺省 cwd 会回落项目根」的**假设**给 `auto` 档免确认放行（`terminal.ts:119` 再把批准透传成 `allowOutside`、跳过边界校验）→ 命令实际跑进主目录。用户报的两个档面现象（`auto` 档「不弹卡跑主目录」；`confirm` 档「同类命令失败」）根源同为「缺省根未接项目根」：前者 = 免确认放行 + 透传 `allowOutside` 后在主目录执行；后者的确切失败路径（拒卡/越界文案）留 step 4 场景清单复核——接线修复后两条路径都收敛为「缺省 = 项目根，各档行为一致」，不存在仅在某档可用的组合。接线修复后 356/371 行的注释假设变为事实。
- `effectiveWorkspaceDir` 已由包入口导出（`packages/agent-core/src/index.ts:21` `export * from './config/effectiveWorkspace.js'`），装配器直接 `import { effectiveWorkspaceDir } from '@aurora/agent-core'` 即可，无需动导出。
- 装配层已有现成的项目根 getter：`apps/desktop/src/main/index.ts:668-672` 的 `const projectRoot = (): string | undefined => resolveProject(settings!.get(), { cwd: process.cwd(), ... }).root`，已传给 `createCommandRunner` / `createNodeFilePort`（681/685 行）；本步把**同一个 getter** 再传给 `registerComputerTools`。
- `sync()` 的热改时机不变：项目切换 / `workspaceDir` 改动都会触发 `settings:changed` → `sync()` 重建（653-654 行注释仍成立，措辞按新口径微调）。
- 测试基建：`apps/desktop/src/main/tools/index.test.ts` 已用假 `run` / `files` 端口断言注册矩阵；`packages/agent-core/src/config/effectiveWorkspace.test.ts` 已覆盖纯函数优先级（本步不改它，只新增消费方用例）。
- 验证命令（仓库根）：`pnpm vitest run apps/desktop/src/main/tools/index.test.ts`、`pnpm typecheck && pnpm test`（本步不动 agent-core 源码，无需重建它）。
- 注意：`resolveWithin` 对「目标恰为根」是放行的（`file-port.ts:133` 注释），默认根=项目根不会被自己的边界拦。

## 操作

1. **先改文档**：`docs/06-agent-core.md` §11.1（约 507–508、520 行）与 §11.5 / `glob` 段（约 605、658 行）、`docs/08-settings-onboarding.md`（约 297、597 行）、`docs/10-user-guide.md`（约 320、324、472 行）里「`workspaceDir` 为空回落用户主目录」的缺省口径统一改为三级：**当前项目根（配置了当前项目时）> `agent.tools.workspaceDir` > 用户主目录**，并注明与 §5.1 `effectiveWorkspaceDir` 同源；无项目时行为不变的既有声明保留。设置页 `AgentPage.vue` 的「留空 = 用户主目录」提示文案补「（配置了当前项目时以项目根优先）」——**只动字符串**，不碰 `data-field` 与门控结构。
2. 改 `apps/desktop/src/main/tools/index.ts`：
   - `ComputerToolsDeps` 增加 `projectRoot: () => string | undefined`（注释：当前项目根，无项目返回 undefined，来自 `resolveProject().root`）；
   - 153 行改为 `const workspaceDir = effectiveWorkspaceDir(settings, deps.projectRoot(), deps.homeDir())`（import 自 `@aurora/agent-core`；`settings` 是该作用域已有的 `deps.getSettings()` 结果）；
   - `run_command` 的 `defaultCwd` 与 `grep`/`glob` 的 `defaultRoot` 继续用这个 `workspaceDir`；更新 195–196 行注释（不再写「空串时回落主目录」的单级口径）；在 216 行的同步日志里追加 `projectRoot: deps.projectRoot() ?? ''` 字段（排查「命令跑在哪」时一眼可辨）。
3. 改 `apps/desktop/src/main/index.ts`：`registerComputerTools({...})`（673 行起）增传 `projectRoot`；按新口径改 650–654 行注释（runner 的 `defaultCwd: process.cwd()` 仅是「工作目录不存在」时的最后兜底，正常缺省链 = 三级回落，真正校验在 `command-runner` / `file-port` 的 `resolveWithin`）。
4. 改 `apps/desktop/src/main/agent-host.ts`：356–357、371–373 行注释按事实微调（「缺省 cwd 回落到生效工作目录；配置了当前项目时即项目根——与 `registerComputerTools` 的装配同源（`effectiveWorkspaceDir`）」）。不改判定逻辑本身。
5. 在 `apps/desktop/src/main/tools/index.test.ts` 新增 describe「缺省工作目录三级回落」，假 `run` 端口记录 `CommandRequest.cwd`、假 `files` 端口记录 `searchText`（grep）/ `findFiles`（glob）收到的 root：
   - **有项目**：`projects.current='p'` + `list:[{id:'p',name:'x',root:'C:\\proj-root'}]`、`projectRoot: () => 'C:\\proj-root'`、`workspaceDir:''` → 注册后执行 `run_command`（不传 cwd）记录到 `cwd === 'C:\\proj-root'`；`grep` / `glob`（不传根）记录到 root `=== 'C:\\proj-root'`。
   - **有项目 + 设了 workspaceDir**：workspaceDir='D:\\elsewhere' 时缺省仍是项目根（优先级）。
   - **无项目**：`projectRoot: () => undefined`、workspaceDir='' → 缺省 = `homeDir()`；workspaceDir='D:\\ws' → 缺省 = 'D:\\ws'（与今天逐字一致）。
   - 空白根（`projectRoot: () => '  '`）→ 视为无项目（`effectiveWorkspace.ts:46-49` 的 `normalize` 只 trim；注意它**不做绝对化**，相对根会被原样当有效根返回——生产侧不会出现，因为 `config/project.ts` 的 `resolveProject` 已把根归一成绝对路径，故**不新增**相对根用例）。
6. `AGENTS.md`：在「三档权限与项目根边界已落地」相关 bullet 里把「缺省工作目录 / 搜索根」的表述改为已按 §5.1 三级回落接线（`effectiveWorkspaceDir` 为唯一口径），并保留「无项目时行为与 v12 之前一致」的既有声明。

## 验收标准

- [ ] `pnpm vitest run apps/desktop/src/main/tools/index.test.ts` 全绿，包含上述新增 describe 的全部用例（读 vitest 输出确认用例名）。
- [ ] 行为证据（证明目标达成，不只是命令跑过）：在「有项目」用例中，从假 `run` 端口记录的 `CommandRequest.cwd` 直接断言 `=== 'C:\\proj-root'`（不是断言注册成功）；`grep` / `glob` 用假 `files` 端口记录的 root 同样断言。
- [ ] 无项目回归护栏：`pnpm vitest run apps/desktop/src/main/tools/index.test.ts packages/agent-core/src/config/effectiveWorkspace.test.ts packages/agent-core/src/tools/terminal.test.ts packages/agent-core/src/tools/search.test.ts apps/desktop/src/main/agent-host.test.ts` 全绿——其中 `agent-host.test.ts` 既有用例「auto 档 + run_command：cwd 在根内免确认…」（480–495 行）与本步执行端断言构成报障③「判定 ↔ 执行」配对证据；内核工具层与纯函数未动，装配层「无项目 = 行为不变」由新用例锁定。
- [ ] `pnpm typecheck && pnpm test && pnpm build` 全仓绿（本步只动 `apps/desktop`，无需重建 agent-core；`effectiveWorkspaceDir` 已在包入口导出）。
- [ ] 口径一致性 grep：`Select-String -Path docs/06-agent-core.md,docs/08-settings-onboarding.md,docs/10-user-guide.md,apps/desktop/src/renderer/settings/pages/AgentPage.vue -Pattern '回落用户主目录|空串 = 用户主目录|留空'` 的每条命中处，上下文都已带上「配置了当前项目时项目根优先」的表述（逐处人工核对，命中清单与处理结论写进执行记录，不许空过）。

## 交接

- 给 step 4：手动场景核对清单——①`auto` 档 + 有项目：让 AI 跑 `run_command`（无 cwd）与 `grep`（无根），确认无卡片、结果头部「工作目录」= 项目根；②`confirm` 档 + 有项目：弹卡批准后命令**成功**且落项目根；③无项目：行为与升级前一致；④主界面手动「继续」按钮仍安全（step 2 未动它）。

## 执行记录

**提交**：`2eac457 fix(desktop): 缺省工作目录/搜索根接上三级回落（项目根 > workspaceDir > 主目录）`（10 文件，+178/−40）

**分片与结果**（主代理代码分片 + 1 个文档子代理 061d5dc3 同波并行，写范围互不重叠）：

- 主代理（代码分片）：
  - `apps/desktop/src/main/tools/index.ts`：`ComputerToolsDeps` 增 `projectRoot: () => string | undefined`（注释写明与边界校验同源）；`sync()` 内 153 行的两级式改为 `effectiveWorkspaceDir(settings, deps.projectRoot(), deps.homeDir())`（**该纯函数首个生产消费方**，import 自 `@aurora/agent-core`）；搜索段注释改为三级口径；同步日志追加 `projectRoot: deps.projectRoot() ?? ''`（grep 确认无既有消费方按旧日志形状断言，仅归档 step 文件提及）。
  - `apps/desktop/src/main/index.ts`：`registerComputerTools({...})` 增传**同一个** `projectRoot` getter（668–672 行，runner / file-port 已在用）；650–654 注释改为「runner `defaultCwd` 仅为缺省目录不存在时的最后兜底，正常缺省链 = 三级回落，真正校验在 `resolveWithin`」。
  - `apps/desktop/src/main/agent-host.ts`：`reasonWithinRoot` 两处注释按事实校正（「缺省 cwd 回落生效工作目录；配了项目即项目根，与装配同源」），**判定逻辑一字未动**。
  - `apps/desktop/src/main/tools/command-runner.ts`：86–88 承重注释纠偏（工具层恒传绝对 cwd，「只有显式给了 cwd 才校验」的旧说法与现实矛盾），不改逻辑。
  - `apps/desktop/src/main/tools/index.test.ts`：假 `files` 端口增记录 `searchRoots` / `findRoots`，`setup()` 增 `projectRoot` 形参，3 处内联调用补 `projectRoot: () => undefined`；新增 describe「缺省工作目录三级回落」5 用例：有项目→三工具缺省全落 `C:\proj-root`（**断言端口实收的 cwd/root，不是注册成功**）；项目根优先于 workspaceDir；无项目+空串→HOME（逐字不变护栏）；无项目+workspaceDir→该值；空白根 `'  '`→视为无项目。
- 文档子代理（docs/06 §5.1 增「三级回落以本节为准」bullet + §11/§11.1×2/§11.4/§11.5、docs/08×3、docs/10×3、AgentPage.vue 仅字符串×5、AGENTS.md bullet 1）：主代理逐 hunk 复核 `.vue` diff 确认 `data-field` / 绑定表达式零改动；`「显式传入的相对路径仍按主进程 CWD 解析」`逐字保留。docs/10 一处刻意避开续行以 `>` 开头的折行（防误变引用块）。
- **事故与恢复（如实记录）**：主代理曾用 `write` 全量覆盖 `index.test.ts`（本意是追加 describe），立即 `git checkout --` 恢复至 HEAD 后改用 `edit` 重做全部 4+1 处编辑，最终提交内容与误操作无关（38 用例含新增 5 全绿可证）。

**验收（主代理实跑）**：

1. `pnpm vitest run apps/desktop/src/main/tools/index.test.ts` → **38 passed**，5 个新用例名逐字出现 ✅。
2. 行为证据：见上「端口实收参数」断言 ✅。
3. 回归护栏五件套：`tools/index.test.ts + effectiveWorkspace.test.ts + terminal.test.ts + search.test.ts + agent-host.test.ts` → **118 passed**（判定端 480–495 用例未动且绿，与本步执行端配对）✅。
4. `pnpm typecheck` ✅（含 vue-tsc 过 AgentPage）；`pnpm test` 全仓 **1503 passed** ✅；`pnpm build` ✅；`pnpm format:check` + `pnpm lint` ✅（子代理文件先 `prettier --write` 归一）。
5. 口径 grep（`回落用户主目录|空串 = 用户主目录|留空`，四文件 11 命中）逐条：**docs/06 零命中**（全改三级）；docs/08 485/537/574/621/625 = 凭据「留空 = 不修改」语义，与缺省链无关，保留；docs/10:273 = 代理直连，无关；docs/10:320、AgentPage 428/434/786 = 已带「项目根优先」；**AgentPage:330 刻意保留**——它描述 `openPath kind:'workspace'` 按钮的两级解析（ipc.ts 995–999 未改，属「范围之外」），注释与现状一致 ✅。

**遗留（交审查与收尾，不在本步修）**：

- `ipc.ts:995–999` 「打开工作目录」按钮仍按 `workspaceDir` 两级解析——配了项目时与 `run_command` 实际落地目录**分叉**。属 00-index「范围之外」明令不动项，作为已知残留披露。
- 白名单外代码注释仍持旧口径 3 处：`schema.ts:484`、`agent-core/src/tools/search.ts:38`、（`index.test.ts:214` 用例名在无项目语境下仍成立，不算）。
- docs/06 §5.1「项目根同时决定两件事」严格说现为三件事（新增 bullet 已兜住，未改基准句，两处镜像保持同步）；docs/10 提「当前项目」但未指登记入口（P3）。
- 已知残留照旧：项目根被删时 `command-runner` 回落 `process.cwd()`、`file-port` 视不存在根为不可用（00-index「范围之外」第 5 条）。已核对 docs/06 §11.1「配置的目录不存在时回落 defaultCwd」句在三级链后**仍然成立**（command-runner.ts:121–124 行为未变）。
- 场景清单（交 step 4）：①auto+有项目无卡且落根；②confirm+有项目批准后成功落根；③无项目逐字不变；④手动「继续」仍安全。
