# 归档报告 · ui-detail-fixes

- 任务：修复六项 UI 细节（设置页说明与入口、权限下拉溢出、上下文详解精简、输入区文案、模型级参数下沉）
- 归档于 2026-10-01 17:54:55
- 归档路径：`step/archive/20261001-175455-ui-detail-fixes/`
- 基线提交：`963cefc78ff491beac8dc2830d5826bd28e4eb77` · 终态：`9aaf862`（共 25 个提交）
- 配置版本：22 → **23**（新增 `migrateV22ToV23`，迁移链 23 条）

## 做了什么

把 LLM 的「上下文窗口 / 支持图片输入 / 思考等级」三项从 **provider 级**下沉为**按模型 id 键**的
`llm.providers.<id>.modelParams.<modelId>`，彻底删除 `temperature`（配置 / 界面 / 请求体三处），
并顺带闭合用户报的另外五条 UI 细节。七步：文档先行 → 配置层 v23 → 运行时/引导页/Center 接线 →
对话窗输入区 → 设置页模型行参数 → 设置页杂项 → 全量回归与视觉核对。

## 验收（终局，主代理实跑）

| 门禁 | 结果 |
|---|---|
| `pnpm typecheck` | 0 错（5 个包全 Done） |
| `pnpm test` | **120 文件 / 2132 用例全绿**（开工前基线 118 / 2101，增量全部来自新增用例） |
| `pnpm build` | 成功 |
| `pnpm verify` | **26/26**（`version=23`、迁移 `count=23/23`） |
| `AURORA_SMOKE=1` 全量 | `SUMMARY 177/177 passed`、0 FAIL（⚠️ 计划与 `AGENTS.md` 写的基线「176」是陈旧的，日志实证开工前已是 177） |
| `AURORA_CAPTURE` 全量 | **71 张图 / 71 条检查项、`"pass": false` 出现 0 次** |
| 视觉核对 | 四张关键图逐张看过并写下「看到什么」（见 `00-index.md` 的 step 7 执行记录）；另抽查 `chat-composer-flyouts.png`（详解卡三行不盖工具行）与 `chat-stream.png`（折叠条仍是「上下文 512 / 128k · 缓存命中 512（100%）」+「累计 528」） |

## 六条问题的闭合

① 通用页删掉会话管理说明句；② 权限下拉说明文字在卡片内折行（根因是**继承**了 `.composer-bar` 的
`white-space: nowrap`，修在 `.perm-item-body`）；③ 上下文详解卡只留「输入 / 上下文窗口 / 模型」三行；
④ 输入区去掉常驻「Enter 发送」（键位说明只留 textarea 的 `title`）；⑤ 生图模型空态补上可点的主按钮
「+ 添加生图模型」；⑥ 参数随模型绑定 + `temperature` 全清（含 `lookupSpec` 的双动态段改进）。

## 执行阶段的两处计划外增改（都记在执行记录里）

1. **新增 `apps/desktop/src/main/llm-params.ts`（含单测）**：`llm.switch` 的落值真身在 `index.ts`
   （import electron，vitest 收不了），而验收要求一条能指到该路径的断言 —— 把写口径抽成纯函数
   `withModelParams`（后补 `llmSwitchRejection`）。
2. **三处 `scrollIntoView`**（两条对话窗 ACT 的参数块、一条设置页 ACT 的生图区组）：设置窗是固定高度 +
   内部滚动，不滚就拍不到「模型行内参数」与「生图空态按钮」，而它们正是本轮唯一的视觉验收项。

## 代码审查（6 个维度 + 1 次复核，全部只读子代理）

- 分档：diff ≈ 2000+ 行 + 数据迁移 + 公共接口变更 → 派 6 个 `Reviewer` 按维度并行审（迁移与配置层 /
  可写面与安全边界 / 运行时与 Center / UI 与探针 / 测试质量 / 文档约定 + 独立复跑），修完两轮再派 1 个复核。
- **1 条 P1 已修**：`main/tools/settings-port.ts` 的可写判定**把顺序弄反了** —— 先拿用户配置的
  `advanced.readonlyPrefixes`（默认值即硬编码黑名单的镜像，含 `llm.providers`）做前缀匹配，
  于是覆盖表对 `llm.providers.<id>.model` 与 `...modelParams.<modelId>.reasoningEffort` 的放行
  **一次都没生效过**，而 `docs/08 §1` 明文写着「覆盖表先于黑名单」。已修 + 同提交补上写路径对
  **含点模型 id** 的段还原（`splitSettingPath`），并补 4 条端口层用例。
- **2 条 P2 已修**：① `modelParams` 漏写 `reasoningEffort`（三兄弟里唯一没有默认值的）会让
  `SettingsSchema.parse` 抛错 → 备份 + **重建出厂配置**（provider / 凭据 / 项目配置一起丢）
  → 给三个子字段都补默认值（只兜「缺」，值非法仍判非法）；② 迁移语义②承诺「旧值只补缺的键」而实现会整条丢弃
  → 改回用**原始**条目合并。
- 其余 P2/P3（含点模型 id 的 `**` 段支持、远程静默 no-op、探针零元素恒真、生图空态按钮与
  「无 temperature」缺自动化护栏、两条设置页 ACT 会把兄弟字段写死、约 30 处注释因果失效）逐条修掉或改准。
- **4 条遗留，按用户要求在归档前全部处理**：vitest include 补 `packages/*/web/src/**/*.test.ts`
  并把 `extractRemoteLlm` 抽成纯模块补 5 条单测；远程 `llm.switch` 的四条守卫抽成纯函数补 5 条单测；
  `lookupSpec` / `lookupEnum` 改逐段匹配（双动态段路径的非法值不再被放行）。
  唯一**不修**的一条：`advanced.readonlyPrefixes` 不能再封掉覆盖表已放行的叶子 —— 那是
  `docs/08 §1` 既定语义的必然结果。
- 复核代理逐条验证 14 项修复（12 PASS / 2 部分通过且已跟进），无新增 P0/P1。

## 遗留（不阻塞，已知）

1. **含点模型 id 在点分路径里天然有歧义**（`gpt-4.1` 会被按 `.` 拆成两段）：对 `fieldAccepts` 仍是
   惰性（它只被 `sanitizeWithDefaults` 使用，而后者对 `llm.providers`（`z.record`）整体保留候选对象、
   不下钻这棵子树）；写入侧的歧义由 `settings-port.ts` 的 `splitSettingPath` 按已知结构还原。
2. `advanced.readonlyPrefixes` 不能再封掉覆盖表已放行的叶子（同上，既定语义）。
3. `AGENTS.md` 里「当前 `CONFIG_VERSION = 21`」与「176 条断言」两句已过期（实际 23 / 177），
   `docs/README.md` / `docs/04-roadmap.md` 的历史条目仍以 provider 级写 `vision` / `reasoningEffort` ——
   均不在本任务范围。
4. `pnpm format:check`（44 文件）与 `pnpm lint`（3 error）**改动前就是红的**（本机 autocrlf 造成），
   不在本任务范围。
