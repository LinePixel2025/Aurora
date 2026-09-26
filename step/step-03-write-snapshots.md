# Step 03 — 写前自动快照 + 一键回滚（write_file / edit_file 共用）

- Task: agent-prod-mainline
- Step: 3 / 6
- Status: pending
- Depends on: step 2
- Produces: `SnapshotPort` 抽象 + `FileSnapshotPort` 实现（环形保留 + 索引 + 损坏恢复）、`writeText` 写前快照钩子（`write_file` 与 `edit_file` 共用）、`snapshots:*` IPC 与界面回滚、配置字段 `agent.snapshots.*`、单测与文档
- Phase: 安全与边界
- Writes: `packages/agent-core/src/snapshots/types.ts`（新）、`packages/agent-core/src/snapshots/snapshot-port.ts`（新）、`packages/agent-core/src/snapshots/snapshot-port.test.ts`（新）、`packages/agent-core/src/tools/files.ts`、`packages/agent-core/src/tools/files.test.ts`、`packages/agent-core/src/tools/edit.ts`、`packages/agent-core/src/tools/edit.test.ts`、`apps/desktop/src/main/tools/file-port.ts`、`apps/desktop/src/main/tools/file-port.test.ts`、`apps/desktop/src/main/tools/index.ts`、`packages/shared/src/config/schema.ts`（仅 `agent.snapshots.*` + `CONFIG_VERSION` 13→14 + 迁移登记）、`packages/shared/src/config/defaults.ts`、`packages/shared/src/config/migrations.ts`、`packages/shared/src/config/schema.test.ts`、`packages/shared/src/config/migrations.test.ts`、`packages/shared/src/ipc/channels.ts`、`packages/shared/src/ipc/types.ts`、`apps/desktop/src/preload/channels.ts`、`apps/desktop/src/preload/index.ts`、`apps/desktop/src/main/ipc.ts`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/renderer/shared/composables/snapshots.ts`（新）、`apps/desktop/src/renderer/chat/components/ContextPanel.vue`、`apps/desktop/src/main/capture.ts`、`apps/desktop/src/main/smoke.ts`、`docs/06-agent-core.md`、`docs/07-ui-spec.md`、`docs/08-settings-onboarding.md`、`docs/11-privacy.md`
- Risk: ①快照目录会无限增长 —— 必须同时实现"每文件环形 N 份"与"目录总量预算"两层上限，并且**淘汰逻辑要有单测**；②在 `writeText` 里插快照会让"快照成功、主写失败"成为一个新的中间态，必须定义清楚（本步定义：主写失败时快照**保留**，因为文件可能已被部分改写）；③`FilePort` 接口加参数会连带改 3 个测试文件，容易漏；④`ipc.ts` 顶层 `import electron`，**不能写单测**，回滚链路的端到端只能靠 smoke。出错回滚：本步独立 commit，`git revert`；已产生的快照目录是可删的普通文件，不影响功能。
- Sources: 仓库既有环形上限两套先例 —— 分类流水 500 条（`apps/desktop/src/main/classification-history.ts:19`、`:96-98`）与会话损坏备份 3 份（`packages/agent-core/src/session/store.ts:33`、`:393-405`）；持久化骨架照抄 `apps/desktop/src/main/tools/todo-port.ts`（懒加载 / 300ms 防抖原子写 / 损坏备份 / `flush()`）。

## 目标

每一次 `write_file`（overwrite 与 append）与 `edit_file` 在真正落盘前，都把**磁盘上的原内容**存进 `<userData>/backups/<sessionId>/`，环形保留 N 份；用户在界面上能把某个文件回到某个快照，回滚前会先给"回滚前状态"再打一份快照（所以回滚本身也可撤回）。文件不存在（新建）时记一条 `exists:false` 记录，回滚它会删掉该文件/清成空。

## 输入

- step 2 已落地：`apps/desktop/src/main/tools/file-port.ts` 的 `createNodeFilePort(options)` 已有 `workspaceRoot()` / `enforceWorkspace()` live getter 与 `resolveWithin()`；`writeText` 在 `:206-220`（`append` 走 `appendFile:211-212`、覆盖走 `writeFileAtomic:214`），`readWholeText` 在 `:171-204`，原子写在 `:653-662`（临时名 `${path}.${process.pid}.${Date.now()}.tmp`）。`packages/agent-core/src/tools/files.ts` 的 `FilePort` 接口是写盘唯一收口（`write_file` 在 `:453-523`，调端口在 `:506`；`edit_file` 在 `edit.ts:54-215`，调端口在 `:204`）。
- 持久化骨架与约定（**逐行照抄，但必须修掉首读竞态**）：`apps/desktop/src/main/tools/todo-port.ts` —— 文件头约定注释 `:8-13`、目录与内存状态 `:44-57`、`read/写入口:72-89`、`flush:98-108`、`ensureLoaded:117-121`（**"先 loaded.add 再 await" 的竞态就在这里**，改成 in-flight promise map，照 `packages/agent-core/src/session/store.ts:435-465` 的 `writing` 写法）、`readFromDisk:123-145`、`backupCorrupt + pruneBackups:147-169`（`MAX_BACKUPS = 3` 在 `:23`）、`scheduleWrite:171-189`、`writeNow:198-226`、`isTodoItem` 一类的类型守卫 `:244-254`。
- userData 路径来源：`app.getPath('userData')` 在 `apps/desktop/src/main/index.ts:285`，现有子目录装配（`sessions` `:521`、`generated` `:564`、`todos` `:586`）就是快照目录要照抄的位置；**`main/paths.ts` 只管"科目 → 目录"，与 userData 无关**，不要往那里加。
- 配置链路（与 step 1 同一套 5 处，**版本号此时是 13，本步升到 14**）：`schema.ts:9`（`CONFIG_VERSION`）、`AgentToolsSchema` 一带（`:447-491`）、`defaults.ts:179-240`、`migrations.ts` 的模板 `migrateV11ToV12`（`:457-484`）与登记数组（`:486-499`）、`packages/shared/src/ipc/types.ts` 的 `SettingsPatch`（`:79-`）+ `apps/desktop/src/main/settings-patch.ts:231-267`。⚠️ `agent.snapshots` 若整段缺失，Schema 会走"整体保留候选对象"路径（`schema.ts:721-730`、`:905-907`）→ **每个字段都必须有 `.default()`**。
- IPC 契约的三处镜像（**漏一处 `pnpm typecheck` 直接失败**）：`packages/shared/src/ipc/channels.ts:75-88`（chat 组通道常量）、`apps/desktop/src/preload/channels.ts`（字面量通道表 + 双向断言 `:9-11`）、`apps/desktop/src/preload/index.ts`（暴露给渲染层的 API）；DTO 落点在 `packages/shared/src/ipc/types.ts` —— 现有分区是 `AgentToolCall:621-660`、`SubagentStep:662-673`、`SubagentSnapshot:681-698`、`ChatMessageDto:705-737`，**新的快照 DTO 紧跟在 `ChatMessageDto` 结束之后、`:739` 的 `AgentEvent` 之前**。⚠️ **不要插在 `:739` 之后**：`:739-819` 是 `AgentEvent` 联合类型，`:821` 起已经是「preload 暴露面」、`:823` 是 `AuroraApi`，插进去会破坏契约分区。参考实现：`apps/desktop/src/main/imagegen.ts:158-182`（`dataUrl` + 路径白名单），通道如 `imagegen:read` 在 `channels.ts` 里的写法。
- 渲染层挂载点：`apps/desktop/src/renderer/chat/components/ContextPanel.vue` 的按模式分支（classroom `:183` / work `:250-263` / 通用档）；左栏固定项在 `SessionNav.vue:118/134`（若要做"回滚"入口也可挂这里）。附件/工具卡的图片预览写法可参考 `MessageList.vue:567-598` 与 `:893-899`。
- 探针与端到端：`apps/desktop/src/main/capture.ts` 的 chat 场景注册区（`4388-4720`，**`chat-collapse` 必须最后**，见 `:4690` 注释）与 settings 场景（`4810-4839`）；`seedChatTtsHistory` 一类"种盘必须早于窗口首读"的时点（`index.ts:999`）。`apps/desktop/src/main/smoke.ts` 的既有"真实写盘"断言可搜 `grep -n "写入\|written\|realWrite" apps/desktop/src/main/smoke.ts` 定位。
- 文档锚点：`docs/06-agent-core.md:355-434`（§11.1 安全边界、§11.3 非目标、§11.4 已知限制里"没有备份也没有撤销"那条必须改）、`:488-548`（§11.6 `edit_file`）、`:323-345`（§11 常量表）；`docs/08-settings-onboarding.md:269-299`（`agent.tools` 散文区）、`:341-366`（迁移清单）；`docs/07-ui-spec.md:135-164`（工具卡与子代理卡）、`:337-363`（浮层锚点与 `data-field` 清单）；`docs/11-privacy.md:120-140`（本地文件与凭据的披露区）。

## 操作

1. **先改文档**：`docs/06` 的 §11.6 与 §11.4 各补「写前快照与回滚」的语义（触发点、保留策略、回滚语义、`append` 也快照），§11 常量表加两行（单文件快照上限、每文件保留份数默认），新增一小节 `### 11.8 写前快照与回滚`（插在 `§12`（`:592`）之前）；`docs/08` 的 §1 JSON 样例与散文区加 `agent.snapshots.*`，迁移清单加 `v13 → v14`；`docs/07` 的右栏规格加「文件备份」卡；`docs/11` 披露"Agent 写文件会在本机留副本，位置与清理方式"。
2. **配置字段（`agent.snapshots`）**：
   - `SnapshotsSchema = z.object({ enabled: z.boolean().default(true), keepPerFile: z.number().int().min(1).max(200).default(20), maxSnapshotBytes: z.number().int().min(1024).max(64 * 1024 * 1024).default(524288), totalBudgetBytes: z.number().int().min(1024 * 1024).default(200 * 1024 * 1024) })`，挂到 `AgentSchema`（**注意它是 `agent.snapshots`，不要放进 `agent.tools`**，避免与 `COMPUTER_TOOL_NAMES` 的门控语义混淆）。
   - **不要**把 `agent.snapshots` 加进 `SETTINGS_READONLY_PREFIXES`（用户与 AI 都可以调保留份数/上限是合理的），但**不要**给它加 `WRITABLE_PATH_OVERRIDES`（默认 AI 只读；确需开放另开一步）。
   - `CONFIG_VERSION` 13 → 14；新增 `migrateV13ToV14`（`fillMissing(agent, { snapshots: {...默认} })`，幂等、不覆盖已写值）；登记数组末尾追加；`defaults.ts` 的 `DEFAULT_TOOLCHAIN_CONFIG.agent` 补同款默认值。
   - `schema.test.ts` 加字段接受性用例；`migrations.test.ts` 加 v13→v14 的 `describe`（照 `:829-882` 写法，注意既有用例用 `CONFIG_VERSION - N` 相对算术会自动跟随）。
