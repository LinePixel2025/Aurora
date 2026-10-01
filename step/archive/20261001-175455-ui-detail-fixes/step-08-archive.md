# Step 08 — 归档清理

- Task: ui-detail-fixes
- Step: 8 / 8
- Status: done
- Depends on: step 1..7
- Writes: `step/`

## 目标

本次任务全部步骤完成后，把这次生成的 step 文件归档到 `step/archive/<YYYYMMDD-HHMMSS>-ui-detail-fixes/`，恢复干净的 `step/` 目录。

## 前置检查

先确认 step 1..7 的 `Status` 都是 `done`、每步的验收标准都已勾选，并且 `step/00-index.md` 的「完成标准」三条都满足、「待确认」里没有悬而未决的问题。

**只要有任何一步没完成、验证没过，或有待确认项没解决，就不要归档**：把缺哪一步、哪条验证没过报给用户，然后结束。

具体门槛（全部要满足才继续）：
- `pnpm typecheck` / `pnpm test` / `pnpm build` / `pnpm verify` 全绿；
- 全量 `AURORA_SMOKE` 无 FAIL、全量 `AURORA_CAPTURE` 的 `report.json` 无 FAIL；
- 四张关键截图（`chat-composer-permission.png`、`settings-llm-params.png`、`settings-llm.png`、`settings-general.png`）的视觉核对结论已写进 `step/00-index.md`（清单与 `00-index.md` 的完成标准逐字一致）。

## 操作

按 1 → 2 → 3 → 4 → 5 的顺序做：先把时间戳冻结、索引补全、状态标完，再移动文件。反过来就不知道该往索引里写哪个归档路径，文件一移走也再改不了。

1. 冻结时间戳并算出归档路径（后面两步都用这两个变量，不要重新取一次时间，否则索引里记的路径会和实际目录名差几秒）：

   ```bash
   cd "D:/AICOP/Projects/Aurora"
   stamp="$(date +%Y%m%d-%H%M%S)"                 # Windows 无 date 时用 PowerShell：Get-Date -Format 'yyyyMMdd-HHmmss'
   dest="step/archive/${stamp}-ui-detail-fixes"   # slug 与 00-index.md 的「任务标识」逐字相同，不许另起
   [ -e "$dest" ] && dest="${dest}-2"             # 撞名才追加 -2，绝不合并进已有目录
   echo "$dest"                                   # 记下来，第 4 步还要用
   ```

2. 把 `step/00-index.md` 的「归档目录」填成刚算出的 `$dest`，「归档时间」填当前时间（与 `stamp` 对应）。
3. **在移动任何文件之前**，把本文件头部的 `Status` 改成 `done`，并把 `step/00-index.md` 步骤表里 step 8 那一行的状态也改成 `done` —— 文件马上就要被移走，事后改不到。
4. 建归档目录并移动本次生成的文件：

   ```bash
   cd "D:/AICOP/Projects/Aurora"
   dest="<第 1 步算出的路径>"
   mkdir -p "$dest"
   [ -f step/00-index.md ] && mv step/00-index.md "$dest"/ || true
   mv step/step-*.md "$dest"/ 2>/dev/null || true
   ```

   - 只移动 `step/` 顶层的 `00-index.md` 与 `step-*.md`；`step/archive/` 下的历史归档不要动。
   - 本次的归档 step 文件（就是你现在执行的这个 `step-08-archive.md`）也会被一起移走，这是预期的 —— 它的内容已经在上下文里，继续做完剩余操作即可。
5. 在归档目录里写 `REPORT.md`：本次任务做了什么（六条 UI 修正 + 配置层 v23 下沉）、每步的验证结果（指向 `00-index.md` 的执行记录，不重复长段）、遗留问题，以及执行阶段的代码审查结论。一行一条。

## 验收标准

- [ ] `ls step/*.md` 无输出（无残留文件）。
- [ ] 归档目录名匹配 `<YYYYMMDD-HHMMSS>-ui-detail-fixes`（时间戳 8+6 位数字，slug 与 `00-index.md` 的「任务标识」逐字符相同）。
- [ ] 归档目录里文件齐全：8 个 step 文件 + `00-index.md` + `REPORT.md`（共 10 个）。
- [ ] `00-index.md` 里记的「归档目录」与实际目录名完全一致。
- [ ] 本文件头部 `Status` 与 `00-index.md` 步骤表里 step 8 那一行都是 `done`（移动前就标好，随文件一起进了归档目录）。
- [ ] 归档目录的绝对路径已在回复中告知用户。

## 规则

- 命名与流程细则以 `step-runner` skill 的《归档目录命名规范》为准；本文件的命令与它冲突时以规范为准。
- 只移动，不删除。用户要的是能回查的提示词，不是消失的文件。
- 不要顺手清理用户自己的其它文件（例如仓库根那个未跟踪的 `bug/` 目录不属于本任务）。
