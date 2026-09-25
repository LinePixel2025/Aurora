# computer-control 执行报告

- 归档时间：2026-09-22 12:33（本次归档**于该时间**执行；文件随后被移入本目录）
- 任务：完善 Agent 能力——让模型真正操控电脑（思考等级设置 + 终端/文件/打开类工具）
- 基线提交：`01d24752482ce3c6dfa660f0905d8bfa207502de`
- 归档时 HEAD：`3fe73a64ff8d0903324cdf0b18119103fcb4e221`
- 最终验证：`pnpm typecheck` 0 · `pnpm test` 48 文件 / **678 用例**全过 · `pnpm build` 0 ·
  `pnpm verify` **26/26** · `pnpm lint` 0 · `prettier --check` 全覆盖通过

## 提交清单（11 条）

| SHA | 说明 |
|---|---|
| `ee48dbf` | fix(chat): 消息区不跟随最新，补自动滚底与「回到最新」胶囊（**开工前就躺在工作区的旧改动**，按用户决定先单独提交） |
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

## 步骤结果（一行一步）

- **step-01 契约与配置基线**：docs 先行（06 §11 + 08 v5 + 07 侧栏 7 项）+ `CONFIG_VERSION = 5` +
  `reasoningEffort` 枚举 + `agent.tools.*` + `COMPUTER_TOOL_NAMES` + `migrateV4ToV5`；三个单测文件补 v5 断言。
  计划外必要改动：`fieldAccepts` 补枚举**值**校验（原实现下计划要求的断言不可能成立）。
- **step-02 思考等级全链路**：内核 `ReasoningEffortLevel` → `ChatRequest.reasoningEffort` →
  `buildBody` 写 `reasoning_effort`（`auto` 时**完全不写**）→ 主进程装配层映射 `'auto' → undefined`；
  设置页新增「思考等级」下拉；capture 新增 `settings-llm-params.png` 探针（实测 `value: "high"`）。
- **step-03 终端工具**：`terminal.ts`（纯逻辑，`run_command` / confirm / 参数校验 / 超时钳制 /
  head 60% + tail 40% 截断）+ `command-runner.ts`（真实 `powershell.exe`、不走 shell、UTF-8 前缀、
  `taskkill /T /F` 杀进程树、1 MiB 采集上限）；28 用例含中文编码回归与「孙进程一并被杀」的正/负对照。
- **step-04 文件与打开工具**：`files.ts`（4 个工具 + 端口注入）、`file-port.ts`（NUL 二进制探测、
  原子写、字节数而非字符数、错误带绝对路径）、`open-port.ts`（`openExternal` / `openPath`，
  返回非空串即失败）；30 用例。
- **step-05 装配与设置页**：`registerComputerTools().sync()` 幂等重建（cwd / 超时 / 上限热改，
  总开关关闭即全部摘除）→ 启动 + `onSettingsChanged` 各一次即「热生效」；新增「电脑操控」设置页
  （5 张卡 + 生效工具清单，保存回传完整 `agent.tools` 子树）；capture 新增 agent 门控探针；
  文档计数同步为 7 页 / 18 张。
- **step-06 端到端与文档收口**：smoke 新增 5 条电脑操控断言（最终 **99/99 PASS**）；
  docs/10 §9 用户手册、docs/11 §6 隐私表 + 不做事 + 命令自身联网、docs/04 P6++、docs/README v0.7.0；
  并在独立审查后修正 docs/06 §11 的 6 处不实描述。