3. **快照抽象（`packages/agent-core/src/snapshots/types.ts`）** —— 只定义端口与 DTO，**不 import electron、不 import node:fs**：
   ```ts
   export interface SnapshotRef {
     id: string            // '<ISO ts>-<hash8>'，同一文件下单调可排序
     sessionId: string
     path: string          // 绝对路径
     toolCallId?: string
     origin: 'write_file' | 'edit_file' | 'rollback'
     createdAt: string
     contentPath: string   // 快照内容文件名（相对快照目录）
     bytes: number
     sha256?: string
     exists: boolean       // false = 记录的是"当时文件不存在"
     truncated?: boolean
     mode?: 'overwrite' | 'append'
   }
   export interface SnapshotPort {
     capture(input: { sessionId: string; path: string; toolCallId?: string; origin: SnapshotRef['origin']; mode?: 'overwrite' | 'append' }): Promise<{ snapshot?: SnapshotRef; skipped?: 'too-large' | 'disabled' | 'unreadable' }>
     list(query: { sessionId?: string; path?: string; limit?: number }): Promise<SnapshotRef[]>
     readContent(ref: SnapshotRef): Promise<{ bytes: Buffer; truncated: boolean } | undefined>
     prune(sessionId: string): Promise<{ removed: number }>
     flush(): Promise<void>
   }
   ```
   `SnapshotRef` 要能经 IPC 序列化（`Buffer` 只在主进程内用，跨 IPC 传 `number[]` 或 `dataUrl`）。
