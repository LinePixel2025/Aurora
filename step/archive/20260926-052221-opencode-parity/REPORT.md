# REPORT — `opencode-parity`（工具面与 opencode 对齐）

- 任务标识：`opencode-parity`
- 归档于：2026-09-26 05:22:21
- 归档路径：`step/archive/20260926-052221-opencode-parity/`（本目录）
- 基线提交：`5f8339bab288e4214659209c346eb3ad37325fe1`
- 执行提交区间：`5f8339b..d58f399`（**34 个提交**）

## 一、做了什么

给 Aurora 的 Agent 内核补上「能改代码」的工具面，并把两处既有机制补齐：

1. **`read_file` 契约升级** —— 返回内容带 `<行号>: ` 前缀，新增 `offset`（1 起始）/ `limit`
   （默认 2000 / 上限 5000），单行超 2000 字符截断；关闭「大文件只能读开头」的缺口
   （之前 `readText` 从字节 0 读起、超上限即截断，没有 offset）。
2. **新增 `grep` / `glob`**（均为 `safe`）—— 自写递归遍历（零新增依赖）、默认忽略 8 个目录、
   不跟随符号链接、文件数与字节数双预算；产出可复用的 **glob 模式编译器**
   （`globPattern.ts`，搜索层与免确认列表共用一份）。
3. **新增 `edit_file`**（`confirm`）—— 精确替换：改前必须先 `read_file` 过该文件（会话级守卫）、
   `oldString` 唯一性校验、EOL 保真、孤立 `\r` 与**混合行尾拒绝**、整文件读走独立入口
   （不用行窗口 API，否则会静默截断 2000 行以后的内容）。
4. **`run_command` 免确认模式列表**（`agent.tools.terminal.allowPatterns`）—— glob 全串匹配，
   命中跳过确认卡片但**仍写审计日志**；**双层拒绝**（Schema refine + 匹配层）防「一条模式放行全部命令」；
   该字段进 `SETTINGS_READONLY_PREFIXES`（AI 改不动，防自我提权）。
5. **prompt caching：前缀稳定化 + 命中观测** —— 系统提示词改成「静态在前、易变在后」；
   `ToolRegistry.toLlmTools()` 按工具名字典序排序且**生效点修到 `agentLoop.ts`**；
   `TokenUsage.cachedTokens` 解析两种厂商字段名并在「上下文详解」条展示。

规格先落 `docs/`（docs-first），配置 Schema 升到 **v12**（迁移 `v11 → v12`）。

## 二、新增工具与配置字段的最终清单

- **8 个电脑操控工具**：`run_command` / `read_file` / `write_file` / `edit_file` / `list_dir` /
  `open_path` / `grep` / `glob`
  （开关分派：`agent.tools.enabled` 总开关；`terminal.enabled` → `run_command`；
  `files.enabled` → `read_file`/`write_file`/`edit_file`/`list_dir`；`search.enabled` → `grep`/`glob`；
  `open.enabled` → `open_path`）
- **新配置**：`agent.tools.search.{enabled, maxResults}`（可写）、
  `agent.tools.terminal.allowPatterns`（**只读前缀**，AI 改不动）
- **共享契约**：`TokenUsage.cachedTokens?`；`FilePort` 新增 `readWholeText` / `findFiles` / `searchText`；
  `readText` 改「行窗口」签名
- **内核常量**（值以 `docs/06 §11` 的常量表为准）：`MAX_EDIT_BYTES = 1 MiB`、
  `DEFAULT_READ_LINES = 2000`、`MAX_READ_LINES = 5000`、`MAX_LINE_CHARS = 2000`、
  `MAX_READ_SCAN_BYTES = 16 MiB`、`MAX_FILE_SCAN_BYTES = 1 MiB`（**只约束内容扫描**）、
  `MAX_MATCH_LINE_CHARS = 400`、`SEARCH_BUDGET = {20000, 64 MiB}`、`SEARCH_TIME_BUDGET_MS = 10_000`、
  `MAX_SEARCH_MAX_RESULTS = 1000`、`MAX_ALLOW_PATTERNS = 100`、`MAX_ALLOW_PATTERN_LENGTH = 200`

## 三、六个工作步骤的提交与验收

| 步骤 | 提交 | 一句话 |
| --- | --- | --- |
| 1 契约与配置 | `c320096` `f769e0a` `088b91b` | docs 规格落盘 + Schema v12 + 工具名扩到 8 个 |
| 2 read_file 契约 | `8aeb2cf` `02b078e` | 行窗口契约（行号前缀 + offset/limit）+ 工具规范三条件条目 |
| 3 搜索层 | `12430c1` `5fd5ed9` `e3b942e` `c54913b` `ed2241a` `0f854f0` | glob 编译器 + grep/glob + 主进程 walker + 设置页栏 |
| 4 edit_file | `5855a86` `a3835c2` `078b6bc` `300e47b` | 精确替换工具 + `readWholeText` + 读前守卫接线 |
| 5 免确认模式 | `28a554d` `0a9c7ac` `bb4a907` `b5b6419` `6910f6c` `30ba8ad` | 匹配器 + 确认链路分支 + 设置页 + 端到端成对断言 |
| 6 prompt caching + 文档 | `35ec301` `2ac3228` `9a7b935` `887ff08` | 前缀稳定化 + 排序生效点 + cachedTokens + 文档收口 |
| 审查后修复 | `dcc6554` `6493f1e` `9e8ef56` `19dab77` | 2 条 P1 + 2 条 P2 + 5 条 P3 |

