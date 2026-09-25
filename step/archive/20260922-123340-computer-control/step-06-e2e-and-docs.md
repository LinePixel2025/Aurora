# Step 06 — 端到端验收（真实命令 + 开关热生效）与文档收口

- Task: computer-control
- Step: 6 / 7
- Status: done
- Depends on: step 5
- Produces: `AURORA_SMOKE` 自测新增断言、`docs/10` / `docs/11` / `docs/06` / `docs/04` / `docs/README.md` 收口、全量验证记录

## 目标

用**真实的 Windows 进程与文件系统**证明「模型真的能操控电脑」这条链路在主进程装配下是通的，
并把本轮能力写进面向用户的文档（用户手册 + 隐私说明），让安全边界可被用户核对。

## 输入

- `apps/desktop/src/main/index.ts`：
  - 第 74–110 行（smokeMode / 隔离 userData）、第 815–870 行（桩 LLM 启动与 `record` 的用法）
  - 第 866–1010 行 已有的 smoke 断言区（**注意第 868–873 行断言了「桩 LLM 收到 3 轮 chat 请求」与
    第 323 行附近的「历史 5 条」——本步新增的断言不得改变这两个数字**）
- `apps/desktop/src/main/smoke.ts`（渲染层侧断言脚本，`record(name, ok, detail)`）
- `packages/agent-core/src/tools/{terminal,files}.ts`、`apps/desktop/src/main/tools/*`（step 3/4/5 产出）
- `docs/10-user-guide.md`、`docs/11-privacy.md` §4/§6、`docs/06-agent-core.md` §11、`docs/04-roadmap.md`、
  `docs/README.md`

## 操作

### 1. smoke 新增主进程侧断言（`apps/desktop/src/main/index.ts`）

在既有 smoke 断言之后追加一节「10. 电脑操控工具」，全部用 `record(...)` 输出（harness 已有）：

1. **注册齐全**：`computerTools.sync()` 后断言
   `tools.list().map(t => t.name)` 包含全部 `COMPUTER_TOOL_NAMES`，detail 里带上实际名字串；
2. **安全标记是真的**：`tools.get('run_command')?.sensitivity === 'confirm'` 且
   `tools.get('write_file')?.sensitivity === 'confirm'`、`tools.get('read_file')?.sensitivity === 'safe'`
   （这一步直接钉住 step 1 文档里写的敏感级）；
3. **真实执行一条命令**：
   - 目标文件：`join(os.tmpdir(), `aurora-smoke-tools-${Date.now()}.txt`)`；
   - `await tools.get('run_command')!.execute({ command: `Set-Content -LiteralPath '${file}' -Value AURORA_CTRL_OK -Encoding UTF8` },
     { sessionId: 'smoke' })` → 断言 `isError !== true`；
   - `await tools.get('read_file')!.execute({ path: file }, { sessionId: 'smoke' })` → 断言 content 含
     `AURORA_CTRL_OK`（**这是「命令真的落盘 + 读回」的硬证据**）；
   - `await tools.get('list_dir')!.execute({ path: dirname(file) }, { sessionId: 'smoke' })` → 断言输出含文件名；
   - 结束 `rm(file, { force: true })` 清理；
   - **代码注释必须写清**：这里直接调 `execute` 而**不**经过确认链路——smoke 下没有渲染层点击确认，
     走状态机会白等 60s 然后被拒；确认链路本身已由 `proactive.test.ts` 与既有 smoke 覆盖；
4. **开关热生效**：`await settings.update({ agent: { tools: { ...current, terminal: { ...terminal, enabled: false } } } })`
   → `computerTools.sync()` → 断言工具表里**没有** `run_command` 但 `open_path` 仍在；
   再改回 `enabled: true` → `sync()` → 断言恢复。**注意**：`settings:update` 是顶层浅合并，
   必须带完整的 `agent.tools` 子树，否则会把 files/open 配置写丢（这一步正好也回归这一点）。

不要动桩 LLM 的脚本轮次与前两步的计数断言。

### 2. 文档收口

