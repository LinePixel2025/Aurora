# Step 01 — 封堵 set_setting 对 agent.loop / agent.snapshots 的写入并统一文档口径

- Task: agent-context-boundary-fixes
- Step: 1 / 5
- Status: done
- Depends on: none
- Produces: `SETTINGS_READONLY_PREFIXES` 新增 `agent.loop` 与 `agent.snapshots` 两条黑名单前缀 + schema 单测 + AURORA_SMOKE 真端口矩阵两行；docs/06、docs/08、AGENTS.md、代码注释、`settings-hint.ts` 中「不进覆盖表 ⇒ AI 改不动」的错误因果统一改为「已进黑名单」口径
- Phase: 安全与边界
- Writes: `packages/shared/src/config/schema.ts`、`packages/shared/src/config/schema.test.ts`、`apps/desktop/src/main/tools/settings-port.ts`（仅注释）、`apps/desktop/src/main/settings-hint.ts`、`apps/desktop/src/main/index.ts`（仅冒烟 set_setting 矩阵处，约 2577–2616 行）、`docs/06-agent-core.md`（§11.8 与 §12 区域）、`docs/08-settings-onboarding.md`（提及两分组可写性处）、`AGENTS.md`、`step/step-01-setting-writable-surface.md` 与 `step/00-index.md`（执行记录回填）
- Risk: 误把 `agent.tools.*` 一并封进黑名单（那些是既定的可写面，见 `WRITABLE_PATH_OVERRIDES` 684–696 行）；退法 = 回滚本步 commit，逐条前缀复核后再来

## 目标

让「AI 不能给自己放大轮次 / token 预算、不能在写文件前关掉备份开关」这条已写进 AGENTS.md 与 docs/06 的安全意图**真实成立**，并把所有文档与代码注释里与实现相反的论断改成事实。

## 输入

- 现状根因（已实测核对，2026-09-26）：`packages/shared/src/config/schema.ts` 的 `settingsReadonlyReason`（约 766–780 行）判定顺序是 ①命中 `WRITABLE_PATH_OVERRIDES` 放行 → ②命中 `SETTINGS_READONLY_PREFIXES` 拒绝 → ③Schema 登记的已知路径**默认可写**。覆盖表不是白名单（其 650–655 行注释第 2 类自己写明「本就因不在黑名单而可写的路径」）。
- 因此 `agent.loop.maxRounds` / `maxTotalTokens` / `autoContinueRounds`（定义 585–594 行）与 `agent.snapshots.enabled` / `keepPerFile` / `maxSnapshotBytes` / `totalBudgetBytes`（554–574 行）今天都是 AI 可写的叶子路径——这就是报障点。
- 无父路径夹带漏洞：`walk()` 对 `ZodObject` 不给组路径登记（982–999 行），`canWriteSettingPath('agent')` / `('agent.loop')` 已因「未知配置路径」被拒（`isKnownSettingPath` 742–744 行），所以只需加两条**前缀**即可封死全部叶子。
- 黑名单与原因表强耦合：`READONLY_PREFIX_REASONS` 是 `Record<(typeof SETTINGS_READONLY_PREFIXES)[number], string>`（616 行），加前缀不补原因会直接编译失败——照现有条目样式补中文原因。
- 用户配置项 `advanced.readonlyPrefixes`（432–458 行）语义是「只能在默认黑名单之上追加」，`settingsReadonlyReason` 从不读它（`apps/desktop/src/main/tools/settings-port.ts:57–70` 注释亦写明「删掉或清空放不开」）→ **不需要配置迁移、不推进 `CONFIG_VERSION`（保持 15）**。
- 消费口径：`set_setting` 的 `get`/`list` 过 `port.writable()`（`packages/agent-core/src/tools/settings.ts:170–190`），`set` 在 `setSettings → port.write` 内逐路径再过一遍（`settings.ts` 约 242–248 行与主进程端口）；加黑名单后三处同时收紧：`list` 不再列出这两个分组、`get` 回「该路径不可读」、`set` 整次拒绝。
- 冒烟真端口矩阵（端到端证据入口）：`apps/desktop/src/main/index.ts` 约 2577–2640 行的条目数组里每项形如 `{ path, value, expectReject }`（现例：`{ path: 'llm.providers.x.apiKeyEnc', value: 'leak', expectReject: true }`），经 `writeSettingThroughTool` **真调** `set_setting.execute` → 主进程真端口判定；本步在此补两行。矩阵只在 `AURORA_SMOKE=1` 时跑，执行本步时无需起冒烟，step 4 统一验证。
- 需统一口径的错误表述位置：schema.ts 551–552 行（snapshots 注释）、582–583 行（loop 注释）、`AGENTS.md`「agent.loop / agent.snapshots……不在 SETTINGS_READONLY_PREFIXES，但同样不在 WRITABLE_PATH_OVERRIDES，所以默认 AI 改不动」的 bullet、`docs/06-agent-core.md` §11.8 约 749–750 行；`docs/06` §12.2（837–894 行）描述的是真实机制，核对后按需补充。**注意**：要改的因果是「不进覆盖表 ⇒ 改不动」；「AI 改不动」这个结论本身修完就是对的，别顺手删掉。
- `settings-hint.ts`（给模型的可写清单提示，37–41 行有「一律只读」句）：AGENTS.md「BetaV2 注册口径」要求可写面变动同步 settingsHint——本步把两个分组并入该只读句。
- 验证命令（仓库根）：`pnpm --filter @aurora/shared build`（改 shared 必须重建）、`pnpm vitest run packages/shared/src/config/schema.test.ts --reporter=verbose`、`pnpm typecheck`、`pnpm build && pnpm verify`。