## 四、验收实测结果（全部由主代理复跑，修复后重跑一遍）

| 命令 | 结果 |
| --- | --- |
| `pnpm build:packages` / `pnpm typecheck` / `pnpm build` | 全部 **exit 0** |
| `pnpm test` | **72 文件 / 1307 用例全绿**（本轮自 1094 增至 1307） |
| `pnpm verify` | **26/26 项通过**（含「执行了 v0 → 当前版本的迁移链 — count=12/12」） |
| `pnpm lint` / `pnpm exec prettier --check "**/*.{ts,md,json,vue}"` | 均通过 |
| `$env:AURORA_SMOKE='1'; pnpm dev` | **SUMMARY 146/146 passed**、0 FAIL、退出码 0（自 134 增至 146） |
| `$env:AURORA_CAPTURE="$env:TEMP\aurora-capture"; pnpm dev` | **48 张 PNG / 48 条 checks（45 条带探针）/ 0 FAIL / 退出码 0**；`settings-agent` 实测 `total=11 / terminalFields=4 / allowPatternsFields=1 / searchFields=2 / filesFields=2 / openFields=1 / pass=true`；`chat-stream` 实测 `512 / 128k · 缓存命中 512（100%）`、`累计 528` |

新增端到端断言（smoke，可指认）：
`glob 递归找到嵌套文件（正斜杠相对路径）且不扫 node_modules`、
`grep 命中行带「相对路径:行号」且不扫 node_modules`、
`电脑操控工具已注册（8 个）`、`敏感级与文档一致（… read_file / grep / glob = safe）`、
`命中免确认模式不弹卡片（整轮无 proactive:sensitiveTool 事件）`、
`负对照未命中仍然弹卡片（收到 proactive:sensitiveTool）`、
`两轮系统提示词静态前缀逐字节相同`、`两轮 tools 顺序相同且已排序`、
`usage 事件带 cachedTokens=512`。

## 五、与计划的偏差（超过两处，逐条列出并说明原因）

1. **`read_file` 的 `offset` / `limit` 用「宽松钳制」而不是 `resolveClamped` 的严格口径**
   （计划「操作 1」写「非数字按缺省处理」，`resolveClamped` 对非数字返回 `undefined` 让调用方报错）。
   按验收标准「参数非法时被钳制」取了宽松口径，`maxBytes` 保持严格。
2. **`maxFileScanBytes` 只对 `searchText` 生效，`findFiles` 不受约束**（计划把它写成 walker 级统一跳过）。
   理由：`glob` 只比名字，让 2 MiB 的 `pnpm-lock.yaml`「按名字也找不到」是反直觉的；阈值按 SSOT 措辞是
   **内容扫描**上限。已补用例钉住。
3. **smoke 的三条免确认断言宿主是 `smoke.ts`（渲染层注入脚本）而不是 `index.ts` 的 `runSmokeTest`**
   （计划「操作 6」指定后者）：那三条要用 `settings.update` / `chat.send` / `proactive.onSensitiveTool` /
   `resolveSensitiveTool`，全是渲染层暴露面，且既有 chat 断言本来就在 `smoke.ts`。
4. **smoke 的公共前缀判据用「≥ 首个易变小节的 `indexOf`」而不是「=」**：实测两轮系统提示词**一字不差**
   （`identical=true`，`## 系统状态` 里的时间只到分钟），严格相等会稳定失败 —— 正好撞上计划自己禁止的
   「断言两轮不同」。
5. **计划的最长公共前缀单测判据本身写错，已订正**：计划写 `commonPrefix(a,b) === stat + '\n\n'`，
   但**第一个易变小节的标题行两轮相同、必然也在前缀里**；实测 `commonPrefix=276`、`stat=263`、
   `stat+'\n\n'=265`，差的就是 `'## 更早对话的摘要' + '\n'`。已改成精确边界（更严，不是放宽）。
6. **`readTracker` 建在 `registerComputerTools` 的闭包里**，而不是「`main/index.ts` 构造后经
   `ComputerToolsDeps` 注入」（计划「操作 4」两句自相矛盾）：效果等价且有单测钉住跨 `sync()` 存活。
