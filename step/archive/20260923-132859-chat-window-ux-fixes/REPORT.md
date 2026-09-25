# REPORT — chat-window-ux-fixes（归档于 2026-09-23 13:28）

- 任务：修复并优化对话窗口收起行为、AI 自改设置、思考等级与模型选择入口、模型设置页与窗口拖动一致性
- 基线提交：`1781d7d`　最终提交：`43eaded`　中间提交：**15 条**（`git log --oneline 1781d7d..43eaded`）
- 工作步骤：step 1–7 全部 `done`；本归档步骤（step 8）在移动前已标 `done`

## 一、六个问题各一句结论（均有实测证据，详见 `step-07-verify.md`）

1. **收起应直接消失**：独立小窗（`mini-chat`）从全仓删除（`WINDOW_NAMES` 4 项、IPC 通道与 preload 字面量同步移除、渲染入口与目录删除），
   交互窗「收起」改为 `windowStore.hide('chat')`；探针 `chat-collapse` 报 `chatVisible:false, primary:null`，smoke 两条窗口断言 PASS。
2. **AI 能改自身设置且不崩**：新增内核工具 `set_setting`（Schema 校验 + 路径段黑名单 + 确认链路 + 审计 + 启动自愈），
   smoke crash 矩阵 7 条坏值全部 `disk=ok effect=ok toolKept=yes`，非法路径 / 凭据路径被拒。
3. **思考等级按钮**：对话窗输入区新增「思考」下拉，探针 `chat-thinking-level` 报 `configValue=high && domValue=high && optionCount=4 && restored=true`。
4. **模型页优化**：改为「provider 行列表 + 一次只开一张编辑卡 + 删除二次确认」，探针 `settings-llm-structure` 报 `rows=1 === expected=1, editors=1`。
5. **模型设置 + 对话窗选模型**：新增 `llm.providers.*.modelList`（候选）与两处入口（同一份数据），
   探针 `settings-llm-models`（`rowsBefore:1 → rowsAfterAdd:2 → rowsAfterRestore:1`）与
   `chat-model-picker`（`configModel === domValue === 'deepseek-reasoner'`，`restored:true`）均 PASS。
6. **窗口拖动统一**：`DRAGGABLE_WINDOWS` 显式清单 + 四窗接线 + `theme.css` 兜底规则，
   探针 `chat-drag`（`.head` 71px）与 `settings-drag`（三处 16 / 39 / 10px）PASS，提示条按设计不可拖。

## 二、每步验证结果（命令 + 退出码 + FAIL 数）

| 检查 | 结果 |
|---|---|
| `pnpm format:check` | 0（**注意**：归档当日工作区出现并发写者的未跟踪产物 `Design/` 与 `integrations/classisland-bridge/obj/`，它们会让仓库级检查失败；本任务 60 个改动文件单独跑 prettier 全过） |
| `pnpm lint` | 0 |
| `pnpm build:packages` → `pnpm typecheck` | 0 → 0（4 个 workspace；必须先刷 dist，`apps/desktop` 解析的是 `packages/shared/dist`） |
| `pnpm test` | 0，**49 文件 / 723 用例**（基线 48 / 681，无下降） |
| `pnpm build` | 0；`out/renderer` 只剩 chat / edge-bar / onboarding / settings 四个入口 |
| `AURORA_SMOKE=1 pnpm dev` | 退出码 0，**109 PASS / 0 FAIL** |
| `AURORA_CAPTURE=<tmp> pnpm dev` | 退出码 0，**24 张 PNG**，`report.json` 里 `pass:false` **0 条**、`ok:false` **0 条**，`mini-chat.png` 不存在 |

## 三、截图核对结论

`read_image` 逐张看过：`chat-collapse.png`（收起前的交互窗，含「收起」按钮）、`chat-thinking-level.png`、
`chat-model-picker.png`（输入区一行内 模型/思考 两个选择器 + 发送按钮，不换行）、`settings-drag.png`、
`settings-llm-structure.png`（行列表 + 展开的编辑卡）、`settings-llm-models.png`（「模型列表」区 + 当前使用行）。
探针 PASS 的场景：`chat-thinking-level`、`chat-model-picker`、`chat-collapse`、`chat-drag`、`settings-drag`、
`settings-llm-structure`、`settings-llm-models`、`settings-llm-params`、`edge-bar-expanded`。

