# Step 03 — 搜索层端到端：glob 模式编译器 + `grep` / `glob` 两个工具 + 主进程 walker

- Task: opencode-parity
- Step: 3 / 7
- Status: done
- Depends on: step 2（`FilePort` 的行窗口形状与 `MAX_READ_SCAN_BYTES` 等常量已就位）
- Produces: `packages/agent-core/src/tools/globPattern.ts`（可复用的 glob 编译器，step 5 也用它）、
  `packages/agent-core/src/tools/search.ts`（`grep` / `glob` 两个工具 + 上限常量）、
  `FilePort` 的 `findFiles` / `searchText` 与主进程实现、`registerComputerTools` 的 search 分派
- Phase: 核心链路
- Writes: `packages/agent-core/src/tools/globPattern.ts`、`packages/agent-core/src/tools/globPattern.test.ts`、`packages/agent-core/src/tools/search.ts`、`packages/agent-core/src/tools/search.test.ts`、`packages/agent-core/src/tools/files.ts`（仅追加 `FilePort` 方法声明与常量）、`packages/agent-core/src/tools/files.test.ts`（同步测试桩）、`packages/agent-core/src/index.ts`、`apps/desktop/src/main/tools/file-port.ts`、`apps/desktop/src/main/tools/file-port.test.ts`、`apps/desktop/src/main/tools/index.ts`、`apps/desktop/src/main/tools/index.test.ts`、`apps/desktop/src/renderer/settings/pages/AgentPage.vue`、`apps/desktop/src/renderer/shared/toolIcons.ts`（给 `grep` / `glob` 加语义图标）、`apps/desktop/src/main/capture.ts`、`docs/07-ui-spec.md`（§5.3 探针清单与计数）
- Risk: 三个具体风险。① **符号链接环**：不跳过 symlink 的递归遍历会死循环——walker 必须直接跳过所有 `dirent.isSymbolicLink()` 条目。② **Windows 下建 symlink 需要管理员或开发者模式**，测环的用例可能因 `EPERM` 无法构造——用"先在 `beforeAll` 里尝试建，失败就 `skip`"的写法，不要让测试变红。③ **无预算的遍历**会在巨型目录上卡死主进程——文件数与字节数双预算必须有，且超预算时返回已收集结果（不是抛错）。
- Sources: `packages/opencode/src/tool/grep.txt`、`glob.txt`（仓库 `sst/opencode`，分支 `dev`，commit `adee738`，访问日期 2026-09-26）

## 目标

模型能按**文件名模式**找文件、按**正则内容**找代码位置，拿到「路径 + 行号」后再用 step 2 的
`read_file` 精确读那一段。这是「从对话助手变成能改代码的 Agent」的第一半。
同时产出一个**可复用、有单测的 glob 编译器**——step 5 的 `run_command` 免确认模式匹配用它。

## 输入

- `packages/agent-core/src/tools/files.ts`：`FilePort` 接口与既有 `list()` 实现约定、
  `DirEntry`、`resolveClamped`（`:321`）、`describeError`（`:363`）
- `apps/desktop/src/main/tools/file-port.ts`：`hasNulByte()` / `NUL_SCAN_BYTES` 二进制探测、
  `withPath()` 错误包装、`readHead()` 的分块读法
- `apps/desktop/src/main/tools/index.ts`：`registerComputerTools` 的 `sync()`——
  目前的写法是「先按 `COMPUTER_TOOL_NAMES` 全量 `unregister`，再按 `agent.tools.*` 的开关重建」，
  本步要在其中插入 search 分派
- `apps/desktop/src/main/tools/index.test.ts`（既有装配器单测，本步要扩）
- `packages/agent-core/src/tools/terminal.ts:39` 的 `TerminalToolOptions`——
  「默认值由装配层注入、内核只做钳制」的既有模式，`grep` / `glob` 的 `defaultRoot` 照此办
- `docs/06 §11.5`（step 1 落盘的搜索层规格：忽略目录、预算、结果格式、不跟随符号链接）

## 操作

