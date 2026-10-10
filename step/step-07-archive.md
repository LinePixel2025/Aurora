# Step 07 — 归档清理

- Task: fix-flaky-chat-probes
- Step: 7 / 7
- Status: pending
- Depends on: step 1..6
- Writes: step/

## 目标

本次任务全部步骤完成后，把这次生成的 step 文件归档，恢复干净的 `step/` 目录。

## 前置检查

先确认 step 1–6 的 Status 都是 done、验收标准都勾选完成，并且 `step/00-index.md` 里"完成标准"已满足、"待确认"里已经没有悬而未决的问题（`chat-model-picker.png` 属"范围之外"，不算待确认）。
**只要有任何一步没完成、验证没过，或有待确认项没解决，就不要归档**，把缺哪一步报给用户，然后结束。

## 操作

按 1 → 2 → 3 → 4 → 5 的顺序做：先把时间戳冻结、索引补全、状态标完，再移动文件。

1. 冻结时间戳并算出归档路径（后面两步都用这两个变量，不要重新取一次时间）：

   ```powershell
   Set-Location "D:\AICOP\Projects\Aurora"
   $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'      # 只取一次
   $dest = "step/archive/$stamp-fix-flaky-chat-probes"
   if (Test-Path $dest) { $dest = "$dest-2" }
   $dest
   ```

2. 把 `step/00-index.md` 的"归档目录"填成刚算出的 `$dest`，并记上归档时间。
3. **在移动任何文件之前**，把本归档 step 文件头部的 `Status` 改成 `done`，`00-index.md` 步骤表里归档那一行的状态也改成 `done`。
4. 建归档目录并移动本次生成的文件：

   ```powershell
   Set-Location "D:\AICOP\Projects\Aurora"
   New-Item -ItemType Directory -Force $dest | Out-Null
   if (Test-Path step/00-index.md) { Move-Item step/00-index.md $dest }
   Get-ChildItem step -Filter 'step-*.md' -File | Move-Item -Destination $dest -Force
   ```

   - 只移动 `step/` 顶层的 `00-index.md` 和 `step-*.md`；`step/archive/` 里的历史归档不要动。
   - 本归档 step 文件（就是现在执行的 `step-07-archive.md`）也会被一起移走，这是预期的。
5. 在归档目录里写 `REPORT.md`：本次任务做了什么、每步的验证结果（四条抖动各自的定向复跑与反向复核结论、四轮全量跑的失败清单）、遗留问题（`chat-model-picker.png` 的独立任务）、以及执行阶段的代码审查结论，一行一条。

## 验收标准

- [ ] `Get-ChildItem step -Filter '*.md' -File` 无输出（无残留文件）
- [ ] 归档目录名匹配 `<YYYYMMDD-HHMMSS>-fix-flaky-chat-probes`（时间戳 8+6 位数字，slug 与 `00-index.md` 的「任务标识」逐字符相同）
- [ ] 归档目录里文件齐全：7 个 step 文件 + `00-index.md` + `REPORT.md`（共 9 个）
- [ ] `00-index.md` 里记的"归档目录"与实际目录名完全一致
- [ ] 本文件头部 `Status` 与 `00-index.md` 步骤表里归档那一行都是 `done`（移动前就标好）
- [ ] 归档目录路径已在回复中告知用户

## 规则

- 命名与流程细则以 `step-runner` skill 的《归档目录命名规范》为准：本文件的命令与它冲突时，以规范为准。
- 只移动，不删除。
- 不要顺手清理用户自己的其他文件（包括 `Memory/`、`docs/` 与当前工作区里的其它改动）。
