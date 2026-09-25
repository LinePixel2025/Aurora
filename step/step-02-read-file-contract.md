# Step 02 — `read_file` 契约对齐：行号前缀 + `offset` / `limit` + 工具规范条目

- Task: opencode-parity
- Step: 2 / 7
- Status: done
- Depends on: step 1（`docs/06 §20` 的 read 契约与 §5 的工具规范清单已定稿）
- Produces: `read_file` 的新输出契约（`<行号>: <内容>` + `offset` / `limit`）与可读大文件后半段的能力；`buildToolGuidance` 的 edit/grep/glob 条件条目
- Phase: 核心链路
- Writes: `packages/agent-core/src/tools/files.ts`、`packages/agent-core/src/tools/files.test.ts`、`packages/agent-core/src/context/systemPrompt.ts`、`packages/agent-core/src/context/systemPrompt.test.ts`、`apps/desktop/src/main/tools/file-port.ts`、`apps/desktop/src/main/tools/file-port.test.ts`
- Risk: 这是**唯一改动既有工具输出格式**的步骤，`read_file` 的结果文本会变（多出行号前缀），
  任何对它做字符串断言的测试/smoke 探针都会红。退路：先 `grep -rn "已按 maxBytes 截断\|读取 \\(result.bytes\\) 字节" apps packages` 把所有断言点列出来一次改完。
  第二个风险是 `FilePort.readText` 的签名变更——所有实现与测试桩都会被编译器揪出来，**逐个改，不要用重载或可选参数糊过去**（那会让 `edit_file` 在 step 4 拿到截断内容，造成静默改坏文件）。

## 目标

模型能**读出大文件的任意一段**（现在只能读开头），且读到的内容带行号，
与 step 3 的 `grep` 结果、step 4 的 `edit_file` 的 `oldString` 引用方式对齐——
这是 opencode `read.txt` / `edit.txt` 契约落地的前提。
同时把「先 grep / glob 定位、改前先读」写进按工具条件生成的工具使用规范。

## 输入

- `packages/agent-core/src/tools/files.ts`：`FilePort`（`:22`）、`createFileTools`（`:64`）、
  `createReadFileTool`（`:115`）、`resolveClamped`（`:321`）、`MIN_READ_BYTES`（`:16`）
- `apps/desktop/src/main/tools/file-port.ts`：`readText` 实现、`readHead()`（只读头部）、
  `hasNulByte()` 二进制探测、`withPath()` 错误包装
- `apps/desktop/src/main/tools/file-port.test.ts`（148 行，真实临时目录）
- `packages/agent-core/src/tools/files.test.ts:42` 起的本地 `FilePort` 测试桩（改签名后这里必须同步）
- `packages/agent-core/src/context/systemPrompt.ts`：`buildToolGuidance`（`:119`）与它现有的
  四个条件条目（`todo_write` / `task` / `run_command` / `set_setting`）
- `docs/06 §20` 的 read 契约行（step 1 落盘）：行号前缀格式、1 起始的 `offset`、默认 2000 行、
  单行超 2000 字符截断、大文件用 `grep` 定位
- `docs/06 §5` 的工具规范条目清单（step 1 已加 edit/grep/glob 三条要求）

## 操作

### 1. 端口契约：`FilePort.readText` 改为「行窗口」读

`packages/agent-core/src/tools/files.ts` 里把 `readText` 换成：

