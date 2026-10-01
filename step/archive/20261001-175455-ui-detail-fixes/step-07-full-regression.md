# Step 07 — 全量回归与视觉核对

- Task: ui-detail-fixes
- Step: 7 / 8
- Status: done
- Depends on: step 1、2、3、4、5、6
- Produces: 一份「六条问题逐条闭合 + 全量质量门禁全绿」的验收结论（写进 `step/00-index.md` 的执行记录）
- Phase: 测试与文档
- Writes: `apps/desktop/src/main/capture.ts`（仅当全量报告里出现与本轮改动直接相关的 FAIL 时按报告修探针）、`apps/desktop/src/main/index.ts`（同上，仅限 smoke 夹具）、`step/00-index.md`（执行记录）
- Size: M
- Risk: ① 各步只跑过定向场景，全量一轮才能暴露「场景之间互相污染」（历史上真实发生过：一条探针把跟随关掉没恢复，后面那条恒红）；② 全量 `AURORA_CAPTURE` 必须**串行**跑、且中途不要与其它的截图 / smoke 并发；③ 本机执行前必须 `Remove-Item env:ELECTRON_RUN_AS_NODE`，否则 Electron 会当纯 Node 起、主进程在 `!electron.app.isPackaged` 崩（看着像打包产物坏了）。

## 目标

在完整质量门禁下确认这一轮六项改动全部落地且没有引入回归，并把结论落进 `step/00-index.md` 的执行记录。

## 输入

- 前六步的 `执行记录`（各自的定向验证结果与遗留问题）。
- 基线（`step/00-index.md` 的「现状与关键结论」）：`pnpm typecheck` 0 错、`pnpm test` 118 文件 / 2101 用例全绿；`pnpm format:check`（44 文件）与 `pnpm lint`（3 error）**改动前就红**，不是本轮回归。
- 命令口径（`AGENTS.md`）：全量冒烟 `$env:AURORA_SMOKE='1'; pnpm dev`，约 25 秒，基线 `SUMMARY 176/176 passed`，结果在 `%TEMP%\aurora-smoke-logs`；全量截图 `$env:AURORA_CAPTURE="$env:TEMP\aurora-capture"; pnpm dev`，3–5 分钟，结果看 `report.json`（有 FAIL 时进程退出码为 2）；`pnpm verify` 需要先 `pnpm build`。
- 视觉核对口径：`AURORA_CAPTURE` 产出的 PNG 需要**你自己用 Read 工具逐张看**（本环境的 visual-judge 子代理只覆盖 pptx/docx/xlsx/pdf/poster/chart，不覆盖应用窗口截图）。
- 本轮要闭合的六条（`step/00-index.md` 的完成标准逐条对照）：
  1. 通用页无「会话管理」说明句；2. 权限下拉文字不出框；3. 上下文详解卡只剩三行；4. 输入卡无「Enter 发送」且模型/思考下拉未被挤压；5. 生图模型空态有添加按钮；6. 上下文窗口 / 图片输入 / 思考等级随模型绑定、temperature 字样彻底消失。

## 操作

1. 静态门禁（可在同一个 shell 里顺序跑）：`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm verify`。任何一条失败都先回到对应步骤修，而不是在这里改判据。
2. 全量端到端冒烟：PowerShell 下
   ```powershell
   Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
   $env:AURORA_SMOKE='1'; pnpm dev
   ```
   跑完看 `%TEMP%\aurora-smoke-logs` 里的 `AURORA_SMOKE_RESULT` 汇总。基线是 176 条全绿；条数若与基线不符，必须逐条说明差异只来自本轮有意的断言调整（例如多模态段 2.8 的夹具），不得出现新的失败项。
3. 全量截图：PowerShell 下
   ```powershell
   Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
   $env:AURORA_CAPTURE="$env:TEMP\aurora-capture-final"; pnpm dev
   ```
   跑完读 `report.json`（张数以报告实际条目为准，不要按固定张数校验）：要求 **0 FAIL**；有 FAIL 时按报告里的探针返回值判断是「探针过期」还是「实现不对」——前者按本步的 `Writes` 范围修探针并复跑那几张（`$env:AURORA_CAPTURE_ONLY='failed'`），后者回到对应步骤修实现。
