# Step 07 — 归档清理

- Task: opencode-parity
- Step: 7 / 7
- Status: done
- Depends on: step 1..6

## 目标

本次任务全部步骤完成后，把这次生成的 step 文件归档，恢复干净的 `step/` 目录。

## 前置检查

先确认前面每一步的 Status 都是 done、验收标准都勾选完成，并且 `00-index.md` 里"完成标准"已满足、
"待确认"里已经没有悬而未决的问题。

**只要有任何一步没完成、验证没过，或有待确认项没解决，就不要归档**，把缺哪一步报给用户，然后结束。

另外逐条确认这些「本轮特有」的前置状态（它们不看就会归档到一份半成品）：

- `pnpm typecheck && pnpm test && pnpm build` 三条命令**当天复跑过**且全绿
  （不要引用几天前的执行记录）。
- `pnpm verify` 通过（本轮改了配置 Schema 与迁移链，这条是必跑项）。
- `00-index.md` 的完成标准第 2 条（smoke 三条新断言）与第 3 条（capture 探针与计数）
  都有**实测输出**作为证据，而不是"应该会过"。
- `AGENTS.md` 与 `docs/07 §5.3` 里记录的探针/截图计数是**实测值**
  （本轮 `SETTINGS_AGENT_FIELDS_SCRIPT` 改过两次：step 3 加 search 字段、step 5 加 allowPatterns 字段）。

## 操作

按 1 → 2 → 3 的顺序做：先把时间戳冻结、索引补全，再移动文件。反过来就不知道该往索引里写哪个归档路径了。

1. 冻结时间戳并算出归档路径（后面两步都用这两个变量，不要重新 `date` 一次，否则索引里记的路径会和实际目录名差几秒）：

   ```bash
   cd "D:/AICOP/Projects/Aurora"
   stamp="$(date +%Y%m%d-%H%M%S)"             # 只取一次；Windows 无 date 时用 Get-Date -Format 'yyyyMMdd-HHmmss'
   dest="step/archive/${stamp}-opencode-parity"   # slug 必须与 00-index.md 的「任务标识」逐字符相同
   [ -e "$dest" ] && dest="${dest}-2"         # 撞名才追加 -2，不许合并进已有目录
   echo "$dest"     # 记下来，第 1、2 步都用它
   ```

2. 把 `step/00-index.md` 的"归档目录"填成刚算出的 `$dest`，并记上归档时间
   （另外把"基线提交"填成开工前的 `git rev-parse HEAD`，若执行阶段还没填）。

3. 建归档目录并移动本次生成的文件：

   ```bash
   cd "D:/AICOP/Projects/Aurora"
   dest="<第 1 步算出的路径>"
   mkdir -p "$dest"
   [ -f step/00-index.md ] && mv step/00-index.md "$dest"/ || true
   mv step/step-*.md "$dest"/ 2>/dev/null || true
   ```

   - 只移动 `step/` 顶层的 `00-index.md` 和 `step-*.md`；`step/archive/` 里的历史归档不要动。
   - 本次的归档 step 文件（就是你现在执行的这个 `step-07-archive.md`）也会被一起移走，这是预期的
     —— 它的内容已经在上下文里，继续完成剩余操作即可。

4. 在归档目录里写 `REPORT.md`：本次任务做了什么、每步的验证结果、遗留问题、
   以及执行阶段的代码审查结论，一行一条，不要长篇复述。内容至少包含：

   - 六个工作步骤各自的 git 提交 SHA 与一句话说明；
   - 四条验收命令（`typecheck` / `test` / `build` / `verify`）与两条端到端（`AURORA_SMOKE` /
     `AURORA_CAPTURE`）的**实测结果**（用例数、PNG 张数、FAIL 数、退出码）；
   - 新增工具与配置字段的最终清单（8 个电脑操控工具名、`agent.tools.search.*`、
     `agent.tools.terminal.allowPatterns`、`TokenUsage.cachedTokens`）；
   - 与计划的两处以上偏差及其原因（计划与实现不一致的地方**必须**出现在这里）；
   - 「已登记、未修」清单（本任务范围之外、只登记不修的既有缺口）。

## 验收标准

- [ ] `ls step/*.md` 无输出（无残留文件）
- [ ] 归档目录名匹配 `<YYYYMMDD-HHMMSS>-opencode-parity`（时间戳 8+6 位数字，slug 逐字符相同）
- [ ] 归档目录里文件齐全：**7 个 step 文件 + `00-index.md` + `REPORT.md`（共 9 个）**；
      `step-07-archive.md` 自身也在其中
- [ ] `00-index.md` 里记的"归档目录"与实际目录名完全一致
- [ ] `REPORT.md` 里的提交 SHA 能在 `git log --oneline` 里查到（逐个核对，不要凭记忆写）
- [ ] 归档目录路径已在回复中告知用户

## 规则

- 只移动，不删除。用户要的是能回查的提示词，不是消失的文件。
- 不要顺手清理用户自己的其他文件（仓库里可能还有与本任务无关的未提交改动，不要动它们，
  也不要替用户提交）。
