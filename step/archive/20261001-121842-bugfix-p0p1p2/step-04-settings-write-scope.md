# Step 04 — 设置写入口径与配置 sanitize

- Task: bugfix-p0p1p2
- Step: 4 / 12
- Status: done
- Depends on: none
- Produces: `modes.work.workspaceDir` 对 AI 只读（权限边界根不再可被 AI 改写）；tts/stt/imagegen 三组对 AI 真正可写（承诺与闸门一致）；对象型字段形状非法时按字段级回退而非整份重建；文档同步
- Phase: 安全与边界
- Writes: `packages/shared/src/config/schema.ts`、`packages/shared/src/config/schema.test.ts`、`packages/shared/src/config/permission.test.ts`、`packages/shared/src/utils/object.ts`、`packages/shared/src/utils/object.test.ts`、`apps/desktop/src/main/tools/settings-port.ts`、`apps/desktop/src/main/tools/settings-port.test.ts`、`apps/desktop/src/main/tools/index.ts`、`packages/agent-core/src/tools/settings.ts`、`packages/agent-core/src/context/systemPrompt.ts`、`packages/agent-core/src/context/systemPrompt.test.ts`、`docs/08-settings-onboarding.md`、`docs/06-agent-core.md`
- Size: M
- Risk: 只读前缀与可写口径有三处文案（schema 常量、set_setting 工具 description、systemPrompt settingsHint）——漏改任何一处都会造成「模型被告知可写但写入被拒」或反向误导；文档先行，改完逐处对照

## 目标

AI 无法再通过 `set_setting` 改写 Work 模式工作目录（权限边界根一级）；AI 能真正写入 `tts.*` / `stt.*` / `imagegen.*`（工具描述承诺的可写面与 write 闸门一致）；手改配置里对象字段被写成标量时只回退该字段，不再整份配置重置出厂。

## 输入

- `bug/P1-严重.md` 的 P1-01、P1-06 与 `bug/P2-一般.md` 的 P2-26（每条含 文件:行、触发条件与修复建议）；证据在 `bug/_raw/U8-shared-preload-modes-scripts.md`（P1-01/P2-26）与 `bug/_raw/U3-tools-automation.md`（P1-06）
- 源码：`packages/shared/src/config/schema.ts`（`SETTINGS_READONLY_PREFIXES` 约 444 行起、`READONLY_PREFIX_REASONS` 与 `WRITABLE_PATH_OVERRIDES` 同文件约 819 行区域）；`apps/desktop/src/main/tools/settings-port.ts`（`TOP_LEVEL_GROUPS` 约 50-59 行，分组检查约 118-122）；`packages/shared/src/utils/object.ts`（`sanitizeWithDefaults` 约 60-83）；`packages/agent-core/src/tools/settings.ts`（set_setting 工具 description）；`packages/agent-core/src/context/systemPrompt.ts`（settingsHint）；`apps/desktop/src/main/tools/index.ts`（工具注册处，若有镜像文案一并改）
- AGENTS.md 相关口径：`SETTINGS_READONLY_PREFIXES` 是「AI 一律拒绝、用户设置页不受影响」的黑名单；`projects` 整组被拉黑的理由与 P1-01 完全同构
- 配置约束：本步不新增字段、不改 CONFIG_VERSION、不写迁移；docs/08 的 AI 可写口径段必须同步（文档先行）

## 操作

1. P1-01（文档先行）：`docs/08-settings-onboarding.md` 的 AI 可写/只读口径段先补两行——`modes.work.workspaceDir` 移入只读（理由：它是权限边界根，AI 可改写即自我提权）；`tts` / `stt` / `imagegen` 三组放行（`center` 维持整组只读不变）。
2. P1-01 实现：`schema.ts` 的 `SETTINGS_READONLY_PREFIXES` 追加 `'modes.work.workspaceDir'`，`READONLY_PREFIX_REASONS` 补对应理由；从 `WRITABLE_PATH_OVERRIDES` 删除该路径（只删覆盖表不够——会落回「Schema 登记过即默认可写」，必须进黑名单）。
3. P1-01 文案同步：`packages/agent-core/src/tools/settings.ts` 的工具 description、`packages/agent-core/src/context/systemPrompt.ts` 的 settingsHint、`apps/desktop/src/main/tools/index.ts` 若有镜像文案——三处按现有文案结构同步（把 Work 工作目录从可写表述挪到只读表述）。
4. P1-06：`settings-port.ts` 的 `TOP_LEVEL_GROUPS` 追加 `'tts'`、`'stt'`、`'imagegen'`（`center` 维持缺席——两侧口径一致地只读）。
5. P2-26：`object.ts` 的 `sanitizeWithDefaults` 补形状校验——fallback 为纯对象而 candidate 不是纯对象（标量 / 数组）时，按「值非法」走字段级回退，不再让整份配置被判损坏重建。
6. 测试：`permission.test.ts` 或 `settings-port.test.ts` 断言 `canWriteSettingPath('modes.work.workspaceDir') === false`（回归报告 U8 的实测场景）且 `tts.*` / `stt.*` / `imagegen.*` 的非凭据叶子可写、`tts.providers` 等凭据路径仍拒绝；`object.test.ts` 补 P2-26 两用例（`general: 123` → 整组按默认对象回退、其余分组保留；`general.edgeBar.quietHours: "22:30"` → 仅该字段回退）；`systemPrompt.test.ts` 如有文案断言同步更新。
7. Conventional Commits 中文分组提交（`fix(config): ...` / `fix(agent): ...`），提交信息尾注覆盖的条目号（如 `...(P1-01, P2-26)`）。