## 操作

1. **先改文档（docs-first，AGENTS.md 硬约定）**：
   - `docs/06-agent-core.md`：§12.2 把黑名单构成清单补上「循环预算与写前快照（`agent.loop.*` / `agent.snapshots.*`：AI 放大轮次/预算、关掉写备份均等于绕过『该停下来问用户』的闸门）」——**不要写死条目总数**（docs/06:855 一带的既有口径是「具体以常量为准」）；§11.8 约 749–750 行改为「在 `SETTINGS_READONLY_PREFIXES` 内（与 `agent.permissionMode` 同款）：用户可在设置页调，AI 一律拒绝」。
   - `docs/08-settings-onboarding.md`：grep `agent.loop` / `agent.snapshots`，把所有「不进覆盖表 ⇒ 默认改不动」类句子改为同一口径。
   - `AGENTS.md`：更新对应 bullet（改为：现已进 `SETTINGS_READONLY_PREFIXES`，与 `agent.permissionMode`、`advanced.confirmSensitiveTools` 同款）；并把「set_setting 可写面由覆盖表驱动」bullet 的措辞校正为「覆盖表 = 黑名单内的显式放行；黑名单外且 Schema 登记过的叶子路径**默认可写**——新增安全敏感分组必须显式进黑名单，只『不登记进覆盖表』挡不住」。
2. 改 `packages/shared/src/config/schema.ts`：
   - `SETTINGS_READONLY_PREFIXES`（399–430 行）追加 `'agent.loop'` 与 `'agent.snapshots'`，各自带中文注释说明理由，沿用 417–429 行条目风格；
   - `READONLY_PREFIX_REASONS`（616–634 行）补两条，样式对齐 `'agent.permissionMode': '权限档位等于 Agent 自己的确认闸门，不允许通过工具修改'`；
   - 修正 551–552、582–583 行注释为「本分组在 `SETTINGS_READONLY_PREFIXES` 里（AI 改不动）；用户走设置页 / `settings:update` 不受影响」。
