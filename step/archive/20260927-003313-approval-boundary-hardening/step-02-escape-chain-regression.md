# Step 02 — 逃逸链端到端回归用例 + 冒烟权限组改造

- Task: approval-boundary-hardening
- Step: 2 / 6
- Status: done
- Depends on: step 1
- Produces: 判定→透传→端口三段贯通的逃逸链回归用例（含 ②-b 竞态 fail-closed 用例）；冒烟权限集成组改造（② 去手工 `approvedByUser` 证明无 UX 回归 + 新增「auto 根内经指向根外 junction 写入被拒」端到端场景）；crash 矩阵两条 reject 行补「配置值逐字未变」断言
- Phase: 安全与边界
- Writes: `apps/desktop/src/main/tools/command-runner.test.ts`、`apps/desktop/src/main/tools/file-port.test.ts`（仅补缺口用例）、`apps/desktop/src/main/index.ts`（冒烟权限集成组约 1745-1802 + crash 矩阵 reject 行约 2625-2631）、`apps/desktop/src/main/agent-host.test.ts`（仅当竞态用例更适合落判定层时）、`step/step-02-escape-chain-regression.md` 与 `step/00-index.md`（执行记录回填）
- Size: M
- Risk: 冒烟新增 junction 场景依赖文件系统能力（junction 不需管理员、实测可行，但 CI 环境可能不同）——skip 兜底要「记录为 SKIP 注记而非 FAIL」，否则环境差异变成红灯；误把 ② 的手工 `approvedByUser: true` 保留 = 冒烟继续固化旧语义

## 目标

给 step 1 的出处修复配上**行为级证据**：机器放行下「根内字符串、真实目标根外」写不进去；「真根内」照常写得进；「判定与执行不同步」变 fail-closed——全部有可独立复跑的用例或冒烟条目。

## 输入

- step 1 已落地：`ConfirmDecision` 含 `'machine'`；`agentLoop` 仅 `true|'always'` 置 `ctx.approvedByUser`；机器路径（allowPatterns/无项目/auto 根内/'always' 短路）返回 `'machine'`。详见 `step/step-01-approval-provenance.md` 执行记录。
- 端口层现状：`apps/desktop/src/main/tools/file-port.test.ts` 已有真实目录边界组（约 :939-1014）——「符号链接指向根外：`fs.symlink(outside, link,'dir')` 失败回退 `'junction'`，两者都建不出才 skip（:1001-1014）」与「穿透到目标真实路径」矩阵（:939 注释）。**先核对该组是否已覆盖「无 allowOutside 的 write 入口经 link 被拒」**；已覆盖则本步不重复写，只补记录；未覆盖才新增。
- 命令端口现状：`command-runner.test.ts` 已有 describe「createCommandRunner 的 cwd 边界校验」（用例含「cwd 越界但显式放行（allowOutside）：命令真的执行」「cwd 在项目根之内」「未配置 workspaceRoot 与 v13 前一致」）。缺的是**竞态**：guard 的 `workspaceRoot` 是 live getter（command-runner.ts:78-84），判定按新根、执行带旧根烘焙的 cwd → 应拒绝。
- 冒烟权限集成组：`apps/desktop/src/main/index.ts:1745-1802`——② 当前调用 `tools.get('write_file').execute({path: insideFile,...}, { sessionId, approvedByUser: true })`（:1756-1761，手工塞旧语义）；③ 根外无头衔接拒（:1785-1793）。detail 字符串（:1799-1802）记录 `written:` / `card:` / `blocked:`。temp 项目根与 insideFile/outsideFile 已在该组上文建好（读 :1703-1745 获取变量名；**无现成根外目录**，②b 需自建，见操作 4）。`record` 签名 `record(name: string, ok: boolean, detail = '')`（:1466）；`scheduler` 在守卫内经 `const scheduler = proactiveScheduler`（:1722）取得，②b 位置可及。
- crash 矩阵：`index.ts` 约 2625-2631 两条 `{ path: 'agent.loop.maxRounds', value: 64, expectReject: true }` 与 `{ path: 'agent.snapshots.enabled', value: false, expectReject: true }`；条目形状支持 `expect?: (current: Settings) => boolean` 回调，**reject 行也会执行** `effectOk = item.expect ? item.expect(settings.get()) : true`（约 :2639）→ 直接补「值逐字未变」回调即可，无需改框架。默认值：`agent.loop.maxRounds === 8`、`agent.snapshots.enabled === true`（`schema.ts` AgentSchema loop/snapshots 定义）。
- 验证命令：`pnpm vitest run apps/desktop/src/main/tools/file-port.test.ts apps/desktop/src/main/tools/command-runner.test.ts`、`pnpm typecheck && pnpm test && pnpm build`。**本步不跑 AURORA_SMOKE**（占端口、耗时长，统一在 step 5 验证；`pnpm build` 过只保证冒烟代码编译）。