## 验证证据

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm test` | 48 文件 / 678 用例全过（新增约 80 条：5 个新测试文件 66 条 + 既有文件 +14 条） |
| `pnpm build` | exit 0 |
| `pnpm verify` | **26/26 项通过**（`config.version = 5`、迁移链 `count=5/5`、明文凭据补加密、导出脱敏） |
| `AURORA_SMOKE=1 pnpm dev` | **SUMMARY 99/99 passed**、退出码 0；既有「桩 LLM 收到 3 轮 chat 请求」「历史 5 条」仍 PASS |
| `AURORA_CAPTURE=%TEMP%\aurora-cap-final pnpm dev` | 退出码 0、**18 张 PNG**、0 FAIL |
| `pnpm lint` / `prettier --check` | exit 0 / 全通过 |

## 代码审查结论与处置

按维度派出 **5 个独立审查子代理**（干净上下文、均非本代码作者，并事先排除开工前那笔 `ee48dbf`）：
正确性逐条比对、安全与边界、测试质量、仓库约定一致性、验收命令独立复跑。

- **结论**：0 个 P0；复跑维度给了「**可交付**」，其余四个维度为「有条件可交付」。
- **已修（本任务范围内，3 个提交）**：
  1. `27a3736` —— smoke 补「**总开关**关闭后 5 个工具全部移除」的字面证据（完成标准第 2 条原本只有
     分开关版本），并把自测里拼进 PowerShell 单引号字面量的路径做转义；
  2. `580cad6` —— 删掉不存在的「提示词要求绝对路径」承诺、如实写出确认卡片**会截断**超长参数、
     披露 `read_file`/`list_dir` 免确认且内容会出网并落会话、统一「能力相当（更宽松但非提权）」口径、
     修正文档计数枚举与过期注释、`schema.ts` 枚举注释写明真正生效的是 4 个静态枚举路径
     （`llm.providers.*.reasoningEffort` 在 `z.record` 下、逐字段校验不会被问到，由迁移兜底）；
  3. `3fe73a6` —— 摘掉「会话中止 = 在途确认作废」这条不成立的承诺。
- **登记未修（越界或属独立决策，已如实写入 00-index）**：
  - P1（**既有**，v0.1.0 起）：`LlmPage.saveProvider()` 回传 `apiKeyEnc: ''`，经 `ipc.ts` 的
    `{...existing, ...patch}` 合并会**清空该 provider 已存的密文**；本任务新增的「思考等级」下拉
    正落在这条保存路径上，扩大了触发面。按用户决定**只登记，不动**。
  - P1（**既有**）：`rejectAll()` 只接到 `dispose()`，未接 `chat:abort`（已在 docs/06 §9.1 标注为已知缺口）。
  - P1（设计取舍）：`read_file` / `list_dir` 为 `safe` + 无路径限制 + 内容进模型上下文与 `sessions/*.json`；
    本轮只补文档披露，「越界读取也要确认」需产品决策。
  - P2：确认钩子未注入时 fail-open；`workspaceDir` 目录不存在时回落 `process.cwd()` 而非主目录；
    `list_dir` 先全量 `stat` 再截断；`open_path` 对可执行文件 / 自定义协议 / UNC 无种类限制；
    关闭确认后的日志留痕不含参数。
  - P3：`command-runner` 的 1 MiB 溢出 / `killGraceMs` / spawn 失败三个分支与 `open-port.ts` 无覆盖；
    `terminateProcessTree` 的 `execFile` 无 timeout；原子写临时名可能同毫秒撞名；`write_file` 无内容长度上限。

## 遗留问题

1. **手工真实对话验收未做**：本机 `%APPDATA%/Aurora/config.json` 里**有**可用 provider
   （`llm.active=deepseek`），但该验收需要在开发态界面发话并在确认卡片上点「允许一次」，
   属人机交互步骤，执行代理无法点击 GUI。等价证据：确认链路由 `proactive.test.ts` 覆盖，
   真实执行链路由 smoke 的「真实 `run_command` → `read_file` 读回 → `list_dir` 列出」覆盖。
2. 两条「手工点击」验收（step-02 第 5 条、step-05 第 6 条）为**替代性覆盖**：
   capture 探针走 IPC 直写，未经过 `.vue` 的 `saveProvider()` / 保存按钮，已在 step 文件中如实标注。
3. **文件类工具的相对路径按主进程 CWD 解析**（不是 `workspaceDir`）：打包应用的 CWD 不可预期，
   模型若传相对路径可能读写到意外位置。改它需要动已定稿的 `FilePort` 端口契约，属计划外接口变更，
   本轮只把事实写进文档（docs/06 §11.4、docs/08 §6、设置页文案）并留作后续项。
4. **版本号**：提交与文档按计划口径写 `v0.7.0`，但各 `package.json` 仍是 `0.6.0`
   —— 计划书明确要求「不要改版本号，版本提升属于发布步骤」，**非疏漏**；发布时需一并 bump。
5. 未覆盖的分支清单见上「P3」。