4. 视觉核对（用 Read 工具打开 PNG 逐张看，重点四张）：
   - `chat-composer-permission.png`：权限菜单说明文字在卡片内折行、无横向溢出；工具行右侧无「Enter 发送 · Shift + Enter 换行」；模型 / 思考两枚下拉文字完整可读。
   - `settings-llm-params.png` 与 `settings-llm-multimodal.png`：参数在模型行内（思考等级 / 上下文窗口 / 支持图片输入），整页无 temperature 字样；接口类型仍在 provider 折叠区。
   - `settings-llm.png`：生图模型空状态有「+ 添加生图模型」按钮（该场景同时跑 `SETTINGS_LLM_FIELDS_SCRIPT`）。
   - `settings-general.png`：通用页没有关于会话管理的说明句（该场景跑 `SETTINGS_FIELDS_SCRIPT`，含 `projects.* === 0` 的回归护栏）。
   同时抽查 `chat-composer-flyouts.png`：上下文详解卡只有三行且不盖住工具行。
5. 把六条问题的闭合结论、四个门禁命令的实际输出摘要（通过/失败、条数）、以及全量截图的关键图名与结论，追加进 `step/00-index.md` 的「执行记录」；有任何未闭合项就如实写上并说明影响面。

## 验收标准

- [ ] `pnpm typecheck` 退出码 0；`pnpm test` 的 `Test Files` / `Tests` 计数不小于基线 118 / 2101 且无 failed；`pnpm build` 成功；`pnpm verify` 通过（会断言 `version === 23` 与迁移条数 = `CONFIG_VERSION`）。
- [ ] 全量 `AURORA_SMOKE` 的 `SUMMARY` 无 FAIL（基线 176 条），差异已逐条说明。
- [ ] 全量 `AURORA_CAPTURE` 的 `report.json` 里 `pass === false` 的条目数为 0。
- [ ] 上述四张 PNG 的人工核对结论已写进 `step/00-index.md`（逐条写「看到什么」，不是「已核对」）。
- [ ] `step/00-index.md` 的「执行记录」里能一条条对上完成标准的三项（静态门禁 / 冒烟 / 截图与视觉核对），没有悬空的「待办」。

## 交接

- 全量结论落进 `step/00-index.md`，供 step 8 归档时原样带进 `archive/<时间戳>-ui-detail-fixes/REPORT.md`。
- 若本步改了 `capture.ts` / `index.ts`，把改动内容与原因写进执行记录（归档报告需要）。

## 执行记录

**本步未改任何源码**（全量报告 0 FAIL，无需修探针）。

### 1. 静态门禁（主代理实跑）
| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 5 个包全 `Done`，**0 错** |
| `pnpm test` | `Test Files 119 passed (119)` / `Tests 2117 passed (2117)`，约 20s |
| `pnpm build` | 成功（三包 + Electron 三段产物） |
| `pnpm verify` | **26/26 项通过**，含 `config.version = 当前版本 — version=23`、`执行了 v0 → 当前版本的迁移链 — count=23/23` |

基线对照：typecheck 0 错（同基线）；测试计数 **118 → 119 文件 / 2101 → 2117 用例**，增量全部来自本轮的
`apps/desktop/src/main/llm-params.test.ts`（新增 1 文件 6 用例）与 `packages/shared/src/config/` 三份测试的新增用例
（共 +16 条，无删减 —— 见 step 2/3 执行记录里的 `expect(` 计数对照）。

### 2. 全量端到端冒烟
`Remove-Item env:ELECTRON_RUN_AS_NODE; $env:AURORA_SMOKE='1'; pnpm dev` → `SUMMARY 177/177 passed`，**0 FAIL**。

⚠️ **计划里写的基线「176/176」是陈旧的**（`AGENTS.md` 同款）。用日志实证：`%TEMP%\aurora-smoke-logs\aurora-2026-10-01.log`
里**本任务开工前**的两次全量跑（本地 13:17 / 13:24，早于 00-index 的 16:02 创建时间）已经是 `177/177 passed`。
把开工前那次（日志行 15628–16143）与本轮这次（16494–17509）的**断言名清单**逐条抽出对比：
两者**逐字相同**（各 178 行，含一个重名），即**本轮没有增删任何一条冒烟断言**。
所以「177 而非 176」不来自本轮改动，是本轮之后基线数字没跟上；本轮真正的差异是 0 条。

