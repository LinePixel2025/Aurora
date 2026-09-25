# 任务：完善 Agent 能力——让模型真正操控电脑（思考等级设置 + 终端/文件/打开类工具）

- 任务标识：`computer-control`
- 项目根目录：`D:\AICOP\Projects\Aurora`
- 创建时间：2026-09-20 17:13
- 基线提交：`01d24752482ce3c6dfa660f0905d8bfa207502de`
- 归档目录：`step/archive/20260922-123340-computer-control`
- 归档时间：2026-09-22 12:33

## 任务背景（为什么这么拆）

现状（v0.6.0）：Agent 内核只有 `use_skill` 一个内置工具（`packages/agent-core/src/skills/bridge.ts`），
MCP 工具是外部进程提供的；模型**没有任何直接操作本机的能力**。
同时 `temperature` 是唯一的生成参数，「思考等级」这类现代模型参数完全无法下发。

本任务的目标是把「内核只有对话能力」补成「内核能真正在本机执行动作」，并为模型请求补上思考等级参数。
安全模型沿用仓库既有约定：`ToolDefinition.sensitivity = 'confirm'` + `ProactiveScheduler` 确认卡片 +
`advanced.confirmSensitiveTools` 开关，命令与文件写入一律先确认再执行。

**不在本次范围**（写进 docs/06 §11 的非目标，别顺手做）：鼠标键盘模拟 / 截图录屏 / 持久交互式 shell /
命令黑名单正则、Work·Code Mode 功能、Anthropic 等非 OpenAI 兼容协议。

## 步骤

| # | 文件 | 标题 | 状态 | 依赖 |
|---|------|------|------|------|
| 1 | step-01-contract-and-config.md | 契约与配置基线（docs 先行 + Schema v5 + 迁移） | done | - |
| 2 | step-02-reasoning-effort.md | 模型思考等级全链路（内核 → 主进程 → 设置页） | done | step 1 |
| 3 | step-03-terminal-tool.md | 终端工具：内核纯逻辑 + 真实 PowerShell 执行器 | done | step 1 |
| 4 | step-04-file-and-open-tools.md | 文件与「打开」操控工具 | done | step 1、step 3（端口形状对齐） |
| 5 | step-05-wiring-and-settings-page.md | 装配、开关热生效、设置页与截图探针 | done | step 2、3、4 |
| 6 | step-06-e2e-and-docs.md | 端到端验收（真实命令 + 开关热生效）与文档收口 | done | step 5 |
| 7 | step-07-archive.md | 归档清理 | done | step 1..6 |

## 完成标准

- [x] `pnpm typecheck && pnpm test && pnpm build` 全绿（与 CI 同一套检查）。
      —— typecheck 0 / test 48 文件 678 用例 / build 0 / **verify 26/26** / lint 0 / prettier 全通过。
- [x] `AURORA_SMOKE=1 pnpm dev` 自测报告中出现并 PASS：电脑操控工具已注册、真实执行 `run_command` 后
      `read_file`/`list_dir` 能读回产物、总开关关闭后工具从注册表移除。
      —— **SUMMARY 99/99 PASS，退出码 0**；「总开关」那条是本轮审查指出缺口后补上的（提交 `27a3736`）。
- [x] `AURORA_CAPTURE=<dir> pnpm dev` 退出码 0、`report.json` 无 FAIL：设置页 7 页（新增 `settings-agent.png`），
      并新增 `settings-llm-params.png`（思考等级断言）；PNG/场景总数按 `report.json` 实际条目数记入
      `AGENTS.md` 与 `docs/07 §5.3`（基线 16，本任务 +2）。
      —— 实测 18 张 PNG、退出码 0、**0 FAIL**（口径：10 条带探针的条目 0 失败，另 8 条仅有文件写出回执）。
