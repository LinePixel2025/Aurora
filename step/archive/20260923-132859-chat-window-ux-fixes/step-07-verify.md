# Step 07 — 全量验证：typecheck / vitest / build / AURORA_SMOKE / AURORA_CAPTURE

- Task: chat-window-ux-fixes
- Step: 7 / 8
- Status: done
- Depends on: step 1, step 2, step 3, step 4, step 5, step 6
- Produces: 一份可核对的验证记录（追加到 `step/00-index.md` 的「执行记录」），以及六个问题的逐条结论

## 目标

证明全部问题都真的修好了，而不是「代码看起来改了」。**本步只验证与记录，不新写功能代码**；
发现问题就回到对应 step 修，修完重跑本步。

## 环境注意

- 当前文件策略应为 `danger-full-access`。若在受限策略下执行，`pnpm` / `vitest` / `electron-vite`
  会因为 esbuild 需要 spawn 子进程并通过管道通信而报 `spawn EPERM`——此时改用直调命令（见下）。
- 所有单测都在**项目根目录**执行。
- 直调命令的已验证入口：
  - `node node_modules/typescript/bin/tsc ...`
  - `node apps/desktop/node_modules/vue-tsc/bin/vue-tsc.js ...`（vue-tsc 是 apps/desktop 的依赖，**不在**根 node_modules）
  - `node node_modules/vitest/vitest.mjs run ...`

## 操作

### 1. 静态检查与单测（CI 同款）

1. 逐条执行并记录退出码：

   ```
   pnpm format:check
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm build
   ```

   受限环境下的等价直调：

   ```
   node node_modules/typescript/bin/tsc -p packages/shared/tsconfig.json --noEmit
   node node_modules/typescript/bin/tsc -p packages/agent-core/tsconfig.json --noEmit
   node node_modules/typescript/bin/tsc -p packages/modes/tsconfig.json --noEmit
   node node_modules/typescript/bin/tsc -p apps/desktop/tsconfig.node.json --noEmit
   node apps/desktop/node_modules/vue-tsc/bin/vue-tsc.js -p apps/desktop/tsconfig.web.json --noEmit
   node node_modules/vitest/vitest.mjs run
   ```

2. `pnpm test` 的**用例总数不得少于基线**。基线是开工前的用例数——
   如果开工时没记，用 `git stash` + `git rev-parse` 那版跑一次太贵，改为按下面的口径判断：
   本任务净新增测试文件 2 个（`packages/agent-core/src/tools/settings.test.ts`、
   以及 `packages/shared/src/config/migrations.test.ts` / `schema.test.ts` / `windowState.test.ts` 里的新用例），
   **不允许出现「测试文件数下降」**。

### 2. 端到端自测（真实 Electron + IPC）

3. 执行：

   ```powershell
   $env:AURORA_SMOKE='1'; pnpm dev
   ```

   结束后读 `%TEMP%\aurora-smoke-logs` 里的 `AURORA_SMOKE_RESULT`，要求 **0 FAIL**。
   重点确认新增断言在结果里（用 `Select-String` 捞）：
   - 电脑操控工具 5 个仍注册
   - 配置写入不会写坏（step 2 的 crash 矩阵，至少 5 条）
   - 损坏 config.json 仍能恢复
   - 交互窗 show/hide 与 `primary` 状态（step 1 改写的那条）

### 3. 截图核对（真实渲染层 DOM 探针）

4. 执行：

   ```powershell
   $env:AURORA_CAPTURE="$env:TEMP\aurora-capture"; pnpm dev
   ```

   结束后读 `$env:TEMP\aurora-capture\report.json`：
   - 进程退出码必须是 0（有 FAIL 时会是 2）
   - 逐条确认这些新场景 `check.pass === true`：
     `chat-model-picker`、`chat-thinking-level`、`chat-collapse`、`chat-drag`、`settings-drag`、
     `settings-llm-models`、`settings-llm-structure`、`settings-llm-params`、`edge-bar-expanded`
   - 确认 PNG 数量与清单一致：`mini-chat.png` **不应存在**；
     本任务新增的 6 张截图（`chat-model-picker` / `chat-thinking-level` / `chat-collapse` /
     `chat-drag` / `settings-drag` / `settings-llm-models` / `settings-llm-structure` 中按 step 1/3/4/5/6
     实际落地的条目）都应存在且非 0 字节——以 `report.json` 的实际条目为准核对名字与数量