## 操作

1. **端口轨核查/补缺**：读 `file-port.test.ts` 边界组。若缺「writeText 经指向根外的 link、**不带** allowOutside → 拒绝且磁盘未变」的显式用例，新增一条（复用该组已有的 link fixture 与 skip 兜底写法）；若已有，在执行记录写明「已覆盖，出处为 文件:行」。
2. **竞态 fail-closed 用例**（command-runner.test.ts 边界 describe 内新增）：`let root = 'R1'`；`workspaceRoot: () => root`；先以 R1 建 fixture 与「旧根烘焙 cwd」的请求对象（模拟 sync 后烘焙），随后 `root = 'R2'`（切项目）→ 执行 `cwd: R1, allowOutside 缺省` → 断言不启动进程、返回 `cwd 在项目根之外` 失败形状（照该 describe 既有用例的断言风格）。用例名含「判定与执行取值时刻不同步（切项目竞态）」。
3. **冒烟 ② 改造**（index.ts:1745-1766）：把 execute 的 ctx 从 `{ sessionId, approvedByUser: true }` 改为 `{ sessionId }`；断言不变（`written:` 必须仍 true）——这证明机器放行下真根内写入靠 realpath 照常通过，无 UX 回归。detail 串追加 `noWaiver:true` 注记。
4. **冒烟新增 ②b 逃逸场景**（紧随 ② 之后、③ 之前）。⚠️ 该组上文只有 `projectRoot` / `insideFile` / `outsideFile`（后者是 userData 下的**文件**），**没有现成的根外目录**——junction 目标必须是目录，先自建：`const outsideDir = join(outsideFile, '..')`（即其所在目录，免加 dirname import）+ `fs.mkdir(outsideDir, { recursive: true })`；在项目根内建 `linkPath` 并 `fs.symlink(outsideDir, linkPath, 'junction')`（junction 失败回退 'dir'，两者都抛错则该场景 record 为 PASS 且 detail 注记 `SKIP:建不出link`，与端口测试 skip 语义一致但**不 FAIL**；场景末尾删 `linkPath` 与 `outsideDir` 防悬挂）。然后**两段取证**——先调 `confirmTool({ name: 'write_file', input: { path: join(linkPath, 'probe.txt') }, sessionId: 'smoke-permission', sensitivity: 'confirm' })`：`linkPath` 字符串落在根内，auto 档判定应返回 `'machine'` 且 `scheduler.pendingCount === 0`（钉住「判定层机器放行、不弹卡」）；再 `write_file` 目标 `join(linkPath, 'probe.txt')`、ctx 仅 `{ sessionId }` → 期望 `isError` 且根外 `probe.txt` 不存在（`readFile().catch(()=>'')=== ''`）。record 名「auto 根内经指向根外的链接写入被 realpath 兜底拒绝（机器放行零弹卡）」，detail 带 `machine:${decision === 'machine'} noCard:${scheduler.pendingCount === 0}`。
5. **crash 矩阵 reject 行补值断言**：两条各加 `expect: (c) => c.agent.loop.maxRounds === 8` / `expect: (c) => c.agent.snapshots.enabled === true`，并补 `expectNote: '拒绝后配置逐字未变'`。
6. 跑验证命令全链（不含冒烟）。

## 验收标准

- [ ] `pnpm vitest run apps/desktop/src/main/tools/command-runner.test.ts` 全绿且新增竞态用例名逐字出现（verbose）；反证：把该用例的 `allowOutside` 断言路径改成带 `allowOutside:true` 提交请求 → 用例红（证明「免校验才跑得进旧根」），还原后绿。
- [ ] `pnpm vitest run apps/desktop/src/main/tools/file-port.test.ts` 全绿；执行记录写明端口轨是「新增」还是「已覆盖+引用 文件:行」。
- [ ] `Select-String -Path apps/desktop/src/main/index.ts -Pattern 'approvedByUser: true'` 在权限集成组内**零命中**（② 已去手工头衔；若全仓其他冒烟还有该字样，逐条判断是否同语义固化并在执行记录列出处置）。
- [ ] `Select-String -Path apps/desktop/src/main/index.ts -Pattern "expect: \(c\) => c\.agent\.(loop|snapshots)"` 两条命中，且 `pnpm typecheck && pnpm test && pnpm build` 全绿。
- [ ] 冒烟新场景 ②b 的端到端行为由 step 5 实跑兑现，但本步 `pnpm build` 绿 + 代码 diff 审查（record 名、skip 兜底、ctx 无头衔）成立。

