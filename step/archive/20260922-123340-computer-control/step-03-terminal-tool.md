# Step 03 — 终端工具：内核纯逻辑 + 真实 PowerShell 执行器

- Task: computer-control
- Step: 3 / 7
- Status: done
- Depends on: step 1（`agent.tools.terminal.*` 配置已存在）
- Produces: `packages/agent-core/src/tools/terminal.ts` + `apps/desktop/src/main/tools/command-runner.ts` 与两者单测

## 目标

模型可以通过 `run_command` 真实执行一条 Windows 命令，并拿到退出码、stdout、stderr；
超时会被真的终止（含子进程），输出不会撑爆上下文，中文不乱码。

## 输入

- `packages/agent-core/src/tools/registry.ts`（`ToolDefinition` / `ToolResult` / `sensitivity`）
- `packages/agent-core/src/skills/bridge.ts`（现有唯一内置工具的写法，照它的形状写）
- `packages/agent-core/src/loop/agentLoop.ts` 的 `runTool`（确认链路如何被调用）
- `apps/desktop/src/main/perception.ts` 的 `runPowerShell`（约 307–323 行，既有的 PowerShell 调用约定）
- `AGENTS.md`「重任务走子进程」「MCP 绝不经过 shell」两条约束的背景
- step 1 的 `docs/06 §11`（工具表与安全边界，实现必须与之一致）

## 操作

### 1. 内核：纯逻辑工具（可单测，不碰真实进程）

新建 `packages/agent-core/src/tools/terminal.ts`：

```ts
export interface CommandRequest {
  command: string
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
}
export interface CommandResult {
  exitCode: number | null   // 被终止时为 null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  durationMs: number
  cwd: string               // 实际使用的工作目录（绝对路径）
}
export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>

export interface TerminalToolOptions {
  run: CommandRunner
  /** 默认超时（来自 agent.tools.terminal.timeoutMs） */
  timeoutMs: number
  /** 回填给模型的输出上限（来自 agent.tools.terminal.maxOutputChars） */
  maxOutputChars: number
  /** 单次请求可申请的超时硬上限，默认 300_000 */
  maxTimeoutMs?: number
  defaultCwd: string
}
export function createTerminalTool(options: TerminalToolOptions): ToolDefinition
export function formatCommandOutput(result: CommandResult, maxOutputChars: number): string
```

要求：

- 工具名 `run_command`，`sensitivity: 'confirm'`；`parameters`：
  `{ command: string（必填）, cwd?: string, timeoutMs?: number }`，`additionalProperties: false`；
  description 写清「在 Windows 上以 PowerShell 执行一条命令；需要用户确认；非交互，不适合需要
  持续输入的程序」，并提示模型「先说明要做什么再调用」。
- 参数校验（全部返回 `isError: true` 且不调用 runner）：`command` 非字符串或去空白后为空。
- `timeoutMs` 取值：`clamp(requested ?? options.timeoutMs, 1_000, options.maxTimeoutMs ?? 300_000)`。
- `cwd` 缺省用 `options.defaultCwd`（**内核不解析 home**，由装配层注入）。
- 调 `options.run({ command, cwd, timeoutMs, signal })`；runner 抛错 → `isError: true`，
  content 为 `命令执行失败：<message>`。
- 结果：`exitCode === 0 && !timedOut && !aborted` → `isError` 为 `false`；否则 `isError: true`
  （让模型看到 stderr 自行修正，而不是让循环崩掉）。
- `summary`（渲染卡片用，短）：成功 `退出码 0 · 123ms`；非零 `退出码 3 · 210ms`；
  超时 `执行超时（>800ms）已被终止`；中止 `已取消`。
- `formatCommandOutput` 把 `command / cwd / 退出码 / 耗时` 作为头部，随后 `stdout`、`stderr`
  （空段省略），总长超过 `maxOutputChars` 时保留**头部 60% + 尾部 40%**，中间插一行
  `…（已截断 N 字符）…`（尾部必须保住，编译错误与堆栈都在尾部）。该函数导出以便直接单测。