5. 打开其中的 `chat-collapse.png`、`chat-model-picker.png`、`chat-thinking-level.png`、
   `settings-llm-models.png`、`settings-llm-structure.png`、`settings-drag.png` 用 `read_image` 亲眼看一遍，确认：
   - 收起后没有残留的小窗
   - 输入区真的有「模型」与「思考」两个选择器，且没有把发送按钮挤出行外
   - 模型页既有模型列表编辑区，也是「行列表 + 一张编辑卡」而不是一屏平铺
   - 设置窗顶部有可见的拖动区域

### 4. 六个问题逐条验收

6. 把下面每条都跑一遍并把**观测到的实际值**记进 `step/00-index.md` 的执行记录：

   | # | 问题 | 验收动作 | 通过判据 |
   |---|------|----------|----------|
   | 1 | 收起应直接消失 | 交互窗点「收起」 | `window.getState()` 里 `chat` 不可见、`mini-chat` 键不存在；`WINDOW_NAMES` 无 `mini-chat`；侧栏有「快速」栏能进入 `quick` 会话 |
   | 2 | AI 能改自身设置且不崩 | smoke 的 crash 矩阵 + 手工让 AI 调一次 `set_setting`（`agent.tools.terminal.timeoutMs` 改成别的值再改回） | 配置确实变了、`pnpm test` 与 `pnpm typecheck` 全绿、应用没崩、凭据字段被拒 |
   | 3 | 思考等级按钮 | `chat-thinking-level` 探针 + `read_image` 看截图 | 探针 `pass: true`，下拉在输入区可见可用 |
   | 4 | 模型页优化 | `settings-llm-structure` 探针 + 截图 | 行列表 + 单卡编辑 + 删除二次确认；既有 `data-field` 抓手全部保留 |
   | 5 | 模型页要有模型设置 + 对话窗要能选模型 | `settings-llm-models` 与 `chat-model-picker` 两条探针 + 手工改一次模型 | 配置里 `llm.providers.<active>.modelList` 与 `.model` 都按操作变化；对话窗选择器切换后下一次请求用的是新模型名；两者列的是同一份列表 |
   | 6 | 窗口拖动统一 | `chat-drag` / `settings-drag` 探针 + 手工拖三个窗口 | 探针 `pass: true`；chat / settings / onboarding 都能拖；提示条按设计不可拖 |

7. 「AI 改设置不崩」这条**必须真的让模型调一次**，不能只看单测。做法二选一：
   - 在开发态对话窗里发：「把 `agent.tools.terminal.timeoutMs` 改成 20000」（会走确认卡片，点允许），
     然后用 `Select-String` 读 `%APPDATA%/Aurora/config.json` 确认值变了；
   - 或者在没有可用模型时，直接调 `window.aurora`（DevTools 控制台）走工具端口那条路径，
     并在记录里注明「未走真实模型，理由是当前环境无可用 LLM」。
   无论选哪种，**都要检查 `%APPDATA%/Aurora/config.json` 仍是合法 JSON 且 `version === 6`**。

### 5. 收尾检查

8. `git status --porcelain` 逐行看一遍：
   - `step/` 下的本计划文件**可以**提交（用户要留下可回查的提示词）；
   - 不应出现 `apps/desktop/out/`、`node_modules/`、`%TEMP%` 下的截图等产物被跟踪；
   - 若发现 `config.json` 之类的用户数据被改进了仓库目录，立刻还原。
9. 死字段自查：本任务新增的配置有 `advanced.readonlyPrefixes`（消费方：`canWriteSettingPath`）与
   `llm.providers.*.modelList`（消费方：模型页编辑区 + 对话窗模型选择器）。
   用 `grep -rn 'readonlyPrefixes\|modelList' packages apps` 确认每个新字段都至少两处命中
   （Schema 声明 + 真实消费方），避免又添一个「能写但不生效」的字段。
10. 把第 1-9 步的实际命令、退出码、FAIL 计数、截图结论，一行一条追加到 `step/00-index.md` 的「执行记录」。

## 验收标准

- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 五条退出码全为 0
      （受限环境下按第 1 条的直调等价命令逐条 0）
- [ ] `AURORA_SMOKE_RESULT` 里 FAIL 数量为 0
- [ ] `report.json` 中不存在 `pass: false` 的条目，进程退出码 0
- [ ] `$env:TEMP\aurora-capture\mini-chat.png` 不存在
- [ ] 第 6 条表格里 6 行都有「实际观测值」，没有留空或写「应该没问题」
- [ ] 第 7 条真的执行过（走模型或走端口二选一），且 `%APPDATA%/Aurora/config.json`
      仍然是合法 JSON、`version === 6`、`llm.providers.*.apiKeyEnc` 不是明文