1. `docs/10-user-guide.md`：新增一章「让 AI 帮你操作电脑」，写清：
   - 能做什么：执行 PowerShell 命令、读写文本文件、列目录、打开文件/文件夹/网页/程序；
   - 怎么确认：每次调用弹确认卡片（含完整参数原文），60s 不响应 / 处于勿扰时段一律按拒绝；
   - 怎么关：设置 → 电脑操控（总开关与终端 / 文件 / 打开三个分开关）；
   - 两三条示例话术（例如「把这个文件夹里的 txt 列出来」「在桌面建一个 待办.md 并写入…」）；
   - 风险提示：命令以当前用户身份执行，能力等同你自己在 PowerShell 里敲同样的命令；
     关闭「敏感工具确认」后不再逐次询问。
2. `docs/11-privacy.md`：
   - §6 权限表追加三行：`执行你确认过的 PowerShell 命令`（能否关闭：设置页总开关 / 终端开关）、
     `读写你指定路径的文本文件`（文件开关）、`用默认程序打开文件或网址`（打开开关）；
   - 「不做的事」段补：不模拟鼠标键盘、不录屏、不读取其它进程内存；
   - §4 出网场景补一句：命令自身可能联网（例如 `git clone`），这属于命令自己的网络行为，
     不走 Aurora 的代理设置，也不经 Aurora 转发。
3. `docs/06-agent-core.md` §11：核对实现（工具名、参数、敏感级、上限字段、已知限制）与代码一致；
   顺手把 §3 里 `reasoningEffort` 的说明补成与 step 2 实现一致的措辞。
4. `docs/04-roadmap.md`：在阶段状态里记一行本轮落地（电脑操控工具 + 思考等级），
   并注明鼠标键盘模拟 / 截图仍属后续范围。
5. `docs/README.md`：「当前实现状态」新增一段 v0.7.0 说明（三条：思考等级、终端与文件操控工具、
   电脑操控设置页 + 全套安全边界），**不要改 `package.json` 的版本号**（版本提升属于发布步骤）。

