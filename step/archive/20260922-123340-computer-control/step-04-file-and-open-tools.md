# Step 04 — 文件与「打开」操控工具

- Task: computer-control
- Step: 4 / 7
- Status: done
- Depends on: step 1（`agent.tools.files.*` / `agent.tools.open.enabled`）、step 3（端口注入 + 纯逻辑工具的写法）
- Produces: `packages/agent-core/src/tools/files.ts`、`apps/desktop/src/main/tools/file-port.ts`、`apps/desktop/src/main/tools/open-port.ts` 与各自单测

## 目标

模型能读文本文件、写文件、列目录、用系统默认方式打开文件/文件夹/网址；
所有真实系统调用都在主进程实现，内核只认注入的端口，因此可以在 Node 里完整单测。

## 输入

- `packages/agent-core/src/tools/registry.ts`、`packages/agent-core/src/tools/terminal.ts`（step 3 建立的文件组织与风格）
- `packages/shared/src/config/ports.ts`（既有的 `FileSystemPort` 习惯：原子写、失败抛错）
- `packages/shared/src/config/store.ts` 的原子写实现（临时文件 + rename，写文件工具沿用同一约定）
- `AGENTS.md`「日志落盘实现在主进程」「配置改动先改文档」两条
- step 1 的 `docs/06 §11` 工具表

## 操作

### 1. 内核：端口 + 四个工具

新建 `packages/agent-core/src/tools/files.ts`：

```ts
export interface FilePort {
  /** 读文本；超 maxBytes 时截断并回带 truncated 标记；二进制（含 NUL）由实现抛错 */
  readText(path: string, maxBytes: number): Promise<{ absolutePath: string; text: string; truncated: boolean; bytes: number }>
  /** 写文本；mode='append' 追加；实现负责建父目录 + 原子写 */
  writeText(path: string, content: string, mode: 'overwrite' | 'append'): Promise<{ absolutePath: string; bytes: number }>
  list(path: string, limit: number): Promise<{ absolutePath: string; entries: DirEntry[]; truncated: boolean }>
}
export interface DirEntry { name: string; type: 'file' | 'dir'; sizeBytes?: number; modifiedAt?: string }
export interface OpenPort { open(target: string): Promise<void> }

export interface FileToolOptions { files: FilePort; open: OpenPort; maxReadBytes: number; listLimit?: number }
export function createFileTools(options: FileToolOptions): ToolDefinition[]   // 恰好 4 个
export function createOpenTool(options: { open: OpenPort }): ToolDefinition
```

工具要求（名字与 step 1 的 `COMPUTER_TOOL_NAMES` 完全一致，顺序也按该常量）：

- `read_file`（`sensitivity: 'safe'`）：参数 `{ path: string(必填), maxBytes?: number }`；
  `maxBytes` clamp 到 `1_024 .. options.maxReadBytes`；成功 content 里带
  `文件：<绝对路径>（<bytes> 字节）` 头 + 正文，`truncated` 时尾部标注
  `…（已按 maxBytes 截断）…`；端口抛错 → `isError: true`。
- `write_file`（`sensitivity: 'confirm'`）：参数
  `{ path: string(必填), content: string(必填), mode?: 'overwrite' | 'append' }`；返回
  `<绝对路径>（写入 <bytes> 字节，mode=…）`。
- `list_dir`（`sensitivity: 'safe'`）：参数 `{ path: string(必填), limit?: number }`；
  `limit` clamp 到 `1 .. 500`，默认 200；输出行格式
  `[DIR]  名称  (2026-09-20 17:10)` / `[FILE] 名称  1234 字节  (…)`，目录在前按名称排序；
  `truncated` 时尾部提示「还有更多条目，已按 limit 截断」。
- `open_path`（`sensitivity: 'confirm'`）：参数 `{ target: string(必填) }`；description 写清
  「网页 URL / 本地文件 / 文件夹 / 已安装程序名都能打开，交给 Windows 默认程序处理」；
  成功后返回 `已打开：<target>`（不等待目标程序退出）。
- 参数校验失败一律 `isError: true` 且不触碰端口；`additionalProperties: false`。

补单测 `packages/agent-core/src/tools/files.test.ts`（内存假端口，无真实 IO）：
四个工具的名字集合等于 `COMPUTER_TOOL_NAMES` 对应子集；缺参报错；`maxBytes`/`limit` 钳制值
按钳制后的值传给端口；端口抛错 → `isError`；`list_dir` 输出包含 `[DIR]`/`[FILE]` 两种前缀；
`open_path` 收到未去空白的 target 时被 trim。

### 2. 主进程：真实端口

新建 `apps/desktop/src/main/tools/file-port.ts`（**不得 import electron**，用 `node:fs/promises` 与 `node:path`，
因此进 vitest）：

```ts
export function createNodeFilePort(): FilePort
```

- `readText`：`stat` 后按 `Math.min(size, maxBytes)` 读；读到的 Buffer 若在**前 8 KiB 内出现 NUL 字节**
  → 抛错 `这是二进制文件，无法按文本读取（可改用 run_command 处理）`；`decode` 用 UTF-8；
  返回绝对路径（`resolve` 后）。
- `writeText`：`mkdir(dirname, { recursive: true })`；`overwrite` 走
  「同目录临时文件 + `rename`」原子写（与 `SettingsStore` 同一约定）；`append` 用 `appendFile`；
  返回写入字节数（`Buffer.byteLength(content, 'utf8')`，注意不是字符数）。