```ts
/** 读取行窗口的上限常量（内核持有，不进配置） */
export const DEFAULT_READ_LINES = 2_000
export const MAX_READ_LINES = 5_000
/** 单行展示上限：超过即截断（对齐 opencode read.txt 的 2000 字符） */
export const MAX_LINE_CHARS = 2_000
/** 端口单次可扫描的文件上限：超过即拒绝并提示改用 grep / run_command */
export const MAX_READ_SCAN_BYTES = 16 * 1024 * 1024

export interface ReadTextOptions {
  /** 起始行号（**1 起始**）；缺省 1。小于 1 一律按 1 处理 */
  offsetLines?: number
  /** 最多返回多少行；缺省 `DEFAULT_READ_LINES`，上限 `MAX_READ_LINES` */
  limitLines?: number
  /** 返回窗口的字节上限（对切片后的窗口生效，不再是从文件头截断） */
  maxBytes: number
}

export interface ReadLine {
  /** 行号（1 起始，相对文件开头，不随 offset 改变） */
  number: number
  text: string
}

export interface ReadTextResult {
  absolutePath: string
  /** 本次返回的行窗口（已按 offset / limit / maxBytes 裁剪） */
  lines: ReadLine[]
  /** 文件总行数；命中扫描上限时为 undefined（无法准确统计） */
  totalLines?: number
  /** 后面是否还有未返回的内容（被 limit / maxBytes / 扫描上限截断） */
  truncated: boolean
  /** 是否因文件超过 `MAX_READ_SCAN_BYTES` 而没读完（此时 `totalLines` 为 undefined） */
  scanLimitHit?: boolean
  /** 本次返回窗口的字节数 */
  bytes: number
  /** 文件总字节数 */
  totalBytes: number
}

export interface FilePort {
  readText(path: string, options: ReadTextOptions): Promise<ReadTextResult>
  // writeText / list 保持不变
}
```

语义要求（逐条写进注释）：

- `offsetLines` 与 `limitLines` 都做整数化与钳制（非数字 / NaN / 负数按缺省处理，
  与 `resolveClamped` 的既有口径一致）；`offsetLines < 1` 当 1。
- **窗口里至少返回一行**：即使窗口第一行单独就超过 `maxBytes`，也要把它带回来，
  否则模型会拿到空结果且无法推进。这一点必须写注释。
- `totalLines` 与 `totalBytes` 用于让模型知道「文件有多长、这次看到哪儿」。
- 文件超过 `MAX_READ_SCAN_BYTES` 时：**不要**静默只读前 16 MiB 就报 `totalLines`——
  置 `scanLimitHit: true`、`totalLines: undefined`、`truncated: true`，
  内核据此在结果里提示「文件过大，只解析了前 16 MiB，请用 `grep` 定位或 `run_command` 处理」。
- 既有的二进制拒绝（含 NUL 即抛错）与「目录要改用 `list_dir`」两条行为**保持不变**。

### 2. 内核工具：`read_file` 重写

参数 Schema 改为：

```ts
{
  path: string,                                  // 必填（不变）
  offset: { type: 'integer', minimum: 1 },        // 起始行号（1 起始），缺省 1
  limit:  { type: 'integer', minimum: 1, maximum: MAX_READ_LINES },  // 行数，缺省 2000
  maxBytes: { type: 'integer', minimum: MIN_READ_BYTES, maximum: maximum },  // 保留既有语义
}
```

结果文本（**这是新契约**，逐字按此实现，行号前缀是 step 4 的 `oldString` 依据）：

```
文件：<绝对路径>（共 <totalLines> 行 / <totalBytes> 字节；本次显示第 <from>–<to> 行）

1: 第一行内容
2: 第二行内容
…

…（还有 <n> 行未显示，用 offset 继续读）…
```

- `totalLines` 为 `undefined` 时头部改写成
  `文件：<绝对路径>（<totalBytes> 字节；文件超过 16 MiB 只解析了开头，建议用 grep 定位）`。
- 单行超过 `MAX_LINE_CHARS` 时该行渲染为
  `12: <前 2000 字符>…（本行共 <n> 字符已截断）…`。
- 窗口为空（`offset` 超出总行数）时结果含
  `offset 超出文件末尾（共 <totalLines> 行）` 并置 `isError: false`（不是错误，是空结果）。
- `summary` 保持短：`读取第 12–31 行 / 共 500 行`。
- **description 按 §20 的措辞规范重写**（中文、先说做什么再说怎么用）：
  说明「返回内容每行带 `<行号>: ` 前缀；默认返回开头 2000 行；用 `offset` 继续读后面；
  单行超 2000 字符截断；不知道路径先用 `glob`，大文件用 `grep` 定位；
  二进制文件读不了」。
- `maxBytes` 的默认值仍是装配层注入的 `agent.tools.files.maxReadBytes`（不改配置语义）。

### 3. 主进程端口实现

`apps/desktop/src/main/tools/file-port.ts` 的 `readText` 按新契约重写：

- 先 `stat` 拿 `totalBytes`；超过 `MAX_READ_SCAN_BYTES` 时按 `scanLimitHit` 语义处理
  （读前 16 MiB 用于定位行，但不给 `totalLines`）。
