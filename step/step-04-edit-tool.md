# Step 04 — `edit_file`：精确替换 + EOL 保真 + 唯一性拒绝 + 读前守卫

- Task: opencode-parity
- Step: 4 / 7
- Status: pending
- Depends on: step 3（`FilePort` 的端口范式与常量导出已就位；`registerComputerTools.sync()` 已能返回实际注册名）
- Produces: `packages/agent-core/src/tools/edit.ts`（`edit_file` 工具 + `ReadTracker` 守卫契约）、
  `FilePort.readWholeText`（整文件读，专供替换用）、装配层的会话级读前守卫
- Phase: 核心链路
- Writes: `packages/agent-core/src/tools/edit.ts`、`packages/agent-core/src/tools/edit.test.ts`、`packages/agent-core/src/tools/files.ts`（追加 `readWholeText` 声明与常量）、`packages/agent-core/src/tools/files.test.ts`（同步测试桩）、`packages/agent-core/src/index.ts`、`apps/desktop/src/main/tools/file-port.ts`、`apps/desktop/src/main/tools/file-port.test.ts`、`apps/desktop/src/main/tools/index.ts`、`apps/desktop/src/main/tools/index.test.ts`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/renderer/shared/toolIcons.ts`（给 `edit_file` 加语义图标）、`docs/06-agent-core.md`（§11.6 补「不可撤销」已知边界）、`docs/11-privacy.md`（权限表补一行）
- Risk: **本步是全任务风险最高的地方——写坏用户文件是不可逆的。** 四条必须堵死的路径：
  ① 用行窗口 API 读文件（`readText` 默认只给 2000 行）→ 替换后写回 = **静默截断掉 2000 行以后的全部内容**。
  防法：新增 `readWholeText` 专供替换，且 `truncated` / `refused` 任一为真即拒绝改动。
  ② CRLF 文件的行尾被重写成 LF（模型给的 `oldString` 几乎总是 LF 形态，直接原文匹配会匹配不到；
  匹配成功而写回 LF 则悄悄改变了整个文件的**每一行**）。防法：归一匹配 + 按原文行尾还原，且有逐字节单测。
  ③ 命中多处却只替换第一处（模型以为改了全部）。防法：多处且未声明 `replaceAll` 一律拒绝。
  ④ 空 `oldString`（能匹配任意位置）。防法：空串直接拒绝。
  退路：本步不引入任何"自动重试/模糊匹配"——匹配不上就如实报错，让模型重新读取。宁可失败一次，不可改错一次。

## 目标

模型能对文件做**精确的局部替换**，不再需要为了改两行而整文件重写；
替换过程对文件其余部分**逐字节不变**（含行尾风格），且改之前必须真的读过这个文件。

## 输入

- `packages/agent-core/src/tools/files.ts`：`FilePort`、`MIN_READ_BYTES`、`MAX_READ_SCAN_BYTES`、
  `resolveClamped`、`readNonEmptyString` / `readString` / `asRecord` / `describeError`（`:342` 起，
  这些参数读取助手是**模块私有**的——`edit.ts` 要么复用要么另写一份与之一致的）
- `packages/agent-core/src/tools/terminal.ts:88` 的 execute 写法（参数非法时**不触碰端口**的既有口径）
- `apps/desktop/src/main/tools/file-port.ts`：`writeFileAtomic()`（同目录临时文件 + rename）、
  `readHead()`、`hasNulByte()`、`withPath()`
- `apps/desktop/src/main/tools/index.ts`：`registerComputerTools`（`sync()` 与既有五个工具的分派）
- `apps/desktop/src/main/index.ts:638` 附近（`createConfirmTool` 与 `KernelAgentHost` 的装配位置，
  读前守卫要在这里按会话持有）
- `docs/06 §11.6`（step 1 落盘的替换语义与上限规格）

## 操作

### 1. `FilePort` 追加整文件读（`files.ts`）

```ts
/** `edit_file` 单文件上限：整文件读入内存做替换，超过即拒绝（内核常量，不进配置） */
export const MAX_EDIT_BYTES = 1_048_576   // 1 MiB