### 1. `globPattern.ts`：纯函数 glob 编译器（**step 5 会复用，务必做成通用件**）

```ts
export interface GlobOptions {
  /** true（缺省）：路径模式——`*` 与 `?` 不跨 `/`，输入里的 `\` 归一为 `/`
   *  false：纯文本模式——`*` 匹配任意字符（含空格），`\` 原样保留（供命令串匹配） */
  pathMode?: boolean
  /** 缺省 true（Windows 口径） */
  caseInsensitive?: boolean
}
export const MAX_GLOB_LENGTH = 200
export function compileGlob(pattern: string, options?: GlobOptions): RegExp
export function matchesGlob(pattern: string, value: string, options?: GlobOptions): boolean
/** 非空、长度合法、`{}` 配对——不检查"是否含字面字符"（那是 allow 列表的额外规则，见 step 5） */
export function isValidGlobPattern(pattern: string): boolean
```

转换规则（**顺序敏感，按此实现**）：

1. 先整体转义正则元字符，再把通配符换回；
2. pathMode 下 `**/` → `(?:.*/)?`（**这必须最先处理**，否则 `src/**/*.ts` 会漏掉 `src/a.ts`）；
3. 然后 `**` → `.*`；
4. 再 `*` → pathMode 下 `[^/]*`、文本模式下 `.*`；
5. `?` → pathMode 下 `[^/]`、文本模式下 `.`；
6. `{a,b,c}` → `(?:a|b|c)`，花括号内**不做嵌套**（不支持 `{a,{b,c}}`，文档写明）；
7. 整体 `^...$` **全串锚定**。

匹配前对 `value` 做归一：pathMode 下 `\` → `/`、折叠重复 `/`；
文本模式不做任何归一（命令串里的反斜杠是内容的一部分）。

单测（`globPattern.test.ts`）：

- [ ] `**/*.ts` 命中 `a.ts` 与 `a/b/c.ts`（**零级目录也要命中**）
- [ ] `src/**/*.ts` 命中 `src/a.ts` 与 `src/a/b.ts`
- [ ] `*.{ts,tsx}` 命中 `a.ts` / `a.tsx`，不命中 `a.js`
- [ ] `?` 恰好一个字符：`a?c` 命中 `abc`，不命中 `ac` / `abbc`
- [ ] pathMode 下 `*` **不跨** `/`：`src/*.ts` 不命中 `src/a/b.ts`
- [ ] 大小写不敏感：`GIT*` 命中 `git status`；`caseInsensitive: false` 时不命中
- [ ] 字面元字符被转义：`a.b` 不命中 `axb`（**这条最容易写错**）；`a(1).ts` 原样匹配
- [ ] 文本模式：`git status*` 命中 `git status --short`；全串锚定使 `git *` **不命中** `echo git`
- [ ] 非法输入：空串 / 纯空白 / 超 `MAX_GLOB_LENGTH` → `isValidGlobPattern` 为 false
- [ ] 未配对花括号 → `isValidGlobPattern` 为 false（且 `compileGlob` 不抛异常，按字面处理）

### 2. `FilePort` 追加两个方法

在 `files.ts` 里追加（**不要动 step 2 定下的 `readText` / `writeText` / `list` 签名**）：

```ts
export const DEFAULT_SEARCH_MAX_RESULTS = 200
export const MAX_SEARCH_MAX_RESULTS = 1_000
/** 单文件扫描上限：超过即跳过（不扫大文件，避免一次搜索吃掉整个预算） */
export const MAX_FILE_SCAN_BYTES = 1024 * 1024
/** 命中行的展示上限（超出截断并标记） */
export const MAX_MATCH_LINE_CHARS = 400
/** 遍历预算：文件数与总字节数双重上限，任一触顶即停止并置 budgetExceeded */
export const SEARCH_BUDGET = { maxFiles: 20_000, maxBytes: 64 * 1024 * 1024 } as const
/** 默认忽略的目录名（整目录跳过，含其子树） */
export const DEFAULT_SEARCH_IGNORE = [
  'node_modules', '.git', 'dist', 'out', 'build', '.next', 'coverage', '.turbo',
] as const