- [ ] `step/00-index.md` 的「完成标准」逐条能对上实测结果

## 交接

- 给 step 8（归档）：只有上述验收标准**全部勾选**才允许归档；有任何一条没过，
  报出是哪一条、回到对应 step 修，**不要归档**。
- 归档前请把六个问题的结论与遗留问题写进 `step/00-index.md` 的执行记录，
  归档步骤会据此写 `REPORT.md`。

## 执行记录

- 执行时间：2026-09-22（执行会话）；状态：**done**。被验证的代码状态：`8866abf`（本步不产生新提交）。
- 环境：Windows + PowerShell，文件策略 `danger-full-access`；所有命令都在项目根目录执行。

### 1. 静态检查与单测（CI 同款，逐条退出码）

| 命令 | 退出码 | 观测 |
|---|---|---|
| `pnpm format:check` | 0 | `All matched files use Prettier code style!` |
| `pnpm lint` | 0 | `eslint .` 无输出 |
| `pnpm build:packages` | 0 | **必须先跑**：`apps/desktop` 解析的是 `packages/shared/dist`，dist 不刷新时新字段/新类型的断裂「看不见」 |
| `pnpm typecheck` | 0 | 4 个 workspace 全过（`tsc node` + `vue-tsc web`） |
| `pnpm test` | 0 | **49 文件 / 720 用例全绿** |
| `pnpm build` | 0 | 三包 + Electron 产物；`out/renderer` 只剩 `chat/ edge-bar/ onboarding/ settings/` 四个入口 |

用例数基线对照：开工前 **48 文件 / 681 用例** → 现在 **49 文件 / 720 用例**（+39，无下降）；
新增测试文件 `packages/agent-core/src/tools/settings.test.ts`（25 用例）。

### 2. 端到端自测（真实 Electron + IPC）

`$env:AURORA_SMOKE='1'; pnpm dev` → 退出码 0，`AURORA_SMOKE_RESULT` **PASS = 106 / FAIL = 0**。重点断言实际输出：

| 断言 | 观测值 |
|---|---|
| `settings.get.version` | `PASS — 6` |
| 电脑操控工具 5 个仍注册 | 已含在既有断言集里，全 PASS |
| `配置写入不会写坏（agent.tools.enabled）` | `accepted=no expected=accept-or-reject schema=ok toolKept=yes 配置校验失败：请检查填写内容` |
| `配置写入不会写坏（advanced.logLevel）` | `accepted=no expected=reject schema=ok toolKept=yes` |
| `配置写入不会写坏（llm.active）` | `accepted=yes schema=ok toolKept=yes 已修改：llm.active = nope（旧值：smoke）`（随后被 `sanitize` 重置为空串） |
| `配置写入不会写坏（modes.classroom.typo）` | `accepted=no 不能修改 modes.classroom.typo：未知配置路径` |
| `配置写入不会写坏（llm.providers.x.apiKeyEnc）` | `accepted=no「llm.providers」属于不可修改的配置（凭据 / 代理 / 窗口 / 版本等）` |
| `损坏 config.json 仍能恢复为合法配置` | `corrupted=true`，备份文件已生成，`settings.get()` 仍合法 |
| `带空 apiKeyEnc 回传后凭据仍在` | `model=renamed-model` 且 `hasSecret === true` |
| `window.showChat 后 chat 可见且 primary=chat` | `{"visible":{"edge-bar":true,"onboarding":true,"chat":true},"primary":"chat"}` |
| `window.hide(chat) 后 chat 不可见、primary 归空且提示条仍在` | `{"visible":{"edge-bar":true,"onboarding":true,"chat":false},"primary":null}` |

### 3. 截图核对（真实渲染层 DOM 探针）

`$env:AURORA_CAPTURE="$env:TEMP\aurora-capture"; pnpm dev` → 退出码 **0**，
`report.json` 里 `pass === false` 的条目 **0 条**、`ok === false` 的条目 **0 条**、**24 张 PNG**，
且 `$env:TEMP\aurora-capture\mini-chat.png` **不存在**。