### 3. 全量截图
`Remove-Item env:ELECTRON_RUN_AS_NODE; $env:AURORA_CAPTURE="$env:TEMP\aurora-capture-final"; pnpm dev`
→ `窗口截图完成 {"written":71}`，退出码 0。读 `report.json`：**71 张图 / 71 条检查项，`"pass": false` 出现 0 次**。

### 4. 视觉核对（Read 工具逐张看，写下「看到什么」）
- `chat-composer-permission.png`：权限菜单三项完整落在卡片内；第三项「完全权限」的说明**折成两行**
  （「有项目：根内免确认，越界仍询问」/「无项目：不再逐次询问」），**没有任何文字画出右边框**；
  工具行右侧只有「变更前确认 / deepseek-ch… / auto / 发送」——**没有「Enter 发送 · Shift + Enter 换行」**；
  两枚下拉文字完整（模型名按设计省略号截断，与发送按钮之间有明显 `.grow` 空隙，说明未被挤压）。
- `settings-llm-params.png`：`deepseek-chat`「当前使用」行内展开着三枚控件 ——
  「思考等级 = high（更深入）」「上下文窗口 = 0」「☐ 把拖入的图片交给这个模型」+ 一行说明，左侧有竖线区分层级；
  **整页没有任何 temperature 字样**；下方「高级参数与连接测试」折叠区里**只剩「接口类型」**
  （OpenAI 兼容 /chat/completions）+ 保存并测试连接 / 拉取模型列表。
- `settings-llm-multimodal.png`：同位置显示「思考等级 = auto（不指定，兼容性最好）」「上下文窗口 = 0」
  「**☑** 把拖入的图片交给这个模型」，接口类型为 `OpenAI Responses API (/responses)`。
- `settings-llm.png`：生图模型区组完整可见 —— 「还没有可选的模型：先添加一个生图模型。」+ 带虚线的空状态卡
  （`data-empty="imagegen.providers"`）+ **可点的蓝色主按钮「+ 添加生图模型」**。
- `settings-general.png`：「启动」卡（开机自启 / 以管理员身份运行 / 唤出快捷键）下面**直接**是「外观」卡 ——
  那句关于会话管理的说明与空壳卡已消失，页面无残留空段。
- `chat-composer-flyouts.png`（抽查）：探针返回 `detailRows:3`、`detailLabels:["输入（最近一轮）","上下文窗口","模型"]`、
  `detailNoteClean:true`、`mutual:true`、`barClear:true`、`sendClickable:true` —— 详解卡三行且不盖住工具行。
- `chat-stream.png`（step 4 遗留项的闭合）：折叠条仍是 **「上下文 512 / 128k · 缓存命中 512（100%）」+ 进度条 +
  「0.4%」+「累计 528」**，与改动前一致 —— 详解卡精简没有波及折叠条。

### 5. 六条问题的闭合结论
| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | 通用页有会话管理说明句 | ✅ 已删 | `settings-general.png` 人工核对 + `projectsFields:0` 回归护栏 PASS |
| 2 | 权限下拉文字溢出卡片 | ✅ 已修 | `.perm-item-body` 的 `white-space: normal` 治根；探针 `noOverflow:true` / `menuOverflow:0` + PNG 核对折行 |
| 3 | 上下文详解卡冗长 | ✅ 精简为三行 | 探针 `detailRows:3` + 标签恰为「输入（最近一轮）/ 上下文窗口 / 模型」，`ctx-note` 不含「消息条数」 |
| 4 | 输入卡有常驻「Enter 发送」 | ✅ 已移除 | `grep composer-hint\|shortcutHint` 无命中 + PNG 核对工具行 |
| 5 | 生图模型空态无入口 | ✅ 已补主按钮 | `settings-llm.png` 人工核对 + `imagegenEmpty:true` |
| 6 | 参数绑错层级、temperature 未删 | ✅ 参数随模型走、temperature 全清 | 配置 v23（`modelParams`）+ 可写面收窄；三册文档同步；模型行内参数 UI + PNG 核对 |