- 定位 `offsetLines`：在内存文本上按 `\n` 切分。**行切分必须处理 CRLF**：
  `text.split('\n')` 后逐行去掉尾部 `\r`（这样 `1: 内容` 里不会出现看不见的回车，
  也让模型复制出的 `oldString` 是干净的），但**不要**修改文件本身。
- 末行无换行符时不要凭空造一个空行（`"a\nb"` 切成 `['a','b']` 是 2 行；
  `"a\nb\n"` 也应是 2 行而不是 3 行）——这条要有单测。
- 窗口累积：从 `offsetLines` 起逐行累加，直到行数达 `limitLines` 或字节数超 `maxBytes`
  （含第一行强制保留的规则）。
- 复用既有的 `readHead` 思路（不要再整体 `readFile` 一个 16 MiB 上限以外的文件）；
  文件在 16 MiB 以内时直接整体读入即可（单用户桌面、且工具是顺序执行的）。
- 错误包装继续走 `withPath`，错误信息必须含绝对路径。

### 4. `buildToolGuidance` 扩充

`packages/agent-core/src/context/systemPrompt.ts` 的 `buildToolGuidance` 追加三条条件条目
（与既有四个条目同款写法，**只在对应工具注册时出现**）：

- `has('edit_file')` → 「改文件前必须先用 `read_file` 读过它（否则 `edit_file` 会拒绝）；
  `oldString` 要带足上下文保证在文件里唯一，命中多处会被拒绝；要全局改名用 `replaceAll`。」
- `has('grep')` 或 `has('glob')` → 「找代码位置先用 `grep` 搜内容、`glob` 找文件名，
  不要用 `list_dir` 逐层翻目录；两者都会自动跳过 node_modules / .git 等目录。」
- `has('grep')` → 「`grep` 返回的是路径与行号，拿到位置后再用 `read_file` 的 `offset` 读那一段。」

同时把 §5 已定稿的「小节顺序」在代码注释里同步（`systemPrompt.ts` 顶部的注释块目前写的是旧顺序，
本步只更新注释与 `buildToolGuidance`；**真正的小节重排属于 step 6**，本步不要动 `buildSystemPrompt` 的渲染顺序）。

## 验收标准

- [ ] `pnpm build:packages && pnpm typecheck` → exit 0（**必须先建包**：`FilePort` 的签名变了，
      而 `@aurora/agent-core` 的 `types` 指向 `dist/`——见 `packages/agent-core/package.json:8`，
      不重建的话下游 typecheck 会对着旧类型报错；`readText` 签名的所有实现与测试桩都会被编译器揪出来）
- [ ] `pnpm vitest run packages/agent-core/src/tools/files.test.ts` 全绿（**内核侧断言**：用假 `FilePort`），
      下列每一条都能在输出里指认：
  - [ ] 行号渲染：内容 `"foo\nbar\n"` → 结果文本含 `1: foo` 与 `2: bar`
  - [ ] `offset: 3, limit: 2` → 结果文本含 `本次显示第 3–4 行`（头部口径）
  - [ ] `offset` 超出末尾 → 结果含「offset 超出文件末尾」且 `isError` 不是 `true`
  - [ ] 单行超 `MAX_LINE_CHARS` → 该行带「本行共 N 字符已截断」标记
  - [ ] `offset` / `limit` 参数非法（非数字 / 负数 / 超上限）时被钳制，**端口收到的仍是合法值**
  - [ ] 二进制 / 目录 → `isError`（端口抛错被折成 `isError`，不让异常冒泡）
- [ ] `pnpm vitest run apps/desktop/src/main/tools/file-port.test.ts` 全绿（**端口侧断言**：真实临时目录），
      下列每一条都能在输出里指认：
  - [ ] CRLF 文件：返回的 `lines[].text` **不含 `\r`**，行号为 `1` / `2`
  - [ ] 末行无换行：`"a\nb"` → `totalLines === 2`（**不是 3**）
  - [ ] 空文件：`totalLines === 0`、`lines` 为空、不报错
  - [ ] **大文件后半段可读**（本步的核心目标，也是「只能读开头」缺口的关闭证据）：
        构造 5000 行文件，`offsetLines: 4000, limitLines: 10` → 返回第 4000–4009 行且内容正确
  - [ ] `maxBytes` 很小（如 1024）时窗口第一行仍被保留、`truncated === true`
  - [ ] 超过 `MAX_READ_SCAN_BYTES` 的文件 → `scanLimitHit === true`、`totalLines === undefined`、
        `truncated === true`（**不允许**静默把 16 MiB 当成全文并报一个假的 `totalLines`）