- [x] `docs/06 §11`、`docs/08 §1/§2`、`docs/11 §6` 与实现一致；`docs/README.md` 状态段记录本轮新增能力。
      —— 由只读规格审查逐条核对并修正 6 处不实描述后达成（提交 `1942243` / `580cad6` / `3fe73a6`）。

## 执行记录

（供执行阶段追加：每步的实际改动与验证结果、git 提交清单、代码审查结论与处置）

### 执行前：工作区旧改动单独提交

开工时工作区带着一批**与本任务无关**的未提交改动（对话消息区自动滚底 + 截图探针）。
按用户决定先单独提交，避免混进本任务的提交历史：

- `ee48dbf` fix(chat): 消息区不跟随最新，补自动滚底与「回到最新」胶囊

### Step 1 — 契约与配置基线 ✅ done

- 改动：docs/06 §11（+§3 一句）、docs/08 v5（§1/§2/§6/§6.1）、docs/07 §2.5 侧栏 7 项；
  `schema.ts`（CONFIG_VERSION 5 + reasoningEffort 枚举 + agent.tools + COMPUTER_TOOL_NAMES）、
  `defaults.ts`（DEFAULT_AGENT_TOOLS / DEFAULT_REASONING_EFFORT）、`migrations.ts`（v4 → v5）与三个单测；
  调用点适配（LlmPage / onboarding / smoke 桩配置 / verify-p1.mjs / classification.test.ts）。
- 计划外必要改动：`fieldAccepts` 补**枚举值**校验（否则非法 `reasoningEffort` 会把整份配置判为损坏）。
- 验证：`pnpm build:packages` / `pnpm typecheck` / `pnpm lint` 全 exit 0；
  `pnpm test` 43 文件 608 用例全过（shared 包 80 用例）。
- 提交：`b049b65`（docs 先行）、`07b5455`（Schema v5 + 迁移）

### Step 2 — 模型思考等级全链路 ✅ done

- 改动：内核 `ReasoningEffortLevel` 类型 + `ChatRequest.reasoningEffort` →
  `openai-compat.buildBody` 写 `reasoning_effort` → `agentLoop` → `agentHost` → 主进程
  `createProviderFactory` 把 `'auto'` 映射成「不下发」；`LlmPage.vue` 新增「思考等级」下拉；
  `fakeProvider` 记录该字段；capture 新增 `settings-llm-params.png` 探针。
- 验证：全仓 `pnpm test` 48 文件 / 678 用例全过；`pnpm typecheck` / `lint` / `prettier` 全 0；
  `AURORA_CAPTURE` 退出码 0，`settings-llm-params` 探针 `pass: true`（`value: "high"`）。
- 提交：`2ce1bf7`

### Step 3 — 终端工具 ✅ done

- 改动：`agent-core/src/tools/terminal.ts`（`run_command`，confirm，纯逻辑 + 注入 runner）、
  `main/tools/command-runner.ts`（真实 `powershell.exe`，不走 shell，UTF-8 前缀，
  超时/取消 `taskkill /T /F` 杀进程树）、两者单测。
- 验证：28 用例全过（含中文编码回归、`Start-Sleep` 800ms 超时真被杀、孙进程一并被杀并有正/负对照）；
  主代理修掉一处 `prefer-const` lint 错误后 `pnpm lint` 0。
- 提交：`1f41447`

### Step 4 — 文件与「打开」操控工具 ✅ done

- 改动：`agent-core/src/tools/files.ts`（4 个工具 + 端口注入）、`main/tools/file-port.ts`
  （NUL 二进制探测、原子写、字节数而非字符数）、`main/tools/open-port.ts`（`openExternal` / `openPath`，
  非空返回值即失败）、两者单测。
- 验证：30 用例全过；`typecheck` / `lint` / `prettier` 全 0；`%TEMP%` 无残留测试目录。
- 提交：`e16d6d5`

### Step 5 — 装配、开关热生效、设置页与截图探针 ✅ done

