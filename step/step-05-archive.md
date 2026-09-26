# Step 05 — 归档清理

- Task: agent-context-boundary-fixes
- Step: 5 / 5
- Status: pending
- Depends on: step 1, step 2, step 3, step 4
- Produces: `step/archive/<YYYYMMDD-HHMMSS>-agent-context-boundary-fixes/`（7 个文件）与其中新写的 `REPORT.md`；顶层 `step/` 恢复只剩 `archive/`
- Phase: 测试与文档
- Writes: `step/`（只移动本次生成的文件 + 写 `REPORT.md` + 回填索引）

## 目标

本次任务全部步骤完成后，把这次生成的 step 文件归档，恢复干净的 step/ 目录。

## 前置检查

先确认前面每一步的 Status 都是 done、验收标准都勾选完成，并且 `step/00-index.md` 里「完成标准」已满足、「待确认」里已经没有悬而未决的问题。
**只要有任何一步没完成、验证没过，或有待确认项没解决，就不要归档**，把缺哪一步报给用户，然后结束。

## 操作

按 1 → 2 → 3 的顺序做：先把时间戳冻结、索引补全，再移动文件。反过来就不知道该往索引里写哪个归档路径了。

1. 冻结时间戳并算出归档路径（后面两步都用这两个变量，不要重新取一次时间，否则索引里记的路径会与实际目录名差几秒）。在仓库根用 PowerShell：

   ```powershell
   cd "D:\AICOP\Projects\Aurora"
   $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'          # 只取一次
   $dest = "step/archive/${stamp}-agent-context-boundary-fixes"   # slug 就是 00-index.md 的「任务标识」，不许另起
   if (Test-Path $dest) { $dest = "${dest}-2" }          # 撞名才追加 -2，不许合并进已有目录
   $dest   # 记下来，第 1、2 步都用它
   ```

2. 把 `step/00-index.md` 的「归档目录」填成刚算出的 `$dest`、「归档时间」填成**同一个** `$stamp` 对应的 `YYYY-MM-DD HH:MM`（两者同源，不许再取一次当前时间）；同时把本文件头部 `Status` 与索引步骤表中第 5 行的状态改为 `done`——**在移动文件之前**做完全部回填。
3. 建归档目录并移动本次生成的文件：

   ```powershell
   cd "D:\AICOP\Projects\Aurora"
   $dest = "<第 1 步算出的路径>"
   New-Item -ItemType Directory -Force -Path $dest | Out-Null
   Move-Item step/00-index.md $dest/
   Move-Item step/step-*.md $dest/
   ```

   - 只移动 `step/` 顶层的 `00-index.md` 和 `step-*.md`；`step/archive/` 里的历史归档（已有 7 个目录）一个都不要动。
   - 本次的归档 step 文件（就是你现在执行的这个 `step-05-archive.md`）也会被一起移走，这是预期的——它的内容已经在上下文里，继续完成剩余操作即可。
4. 在归档目录里写 `REPORT.md`：本次任务做了什么（三个修复各一行）、每步的验证结果、git 提交清单、遗留问题、以及执行阶段的代码审查结论，一行一条，不要长篇复述。

## 验收标准

- [ ] `step/*.md` 顶层无残留：`Get-ChildItem step/*.md` 无输出
- [ ] 归档目录名匹配 `<YYYYMMDD-HHMMSS>-agent-context-boundary-fixes`（时间戳 8+6 位数字，slug 与 `00-index.md` 的「任务标识」逐字符相同；撞名时允许尾随 `-2`）
- [ ] 归档目录里文件齐全：5 个 step 文件 + `00-index.md` + `REPORT.md`（共 7 个；本文件也在其中）
- [ ] `00-index.md` 里记的「归档目录」与实际目录名完全一致
- [ ] 归档目录路径已在回复中告知用户

## 规则

- 只移动，不删除。用户要的是能回查的提示词，不是消失的文件。
- 不要顺手清理用户自己的其他文件。

## 执行记录

（执行后填写：实际改动、验证结果、遗留问题）