## 验收标准

- [ ] `pnpm vitest run packages/shared/src packages/agent-core/src/context apps/desktop/src/main/tools` 全绿，且含上述新用例（workspaceDir 拒写、三组放行、两条 sanitize 回退）
- [ ] `pnpm typecheck` 通过（改了 shared 后若下游报类型缺失，先 `pnpm --filter @aurora/shared build` 再查）
- [ ] `docs/08-settings-onboarding.md` 有 workspaceDir 只读与三组放行的记载（文档先行落地证据）
- [ ] 对照 AGENTS.md：`tts.providers` 等凭据路径仍在只读口径内（新放行不扩大到凭据）

## 交接

- `docs/08` 的口径段是 step-08（P1-07 命名约定）要继续编辑的同一文件——本步收尾时保持该文档结构与条目编号稳定。
- `modes.work` 组内其余字段（如人设开关等）不受影响——审查时确认只收紧了 `workspaceDir` 一个路径。

## 执行记录

**提交**：`ba737e0 fix(config): work.workspaceDir 转只读、tts/stt/imagegen 放行、sanitize 形状校验`

**分片与结果**：单分片，1 个实现子代理（general-purpose）。主代理复跑全套验收命令。

**实际改动**
- `docs/08` / `docs/06`（文档先行）：补 `modes.work.workspaceDir` 只读（理由：权限边界根的一级，AI 可改写即自我提权）、`tts` / `stt` / `imagegen` 三组放行（`center` 维持整组只读）；同步 `readonlyPrefixes` 条、JSON 样例、字段条与 §12.2 / §17 的可改清单。
- `packages/shared/src/config/schema.ts`：`SETTINGS_READONLY_PREFIXES` 追加 `'modes.work.workspaceDir'`；`READONLY_PREFIX_REASONS` 补对应理由；从 `WRITABLE_PATH_OVERRIDES` 删除该 pattern 并留「刻意不登记」注释（**只删覆盖表不够**——会落回「Schema 登记过即默认可写」）。
- `packages/shared/src/utils/object.ts`（P2-26）：`sanitizeWithDefaults` 在 `validate` 之后、递归之前加 `if (isPlainObject(fallback) && !isPlainObject(candidate))` → 记 issue + 回退默认（兜 `z.record` 这类 `fieldAccepts` 判 `'any'` 的路径）。
- `schema.ts` 另加 `fieldAccepts` 的对象形状校验（P2-26 的另一半）：新增 `objectPaths` / `nullableObjectPaths`（与 `schemaSpecs` **分开**，避免 `isKnownSettingPath('general')` 变真、`canWriteSettingPath('general')` 被放开）；`walk` 的 `ZodObject` 分支登记本级，新增独立 `ZodNullable` 分支（内层是对象时额外接受 `null`）。
- `apps/desktop/src/main/tools/settings-port.ts`（P1-06）：`TOP_LEVEL_GROUPS` 追加 `'tts'` / `'stt'` / `'imagegen'`（`center` 仍缺席，两侧口径一致地只读）。
- 文案三处同步：`schema.ts` 黑名单条目 + 理由 + 覆盖表注释；`packages/agent-core/src/tools/settings.ts:76` 的 `set_setting` description（并把 `modes.work.workspaceDir` 从可写列表移到只读表述）；`apps/desktop/src/main/settings-hint.ts:43` 的 settingsHint（第 26 行旧的可改行已删除）。

**⚠️ 超出白名单的一处（子代理主动报告，主代理确认接受）**：`apps/desktop/src/main/settings-hint.ts`（+3/−1 行，仅字符串与注释）。操作 3 原文写「`systemPrompt.ts` 的 settingsHint」，但 `systemPrompt.ts` 只负责**注入渲染**、没有任何 settingsHint 内容；真实的 settingsHint 常量在 `apps/desktop/src/main/settings-hint.ts`（经 `index.ts:1170` 注入），而 `tools/index.ts` 没有镜像文案。不改它，验收第 4 条必然不成立（模型仍被告知可改 `modes.work.workspaceDir`，写入必拒）。该文件不在其他任何 step 的写范围内。**step-04 的 Writes 清单应把 `packages/agent-core/src/context/systemPrompt.ts` 更正为 `apps/desktop/src/main/settings-hint.ts`。**

**验证（主代理实跑）**
```
pnpm vitest run packages/shared/src packages/agent-core/src/context apps/desktop/src/main/tools
  → 19 files / 404 tests 全绿（新增 8 例：schema +2、object +2、settings-port +4）
pnpm test      → 115 files / 2028 tests 全绿
pnpm typecheck → 全部 Done
pnpm verify    → 26/26 通过（v0 → 当前版本迁移链 21/21 照旧）
```
子代理首跑 port 测试失败一次（`expected true to be false`），根因是 `@aurora/shared` 的 **dist 未重建** —— 正是 AGENTS.md 记的那条坑，`pnpm --filter @aurora/shared build` 后即绿。

**遗留 / 注意**
- 子代理另加了一条 step 未要求的用例：「用户把 `advanced.readonlyPrefixes` 清空也放不开该路径」（钉住硬编码常量兜底）。
- P2-26 的端到端反向复核（store 层「不再整份重建」）**未做**：`store.test.ts` 不在本 step 白名单内，未新增用例；已读 `store.ts:154-172` 确认 `sanitizeWithDefaults` → `SettingsSchema.parse` 失败即备份重建的路径与修复点的关系。
- `modes.work` 组内其余字段不受影响 —— 只收紧了 `workspaceDir` 一个路径。