- 改动：`main/tools/index.ts` 装配器（`sync()` 幂等 + 按当前配置重建，总开关关闭即全部摘除）、
  `main/index.ts` 接线（启动 + `onSettingsChanged` 各一次即「热生效」）、`openPath({kind:'workspace'})`、
  `SettingsPatch.agent`、`AgentPage.vue`（5 张卡 + 生效工具清单）、侧栏第 7 项、
  `SETTINGS_AGENT_FIELDS_SCRIPT` 探针、`AGENTS.md` / `docs/07 §5.3` / `docs/08 §6.1` 计数与门控同步。
- 验证：`pnpm vitest run apps/desktop/src/main/tools` 28 用例全过；`typecheck` / `build` / `lint` 全 0；
  `AURORA_CAPTURE` 退出码 0、**18 张 PNG**、无 FAIL，`settings-agent` 探针 `pass: true`
  （`total: 8`、`terminalFields: 3`、`filesFields: 2`、`openFields: 1`）。
- 提交：`fe142c4`

### Step 6 — 端到端验收与文档收口 ✅ done

- 改动：`main/index.ts` 新增「4. 电脑操控工具」四条 smoke 断言（注册齐全 / 敏感级 / 真实命令 +
  读回 / 开关热生效）；`smoke.ts` 两处新建 provider 补必填 `reasoningEffort`；
  `docs/10`（新增 §9 让 AI 帮你操作电脑）、`docs/11`（§6 权限表 + 不做事 + 命令自身联网）、
  `docs/04`（P6++ 小节 + 阶段行 + 状态段）、`docs/README.md`（v0.7.0 三条）、
  `docs/06 §11` 按独立审查结论修正 6 处不实描述、`docs/08` 与 `AgentPage.vue` 文案对齐。
- 验证：`typecheck` 0、`test` 48 文件 678 用例、`build` 0、`verify` **26/26**；
  `AURORA_SMOKE` **98/98 PASS**（退出码 0）；`AURORA_CAPTURE` 退出码 0、18 张 PNG、0 FAIL；
  `lint` / `prettier` 全 0。
- 提交：`b89fa30`（smoke 断言）、`1942243`（文档收口 + 06 §11 修正）
- 遗留：手工真实对话验收需人在确认卡片上点「允许一次」，本 agent 无法操作 GUI，未做
  （确认链路已由 `proactive.test.ts` 覆盖、真实执行链路由 smoke 覆盖）。

## 提交清单（本任务）

| SHA | 说明 |
|---|---|
| `ee48dbf` | fix(chat): 消息区不跟随最新，补自动滚底与「回到最新」胶囊（**开工前的旧改动，按用户决定单独提交**） |
| `b049b65` | docs: 先行补齐思考等级与电脑操控工具规格（06 §11 / 08 v5 / 07 侧栏） |
| `07b5455` | feat(v0.7.0): 配置 Schema v5（思考等级枚举 + 电脑操控工具配置 + v4→v5 迁移） |
| `2ce1bf7` | feat(v0.7.0): 模型思考等级端到端生效 |
| `1f41447` | feat(v0.7.0): 新增终端命令执行工具 |
| `e16d6d5` | feat(v0.7.0): 新增文件与「打开」类操控工具 |
| `fe142c4` | feat(v0.7.0): 电脑操控设置页与开关热生效 |
| `b89fa30` | test(smoke): 新增电脑操控工具端到端断言（真实命令 + 开关热生效） |
| `1942243` | docs: 电脑操控能力与隐私说明，并修正 06 §11 与实现不一致处 |
| `27a3736` | test(smoke): 补「总开关」热生效断言，并转义自测命令里的路径 |
| `580cad6` | docs: 按独立审查结论修正文档与注释口径（绝对路径 / 参数截断 / 读取出网 / 能力边界 / 计数） |
| `3fe73a6` | docs: 摘掉「会话中止 = 在途确认作废」这条不成立的承诺 |

## 代码审查结论与处置