3. 改 `apps/desktop/src/main/tools/settings-port.ts`：60 行附近「默认九 / 十项」已过时，改为「默认全量前缀（含 `agent.loop` / `agent.snapshots`）」。
4. 改 `apps/desktop/src/main/settings-hint.ts`：37–41 行的「一律只读」句里并入「循环预算（`agent.loop.*`）与写前快照（`agent.snapshots.*`）」，措辞与既有一句「改它们等于……需要用户去设置页操作」连贯。
5. 改 `packages/shared/src/config/schema.test.ts`（参考 514 行 `projects.current` 的写法）：
   - 新增用例「agent.loop / agent.snapshots 进黑名单」：`canWriteSettingPath` 对 `agent.loop.maxRounds` / `agent.loop.maxTotalTokens` / `agent.loop.autoContinueRounds` / `agent.snapshots.enabled` / `agent.snapshots.keepPerFile` 全部 `false`；`settingsReadonlyReason('agent.loop.maxRounds')` 满足 `toMatch(/不允许/)`（拒绝带可追溯理由）；
   - 回归护栏：`canWriteSettingPath('agent.tools.enabled')` 与 `('agent.tools.workspaceDir')` 仍 `true`（覆盖表内路径不误伤）。
   - 先跑一次记录改前用例数（`--reporter=verbose` 存底），改后要求输出**出现新用例名**且全绿。
6. 改 `apps/desktop/src/main/index.ts` 冒烟矩阵：紧邻 `llm.providers.x.apiKeyEnc` 那条追加两行 `{ path: 'agent.loop.maxRounds', value: 64, expectReject: true }` 与 `{ path: 'agent.snapshots.enabled', value: false, expectReject: true }`（形状以矩阵既有条目为准）。**不要**动矩阵其它条目，也不要改任何生产判定代码。
7. 跑 `pnpm --filter @aurora/shared build && pnpm typecheck && pnpm test`；`pnpm build && pnpm verify` 留作本步收尾复跑（AURORA_SMOKE 端到端在 step 4 统一跑）。

## 验收标准

- [ ] `pnpm --filter @aurora/shared build` 成功（漏补 `READONLY_PREFIX_REASONS` 会在编译期直接失败）。
- [ ] `pnpm vitest run packages/shared/src/config/schema.test.ts --reporter=verbose` 全绿，输出中**逐字出现**新用例名（如「agent.loop / agent.snapshots 进黑名单」），且「agent.tools.* 仍可写」护栏用例通过。
- [ ] `pnpm typecheck` 全仓绿；`pnpm build && pnpm verify` 绿，`verify` 断言的 `version === CONFIG_VERSION` 仍为 15（本步无迁移、无版本推进）。
- [ ] 表述一致：用 PowerShell `Select-String -Path docs/06-agent-core.md,docs/08-settings-onboarding.md,AGENTS.md,packages/shared/src/config/schema.ts -Pattern 'agent\.(loop|snapshots)'` 列出全部命中（或等价的 harness grep 工具），每条命中处对可写性的说法均为「用户可写 / AI 不可写（在 `SETTINGS_READONLY_PREFIXES`）」，无任何一处仍以「不进 `WRITABLE_PATH_OVERRIDES`」作为 AI 改不动的理由。
- [ ] `settings-hint.ts` 与冒烟矩阵改动可见：`Select-String -Path apps/desktop/src/main/settings-hint.ts,apps/desktop/src/main/index.ts -Pattern 'agent\.loop'` 在两个文件均有命中，且矩阵两条新条目 `expectReject: true`（端到端 reject 行为由 step 4 的 AURORA_SMOKE 兑现，这里锁代码状态）。

## 交接

- 给 step 4：`CONFIG_VERSION` 保持 15、无新迁移；冒烟矩阵新增两行 `expectReject` 条目待端到端验证。
- 不改 `WRITABLE_PATH_OVERRIDES` 内容（防误伤既定可写面）。

## 执行记录

**提交**：`3d7da16 fix: 封堵 set_setting 对 agent.loop / agent.snapshots 的越权可写并统一文档口径`（8 文件，+68/−25）

**分片与结果**（主代理 + 1 个文档实现子代理，写范围互不重叠，同波并行）：