export interface ReadWholeTextResult {
  absolutePath: string
  /** 文件完整内容；`refused` 为 true 时为空串 */
  text: string
  bytes: number
  /** 文件超过 maxBytes（或命中 `MAX_READ_SCAN_BYTES`）时为 true —— 调用方**必须**据此拒绝改动 */
  refused: boolean
}

export interface FilePort {
  // ... 既有方法不变
  /** 为整文件替换读取完整内容；**不做行窗口裁剪**，超过 maxBytes 即 refused */
  readWholeText(path: string, maxBytes: number): Promise<ReadWholeTextResult>
}
```

**为什么必须有这个方法**（写进注释）：`readText` 是行窗口 API（默认 2000 行、`maxBytes` 是对窗口的字节上限），
拿它做「读全文 → 替换 → 写回」会在文件超过窗口时把窗口外的内容整段丢掉，
而且**不会有任何报错**。因此整文件替换走独立的入口，语义是"要么给全文，要么明确拒绝"。

**`readWholeText` 还必须复用二进制的 NUL 探测**（`file-port.ts` 的 `hasNulByte` / `BINARY_MESSAGE`，
与 `readText` 同款）：命中 NUL 即**抛错**（文案「这是二进制文件，无法按文本编辑」）。
不堵这条的后果很具体：一个 1 MiB 以内的 `.png` / `.exe` / 压缩包只要字节里恰好出现一段
能被当成 `oldString` 的序列，就会以 UTF-8 原文写回 → **静默损坏且不报错**。

### 2. `edit.ts`：工具与守卫契约

```ts
/** 会话级「读过哪些文件」的守卫（docs/06 §11.6）。未注入时不做拦截（供直接调用工具的单测使用） */
export interface ReadTracker {
  has(sessionId: string, absolutePath: string): boolean
  mark(sessionId: string, absolutePath: string): void
  /** `write_file` 整篇覆盖后必须清掉：否则模型拿着"读过"的标记去 edit，套用的是过期基线 */
  clear(sessionId: string, absolutePath: string): void
}

export interface EditToolOptions {
  files: FilePort
  /** `read_file` 读完后标记，`edit_file` 据此放行 */
  readTracker?: ReadTracker
  /** 单文件上限，缺省 `MAX_EDIT_BYTES` */
  maxEditBytes?: number
}