全部工作步骤完成后，按维度派出 **5 个独立审查子代理**（干净上下文、均非本代码作者，
且都事先被告知排除开工前那笔 `ee48dbf`）：

| 维度 | 结论 | 关键发现 |
|---|---|---|
| 正确性 / 完成标准逐条比对 | 有条件可交付 | 完成标准第 2 条「**总开关**移除工具」在 smoke 报告里没有字面证据（只有分开关版本） |
| 安全与边界 | 有条件可交付 | 无 P0；3 条 P1 全部指向**既有**缺口或文档失真，非本轮引入 |
| 测试质量 | 有条件可交付 | 无系统性弱断言、无恒真探针；杀进程树缺**负**对照；`auto → undefined` 无单测；`open_path` 真实执行零覆盖 |
| 仓库约定一致性 | 有条件可交付 | 6 条架构硬约束全部守住；`fieldAccepts` 枚举改动对其动机字段（`llm.providers.*`）**实际无效**、注释误导 |
| 验收命令独立复跑 | **可交付** | 5 条命令全部 exit 0；smoke 98/98、capture 18 张 0 FAIL 均从产物复现 |

**已修（本任务范围内，共 3 个提交）**

- `27a3736`：补 smoke 的**总开关**热生效断言（完成标准第 2 条的字面证据），
  并把自测命令拼进 PowerShell 单引号字面量前做转义；顺手修掉总开关日志 `{names: []}` 无信息量。
- `580cad6`：文档与注释口径 —— 删掉不存在的「提示词要求绝对路径」承诺、
  如实写出确认卡片**会截断**超长参数、披露 `read_file` 免确认且内容出网/落会话、
  统一「能力相当（更宽松但非提权）」口径、修掉文档计数枚举与过期注释、
  `schema.ts` 枚举注释写明真正生效的是 4 个静态路径。
- `3fe73a6`：摘掉「会话中止 = 在途确认作废」这条不成立的承诺（`rejectAll()` 只接到 `dispose()`）。

**已登记、未修（越界或属独立决策，见给用户的收尾说明）**

1. **P1（既有，v0.1.0 起）**：`LlmPage.saveProvider()` 显式回传 `apiKeyEnc: ''`，而
   `ipc.ts` 的 `applyPatch` 是 `{...existing, ...patch}` → 从「AI 模型」页保存会**清空该 provider
   已存的密文**（进程内靠 `memorySecrets` 仍可用，重启后需重填）。本任务新增的「思考等级」下拉
   正落在这条保存路径上，扩大了触发面。
2. **P1（既有）**：`rejectAll()` 未接 `chat:abort`（已在文档里如实标注为已知缺口）。
   真正接线要注意它是**全局**拒绝，会影响其它会话的在途确认。
3. **P1（设计取舍）**：`read_file` / `list_dir` 为 `safe` + 无路径限制 + 内容进模型上下文与
   `sessions/*.json`。本轮只补了文档披露；「越界读取也要确认」属改敏感级，需产品决策。
4. **P2**：确认钩子未注入时 fail-open（应用内恒注入，但有测试固化该行为）；
   `workspaceDir` 目录不存在时回落 `process.cwd()` 而非主目录；`list_dir` 先全量 `stat` 再 `slice`；
   `open_path` 对可执行文件/自定义协议/UNC 无种类限制；关闭确认后的日志留痕不含参数。
5. **P3**：`command-runner.test.ts` 有 `maxOutputBytes` 溢出 / `killGraceMs` / `spawn` 失败
   三个分支无覆盖；`open-port.ts` 无单测；`terminateProcessTree` 的 `execFile` 无 timeout；
   原子写临时名可能在同一毫秒内撞名；`write_file` 无内容长度上限；无并发上限。
6. **版本号**：提交与文档按计划口径写 `v0.7.0`，但 `package.json` 仍是 `0.6.0`
   —— 这是计划书明确要求「不要改版本号，版本提升属于发布步骤」的结果，**非疏漏**。