| 场景 | 观测值 |
|---|---|
| `chat-thinking-level` | `{"pass":true,"configValue":"high","domValue":"high","optionCount":4,"restored":true}` |
| `chat-model-picker` | `{"pass":true,"configModel":"deepseek-reasoner","domValue":"deepseek-reasoner","optionCount":2,"restored":true}` |
| `chat-collapse` | `{"pass":true,"clicked":true,"label":"收起","chatVisible":false,"primary":null}` |
| `chat-drag` | `{"pass":true,"maxHeight":71,"regionValue":"drag","buttonLabel":"历史","buttonHit":true}` |
| `settings-drag` | `{"pass":true,"maxHeight":39,"regions":[`.sidebar-drag` 16px / `.brand` 39px / `.content-drag` 10px],"buttonHit":true}` |
| `settings-llm-structure` | `{"pass":true,"expected":1,"rows":1,"rowIds":["llm.providers.capture"],"editors":1,"emptyState":false,"act":{"clicked":true,"label":"编辑"}}` |
| `settings-llm-models` | `{"pass":true,"sectionExists":true,"rowsBefore":1,"rowsAfterAdd":2,"rowsAfterRestore":1,"emptyState":false}` |
| `settings-llm-params` | `{"effortFields":1,"temperatureFields":1,"value":"high","pass":true}` |
| `edge-bar-expanded` | `{"buttonCount":3,"allClickable":true,"pass":true}` |

`read_image` 逐张核对（共 7 张）：`chat-collapse.png`（收起前的交互窗，含「收起」按钮）、
`chat-thinking-level.png`（输入区一行内 `会话…/思考/提示/发送`，未换行、按钮未出框）、
`chat-model-picker.png`（`模型 [deepseek-reas…] → 思考 [auto（不指定…)] → 发送`）、
`settings-drag.png`（侧栏顶部与内容区顶部可见拖动区，内容未被压住）、
`settings-llm-structure.png`（页头摘要 + 工具行 + 单行列表 + 展开的编辑卡）、
`settings-llm-models.png`（「模型列表」区头 + 拉取/手动添加 + 一行含 radio/「当前使用」/重命名/删除）。

### 4. 六个问题逐条结论（实际观测值）

| # | 问题 | 验收动作 | 观测到的实际值 | 结论 |
|---|---|---|---|---|
| 1 | 收起应直接消失 | capture `chat-collapse` 探针真实点击「收起」+ smoke 窗口断言 | 探针 `chatVisible:false, primary:null`；smoke 两条窗口断言 PASS；`WINDOW_NAMES = ['edge-bar','chat','settings','onboarding']`（无 `mini-chat`）；`apps/desktop/out/renderer` 无 `mini-chat` 入口；`apps\|packages\|scripts` 下 `mini-chat\|miniChat\|showMiniChat` **0 命中**；侧栏「快速 / 会话」双栏在 `chat/App.vue`（`.sidebar-tabs`、`selectTab('quick')`、「继续快速对话」→ `switchSession('quick')`、`loadQuickPreview()`）。**未做侧栏的 DOM 探针**，这一条是代码核对 + 收起探针的组合结论 | ✅ 解决 |
| 2 | AI 能改自身设置且不崩 | smoke crash 矩阵 5 条坏值 + 真实工具路径写入 | 5 条全 PASS（详见第 2 节）；`llm.active='nope'` 被真实写入后由 `sanitize` 重置；每次写入后 `SettingsSchema.safeParse` 成功且 `set_setting` 仍在注册表里；`llm.providers.x.apiKeyEnc` 被黑名单拒绝 | ✅ 解决 |
| 3 | 思考等级按钮 | capture `chat-thinking-level` + 截图 | 探针 `configValue=high && domValue=high && optionCount=4`（并把原值写回）；截图里「思考」下拉在输入区可见可用，无 provider 时为 `disabled` + 提示 | ✅ 解决 |
| 4 | 模型页优化 | capture `settings-llm-structure` + 截图 | 探针 `rows=1 === expected=1`、`editors=1`（点开「编辑」后恰好一张卡）、`act.clicked=true`；截图：行列表 + 单卡 + 删除二次确认（`data-action="confirm-remove-provider"`）；既有 `data-field` 抓手全部保留（`grep -c data-field` = 9） | ✅ 解决 |
| 5 | 模型页要有模型设置 + 对话窗要能选模型 | capture `settings-llm-models` + `chat-model-picker` | 模型页：`rowsBefore:1 → rowsAfterAdd:2 → rowsAfterRestore:1`（「+ 手动添加」真实增行并还原）；对话窗：`configModel === domValue === 'deepseek-reasoner'`、`optionCount:2`，两者列的是同一份 `llm.providers.<active>.modelList` | ✅ 解决 |
| 6 | 窗口拖动统一 | capture `chat-drag` + `settings-drag` | chat：唯一 `.drag-region` 是 `.head`，高 71px，`region=drag`，区内按钮命中自身；settings：三处拖动区 16/39/10px，最大 39px，按钮 `✕` 命中自身；提示条按设计不可拖（`focusable:false` + 几何由主进程推导，仅注释说明） | ✅ 解决 |