- [ ] `pnpm vitest run packages/agent-core/src/context/systemPrompt.test.ts` 全绿，
      且新用例断言：只注册 `todo_write` 时 `toolGuidance` **不含** `edit_file` 字样；
      注册了 `edit_file` / `grep` / `glob` 时三条新条目都出现
- [ ] 仓库内没有对旧输出格式的残留断言：
      `grep -rn "已按 maxBytes 截断" apps packages --include=*.ts` **无命中**
- [ ] 工具规范新条目的证据是**单测断言**（上面那条用例），不要用 `grep` 命中当证据
- [ ] `pnpm test` 全绿（改坏既有断言的都属本步范围内，要改断言而不是删用例）
- [ ] `pnpm lint` 与 `pnpm exec prettier --check "**/*.{ts,md,json}"` 通过

## 交接

- **新的「行窗口」端口形状**是 step 3（`grep` 结果要对齐行号口径）与 step 4
  （`edit_file` 的**整文件读**必须绕开这个窗口读——见 `docs/06 §11.6` 的告警）共同依赖的接口，
  字段名不要改。
- **行号前缀格式 `N: 内容`** 是 step 4 的工具 description 与 §20 契约的基础：`edit_file` 的
  `oldString` 是**去掉 `N: ` 前缀之后**的原文。
- 内核常量 `DEFAULT_READ_LINES` / `MAX_READ_LINES` / `MAX_LINE_CHARS` / `MAX_READ_SCAN_BYTES`
  从 `files.ts` 导出，step 3 / 4 的 description 与文档若引用这些数字，**引用常量而不是再写一遍字面量**。
- 本步**不动** `buildSystemPrompt` 的小节渲染顺序（那是 step 6）。

## 执行记录

执行时间：2026-09-26（会话内连续执行）

### 分片与结果

主代理先**亲自定稿 `FilePort` 的共享接口**（`readText(path, options)` 与 `ReadTextResult` / `ReadLine`
—— step 3 / 4 都依赖它，两个子代理分头写会漂移），再派三个写范围互不重叠的分片并行：

| 分片 | 负责文件 | 结果 |
| --- | --- | --- |
| 主进程端口 | `apps/desktop/src/main/tools/file-port.ts` + `.test.ts` | 行窗口实现（CRLF 去 `\r`、末行不补空行、首行强制保留、扫描上限三态）。**21 用例**。新增用例可指认：`大文件后半段可读：5000 行文件用 offsetLines=4000 / limitLines=10 取第 4000–4009 行`、`末行没有换行符时不凭空补空行："a\nb" → totalLines 2（不是 3）`、`CRLF 文件：lines[].text 不含 \r，行号为 1 / 2`、`超过上限的文件：scanLimitHit 为 true、totalLines 为 undefined、truncated 为 true` |
| 内核单测 | `packages/agent-core/src/tools/files.test.ts` | 桩改新签名 + 12 条新用例（**20 → 32**）。可指认：`把行窗口渲染成 <行号>: 内容 行…`、`offset: 3 / limit: 2 时头部显示 本次显示第 3–4 行…`、`offset 超出文件末尾时回带空窗口并说明，不置 isError`、`单行超过 MAX_LINE_CHARS 时截断，并在该行标注原长`、`offset 非数字 / 小于 1 时钳到 1，端口收到的仍是合法值`、`limit 非数字回落缺省值、负数钳到 1、超上限钳到 MAX_READ_LINES`、`端口对二进制文件抛错时折成 isError 并回带原因，异常不冒泡`、`description 写清行号前缀、offset 续读与 glob / grep 定位（§20 契约）` |
| 工具规范 | `packages/agent-core/src/context/systemPrompt.ts` + `.test.ts` | 三条条件条目 + 顶部注释块更新（**渲染顺序一行未动，那是 step 6**）。**20 → 25 用例**，含负例 `只注册 todo_write 时不出现 edit_file / grep / glob 的规范` |
| 主代理 | `apps/desktop/src/main/tools/index.test.ts` | 假的 `FilePort` 桩改成 `ReadTextResult` 形状（**计划未把它列进 `Writes`，但改签名后它必然编译失败**，属必要连带改动） |