补单测 `packages/agent-core/src/tools/terminal.test.ts`（用假 runner，不启进程）：
命令透传、`cwd` 缺省值、超时钳制（请求 10ms → 收到 1000；请求 9e9 → 收到 300000）、
非零退出码 → `isError` 且 content 含 stderr、runner 抛错 → `isError`、
`formatCommandOutput` 的截断（构造超长输出，断言头尾片段都在、中间标记计数正确）。

### 2. 主进程：真实执行器

新建 `apps/desktop/src/main/tools/command-runner.ts`（**不得 import electron**，这样才进 vitest）：

```ts
export interface CommandRunnerOptions {
  defaultCwd: string
  /** stdout+stderr 各自收集上限（字节），默认 1 MiB */
  maxOutputBytes?: number
  /** 终止进程树时的等待宽限，默认 500ms */
  killGraceMs?: number
}
export function createCommandRunner(options: CommandRunnerOptions): CommandRunner
export function terminateProcessTree(pid: number | undefined): Promise<void>
```

实现要点（逐条写进注释，都是踩过的坑）：

- 用 `node:child_process.spawn('powershell.exe', args, { cwd, windowsHide: true, env: process.env,
  stdio: ['ignore','pipe','pipe'] })`；**不传 `shell: true`**，命令作为 `-Command` 的单个 argv
  元素传递（避免 cmd.exe 二次解析）。
- args：`['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command', script]`。
- script = 编码前缀 + 用户命令，前缀固定为
  `$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; `
  ——Windows PowerShell 5.1 默认按控制台代码页（中文系统为 GBK）输出，不设这两行中文必然乱码。
- 收集 stdout/stderr 的 Buffer，按 UTF-8 `toString('utf8')` 解码（解码失败用替换字符兜底，不要让读取抛错）；
  超过 `maxOutputBytes` 的片段丢弃并在结尾追加 `\n…（输出超过 1 MiB 已截断）…\n`。
- 超时：`setTimeout(timeoutMs)` 到期 → `terminateProcessTree(child.pid)`，`timedOut: true`；
  `taskkill /PID <pid> /T /F` 经 `execFile` 执行（Node 的 `child.kill()` 在 Windows 上杀不掉孙进程，
  实测会让 `Start-Sleep` 之类的命令残留），失败时回落 `child.kill()`；宽限 `killGraceMs` 后强制 resolve。
- `signal`（来自 Agent 的 AbortSignal）中止：与超时同样杀进程树，但 `aborted: true`、`timedOut: false`。
- `durationMs` 用 `performance.now()` 差值；退出码取 `close` 事件的 `code`（被信号杀死时为 `null`）。
- `defaultCwd` 由装配层传入（`agent.tools.workspaceDir` 或用户主目录），这里只做兜底
  `existsSync(cwd) ? cwd : options.defaultCwd`。

补单测 `apps/desktop/src/main/tools/command-runner.test.ts`（`describe.skipIf(process.platform !== 'win32')`，
**真实启动进程**，离线可跑；每个用例 `timeout: 20_000`）：

1. `echo AURORA_TERMINAL_OK` → `stdout` 含该串、`exitCode === 0`、`timedOut === false`；
2. `Write-Output '中文输出测试'` → `stdout` 含 `中文输出测试`（编码回归）；
3. `[Console]::Error.WriteLine('BOOM')` → `stderr` 含 `BOOM`；
4. `exit 3` → `exitCode === 3`；
5. `cwd` 生效：`cwd = os.tmpdir()`，命令 `(Get-Location).Path` → stdout 含该目录；
6. 超时：`Start-Sleep -Seconds 10` + `timeoutMs: 800` → `timedOut === true` 且
   `durationMs < 4_000`（证明进程真的被杀，不是等它自己睡完）；
7. abort：传入已 abort 的 `AbortSignal` → `aborted === true`，且 2s 内返回。

### 3. 导出

- `packages/agent-core/src/index.ts`：导出 `createTerminalTool`、`formatCommandOutput`
  与类型 `CommandRunner` / `CommandResult` / `CommandRequest`（step 5 的装配层要 import 类型）。