### 遗留问题
- 无未闭合项。两条**已知限制**（不属本轮范围、未修）记在 step 2 的执行记录与 `00-index`：
  ① `lookupSpec`/`lookupEnum` 的单段通配限制（对双动态段路径惰性，已有 `it.fails` 探针）；
  ② v23 之后 `modelParams` 子树里的非法值没有字段级回退（写入方必须写全三项，本轮三处写入点都已遵守）。
- 本步**没有**修改 `capture.ts` / `index.ts`，因此归档报告里无需交代探针改动。

---

## 代码审查（独立子代理，6 个维度 + 1 次复核）

### 审查安排
按 skill 的分档：diff ≈ 2000+ 行、含**数据迁移**与**公共接口变更** → 属「大改」，派 **6 个只读 `Reviewer` 子代理按维度拆开**
（迁移与配置层 / 可写面与安全边界 / 运行时接线与 Center / 对话窗与设置页 UI + 探针 / 测试质量 / 文档 SSOT + 项目约定 + 独立复跑），
分两批各 3 个并行；全部使用干净上下文（无一参与过实现）。修完两轮后再派 **1 个复核代理**验证修复。

### 首轮结论与处置
| 维度 | 首轮结论 | 处置 |
|---|---|---|
| 迁移与配置层 | 可交付（2 P2 + 4 P3） | P2-1（迁移合并顺序）**已修**；其余 P2/P3 见下 |
| 可写面与安全边界 | 有条件可交付（**1 P1** + 1 P2 + 3 P3） | P1（含点模型 id 写不了）**已修** |
| 运行时接线与 Center | 可交付（3 P3） | P3-1（远程静默 no-op）**已修**、P3-2（陈旧注释）**已修** |
| 对话窗与设置页 UI + 探针 | 可交付（5 P3） | 3 条**已修**（探针零元素护栏 / ACT 保留兄弟字段 / 补新按钮断言 + 去重复文案），2 条记录 |
| 测试质量 | 有条件可交付（**2 P2** + 5 P3） | 两条 P2 **已修**（见下），4 条 P3 **已修** |
| 文档 SSOT + 约定 | 有条件可交付（1 P1 + 2 P2 + 3 P3） | P1 与上面同源**已修**；两条 P2 **已修**；P3 部分已修 |

### 已修的审查发现（按提交）
- `63da971` 覆盖表支持 `**` 段（含点模型 id 可写）+ 边界防退化用例；`c2f7722` 迁移合并改用**原始**条目
  （兑现「旧值补缺键」，此前实现会把旧值整条丢掉）；`d5d92c6` 远程切档在 provider 无生效模型时显式报错；
  `1fb9be2` 清掉 9 处仍指向 provider 级旧路径的注释。
- `9d5e23c` **给 `LlmModelParamsSchema.reasoningEffort` 补 `.default('auto')`** —— 审查实测：
  手改配置漏写这一个字段（它是三兄弟里唯一没有默认值的）会让 `SettingsSchema.parse` 抛错，
  走「备份 + 重建出厂配置」，用户的 provider / 凭据 / 项目配置一起丢。补默认值后只回落 `auto`；
  值**非法**仍判非法（只兜「缺」不放过「错」，复核代理逐格实测 10 组输入确认）。
- `c0b28da` 探针三处加固：`temperatureFields === 0`（「设置页不再有 temperature」的**反向**护栏）、
  `imagegenAddButtons > 0`（生图空态按钮可点，此前只有人眼看 PNG）、`noOverflow` 加 `menuBoxes.length > 0`
  （零元素时不再恒真）；两条设置页 ACT 改成保留该模型已有的兄弟字段（不再把 `contextWindow` / `vision` 写死）。
- `e653bde` 补登记 `**` 段语义、改准 `docs/07` 一处 provider 级旧路径。
- `4f8b04d` **`settings-port.ts` 的可写判定改回「覆盖表先于黑名单」**（详见下）。
- `0091b95` 远程切档守卫只在「本次不改模型」时才拦（同时传 `model` + `reasoningEffort` 且当前无模型原本可用）；
  `matchesPattern` 拒绝多于一个 `**`（避免模式静默永不命中）。
- `02f5d77` 改准约 20 处「`reasoningEffort` 没有 `.default()`」的注释（补默认值后该因果已不成立）。