4. **快照实现（`packages/agent-core/src/snapshots/snapshot-port.ts`）**：`createFileSnapshotPort({ dir, fs, logger, keepPerFile, maxSnapshotBytes, totalBudgetBytes, writeDebounceMs })` —— `fs` 类型用 `@aurora/shared` 的 `FileSystemPort`（`packages/shared/src/config/ports.ts:11-20`，含 `writeFileAtomic`）。行为：
   - **命名口径**：用户原话给的是 `userData/backups/<sid>/<ts>-<name>`；实现按同一精神收敛为 **`<dir>/<sessionId>/<ISO 时间戳>-<8 位哈希>.snap` + `index.json`**（**不用原文件名**：同一路径可能被改多次、原名会撞名且含非法字符；`name` 信息放在 `index.json` 的 `path` 字段里）。这条口径必须在 `docs/06 §11.8` 与代码注释里各写一次。
   - 目录布局（**这是全程唯一的形状口径，`00-index.md` 的完成标准也按它写**）：一条快照 = `<dir>/<sessionId>/` 下的**一个内容文件**，文件名就是快照 id，形如 `<ISO 时间戳>-<8 位内容哈希>.snap`（例：`2026-09-26T10-52-31-123Z-3f9a1c07.snap`）。id 里的时间戳保证同一文件下**字典序 = 时间序**，哈希保证同毫秒不撞名。索引是 `<dir>/<sessionId>/index.json`（`SnapshotRef[]`）。读取大文件时只按 `bytes` 与索引列出，不预读内容。
   - `capture`：`stat` 目标 → 不存在则写 `exists:false` 记录（`bytes:0`，不建内容文件）；是目录/符号链接 → `skipped:'unreadable'`；大于 `maxSnapshotBytes` → `skipped:'too-large'`（**不静默**，调用方要把这个状态回带进工具结果）；否则 `readFile` → 写 `<id>.snap` → 追加索引。
   - **环形淘汰**：按 `path` 分组，每组按 `createdAt` 倒序保留 `keepPerFile` 条，超出的删内容文件 + 从索引移除；再做一次**目录总量**检查（所有内容文件 `bytes` 之和 > `totalBudgetBytes` 时从最旧开始删）。
   - **索引与并发**：索引读写用与 `todo-port.ts` 同款的 300ms 防抖原子写 + `flush()`；**`ensureLoaded` 必须用 in-flight promise map**（不要复制 `todo-port.ts:117-121` 的"先标记后 await"）；同一个 `sessionId` 的写操作串行化。
   - 损坏恢复：`index.json` 解析失败 → 备份为 `index.corrupt-<ts>.json`（最多 3 份）后按空索引继续，并顺手清掉孤儿 `.snap`。