### 3. 全量验证（逐条跑，结果写进本文件「执行记录」）

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm verify
```

```powershell
$env:AURORA_SMOKE='1'; pnpm dev
# 结束后看 %TEMP%\aurora-smoke-logs 最新日志里的 AURORA_SMOKE_RESULT 行，
# 确认全部 PASS，尤其新增的四条（工具注册 / 敏感级 / 真实读写回 / 开关热生效）
```

```powershell
$env:AURORA_CAPTURE="$env:TEMP\aurora-cap-final"; pnpm dev
# 退出码 0；report.json 无 FAIL；settings-agent.png 与 settings-llm-params.png 都在
```

### 4. 手工真实对话验收（**有可用模型 Key 时才做**，不作为完成标准）

在开发态对话窗里发一句「在当前工作目录下创建一个 hello-aurora.txt，内容写 AURORA_OK，然后读回来告诉我」，
在确认卡片上点「允许一次」，确认：文件真的被创建、卡片状态 running→success、回答里引用了文件内容。
无 Key 时跳过，并在执行记录里写明「跳过原因：无可用模型凭据」。

## 验收标准

- [x] `pnpm typecheck && pnpm test && pnpm build && pnpm verify` 全部退出码 0
      （typecheck 0 / test 48 文件 678 用例 / build 0 / verify **26/26 项通过**）
- [x] `AURORA_SMOKE=1 pnpm dev` 的日志里新增四条断言全部为 PASS/ok，且既有的
      「桩 LLM 收到 3 轮 chat 请求」「历史 5 条」仍然是 PASS（证明没被本步改动带偏）
      —— **SUMMARY 98/98 passed，退出码 0**
- [x] `AURORA_CAPTURE` 退出码 0、`report.json` 无 FAIL、两张新增截图存在
      —— 18 张 PNG、10 条探针结果、FAIL 0，`settings-agent.png` 与 `settings-llm-params.png` 均在
- [x] `grep -n "AURORA_CTRL_OK" apps/desktop/src/main/index.ts` 命中（真实读写回的断言在源码里）
- [x] `docs/10-user-guide.md` 有「让 AI 帮你操作电脑」章节（§9，含 TOC 与章号同步）；
      `docs/11-privacy.md` §6 表里出现「PowerShell」与「文件」两行；`docs/README.md` 状态段提到
      思考等级与电脑操控工具
- [x] `AGENTS.md` 里「尚未生效 / 已知限制」段没有被过时描述污染
      （复核：无任何一句暗示「没有命令执行能力」；本轮能力写在 docs/README 与 docs/04）

## 交接

- 本步结束后，`step/00-index.md` 的「完成标准」应全部可勾选；把每步的执行记录与提交清单补进索引。
- 归档前由 step 7 复核：所有 step 文件 Status = done、验收标准已勾选。
- 提交规范：按「一个功能一个 commit」拆（建议：`feat(v0.7.0): 模型思考等级端到端生效`、
  `feat(v0.7.0): 新增终端命令执行工具`、`feat(v0.7.0): 新增文件与打开类操控工具`、
  `feat(v0.7.0): 电脑操控设置页与开关热生效`、`docs: 电脑操控能力与隐私说明`），描述用中文。

## 执行记录

**状态：done（2026-09-20）· 提交 `b89fa30`（smoke 断言）、`1942243`（文档收口 + 06 §11 修正）**

### 子代理分片（同波，写范围互不重叠）

| 分片 | 负责文件 | 结果 |
|---|---|---|
| 主代理 | `main/index.ts` 新增 smoke 断言、`smoke.ts` 调用点、最终验收 | 完成 |
| 子代理 `1c5e89ae` | `docs/10-user-guide.md`、`docs/11-privacy.md` | 完成（含 2 处由本轮改动直接导致的既有描述修正） |
| 子代理 `e41edef8` | `docs/04-roadmap.md`、`docs/README.md` | 完成（新增 P6++ 小节 + 状态段，未动版本号） |
| 子代理 `baf789aa`（**只读**） | 核对 `docs/06 §11` / §3 与实现 | 完成：找到 2 处「文档写多/写错」+ 1 处写少，**全部由主代理改文档修掉** |

### 第一轮 smoke 真跑出来的两个 FAIL（已修）

1. `settings.update(全新 provider)` / `settings.update(改模型名)` 失败：`reasoningEffort` 变成必填字段后，
   `smoke.ts` 里注入的渲染层脚本中两处**新建** provider 的字面量没带该字段 → Schema 拒绝。
   （既有 provider 的 patch 因 `applyPatch` 会合并当前值而幸免，所以只有「全新 provider」路径炸。）
2. 自测新断言的 `list_dir` 查不到刚写的文件 —— 是**断言写错**，不是功能坏了：
   产物原本直接丢进 `%TEMP%`，而 `list_dir` 默认上限 200 条且**目录排在文件前面**，
   本机临时目录有 2138 个子目录，文件被整段截掉。改为写进专用的空子目录后通过。

### 独立规格审查发现并修正的 06 §11 不实描述

`docs/06 §11` 有 6 处与代码不符（代码是对的），已全部按实现改文档：
确认卡片展示的是模型**原始参数**（不是解析后的绝对路径）；`workspaceDir` 只作 `run_command`
的缺省 `cwd`（文件类工具不读它，相对路径按主进程 CWD 解析）；补 stdout / stderr 各自 1 MiB
**丢尾**上限；`open_path` 的 `explorer` 措辞改正；补参数钳制与「未注入 `confirmTool` 即不拦截」；
§11.2 由「能力等同」改为「能力相当，且以 `-ExecutionPolicy Bypass` 启动，更宽松但非管理员提权」。
`docs/08` 与 `AgentPage.vue` 的文案同步该口径。

### 全量验证（主代理实跑）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm test` | 48 文件 / 678 用例全过 |
| `pnpm build` | exit 0 |
| `pnpm verify` | **26/26 项通过**（含 `config.version = 当前版本 — version=5`） |
| `AURORA_SMOKE=1 pnpm dev` | **98/98 PASS**、退出码 0；四条新断言全 PASS |
| `AURORA_CAPTURE=%TEMP%\aurora-cap-final pnpm dev` | 退出码 0、18 张 PNG、无 FAIL |
| `pnpm lint` / `prettier --check` | exit 0 / 全部通过 |

### 遗留

- **手工真实对话验收未做**：本机 `%APPDATA%/Aurora/config.json` 里**有**可用 provider
  （`llm.active=deepseek`，已存密钥），但该验收要求在开发态界面里发话并在确认卡片上点「允许一次」，
  属人机交互步骤，本 agent 无法点击 GUI。等价证据已具备：确认链路由 `proactive.test.ts` 覆盖，
  真实执行链路由本步 smoke 的「真实 `run_command` → `read_file` 读回 → `list_dir` 列出」覆盖。
- 审查提示的「文件类工具相对路径按主进程 CWD 解析」对用户不够直观：改它需要动已定稿的
  `FilePort` 端口契约（属计划外接口变更），本轮只把事实写准，留作后续项。