export interface FindFilesOptions { root: string; pattern: string; maxResults: number }
export interface FindFilesResult {
  root: string
  /** 相对 root 的路径，**正斜杠分隔**（跨平台一致，便于测试与展示） */
  files: string[]
  truncated: boolean
  scannedFiles: number
  budgetExceeded: boolean
}
export interface SearchTextOptions {
  root: string
  /** 正则源码（内核已验过能编译） */
  pattern: string
  /** 可选的文件名 glob 过滤 */
  include?: string
  maxResults: number
}
export interface SearchMatch { path: string; line: number; text: string }
export interface SearchTextResult {
  root: string
  matches: SearchMatch[]
  truncated: boolean
  scannedFiles: number
  skippedBinary: number
  budgetExceeded: boolean
}
```

`FilePort` 接口加 `findFiles(options): Promise<FindFilesResult>` 与
`searchText(options): Promise<SearchTextResult>`。

**结果顺序必须是确定性的**：遍历时目录名与文件名都按字典序处理，命中行按行号升序，
因此结果天然有序、**不需要最后一次全局排序**（在预算提前中止时也能保证前缀稳定）。写进注释。

### 3. `search.ts`：两个工具

```ts
export interface SearchToolOptions {
  files: FilePort
  /** `agent.tools.search.maxResults`（钳制到 1..MAX_SEARCH_MAX_RESULTS） */
  maxResults: number
  /** 搜索根缺省值（装配层注入：`agent.tools.workspaceDir`，空串时回落用户主目录） */
  defaultRoot: string
}
export function createSearchTools(options: SearchToolOptions): ToolDefinition[]
```

**`grep`**：`sensitivity: 'safe'`，参数
`{ pattern: string（必填，正则源码）, path?: string, include?: string（文件名 glob） }`，
`additionalProperties: false`。

- 参数校验（全部 `isError` 且**不触碰端口**）：`pattern` 非字符串 / 去空白后为空；
  `pattern` 超 200 字符；`new RegExp(pattern)` 抛错（返回「正则不合法：<原因>」）。
  ⚠️ 内核只用 `new RegExp(pattern)` **校验**，真正执行在主进程；**不要**把 RegExp 对象跨端口传
  （端口签名里是 `pattern: string`）。
- 结果渲染（**对齐 opencode 的「路径 + 行号 + 命中行」**，同时贴住 step 2 的行号口径）：

```
搜索根：<绝对路径>（匹配 <n> 处，已扫描 <m> 个文件）

<相对路径>:<行号>: <该行内容>
<相对路径>:<行号>: <该行内容>
```

- 同一行**只记一条**（一行内多次命中不重复出现）。
- 命中行超 `MAX_MATCH_LINE_CHARS` 截断并标 `…（本行超长已截断）…`；
  stdout 用 `\t` 保留缩进无关紧要，但**行首空白要保留**（缩进是定位信息）——
  不要对命中行做 `trim()` 后回填（截断判断可以用 trim 后的长度，输出用原文）。
- 无命中：`未找到匹配「<pattern>」的内容。` 且 `isError: false`（空结果不是错误）。
- `truncated` 时追加一行 `…（结果已达上限 <n> 条，可能还有更多；请缩小 pattern 或 include）…`。
- `budgetExceeded` 时追加 `…（搜索预算已用完，仅扫描了 <m> 个文件，结果可能不完整）…`。
- `skippedBinary > 0` 时加一行 `（已跳过 <k> 个二进制文件）`。
- `description` 按 §20 措辞规范写：说清「正则内容检索」「返回路径与行号」
  「`include` 支持 `*.js` / `*.{ts,tsx}`」「会自动跳过 node_modules / .git 等」
  「**不提供计数功能**，要统计请用 `run_command`」（这一条对应 §20 对照表里对
  opencode「改用 Bash + rg」的**不采纳**结论）。

**`glob`**：`sensitivity: 'safe'`，参数 `{ pattern: string（必填）, path?: string, limit?: number }`。

- 参数校验：`pattern` 空 / 超长 → `isError`；`isValidGlobPattern(pattern)` 为 false → `isError`（含花括号未配对的原因）；
  `limit` 用 `resolveClamped` 钳到 `1..maxResults`（缺省 `maxResults`）。
- 结果：

```
搜索根：<绝对路径>（匹配 <n> 个文件）