5. **写盘钩子（`apps/desktop/src/main/tools/file-port.ts`）**：
   - 给 `createNodeFilePort(options)` 加 `snapshots?: Pick<SnapshotPort, 'capture'>`。
   - `writeText` 签名扩展（`FilePort` 接口同步改）：`writeText(path, content, mode, options?: { allowOutside?: boolean; snapshot?: { sessionId: string; toolCallId?: string; origin: 'write_file' | 'edit_file'; mode: 'overwrite' | 'append' } })`。
   - 执行顺序（**这就是"写前"的定义，顺序不能变**）：`resolveWithin` → 若 `snapshot` 存在且已注入快照端口 → `capture({...})`（**先快照再写**）→ `mkdir(dirname)` → `writeFileAtomic`/`appendFile`。主写失败时**不回滚快照**（保命优先），并把快照 id 写进错误信息。
   - `readWholeText`（`edit_file` 用它读全文）不动快照逻辑；但 `edit_file` 的写入也必须带上 `snapshot` 参数（见下一条）。
6. **工具层透传（`packages/agent-core/src/tools/files.ts` / `edit.ts`）**：`write_file`（`files.ts:453-523`，写盘在 `:506`）与 `edit_file`（`edit.ts:204`）在调用端口时带上 `snapshot: { sessionId, toolCallId, origin, mode }`；`sessionId` 与 `toolCallId` 都来自工具 `ctx`（`registry.ts` 的 `ToolContext`，`grep -n "sessionId" packages/agent-core/src/tools/registry.ts` 确认真实字段名）。工具结果里回带一行 `已保存快照：<id>`（或 `未保存快照：文件过大（>512KiB）`），让模型与用户都能看到。
   - `allowOutside` 参数按 step 2 的通道透传（本步不改边界判定）。