## 验收标准

- [x] `pnpm vitest run packages/agent-core/src/tools/terminal.test.ts apps/desktop/src/main/tools/command-runner.test.ts` 全绿
      （28 用例：内核 18 + 真实 PowerShell 10）
- [x] 在 PowerShell 里单独跑一条真实命令确认字符集链路：
      `node -e "..."` 不必要；直接用 vitest 用例 2 的输出作为证据（测试名含「中文」）
      —— 实测 `Write-Output '中文输出测试'` 的 stdout 含该串且**不含 U+FFFD**
- [x] `pnpm typecheck` 通过
- [x] `grep -n "sensitivity: 'confirm'" packages/agent-core/src/tools/terminal.ts` 命中（L87）
- [x] `grep -n "shell" apps/desktop/src/main/tools/command-runner.ts` **没有** `shell: true`
      （只有注释里的「不走 shell」）

## 执行记录

**状态：done（2026-09-20）· 提交 `1f41447`**

### 子代理分片
单一实现分片（子代理 `39354440`），白名单 4 个文件；主代理负责集成、复跑验收与提交。

### 实际改动
- 新建 `packages/agent-core/src/tools/terminal.ts`（`run_command`，`sensitivity: 'confirm'`，
  纯逻辑 + 可注入 runner）与 `terminal.test.ts`（18 用例，假 runner）。
- 新建 `apps/desktop/src/main/tools/command-runner.ts`（**不 import electron**，故进 vitest）
  与 `command-runner.test.ts`（10 用例，真实启 `powershell.exe`）。
- `packages/agent-core/src/index.ts` 补 `export * from './tools/terminal.js'`。

### 与计划的两处偏差（已在实现里注明）
1. `CommandResult` 增加了**可选**字段 `command?: string`（规定的 7 个字段一个没改名）。
   原因：`formatCommandOutput(result, maxOutputChars)` 的签名需要一个来源渲染「命令：」头部。
   执行器会回带它，内核再用 `result.command ?? parsed.command` 兜底，手工构造的结果不填也不会报错。
2. 单测比要求多了 3 条：把「超时杀整棵进程树」做成了**可证伪**的用例（孙进程 4s 后写 marker），
   并附正 / 负两个对照实验（只杀直接子进程时 marker 确实会出现，证明 `/T` 是必需的）。

### 验证（主代理实跑）
- `pnpm vitest run apps/desktop/src/main/tools packages/agent-core/src/tools` → 5 文件 / 66 用例全过
  （command-runner 真实进程用例 11.5s，其中杀树用例 6.2s）。
- `pnpm typecheck` → 0；`pnpm lint` → 0（主代理修掉了 `killTimer` 的 `prefer-const` 报错，
  计时器改放进 `timers` 持有对象）；`pnpm exec prettier --check` → 通过。
- 端到端间接证据：`AURORA_CAPTURE` 启动日志出现
  `[tools] 已同步电脑操控工具 {"names":["run_command",...]}`。

### 遗留
- 未覆盖：1 MiB 输出溢出的真实链路、`killGraceMs` 的「`close` 永不到来」兜底、`spawn` 失败
  （系统无 `powershell.exe`）的 reject 分支 —— 构造这些异常场景性价比不高，已如实记录。

## 交接

- 端口形状（step 4 的文件工具沿用同一套「端口注入 + 纯逻辑工具」模式）：
  `createXxxTool(options) → ToolDefinition`，真实系统调用一律在主进程 `apps/desktop/src/main/tools/` 下实现。
- `CommandRunner` 的返回字段（`exitCode/stdout/stderr/timedOut/aborted/durationMs/cwd`）
  是 step 6 smoke 断言的依赖，不要改名。
- 已知限制（写进 `docs/06 §11`，step 6 收口时校对）：非交互命令；不支持需要持续输入的程序；
  不注入持久 shell 会话；不支持字节级二进制输出。

## 执行记录

（见上：执行记录已并入「验收标准」之后）