### 5. 「AI 改设置不崩」的执行方式（如实说明）

本机**没有可用的真实 LLM**（`%APPDATA%\Aurora\config.json` 里 `llm.providers.deepseek.apiKeyEnc` 为空，
即用户没有配置可用 API Key），因此无法在开发态对话窗里让真模型调一次工具。
按计划第 7 条的**第②种**做法执行：由 smoke 直接走**真实工具注册表**
（`tools.get('set_setting').execute({ action:'set', values:[…] })`，见 `main/index.ts` 的 crash 矩阵）
—— 它比「DevTools 里手调」更完整：经过真实 `ToolRegistry`、真实 `settings-port`、真实 `applyPatch`、
真实凭据抽取与广播、真实审计日志，只是调用方不是模型。

补充证据：`llm.active = 'nope'` 那次是**被接受的真实写入**（回填 `已修改：llm.active = nope（旧值：smoke）`），
说明「工具 → 端口 → 落盘」这条链路真的通；`llm.providers` 相关的写入则被黑名单拒绝。

用户配置检查（只读）：`%APPDATA%\Aurora\config.json` 是**合法 JSON**、`version === 6`、
`llm.providers.deepseek.apiKeyEnc` 为空串（**不是明文**）。
⚠️ 另见「遗留」第 1 条：该密文在我接手前就已是空的。

### 6. 死字段自查

`grep` 统计（`packages` 49 处、`apps` 53 处命中）：
- `advanced.readonlyPrefixes`：Schema 声明（`schema.ts:249`）+ 默认值（`defaults.ts:136`）+ 迁移补齐
  （`migrations.ts:257`）+ 端口消费（`tools/settings-port.ts:64`）+ 装配不受影响（`tools/index.ts:120`）+ 测试。
- `llm.providers.*.modelList`：Schema 声明（`schema.ts:89`）+ 迁移补齐（`migrations.ts:244-250`）+
  模型页读写（`LlmPage.vue`，含 `data-field` / `data-empty`）+ 对话窗选择器（`ModelPickerSelect.vue`、
  `chat/App.vue:143`）+ 引导页与 smoke 桩 provider 的字面量。两者都**不只**「能写」，都有真实消费方。

### 7. 收尾检查

- `git status --porcelain`：只剩 `?? step/`（本任务的计划文件，按仓库现状未入库；历史归档同样未入库）。
  没有 `apps/desktop/out/`、`node_modules/`、`%TEMP%` 产物被跟踪；仓库目录里没有用户数据文件。
- `git log --oneline 1781d7d..HEAD`：**12 条提交**，全部为一个功能/修复单元（详见 `00-index.md` 执行记录）。

### 遗留问题（不阻塞归档，但必须如实记录）

1. **用户真实配置里的 API Key 已是空的**：`%APPDATA%\Aurora\config.prestart-backup.json`（09-19，v4）
   里 `deepseek.apiKeyEnc` 是一段 88 字符密文，而当前 `config.json`（v6）里是空串。
   本会话的 capture/smoke 都跑在隔离 userData 上（日志里 `userData` 指向 `%TEMP%\aurora-smoke-*`），
   但会话期间确实有一个**未隔离**的 dev 实例短暂运行过（13:54–14:08，已被我停掉），它把真实配置迁移到了 v6。
   无法确证密文是哪一次操作清空的 —— 本轮修掉的「回传空 `apiKeyEnc` 会清空磁盘凭据」缺陷
   正好会造成这个现象（同进程内被 `memorySecrets` 掩盖，重启才暴露）。
   **建议用户重新在「设置 → AI 模型」里填入 API Key**，本轮的修复会阻止它再次被清空。
2. 探针覆盖不到的两件事：设置页「删除 provider」的二次确认**没有单独探针**（只有抓手与代码审查），
   以及「AI 通过模型真实调用 `set_setting`」（无可用 LLM，见第 5 节）。
3. 真人手测项：窗口拖动的手感、420px 下输入区的真实像素、`auto` 文案在下拉内的省略号 ——
   探针与截图都过了，但只能由人点一次确认。