- 主代理（代码分片）：
  - `packages/shared/src/config/schema.ts`：`SETTINGS_READONLY_PREFIXES` 追加 `'agent.loop'` / `'agent.snapshots'`（各带中文理由注释，沿用条目样式）；`READONLY_PREFIX_REASONS` 补两条（「循环轮次与 token 预算等于 Agent 自己的停止闸门，不允许通过工具修改」/「写前快照是改动可回滚的兜底，不允许通过工具关闭」）；551–552 / 582–583 行两处错误注释改为「在黑名单里（AI 改不动）+ 用户走设置页不受影响」。
  - `packages/shared/src/config/schema.test.ts`：新增用例「agent.loop / agent.snapshots 进黑名单（放大预算与关快照均系自我提权）」——2 条组路径 + 7 条叶子路径（共 9 条）全部 `canWriteSettingPath === false`、原因 `toMatch(/不允许/)` 且非「未知配置路径」；护栏 `agent.tools.enabled` / `agent.tools.workspaceDir` 仍可写。附带发现：组路径 `agent.loop` 在 `matchReadonlyPrefix`（先于 Schema 兜底）即被黑名单命中，拒绝理由从「未知配置路径」变为显式中文原因——用例已锁定。
  - `apps/desktop/src/main/tools/settings-port.ts`：60 行「默认九 / 十项」改为「默认全量前缀（含 `agent.loop` / `agent.snapshots`）」。
  - `apps/desktop/src/main/settings-hint.ts`：只读句拆为两行并入「循环预算（agent.loop.*）与写前快照（agent.snapshots.*）同样一律只读」。
  - `apps/desktop/src/main/index.ts`：冒烟矩阵 `apiKeyEnc` 条目后追加 `{ path: 'agent.loop.maxRounds', value: 64, expectReject: true }` 与 `{ path: 'agent.snapshots.enabled', value: false, expectReject: true }`。
- 文档子代理（ec07246d，docs/06 + docs/08 + AGENTS.md）：§11.8 749 行改「在黑名单里（与 permissionMode 同款）」；§12.2 三处（黑名单新增列举 / 默认项覆盖清单补两条 / 理由段补 loop·snapshots 并把「后两条」改「这几条」）；docs/08 352–353 与 360–362 两处改「用户可写 / AI 不可写（在黑名单）」；AGENTS.md 195–199 bullet 与 BetaV2 bullet 的覆盖表错误因果校正。主代理逐 hunk 复核 diff 通过。
- 子代理请示：docs/08 另有 3 处提到 `WRITABLE_PATH_OVERRIDES` 的既有句（约 601–605 / 631 / 656–659）——主代理核对后**不改**：它们描述的是 `workspaceDir` / `maxReadBytes` 等**真·可写**路径（登记在覆盖表内），不含「不进覆盖表 ⇒ 改不动」的错误因果，也不涉及 `agent.loop` / `agent.snapshots`。

**验收（主代理实跑，均在仓库根）**：

1. `pnpm --filter @aurora/shared build` ✅（漏补原因表会在编译期失败的护栏生效）。
2. `pnpm vitest run packages/shared/src/config/schema.test.ts --reporter=verbose`：改前 40 → 改后 **41 passed**，新用例名逐字出现 ✅。
3. `pnpm typecheck` 全仓绿 ✅；`pnpm test` **1497 passed（79 文件）** ✅；`pnpm build && pnpm verify` **26/26 PASS**，`version === CONFIG_VERSION = 15` 未动 ✅。
4. 表述一致 grep（`agent\.(loop|snapshots)` 于 docs/06、docs/08、AGENTS.md、schema.ts）：全部命中处口径均为「用户可写 / AI 不可写（在 `SETTINGS_READONLY_PREFIXES`）」；`WRITABLE_PATH_OVERRIDES` 命中 8 处，唯一保留「不进覆盖表」字样的 docs/06:886 是**正确机制表述**（登记进覆盖表 = 先于黑名单放行，故刻意不登记），非错误因果 ✅。
5. `Select-String` 等价 grep：settings-hint.ts 与 index.ts 均命中 `agent.loop`，矩阵两条 `expectReject: true` ✅。
6. `pnpm format:check` + `pnpm lint` 全绿（含子代理改后复跑）✅。

**遗留**：无。端到端 reject 行为由 step 4 的 AURORA_SMOKE 兑现；`docs/release-notes/v0.1.5.md` 的已知限制披露按 step 4 第 5 条处理（历史发布说明不改写）。