### 验收命令与真实结果（主代理复跑）

| 命令 | 结果 |
| --- | --- |
| `pnpm build:packages` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm vitest run packages/agent-core/src/tools/files.test.ts apps/desktop/src/main/tools/file-port.test.ts packages/agent-core/src/context/systemPrompt.test.ts` | **3 文件 / 78 用例全绿**（32 + 21 + 25） |
| `pnpm test` | **66 文件 / 1122 用例全绿**（较 step 1 的 1094 增至 1122） |
| `pnpm lint` | exit 0 |
| `pnpm exec prettier --check "**/*.{ts,md,json}"` | All matched files use Prettier code style! |
| `grep -rn "已按 maxBytes 截断" apps packages --include=*.ts` | 无命中 ✅ |

### 端到端证据（主代理自建的临时集成用例，跑完即删）

真实 `createNodeFilePort()` + 真实 `createFileTools()`，对 5000 行 **CRLF** 文件读 `offset: 4000, limit: 3`：

```
文件：C:\...\big.txt（共 5000 行 / 103891 字节；本次显示第 4000–4002 行）

4000: 第4000行的内容
4001: 第4001行的内容
4002: 第4002行的内容

…（还有 998 行未显示，用 offset 继续读）…
```

`summary: 读取第 4000–4002 行 / 共 5000 行`、`isError` 为 `undefined`，且结果文本**不含 `\r`**。
这是「只能读开头」缺口的关闭证据。

### git 提交

| SHA | 说明 |
| --- | --- |
| `8aeb2cf` | `feat(tools): read_file 改「行窗口」契约（行号前缀 + offset/limit），关闭只能读开头的缺口` |
| `02b078e` | `feat(agent-core): 工具使用规范补 edit_file / grep / glob 三条条件条目` |

### 与计划的偏差

1. **`apps/desktop/src/main/tools/index.test.ts` 是本步的必要连带改动**（计划 `Writes` 里没有它）：
   `FilePort.readText` 签名变了，该文件里的假端口桩必然编译失败。
2. **`offset` / `limit` 用「宽松钳制」而不是 `resolveClamped` 的严格口径**：计划「操作 1」写的是
   「非数字 / NaN / 负数**按缺省处理**」，`resolveClamped` 对非数字返回 `undefined`（让调用方报错），
   两者不一致。按验收标准那条「参数非法时**被钳制**，端口收到的仍是合法值」取了宽松口径，
   并新写 `resolveLineParam` 实现；`maxBytes` 保持严格（它关系着"会不会把上下文刷爆"）。
   口径已写进该助手的 JSDoc。
3. **`node_modules` / `.git` 的反引号按 `docs/06 §5`（SSOT）两者都加**，
   与 step-02「操作 4」原文（只给 `.git` 加）不同。

### 已登记、未修

- `>MAX_READ_SCAN_BYTES` 的文件里，前 16 MiB 的**最后一行可能是被切断的半行**（行号仍正确）。
  按规格「只读前 16 MiB 用于定位行」保留，未额外丢弃；`scanLimitHit: true` 已告知调用方只解析了开头。
- `read_file` 单行窗口的 `summary` 文案是 `读取第 12–12 行 / 共 31 行`（同数字重复），纯文案瑕疵。
- `maxBytes` 未写进 `read_file` 的 `description`（参数 Schema 里有、运行时校验也有）。

### 对后续步骤的影响

- `ReadTextResult.lines[].number` 与 `SearchMatch.line`（step 3）口径一致，都是 **1 起始、相对文件开头**。
- 行号前缀格式 `N: 内容` 是 step 4 的 `edit_file` 的 `oldString` 基础（引用时要**去掉**前缀）。
- `DEFAULT_READ_LINES` / `MAX_READ_LINES` / `MAX_LINE_CHARS` / `MAX_READ_SCAN_BYTES` 已从
  `files.ts` 导出并被 `file-port.ts` 引用（**引用常量，不重抄字面量**）。