### 修复过程中发现的**既有 P1**（本轮一并修掉，理由见下）
`apps/desktop/src/main/tools/settings-port.ts` 的 `reasonOf` **把判定顺序弄反了**：它先拿用户配置的
`advanced.readonlyPrefixes` 做前缀匹配（该字段的**默认值就是硬编码黑名单的镜像**，含 `llm.providers`），
再问 `canWriteSettingPath`。于是覆盖表对 `llm.providers.<id>.model` 与
`...modelParams.<modelId>.reasoningEffort` 的放行**一次都没生效过** —— 工具 description / `settings-hint` /
`docs/06 §12.2` / `docs/08 §1` 四处都承诺这两条可写（`docs/08 §1` 更明文写着「覆盖表的判定**先于**
`advanced.readonlyPrefixes` 黑名单」），实际每次都回「「llm.providers」属于不可修改的配置」。
复核代理用真实端口实测确认（`writable('llm.providers.deepseek.model')` → `ok:false`），并指出这与仓库既有的
「承诺可写 = 写入可写（P1-06）」是同一缺陷类（`TOP_LEVEL_GROUPS` 上修过一次）。
**处置：修。** 硬编码规则成为唯一权威，用户配置项只认得「硬编码清单之外」的追加项（「只能追加限制、
不能放宽」这条承诺仍然成立）；凭据 / `contextWindow` / `vision` 依旧一个字写不进去。
**耦合修复**：覆盖表承认含点模型 id 可写，写路径就必须能把模型 id 还原 —— 同一提交里恢复了
`splitSettingPath`（`llm.providers.<id>.modelParams.<模型 id>.<字段>` 按已知结构重建段边界），
否则一修闸门就会「把 fail-closed 的拒绝换成写到错误的键上」。新增 4 条端口层用例
（含点 id 往返 / 切模型 / 凭据与能力事实仍拒 / 用户追加前缀仍生效）。

### 遗留（4 条，**已按用户要求于归档前全部处理**，`be9bda2` / `d2e91f5` / `9aaf862`）
> 处理结果：① vitest include 补 `packages/*/web/src/**/*.test.ts`，`extractRemoteLlm` 抽成纯模块
> `packages/center/web/src/remote-llm.ts` + 5 条单测；② 远程 `llm.switch` 守卫抽成
> `main/llm-params.ts` 的 `llmSwitchRejection` + 5 条单测（四条分支 + 合法组合）；
> ③ `lookupSpec` / `lookupEnum` 改逐段匹配、双动态段路径不再放行，两条现状断言翻成期望行为；
> ④ **不修**（`docs/08 §1` 既定语义的必然结果）。修完后的最终门禁：
> `pnpm typecheck` 0 错 / `pnpm test` 120 文件 2132 用例 / `pnpm build` / `pnpm verify` 26/26 /
> `AURORA_SMOKE` 177/177 / `AURORA_CAPTURE` 71/71 且 0 FAIL。

### 原始遗留清单（留档）
1. **`packages/center/web/src/**` 不在 `vitest.config.ts` 的 include 内**（只覆盖 `packages/*/src/**`），
   且该目录零测试文件 —— 往那里写用例会**静默不跑**。复核代理确认 `extractRemoteLlm` 的手写收窄
   对所有可落盘的值与 `resolveModelParams` 等价（越界值写不进配置），故不算可达缺陷。
   修法：include 加 `'packages/*/web/src/**/*.test.ts'`。
2. **远程 `switchLlm` 的分支零自动化覆盖**（`index.ts` import electron，vitest 收不了；
   `connector.test.ts` 用注入的 spy 只验转发）。建议后续补 `AURORA_SMOKE` 断言。
3. **`lookupSpec` / `lookupEnum` 只做单段 `*` 通配替换** → 双动态段路径的 `fieldAccepts` 按「未登记放行」。
   惰性（该函数只被 `sanitizeWithDefaults` 使用，而它对 `z.record` 子树整体保留、不下钻），
   已由 `schema.test.ts` 两条**现状断言**（先证明不抛异常、再断言当前值，修好后会变红）钉住。
4. `advanced.readonlyPrefixes` 无法再用来封掉「覆盖表已放行的叶子」（如 `llm.providers.x.model`）——
   这是 `docs/08 §1` 既定的「覆盖表先于黑名单」语义的必然结果，非本轮引入。