7. **桩 LLM 的分片之间隔 40ms 再发**（`FRAME_GAP_MS`）：主进程的事件合并缓冲按 16ms 窗口合并相邻增量，
   零延迟连发会让「逐条增量下发」判据变成随机失败。`event-buffer.ts` 本身未改（它的合并语义是对的）。
8. **桩 LLM 的 `prompt_tokens` 128 → 512、`total_tokens` 144 → 528**：为让 `cachedTokens=512` 自洽
   （否则界面会算出 >100%），连带把文档里的 `128 / 128k` 同步为实测值。
9. **`DEFAULT_AGENT_TOOLS.terminal.allowPatterns` 写成 `[] as string[]`**（计划原文裸 `[]`）：
   该对象是 `as const`，裸 `[]` 是只读空元组，赋给可变 `string[]` 会 `TS2322`。
10. **`apps/desktop/src/main/tools/index.test.ts` 的桩改新签名**（计划 step 2 的 `Writes` 没列它）：
    `FilePort.readText` 签名变了，该文件的假端口必然编译失败，属必要连带改动。

## 六、独立代码审查结论与处置

派了 **2 个独立只读审查子代理**（干净上下文、非实现者）：一个审**安全边界与文件损坏路径**，
一个审**正确性与假 PASS**（含独立复跑全部验收命令 + 「范围之外」核查）。

- 结论：一个 **有条件可交付**、一个 **可交付**；无 P0。
- **P1 两条（已修 + 复验）**：
  1. `readWholeText` 会把非 UTF-8 文本文件静默改成另一种编码（整文件非 ASCII 内容变 U+FFFD，无备份无撤销）。
     主代理亲手复现（GBK 字节 11 → 16、`equals` 为 false）。修法：三条不变量 —— 字节数一致、**全量** NUL 扫描、
     `Buffer.from(text,'utf8').equals(buffer)` 往返校验。复验：GBK 与后置 NUL 均被拒且**磁盘字节未变**。
  2. `grep` 的回溯型正则会冻结主进程（`safe` 级、不弹确认；审查者实测 85–91 秒）。
     修法（分层、如实披露）：静态拒绝**嵌套无界量词**（启发式、不声称完备）+ 主进程**墙钟护栏** 10 秒。
     残余：根因是「不可信正则 + 主进程同步执行」，彻底做法是把扫描移进 `utilityProcess`，属单独立项。
- **P2 两条（已修）**：读前守卫把「空窗口的成功读」也算作已读 → 改为仅 `lines.length > 0` 时打标记；
  免确认模式的 `*` 会跨 `;` / `&&` / `|` 但 UI 与文档没说（假安全感）→ 只改文案（不动已定稿的匹配语义），
  在 `docs/06 §11.7` / `docs/08` / `docs/10` / 设置页 / `schema.ts` JSDoc 五处补披露。
- **P3 四条（已修）**：`newString` 里的孤立 `\r` 会让文件此后被自己硬拒（改为一并拒绝）；
  `include` 无上限且逐文件重编译 glob（加上限 + 一次编译）；`set_setting` 描述补只读例外；
  `readCommand` 与执行串的 trim 口径统一（含两条新用例）。
- **P3 两条（未修，留作已知残余）**：会话守卫记账是 FIFO 近似而非严格 LRU、单会话集合无上限（方向保守）；
  经符号链接编辑会替换链接本身（与既有 `write_file` 同款行为）。

## 七、已登记、未修

- `advanced.readonlyPrefixes` 对 AI 可写但**写了不生效**（不构成自我提权，但会出现「回报已更新、行为无变化」
  的假成功）—— 既有行为。
- `packages/agent-core/src/tools/task.ts` 子代理的工具清单仍用 `describeTools(subTools.list())`（注册序）；
  子代理另建请求、不影响主前缀缓存。
- 设置页「免确认命令模式」卡的**非空列表态**无 capture 现场证据（capture 配置里该列表为空，只渲染空状态分支）。
- `docs/08 §1` 标题与 JSON 示例里的 `version` 仍写 `10`（历史滞后，上一次 v11 迁移提交也没改）。
- `grep` 病态正则的**根因**（同步执行）未消除，只加了静态过滤 + 墙钟护栏。
- 桩 LLM 用「把工具结果 stdout 回显进收尾文本」的方式让渲染层能断言命令真的执行了 ——
  属为可观测性做的取舍，长期应改为在 `index.ts` 用 `stub` 句柄直接断言工具结果原文。

## 八、归档自检

- 本目录文件齐全：**7 个 step 文件 + `00-index.md` + `REPORT.md` = 9 个** ✅
- `step/` 顶层无残留 `step-*.md` ✅
- 目录名匹配 `^[0-9]{8}-[0-9]{6}-[a-z0-9]+(-[a-z0-9]+)*$`，`00-index.md` 里记的归档路径与本目录逐字符一致 ✅
- 全部提交可查：`git log --oneline 5f8339b..d58f399`（34 条）✅