## 四、执行阶段的独立审查结论与处置

五路并行审查（正确性 / 安全 / 测试质量 / 仓库约定 / 验收复跑），干净上下文、非实现者：

- 功能实现**未发现假实现**；问题集中在证据强度与两处真实缺陷。
- **P0（已修）**：`set_setting` 写不了三层以上路径（patch 局部子树 + `applyPatch` 整棵子树覆盖 → 兄弟字段被抹掉 → Schema 拒绝），
  而 `list` 还把这些路径列给模型、crash 矩阵用 `accept-or-reject` 把这次真实失败记成 PASS。
  修法：以当前分组值为基底深合并；矩阵改「必须接受且效果落地」。修复后 smoke 该行变为 `accepted=yes effect=ok disk=ok`。
- **P1（已修）**：①「空 apiKeyEnc 不丢凭据」用 `hasSecret`（先读内存缓存）→ 不可能失败，改为**读盘**断言密文非空（长度 64）；
  ② 矩阵核心断言 `safeParse(settings.get())` 恒真 → 改为读 `config.json` 解析；③ `advanced.confirmSensitiveTools` 可被 AI 关闭（自我提权）→ 入硬黑名单（默认项 9→10）；
  ④ 两条探针的 `restored` 只上报不判定、思考等级探针从不写回原值 → 纳入 `pass` 并写回；
  ⑤ 「点击竖条呼出交互窗」在删掉 mini-chat 后空转 → 加 `prepare: hide('chat')`。
- **P2/P3（已修）**：`failed` 判定纳入 `ok:false`；早退分支补 `pass:false`；黑名单对 `[]`/`*` 路径失效 → 加「必须是具体路径」校验；
  两个对话窗 ACT 补水合轮询；`ComputerToolsDeps.settingsPort` 死字段删除；文档/注释失真 10 余处按实现改正。
- 复审由 Lead 亲自复跑：静态五条全绿、smoke 109/0、capture 24 图 0 FAIL（后者的**修复批复查**因并发写者干扰未跑完，已停止）。
- 结论：**可交付**（独立复跑那一路的原文结论亦为「可交付」）。

## 五、遗留问题（如实记录）

1. **`step-06` 的待确认项已闭环**：`-webkit-app-region` 的 `getComputedStyle` 计算值**可读**（探针实测 `regionValue: "drag"`），
   因此不需要退化成「按 regions 尺寸判定」的备选口径；拖动探针保留严格四条件判定。
   真正需要人确认的只剩「真机手感」（本环境只能跑探针与截图）。
2. **未修的既有缺陷（需单独的契约改动）**：
   - `mcp.servers` 的空 `envEnc` 回传会清掉 MCP 凭据（与 provider 同类缺陷，本轮只修了 provider 侧）；
   - 设置页「删除 provider」在 `applyPatch` 语义下实际是 no-op：provider 不会被删掉，密文却被 `clearSecret` 清掉。
3. **`set_setting` 回填文案偏乐观**：`SettingsStore.sanitize` 的规范化发生在 `applyPatch` 返回**之后**，
   因此 `llm.active = 'nope'` 仍回填「已修改」；「生效值」与「磁盘」两条断言已覆盖该风险。
4. **用户真实配置**：`%APPDATA%\Aurora\config.json` 的 `deepseek.apiKeyEnc` 在我接手前已是空串
   （09-19 的 `config.prestart-backup.json` 里是 88 字符密文）。本轮修掉的「回传空 `apiKeyEnc` 会清空磁盘凭据」
   正是这类现象；**建议重新填一次 API Key**。
5. **会话期间的并发写者**（非本任务）：工作区出现未跟踪的 `Design/`（design 编排产物）与
   `integrations/classisland-bridge/obj/`（dotnet 构建产物）；会话早期还有一个**未隔离**的 dev 实例
   把真实配置迁移到 v6、并触发过 electron-vite 反复重启。这些都会影响仓库级 `format:check` 与 `pnpm dev` 类验收，
   需要与那个会话/工具协调。
6. `step/` 一直是未跟踪目录（历史归档同样），本任务沿用该现状未入库；本归档即 `step/archive/20260923-132859-chat-window-ux-fixes/`。