- `list`：`readdir(withFileTypes)` + 逐条 `stat`（`stat` 失败的单条跳过，不要整体失败）；
  目录在前、同类按 `localeCompare` 排序；超过 `limit` 截断并置 `truncated`。
- 错误信息里必须带上**绝对路径**（越界不静默：用户/模型要看得到动的是哪个文件）。

新建 `apps/desktop/src/main/tools/open-port.ts`（**import electron `shell`**，因此只能被主进程装配层
import，不参与 vitest，由 step 6 的 smoke 覆盖）：

```ts
export function createShellOpenPort(): OpenPort
```

- `^https?://` 或 `^mailto:` → `shell.openExternal(target)`；
- 其它 → `shell.openPath(target)`，**返回非空字符串即为失败**（Electron 的约定），据此抛错，
  不要把失败当成功（既有 `notifications.ts` / `index.ts` 都是这么处理的）。

补单测 `apps/desktop/src/main/tools/file-port.test.ts`（真实临时目录，`os.tmpdir()` + 随机子目录，
`afterEach` 递归删除）：

1. 写 → 读往返，内容与字节数一致；
2. 写入不存在的多级父目录 → 自动创建成功；
3. `append` 模式在已有文件后追加；
4. 二进制拒绝：写入 `Buffer.from([0x41, 0x00, 0x42])` 后 `readText` 抛错且错误信息含「二进制」；
5. 截断：写入 4000 字节文本，`readText(path, 1024)` 的 `truncated === true` 且 `bytes === 1024`；
6. `list`：建 2 个目录 + 3 个文件 → 目录排在前、`limit: 2` 时 `truncated === true` 且 `entries.length === 2`；
7. 不存在的路径 → 抛错且错误信息含该路径。

### 3. 导出

- `packages/agent-core/src/index.ts`：导出 `createFileTools`、`createOpenTool` 与类型
  `FilePort` / `DirEntry` / `OpenPort`（step 5 装配层要用）。
- 不要在 `file-port.ts` 里读配置（上限由装配层从 `agent.tools.files.maxReadBytes` 注入），
  保持端口是无状态纯实现，便于单测。

## 验收标准

- [x] `pnpm vitest run packages/agent-core/src/tools/files.test.ts apps/desktop/src/main/tools/file-port.test.ts` 全绿
      （2 文件 / 30 用例：内核 20 + 真实临时目录 10）
- [x] `pnpm typecheck` 通过
- [x] `grep -rn "from 'electron'" apps/desktop/src/main/tools/file-port.ts` 无输出
      （该文件必须能在 Node 环境加载）
- [x] `apps/desktop/src/main/tools/open-port.ts` 里 `shell.openPath` 的返回值被判定为非空字符串即失败
      （L22 `if (failure !== '') throw new Error(...)`）
- [x] 测试运行后 `os.tmpdir()` 里没有残留 `aurora-files-test-*` 目录（`afterEach` 生效）

## 执行记录

**状态：done（2026-09-20）· 提交 `e16d6d5`**

### 子代理分片
单一实现分片（子代理 `5d47cdc8`），白名单 5 个文件；主代理负责集成、复跑验收与提交。

### 实际改动
- 新建 `packages/agent-core/src/tools/files.ts`（`createFileTools` 恰好 4 个工具 +
  `createOpenTool`）与 `files.test.ts`（20 用例，内存假端口）。
- 新建 `apps/desktop/src/main/tools/file-port.ts`（**不 import electron**）+ `file-port.test.ts`（10 用例，真实临时目录）。
- 新建 `apps/desktop/src/main/tools/open-port.ts`（import electron `shell`，只被主进程装配层引用）。
- `packages/agent-core/src/index.ts` 补 `export * from './tools/files.js'`。

### 实现里的三处自主决定
1. `write_file` 允许 `content: ''`（清空文件），只有**缺字段**才报错；
2. `maxBytes` / `limit` 传非数字按参数校验失败处理（不静默回落到默认值）；
3. `read_file` 读到目录时提示「这是目录，不是文件（可改用 list_dir）」，而不是抛底层 fs 错误。

### 验证（主代理实跑）
- `pnpm vitest run apps/desktop/src/main/tools packages/agent-core/src/tools` → 5 文件 / 66 用例全过。
- `pnpm typecheck` → 0；`pnpm lint` → 0；`pnpm exec prettier --check` → 通过。
- `git status` 确认 `apps/desktop/src/main/tools/file-port.test.ts` 运行后 `%TEMP%` 无 `aurora-files-test-*` 残留。

### 遗留
- `open_path` 的真实打开行为会在本机弹出资源管理器 / 浏览器，属预期；smoke 侧改用「记录调用」的假端口
  （step 6 处理）。

## 交接

- `createFileTools` 返回**恰好 4 个**工具（read/write/list/open）——step 5 的开关按名字分派：
  `read_file` / `write_file` / `list_dir` 受 `agent.tools.files.enabled` 控制，
  `open_path` 受 `agent.tools.open.enabled` 控制。
- 端口方法名与返回字段（`absolutePath` / `truncated` / `entries`）是 step 5、step 6 的依赖，不要改名。
- `open_path` 的真实打开行为在本机验收时**会真的弹出资源管理器 / 浏览器**，属预期；
  smoke 里改用「记录调用」的假端口（step 6 会给出具体做法）。

## 执行记录

（见上：执行记录已并入「验收标准」之后）