7. **IPC 与界面**：
   - `channels.ts` 新增 `snapshots.list` / `snapshots.restore` / `snapshots.prune`（命名遵守 `namespace:action` 约定），**同步** `preload/channels.ts` 与 `preload/index.ts`。
   - `apps/desktop/src/main/ipc.ts` 加三个 handler：`snapshots:list`（默认按当前会话，可传 `path` 过滤，`limit` 缺省 50）、`snapshots:restore`（`{ snapshotId }` → **先给当前磁盘状态再打一份 `origin:'rollback'` 快照** → 再把旧内容写回（`exists:false` 的回滚 = 删除该文件）→ 返回新快照 ref）、`snapshots:prune`（手动清理）。
   - 主进程装配：在 `apps/desktop/src/main/index.ts` 的 userData 子目录装配区（`:521`/`:564`/`:586` 一带）加 `snapshots` 目录，`createFileSnapshotPort` 实例注入 `createNodeFilePort`（`:550` 一带），并在退出 flush 链（`:2166-2175`）里加 `flush()`。
   - 渲染层 `apps/desktop/src/renderer/shared/composables/snapshots.ts`（新）：`list()` / `restore(id)` / `prune()` + 每会话缓存；`ContextPanel.vue` 新增「文件备份」卡（`data-field="chat.snapshot-card"`，列出最近 5 条：文件名 + 时间 + 来源工具 + 「回滚」按钮；点回滚走两段式确认 —— 第一次点变「确认回滚？」再点才执行，照 `AdvancedPage.vue:61-73` 的写法；回滚成功后 `toast` + 刷新列表）。
8. **探针与端到端**：
   - `capture.ts`：新增场景 `chat-snapshot-card.png`（种一份快照目录 + 触发一次真实写盘 → 断言卡片出现、条目数 ≥1、回滚按钮两段式文案变化），并在 settings 页探针里加 `agent.snapshots.*` 字段计数（`count('[data-field^="agent.snapshots."]')` + `unexpected` 白名单，**不要写死数字**）。
   - `smoke.ts`：新增断言 —— 用 smoke 专用写入路径让 Agent 真写一个文件 → ①快照目录里出现该文件的快照且索引可解析；②调用 `snapshots:restore` 后磁盘内容等于写之前；③回滚又产生了一条 `origin:'rollback'` 的快照；④`edit_file` 路径同样产生快照（覆盖 `append` 与 `overwrite` 两种 mode）。