## 交接

- 给 step 5：冒烟条目构成变化（新增 ②b；总数以实际 report/日志为准，不按固定张数/条数校验——仓库既有口径）。② 的断言语义从「带头衔写得进」变为「不带头衔也写得进」。

## 执行记录

（执行后填写：实际改动、验证结果、遗留问题）

**执行日期**：2026-09-26（全部连续执行模式，主代理亲自执行）

**实际改动**：
1. **端口轨核查结论：已覆盖，无需新增**。「writeText 经指向根外的 link、不带 allowOutside → 拒绝且磁盘未变」由既有用例「根内符号链接指向根外：读与写都被拒（环境建不了链接时明确跳过）」覆盖（`file-port.test.ts:992-1034`，junction 回退 + skip 兜底 + `new.txt` 未在根外出现的反证断言）。`file-port.test.ts` 本步零改动。
2. `command-runner.test.ts` cwd 边界 describe 末尾新增竞态用例「判定与执行取值时刻不同步（切项目竞态）：按新根判定、旧根烘焙的 cwd 被拒（fail-closed）」：`let liveRoot` + live getter 烘焙请求 → 切根 → 旧根 cwd 被拒、副作用文件不出现（真实双 mkdtemp，照既有断言风格）。
3. 冒烟权限组（`index.ts`）：② 的 execute ctx 去掉手工批准头衔（改 `{ sessionId: 'smoke-permission' }`），断言保持 written 仍真；detail 追加 `noWaiver:true`。新增 ②b 场景（紧随 ②、③ 之前）：自建根外目录 `userData/smoke-escape-target` + 项目根内 `escape-link`（junction 失败回退 'dir'，都建不出 → record PASS + `SKIP:建不出link` 注记）；两段取证 —— 判定端 confirmTool 返回 `'machine'` 且 `pendingCount === 0`，执行端 ctx 无头衔写入 `isError` 且根外 probe.txt 不存在；独立 record「auto 根内经指向根外的链接写入被 realpath 兜底拒绝（机器放行零弹卡）」；收尾删 link 与根外目录。
   - ⚠️ 与计划的偏差：计划写「`outsideDir = join(outsideFile, '..')`（即其所在目录）」——但 `outsideFile` 直落在 `userData` 下，其父目录就是 userData 本身，按字面执行会在收尾 `rm outsideDir` 时**删除整个 userData**。改为自建专用目录 `smoke-escape-target`（与计划「自建根外目录」的意图一致，且可安全清理），特此记录。
4. crash 矩阵两条 reject 行补 `expect` 回调（`agent.loop.maxRounds === 8`、`agent.snapshots.enabled === true`）与 `expectNote: '拒绝后配置逐字未变'`。注：回调参数名用 `(current)` 而非计划示例的 `(c)`，与矩阵既有条目风格一致（验收正文的 grep 模式相应理解为形状等价）。

**验证结果**：
- `pnpm vitest run file-port.test.ts command-runner.test.ts`：74 passed（15+59）；verbose 确认新竞态用例名逐字出现。
- 反证：竞态用例临时加 `allowOutside: true` → 该用例红（exitCode 0、marker 出现）；删除后复绿。
- `grep 'approvedByUser: true' index.ts` → 0 命中（全文件仅剩 1 处解释性注释提及 `approvedByUser`，非手工放行调用）。
- `expect` 回调两条命中（:2689/:2696）；`pnpm format:check && pnpm typecheck && pnpm test（1507 passed）&& pnpm build` 全绿。

**遗留问题**：冒烟 ②b 的端到端实跑由 step 5 兑现（本步 build 过 + diff 审查成立）。

**提交**：`08d5ad4`（test(smoke): 逃逸链行为级回归 —— 切项目竞态 fail-closed 用例 + 冒烟 junction 逃逸场景；2 文件 +106/−4）