<相对路径>
<相对路径>
```

- 无命中：`未找到匹配「<pattern>」的文件。`，`isError: false`。
- `truncated` 时追加 `…（已达上限 <n> 个，可能还有更多）…`。
- `description` 写清模式语法（`**/*.js`、`src/**/*.ts`、`{a,b}`）、
  「只返回文件路径，不返回内容」「找内容请用 `grep`」。

两个工具都用 `defaultRoot` 作 `path` 缺省值；`path` 传入时**原样交给端口解析**
（端口负责 `resolve` 并把绝对路径回带进结果的「搜索根」行——越界不静默的既有口径）。

### 4. 主进程实现（`apps/desktop/src/main/tools/file-port.ts`）

`createNodeFilePort` 增加可选参数（默认取内核导出的常量，便于单测收紧预算）：

```ts
export interface NodeFilePortOptions {
  searchIgnore?: readonly string[]
  searchBudget?: { maxFiles: number; maxBytes: number }
  maxFileScanBytes?: number
}
export function createNodeFilePort(options?: NodeFilePortOptions): FilePort
```

递归 walker 的硬要求：

- `readdir(dir, { withFileTypes: true })`，条目先按名字字典序排序再处理；
- **`dirent.isSymbolicLink()` 一律跳过**（文件与目录都跳）——这是防目录环的唯一手段，写注释说明原因；
- 目录名命中 `searchIgnore` 时**整棵子树跳过**（按名字精确匹配，不做模式匹配）；
- 单文件 `size > maxFileScanBytes` 时跳过（`searchText` 计入 `skippedBinary`？**不算**——
  另加一个口径：大文件跳过不单独计数，只在 `budgetExceeded` / `truncated` 之外保持静默；
  写注释说明「大文件跳过是刻意的，避免噪声」）；
- 文件内容读入后先做 NUL 探测（复用 `hasNulByte`），二进制计入 `skippedBinary` 并跳过；
- 每次读文件累加 `maxBytes` 预算，超预算或文件数超 `maxFiles` 立即停止遍历并置 `budgetExceeded: true`，
  **已收集的结果照常返回**；
- `searchText` 逐行 `split('\n')` 后去掉行尾 `\r` 再匹配（与 step 2 的行切分口径一致），
  行号从 1 开始；
- `findFiles` 在 pathMode 下用 `matchesGlob(pattern, 相对路径)` 匹配；
  `searchText` 的 `include` 同样用 `matchesGlob` 过滤**文件名相对 root 的路径**；
- 相对路径一律 `split(sep).join('/')`（正斜杠），跨平台一致；
- 错误包装继续用 `withPath`。

### 5. 装配与导出

- `packages/agent-core/src/index.ts`：导出 `createSearchTools`、`matchesGlob`、`compileGlob`、
  `isValidGlobPattern`、`globPattern` 的全部常量、`search` 的全部常量与类型、
  以及 `FilePort` 新增的方法类型。
- `apps/desktop/src/main/tools/index.ts` 的 `registerComputerTools.sync()`：
  把 `search.enabled` 纳入分派——`true` 时用
  `createSearchTools({ files, maxResults: cfg.search.maxResults, defaultRoot: cfg.workspaceDir || homeDir() })`
  创建并注册；`false` 时不创建。`sync()` 返回的 `names` 改为「**实际注册成功的名字列表**」
  （从创建出来的工具实例上取 `name`，不要写死数组）——这样 step 4 往 `createFileTools` 里加
  `edit_file` 时，这里不需要再改。
- `apps/desktop/src/main/tools/index.test.ts`：新增断言——`search.enabled = false` 时 `grep` / `glob`
  不在注册表；`true` 时在；总开关 `agent.tools.enabled = false` 时两个都不在。

### 6. 设置页（`AgentPage.vue`）

`agent.tools.search.*` 是**由用户控制的开关**（docs/06 §11.1 的口径：开关应可在设置页切换，
配置字段不能是死字段），因此本步要把 UI 一起交付，不能只加 Schema：

- 在「文件」卡片之后加一张「文件检索」小卡（栏名与 `docs/08 §6` 保持一致），
  含两个字段，`data-field` 命名沿用既有风格：
  `data-field="agent.tools.search.enabled"`（复选框）与
  `data-field="agent.tools.search.maxResults"`（数字输入，钳 1–1000）。
- 保存走既有的 `save()` 路径新增一个 `saveSearch(patch)`：
  ```ts
  async function saveSearch(patch: Partial<AgentToolsConfig['search']>): Promise<void> {
    await save({ search: { ...tools.value.search, ...patch } })
  }
  ```
  **理由与 `saveTerminal` 相同**：`settings:update` 只做顶层浅合并，改子对象必须带完整子树，
  否则同级的另一个字段会被丢掉（`AgentPage.vue:16` 有这段注释，照它写）。
- 卡片里必须有一句口径说明：「`grep` / `glob` 是**只读**工具（不弹确认），
  但它们会递归扫描整个搜索目录（自动跳过 node_modules / .git 等）。」
  ——只读不等于无开销，这一点要如实告知（`docs/11` 同步）。

### 7. capture 探针（`capture.ts`）

`SETTINGS_AGENT_FIELDS_SCRIPT`（`:1378`）增加 `search` 栏的计数：

```ts
const searchFields = count('[data-field^="agent.tools.search"]')
```

返回对象里带上它，`pass` 条件补 `enabled !== true || searchFields >= 2`
（与既有的 `terminalFields > 0 && filesFields > 0 && openFields > 0` 同款门控口径：
总开关关着时这些栏不渲染）。
**注意**：本步只改 search 相关部分；step 5 会在同一个探针里再加 `allowPatterns` 的计数，
两次都要保证 `pass` 条件自洽。`total` 与各栏计数的**最终数值以 `report.json` 实测为准**，
写进 `docs/07 §5.3` 时不要按推算值写。
（**`AGENTS.md` 本步不动**——它明确写着"张数与具体构成以 `report.json` 的实际条目为准，不要按固定张数校验"，
全文不含探针数值；`AGENTS.md` 里真正要改的是工具计数「5 个」与只读前缀条目，那属于 step 5 / step 6。）

## 验收标准

- [ ] `pnpm build:packages && pnpm typecheck` → exit 0（**必须先建包**：本步给 `FilePort` 加了两个方法，
      而 `@aurora/agent-core` 的 `types` 指向 `dist/`——`packages/agent-core/package.json:8`；
      `createNodeFilePort(): FilePort` 返回对象字面量多出方法还会触发 excess property check）
- [ ] `pnpm vitest run packages/agent-core/src/tools/globPattern.test.ts` 全绿，
      且上面「操作 1」列出的 10 组断言**逐条**能在输出里指认（尤其 `src/**/*.ts` 命中 `src/a.ts`
      与 `a.b` 不命中 `axb` 两条）
- [ ] `pnpm vitest run packages/agent-core/src/tools/search.test.ts` 全绿（用假 `FilePort`，不碰磁盘），
      覆盖：参数非法（空 pattern / 非法正则 / 超长）时**端口未被调用**；
      命中行的渲染格式 `<path>:<line>: <text>`；同一行多次命中只记一条；
      超长命中行截断标记；无命中不是错误；`truncated` / `budgetExceeded` / `skippedBinary` 三种标注各一条
- [ ] `pnpm vitest run apps/desktop/src/main/tools/file-port.test.ts` 全绿（真实临时目录），覆盖：
  - [ ] 嵌套目录下 `findFiles('**/*.ts')` 返回**正斜杠相对路径**且顺序稳定
  - [ ] `node_modules` / `.git` 子树里的文件**不被扫到**
  - [ ] `searchText` 的行号正确（构造第 5 行命中，断言 `line === 5`）且 CRLF 文件的命中行**不含 `\r`**
  - [ ] 二进制文件被跳过且计入 `skippedBinary`
  - [ ] 超过 `maxFileScanBytes` 的文件被跳过（构造 > 1 MiB 文本文件，断言其中不可能命中的标记串未被找到）
  - [ ] 预算触顶：把 `searchBudget.maxFiles` 收到 3，断言 `budgetExceeded === true`
        且**仍有结果返回**（不是抛错、不是空结果）
  - [ ] 符号链接环：`beforeAll` 里尝试 `fs.symlink` 建自指环，**失败（Windows 无权限）即 skip 并打印原因**，
        成功则断言在 5 秒内返回且不重复访问同一目录
- [ ] `pnpm vitest run apps/desktop/src/main/tools/index.test.ts` 全绿，含 search 开/关两个断言
- [ ] `pnpm test` 全绿；`pnpm lint` 与 `pnpm exec prettier --check "**/*.{ts,md,json}"` 通过
- [ ] 设置页字段就位（**本步的纵向切片要求带 UI，不能只加 Schema**）：
      `grep -n 'data-field="agent.tools.search.enabled"' apps/desktop/src/renderer/settings/pages/AgentPage.vue`
      与 `grep -n 'data-field="agent.tools.search.maxResults"' ...` **都命中**；
      且 `grep -n "saveSearch" apps/desktop/src/renderer/settings/pages/AgentPage.vue` 命中
      （保存带完整 `search` 子树，不是只发单个字段）
- [ ] `$env:AURORA_CAPTURE="$env:TEMP\aurora-capture"; pnpm dev` 退出码 0、`report.json` 无 FAIL，
      且 `settings-agent` 条目的探针结果含 `searchFields >= 2`；
      `docs/07 §5.3` 的「三栏」表述扩成四栏并按本次**实测值**记录
      （`AGENTS.md` 本步不动，理由见「操作 7」的注）
- [ ] 端到端可见证据（**本步的核心目标**）：`$env:AURORA_SMOKE='1'; pnpm dev` 的
      `AURORA_SMOKE_RESULT` 里出现 `grep` 与 `glob` 已注册的条目（第 4 条断言在 step 5 一并补齐；
      本步至少要有注册清单的日志/断言命中 `"grep"` 与 `"glob"`）

## 交接

- **`matchesGlob(pattern, value, { pathMode: false })` 是 step 5 的 `run_command` 免确认匹配器**：
  它已经做了「全串锚定 + 大小写不敏感 + `*`/`?`」，step 5 只需再加「必须含字面字符」的规则，
  **不要再写第二份匹配逻辑**。
- **`FilePort` 新增的 `findFiles` / `searchText` 是 step 4 可参考的「端口回调 + 内核告警」范式**，
  但 `edit_file` **不要**用它们去读文件内容（它需要整文件读，见 `docs/06 §11.6`）。
- **`SearchMatch` 的 `path` 是相对 root 的正斜杠路径**，`line` 是 1 起始行号——
  与 step 2 的 `ReadLine.number` 口径一致，后续若做「grep 结果点击跳转读」直接可用。
- `registerComputerTools.sync()` 现在返回**实际注册的名字列表**（不再是写死的 5 个），
  step 4 / step 5 加工具或改门控时无需再动返回值逻辑。

## 执行记录

执行时间：2026-09-26（会话内连续执行）

### 分片与结果

主代理先**亲自定稿两个共享契约**（`globPattern.ts` 的编译器、`FilePort` 的 `findFiles` / `searchText`
与全部搜索常量，以及 `index.ts` 的导出面）—— 三者同时被 `search.ts`、主进程 walker、后面的 step 5 消费，
分头写必然漂移；随后派三个写范围互不重叠的分片并行。

| 分片 | 负责文件 | 结果 |
| --- | --- | --- |
| 主代理 | `globPattern.ts` + `globPattern.test.ts`（23 用例）、`files.ts` 的端口与常量、`index.ts` 导出 | 编译器一遍扫描实现（无「先转义再换回」的顺序坑）；导出面确认 `createSearchTools` / `matchesGlob` / `DEFAULT_SEARCH_IGNORE` 等均可用 |
| 内核工具 | `search.ts` + `search.test.ts`（22 用例）、`files.test.ts` 桩同步 | 两个 `safe` 工具；参数非法时**不触碰端口**；三种尾注（truncated / budgetExceeded / skippedBinary）各有用例 |
| 主进程 walker | `file-port.ts` + `file-port.test.ts`（+11 用例，21 → 32） | 字典序遍历、符号链接跳过、忽略目录整棵子树、双预算触顶仍返回已收集结果；**符号链接环用例本机真跑了**（`fs.symlink` 成功，非 skip） |
| 装配 + UI | `tools/index.ts` + `index.test.ts`、`AgentPage.vue`、`toolIcons.ts`、`icons.ts` | `search.enabled` 分派 + 三条开关注册用例；设置页「文件检索」栏（`data-field` 两个、`saveSearch` 带完整子树、**未新增 `data-empty`**） |
| 主代理 | `capture.ts` 探针、`index.ts` 的 smoke 断言与文案、`docs/07 §5.3` | `searchFields` 计数纳入 `pass`；smoke 补两条真实文件系统断言 |

### 验收命令与真实结果（主代理复跑）

| 命令 | 结果 |
| --- | --- |
| `pnpm build` | exit 0（三个包 + Electron 产物） |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | **67 文件 / 1182 用例全绿**（step 2 结束时尚为 1122） |
| `pnpm lint` / `pnpm exec prettier --check "**/*.{ts,md,json}"` | 均通过 |
| `pnpm vitest run packages/agent-core/src/tools/globPattern.test.ts` | 23 用例全绿（含 `**/*.ts` 命中 `a.ts`、`a.b` 不命中 `axb`） |
| `pnpm vitest run apps/desktop/src/main/tools` | 6 文件 / 87 用例全绿 |
| `$env:AURORA_SMOKE='1'; pnpm dev` | **SUMMARY 134/134 passed**、退出码 0。新增可指认条目：`glob 递归找到嵌套文件（正斜杠相对路径）且不扫 node_modules`、`grep 命中行带「相对路径:行号」且不扫 node_modules`、`电脑操控工具已注册（7 个）`、`敏感级与文档一致（…read_file / grep / glob = safe）` |
| `$env:AURORA_CAPTURE="$env:TEMP\aurora-capture"; pnpm dev` | 退出码 0、**48 张 PNG / 48 条 `checks` / 0 FAIL**、12 条 DOM 探针全 PASS。`settings-agent` 实测 `{"total":10,"terminalFields":3,"filesFields":2,"searchFields":2,"openFields":1,"pass":true}` |

`docs/07 §5.3` 已按上表**实测值**回填（不再写「待回填」）。

### git 提交

| SHA | 说明 |
| --- | --- |
| `12430c1` | `feat(agent-core): 新增 glob 模式编译器与单测（search / walker / 免确认列表共用）` |
| `5fd5ed9` | `feat(agent-core): 新增 grep / glob 搜索工具与 FilePort 搜索端口` |
| `e3b942e` | `style: 修正 globPattern.test.ts 的 Prettier 格式` |
| `c54913b` | `feat(tools): FilePort 实现递归遍历（findFiles / searchText，预算与符号链接防护）` |
| `ed2241a` | `feat(settings): 装配 grep / glob（agent.tools.search 门控）+ 设置页「文件检索」栏与工具图标` |
| `0f854f0` | `test(e2e): smoke 补 glob/grep 端到端断言、capture 补检索字段探针，桩 LLM 分片隔帧下发` |

### 与计划的偏差

1. **`maxFileScanBytes` 只对 `searchText` 生效，`findFiles` 不受它约束**（计划「操作 4」把它写成
   walker 级的统一跳过）。原因：`glob` 只比文件名、不读内容，让一个 2 MiB 的 `pnpm-lock.yaml`
   「按名字也找不到」是反直觉的；那个阈值按 SSOT 的措辞是**内容扫描**上限。
   实现上把 `sizeBytes` 交给 visitor，由各工具自己决定。已补用例
   `findFiles 只比名字、不受 maxFileScanBytes 约束：超大文件按名字仍然找得到` 钉住。
2. **`glob` 也渲染 `budgetExceeded`**（计划只要求 `truncated`）。理由：`FindFilesResult.budgetExceeded`
   在内核侧没有第二个消费方，不渲染就等于把「预算触顶的不完整前缀」静默当完整结果。
3. **`globPattern.test.ts` 由主代理补写**（`globPattern.ts` 由主代理实现，其单测随实现一起交付）。
   其中一条断言初版写错（把 `x{a,{b}c}` 当成能匹配 `x{b}c`）—— **是断言错、不是实现错**：
   外层花括号在**第一个** `}` 处收口，该模式的语义是 `x` + (`a` | `{b`) + `c` + `}`，
   已改成断言这一真实语义（并借此把「不支持嵌套」的可观测后果钉住）。
4. **smoke 的「正文按增量逐条下发」判据一度稳定失败，已修根因**：桩服务零延迟连发两条 `content`
   分片，而主进程的事件合并缓冲按 **16ms 窗口**把相邻增量合并（`main/event-buffer.ts`，刻意的降载设计），
   于是事件数恒为 1、判据变成随机失败。改法是**让桩的分片之间隔 40ms 再发**
   （`FRAME_GAP_MS`），判据就变确定了 —— 真出现「攒完整段发一次」的回归时事件数仍会是 1。
   `main/event-buffer.ts` 本身**未改**（它的合并语义是对的，不该为了测试放宽）。
5. **smoke 的注册清单断言改为「已装配」的显式常量** `SMOKE_IMPLEMENTED_TOOLS`（7 个）：
   `edit_file` 要到 step 4 才创建得出来，断言 `COMPUTER_TOOL_NAMES` 全量必然红。
   step 4 加名字后即变 8 个。总开关断言的「关掉后一个都不剩」仍用 `COMPUTER_TOOL_NAMES`（更宽更强）。

### 已登记、未修

- `grep.include` 不做内核校验（非法 `include` 会按字面口径匹配、可能得到「未找到匹配」而无提示）。
  按既定分工（匹配只在 `globPattern.ts`）保留。
- `include` 按「相对 root 的路径」全串锚定，因此 `include: '*.txt'` 只覆盖根目录一层，
  嵌套文件要写 `**/*.txt`（已有用例钉住语义）。
- `maxFileScanBytes` 之外，「字节预算按文件 size 记账、`findFiles` 不读内容也记账」等三条记账口径
  是规格未明说、由实现定的，已写进注释。

### 对后续步骤的影响

- **`matchesGlob(pattern, value, { pathMode: false })` 就是 step 5 的免确认匹配器**：
  全串锚定 + 大小写不敏感 + `*`/`?` 都已具备，step 5 只需再加「必须含字面字符」与「整类拒绝花括号」。
- **`registerComputerTools.sync()` 返回的仍是「实际注册成功的名字」**（按 `COMPUTER_TOOL_NAMES` 顺序过滤），
  step 4 加 `edit_file` 时无需再动返回值逻辑，但 `IMPLEMENTED_COMPUTER_TOOLS`
  （`tools/index.test.ts`）与 `SMOKE_IMPLEMENTED_TOOLS`（`main/index.ts`）两处都要加名字。
- `SETTINGS_AGENT_FIELDS_SCRIPT` 本步已把 `searchFields >= 2` 纳入 `pass`；
  step 5 再加 `allowPatternsFields === 1` 与 `terminalFields` 的期望值 4。