9. **测试落点**：`packages/agent-core/src/snapshots/snapshot-port.test.ts` 用 `apps/desktop/src/main/tools/todo-port.test.ts` 的同款结构（内存 `FileSystemPort` 或临时目录），覆盖：往返、懒加载、防抖、`flush`、写失败重试、索引损坏恢复、`keepPerFile` 环形淘汰（写 N+3 份后只剩 N 份且最旧的被删）、`totalBudgetBytes` 淘汰、`exists:false` 记录、`too-large` 跳过、`append` 模式快照的是**追加前**的内容、**并发首读不返回空索引**（这条直接锁死 `todo-port.ts` 那个竞态的复现——用 `Promise.all([port.list(), port.capture(...)])` 断言 `list` 不是空数组）。
10. **验证并提交**：`pnpm --filter @aurora/shared build && pnpm --filter @aurora/agent-core build` → `pnpm typecheck && pnpm test && pnpm lint` → smoke/capture。提交信息建议 `feat(v0.1.5): 写前自动快照与一键回滚（write_file / edit_file 共用，agent.snapshots，配置 v14）`。

## 验收标准

- [ ] `pnpm vitest run packages/agent-core/src/snapshots` 全绿，且存在断言：`keepPerFile` 环形淘汰后同目录只剩 N 份、最旧的被删；`totalBudgetBytes` 触顶时从最旧删；`Promise.all([list(), capture()])` 时 `list()` 返回的不是空索引（锁死首读竞态）。
- [ ] `pnpm vitest run apps/desktop/src/main/tools/file-port.test.ts` 全绿，含断言：注入快照端口后写一个已存在文件 → 快照目录多出 1 条且内容等于写前；`append` 模式的快照内容是**追加前**的全文；未注入快照端口时行为与 step 2 一致（同一用例在注入前后断言不同、不注入时快照目录不存在）。
- [ ] `pnpm vitest run packages/agent-core/src/tools` 全绿，`files.test.ts` / `edit.test.ts` 各含一条"工具结果回带快照 id"的断言。
- [ ] `pnpm vitest run packages/shared/src/config` 全绿，含 `migrate({ version: 14 })` 恒等 + v13→v14 补默认且不覆盖已写值的断言。
- [ ] `pnpm typecheck`、`pnpm lint` 退出码 0；`pnpm test` 全量退出码 0。
- [ ] `AURORA_SMOKE=1 pnpm dev` 的 `AURORA_SMOKE_RESULT` 全通过，且四条新增断言（快照生成 / 回滚后内容还原 / 回滚自身也留快照 / `edit_file` 同样快照）都在日志里。
- [ ] `AURORA_CAPTURE="$env:TEMP\aurora-capture-03" pnpm dev` 退出码 0、`report.json` 无 FAIL，含 `chat-snapshot-card.png` 且 `settings-general-fields` 的 `agent.snapshots.*` 检查项存在。
- [ ] 目录上限真的生效：在临时 userData 下连续写同一文件 30 次（`keepPerFile` 默认 20），**先等防抖落盘（300ms 或显式 `flush()`）再数**，`Get-ChildItem <userData>\backups\<sid>\*.snap | Measure-Object` 的计数 ≤ 20。
- [ ] 回滚可撤回：对同一文件连续两次 `snapshots.restore`（**两次之间先 `await snapshots.flush()` 或轮询等索引落盘**，否则会因 300ms 防抖读到旧索引而假 FAIL），第二次回滚后内容等于第一次回滚前的内容（"回滚本身也留快照"的端到端证据）。

## 交接

- 给 step 4：主进程退出时已有 `flush()` 链（`:2166-2175`），**job 的 `flush()` 要挂在同一条链上**；`apps/desktop/src/main/index.ts` 的 userData 子目录区本步已改过一次（加 `backups`），step 4 只加 `jobs`。
- 给 step 4：`packages/shared/src/ipc/channels.ts` / `types.ts` / `preload/*` 本步已用掉 `snapshots:*` 三个通道，step 4 加 `chat.jobs*` 时**只追加，不要重排既有常量顺序**（既有测试按数组顺序断言过）。
- 给 step 5：快照的端到端证据由本步 smoke 提供；step 5 只需把它与 job 续跑串成一条"写文件 → 快照 → 中断 → 续跑 → 回滚"的综合场景。

## 执行记录

（执行后填写：实际改动、验证结果、遗留问题）