export function createEditTool(options: EditToolOptions): ToolDefinition
```

工具定义：`name: 'edit_file'`，`sensitivity: 'confirm'`（与 `write_file` 同族，
每一次调用都要过 `confirmTool` 钩子），参数：

```ts
{
  path: { type: 'string', description: '要修改的文件路径（必须先用 read_file 读过；结果里回带解析后的绝对路径）' },
  oldString: { type: 'string', description: '要被替换的原文，必须与 read_file 输出**去掉行号前缀后**的内容逐字一致，且在本文件内唯一' },
  newString: { type: 'string', description: '替换成的新文本；传空串表示删除该片段' },
  replaceAll: { type: 'boolean', description: 'oldString 在文件里出现多处时，必须显式传 true 才会全部替换；缺省只允许唯一命中' },
}
required: ['path', 'oldString', 'newString']，additionalProperties: false
```

执行顺序（**严格按此顺序，任何一步失败都立即返回 `isError` 且不写盘**）：

1. 参数校验：`path` 非空字符串；`oldString` / `newString` 是字符串（`newString` 允许空串）；
   `oldString` 为空串 → `isError`（「`oldString` 不能为空：空串会在任意位置匹配」）；
   `oldString === newString` → `isError`（「新旧内容相同，无需改动」）；
   `replaceAll` 非布尔真值就当 `false`。
2. `files.readWholeText(path, maxEditBytes)`；`refused === true` → `isError`，
   文案写清「文件超过 `MAX_EDIT_BYTES`（1 MiB）无法整体替换，请改用 `run_command` 或分块 `write_file`」。
3. **读前守卫**：`readTracker !== undefined && !readTracker.has(ctx.sessionId, result.absolutePath)`
   → `isError`，文案「修改前必须先用 `read_file` 读过 <绝对路径>」。
   **以端口回带的 `absolutePath` 为键**（不是模型传入的原始串），防 `a/../b` 之类绕过。
4. **孤立回车检测**：`/\r(?!\n)/.test(text)` 为真 → `isError`，
   文案「文件含孤立的回车符（旧 Mac 行尾），为避免写坏已放弃改动」。
4.5. **混合行尾检测**（**漏了这条会整文件重写行尾**）：
   `text.includes('\r\n') && /\n/.test(text.replace(/\r\n/g, ''))` 为真（即同时含 CRLF 与 LF）
   → `isError`，文案「文件行尾不一致（同时含 CRLF 与 LF 行），为避免把整个文件的行尾改掉，
   已放弃改动；请先统一行尾」。
   为什么必须拒绝："把全文归一成 LF 再按 `usesCrlf` 还原"这套做法在**混合行尾**文件上
   会把所有 LF 行也改成 CRLF——**整个文件每一行的行尾都被改写**，
   `git diff` 全文变色、用户的 stash 全部冲突。这是本步声明的「对文件其余部分逐字节不变」承诺的反面。
5. **行尾归一**：`usesCrlf = text.includes('\r\n')`；
   `norm(s) = s.replace(/\r\n/g, '\n')`，对文件内容与 `oldString` / `newString` 都归一。
6. **计数与替换**（在归一后的文本上做，用 `split` / `indexOf`，**不要用正则**——`oldString` 里的元字符必须当字面量）：
   `count = fileNorm.split(oldNorm).length - 1`。
   - `count === 0` → `isError`：文案含「未找到 `oldString`」，
     并提示两句排查方向：「请用 `read_file` 确认原文（注意 `oldString` **不要**带 `N: ` 行号前缀）」、
     「比对已按 LF 归一，行尾差异不是原因」。
   - `count > 1 && replaceAll !== true` → `isError`：文案含**出现次数**，
     并要求「扩大 `oldString` 的上下文使其唯一，或显式传 `replaceAll: true`」。
   - 其余 → 替换（`replaceAll` 用 `split/join`，否则用 `indexOf + slice` 只换第一处）。
7. **行尾还原**：`usesCrlf ? replaced.replace(/\n/g, '\r\n') : replaced`。
8. `files.writeText(path, out, 'overwrite')`（复用既有原子写）。
   写盘抛错 → `isError`，文案含原因；**不要让异常冒泡进工具循环**。
9. 成功后**不要**清除守卫标记（模型刚主动改过它，知道当前内容）。
   但 `write_file` 成功路径**必须**调 `readTracker.clear(ctx.sessionId, result.absolutePath)`
   （`files.ts` 的 `createWriteFileTool` 里加一行）——否则「读过 → 被 `write_file` 整篇覆盖 →
   `edit_file` 拿着过期内容改」会静默套用错误基线。`append` 模式同样清除
   （内容已变，旧基线不再可信）。

结果文本与 `summary`：

```
已修改：<绝对路径>（替换 <n> 处，共 <bytes> 字节）
```

`summary` 用 `替换 <n> 处`。`description` 按 §20 措辞规范写，必须包含：
「改前必须先用 `read_file` 读过」「`oldString` 要带足上下文保证唯一」「要全局改名用 `replaceAll`」
「**不要**在 `oldString` 里带上 `read_file` 的行号前缀」这四条。

### 3. `read_file` 打完标记

在 `files.ts` 的 `createReadFileTool` 里，成功读出内容后调用
`options.readTracker?.mark(ctx.sessionId, result.absolutePath)`。
`createFileTools` 的 `FileToolOptions` 增加可选 `readTracker?: ReadTracker`
（`ReadTracker` 类型定义在 `edit.ts`，`files.ts` 从 `./edit.js` 导入 `type`——
注意不能形成运行时循环依赖：只 `import type`）。

### 4. 装配层：会话级守卫（`apps/desktop/src/main/tools/index.ts` + `main/index.ts`）

- 在 `registerComputerTools` 的**闭包里**（`sync()` 之外）建一次守卫，这样 `settings:changed` 触发的
  `sync()` 重建不会把"已读过的文件"清空：

```ts
const MAX_TRACKED_SESSIONS = 16
const readFiles = new Map<string, Set<string>>()
const readTracker: ReadTracker = {
  has: (sessionId, absolutePath) => readFiles.get(sessionId)?.has(absolutePath) === true,
  mark: (sessionId, absolutePath) => {
    const set = readFiles.get(sessionId) ?? new Set<string>()
    set.add(absolutePath)
    readFiles.set(sessionId, set)
    // 只保留最近 MAX_TRACKED_SESSIONS 个会话（Map 的插入序天然是 LRU 近似），防无界增长
    while (readFiles.size > MAX_TRACKED_SESSIONS) {
      const oldest = readFiles.keys().next().value
      if (oldest === undefined) break
      readFiles.delete(oldest)
    }
  },
}
```

- 把 `readTracker` 同时传给 `createFileTools({...})` 与 `createEditTool({ files, readTracker })`，
  在 `files.enabled === true` 分支里注册（`edit_file` 与 `read_file` / `write_file` / `list_dir` 同开关）。
- `createFileTools` 仍只产 4 个工具（保持它"恰好 4 个"的契约与既有单测不变），
  `edit_file` 由 `createEditTool` 单独产出，装配层把两者拼起来注册。
- `registerComputerTools` 的 `ComputerToolsDeps` 增加 `readTracker` 依赖，由 `apps/desktop/src/main/index.ts`
  构造后传入（不要在这里 new——保证"进程内只有一份"）。

### 5. 导出

`packages/agent-core/src/index.ts` 追加 `createEditTool`、`MAX_EDIT_BYTES`、
类型 `ReadTracker` / `EditToolOptions` / `ReadWholeTextResult`。

### 6. 文档：如实披露「不可撤销」

在本步同时更新两处（**这是安全披露，不是可选项**）：

- `docs/06 §11.6` 补一句已知边界：`edit_file` **没有备份、没有撤销**——
  原子写只保证"写盘过程不会写坏"，**不保证改动内容可回滚**；改错了只能靠用户自己恢复
  （`git checkout` / 备份 / 编辑历史）。同时写明原子写与「孤立 `\r` 拒绝」这两条**不是**回滚机制。
- `docs/11-privacy.md` 的权限表补 `edit_file` 一行（写文件、`sensitivity: confirm`、逐次确认、
  不可撤销），与 `write_file` 并列。

## 验收标准

- [ ] `pnpm build:packages && pnpm typecheck` → exit 0
      （**必须先 `build:packages`**：`@aurora/agent-core` 的 `types` 指向 `dist/index.d.ts`
      ——`packages/agent-core/package.json:8`，不重建的话下游会对着旧类型报「no exported member `createEditTool`」，
      而且 `createNodeFilePort(): FilePort` 返回对象字面量多出方法会触发 excess property check 直接编译失败）
- [ ] `pnpm vitest run packages/agent-core/src/tools/edit.test.ts` 全绿（用假 `FilePort`，不碰磁盘），
      下列每一条都能在输出里指认：
  - [ ] 唯一命中 → 成功，写回内容与预期**逐字节相同**
  - [ ] `oldString` 未找到 → `isError`，且**断言假端口的 `writeText` 未被调用**
  - [ ] 命中 3 处且未传 `replaceAll` → `isError`，文案含 `3`，且**未写盘**
  - [ ] `replaceAll: true` → 3 处全替换，文案回报 `3 处`
  - [ ] `oldString` 空串 → `isError`，未写盘
  - [ ] `oldString === newString` → `isError`，未写盘
  - [ ] `newString` 空串 → 成功删除该片段（这是**允许**的，与空 `oldString` 不同）
  - [ ] **CRLF 保真**：原始 `"line1\r\nline2\r\n"`，`oldString: 'line2'`（LF 形态）→ 写回
        `"line1\r\nLINE2\r\n"`；断言结果中**不存在**不跟在 `\r` 后面的 `\n`
  - [ ] **LF 保真**：原始 `"a\nb\n"` → 写回结果中**不含任何 `\r`**
  - [ ] 孤立 `\r`（`"a\rb\n"`）→ `isError`，未写盘
  - [ ] **混合行尾**（`"a\r\nb\nc\r\n"`）→ `isError` 且**未写盘**
        （这条防的是"整个文件每一行的行尾都被改写"，是本步最容易漏的损坏路径）
  - [ ] **二进制**（含 NUL 的伪文件）→ `isError` 且 `writeText` **未被调用**
  - [ ] `write_file` 成功后守卫标记被 `clear`（用假守卫断言 `clear` 被调用）
  - [ ] 多行 `oldString` 命中 → 成功（证明跨行替换可用）
  - [ ] `refused: true`（超 `maxEditBytes`）→ `isError`，未写盘
  - [ ] 正则元字符按字面处理：文件 `"a.b\naxb\n"`，`oldString: 'a.b'` → 只替换 `a.b`，
        断言 `axb` 未被改动
  - [ ] 读前守卫：未标记 → `isError` 且未写盘；`mark` 后 → 成功；**未注入守卫 → 不拦截**
  - [ ] 守卫按 `sessionId` 隔离：会话 A 标记过，会话 B 仍被拒
  - [ ] 守卫以**绝对路径**为键：模型传相对路径但端口回带绝对路径时，标记与判定都对得上
  - [ ] `read_file` 成功后确实调用了 `mark`（用假守卫断言）
- [ ] `pnpm vitest run apps/desktop/src/main/tools/file-port.test.ts` 全绿，且新增一个
      **真实磁盘往返**用例：用真实 `createNodeFilePort()` 写一个 CRLF 文件 →
      `readWholeText` 读 → `createEditTool`（注入守卫，先 `mark`）替换一行 →
      读回磁盘原始字节，断言「除目标行外逐字节不变，且行尾仍是 CRLF」
- [ ] `pnpm vitest run apps/desktop/src/main/tools/index.test.ts` 全绿，
      含 `agent.tools.files.enabled = false` 时 `edit_file` **不在**注册表、
      `true` 时在、总开关 `agent.tools.enabled = false` 时不在
- [ ] `grep -n "sensitivity: 'confirm'" packages/agent-core/src/tools/edit.ts` 命中
- [ ] `grep -n "readWholeText" packages/agent-core/src/tools/files.ts packages/agent-core/src/tools/edit.ts apps/desktop/src/main/tools/file-port.ts` **三处都命中**
      （证明没有走行窗口 API）
- [ ] `pnpm test` 全绿；`pnpm lint` 与 `pnpm exec prettier --check "**/*.{ts,md,json}"` 通过
- [ ] 端到端：`$env:AURORA_SMOKE='1'; pnpm dev` 的 `AURORA_SMOKE_RESULT` 里 `edit_file` 出现在
      已注册工具清单中、敏感级为 `confirm`

## 交接

- **`ReadTracker` 契约**由 step 5 无关，但 `registerComputerTools` 的依赖清单已扩了
  `readTracker`——step 5 往同一处加 `confirmTool` 依赖时不要把它挤掉。
- **`MAX_EDIT_BYTES` / `ReadWholeTextResult.refused`** 是 `docs/06 §11.6` 的实现对应物；
  若实现中发现 1 MiB 这个取值不合理，就地改 `docs/06 §11.6` 并把原因写进执行记录。
- step 6 会给 `ToolRegistry.toLlmTools()` 加排序；届时 `edit_file` 也会被排序，
  **本步不要**自己给工具表排序。
- `createFileTools` 仍然只产 4 个工具、`edit_file` 单独产出——step 6 核对工具清单数量时按 8 个算
  （`run_command` / `read_file` / `write_file` / `edit_file` / `list_dir` / `open_path` / `grep` / `glob`）。
