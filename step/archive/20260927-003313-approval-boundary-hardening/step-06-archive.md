# Step 06 — 归档清理

- Task: approval-boundary-hardening
- Step: 6 / 6
- Status: done
- Depends on: step 1..5
- Produces: `step/archive/<YYYYMMDD-HHMMSS>-approval-boundary-hardening/`（**8 个文件**：00-index + step-01..06 共 6 个 step + REPORT.md）；顶层 `step/` 恢复只剩 `archive/`
- Writes: `step/`（移动本次生成的文件 + 写 `REPORT.md` + 回填索引）

## 目标

本次任务全部步骤完成后，把这次生成的 step 文件归档，恢复干净的 step/ 目录。

## 前置检查

先确认 step 1–5 的 Status 都是 done、验收标准都已勾选，`00-index.md`「完成标准」全部满足、执行记录里没有悬而未决的待确认项。
**只要有任何一步没完成、验证没过，就不要归档**，把缺哪一步报给用户，然后结束。

## 操作

按 1 → 2 → 3 → 4 → 5 顺序做：先冻结时间戳、索引补全、状态标完，**再**移动文件。

1. 冻结时间戳并算出归档路径（仓库根，PowerShell）：

   ```powershell
   cd "D:\AICOP\Projects\Aurora"
   $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'          # 只取一次，全程复用
   $dest = "step/archive/${stamp}-approval-boundary-hardening"   # slug 逐字取自 00-index 的「任务标识」
   if (Test-Path $dest) { $dest = "${dest}-2" }          # 撞名才追加 -2，禁止合并进已有目录
   $dest   # 记下来，第 2、4 步都用它，不许重新取时间
   ```

2. 把 `step/00-index.md` 的「归档目录」填成 `$dest`（含 `step/archive/` 前缀、逐字符一致）、「归档时间」填成同一 `$stamp` 对应的 `YYYY-MM-DD HH:MM`。
3. **移动前**把本文件头部 `Status` 与 `00-index.md` 步骤表第 6 行都改成 `done`。
4. 建目录并移动：

   ```powershell
   cd "D:\AICOP\Projects\Aurora"
   $dest = "<第 1 步算出的路径>"
   New-Item -ItemType Directory -Force -Path $dest | Out-Null
   Move-Item step/00-index.md $dest/
   Move-Item step/step-*.md $dest/
   ```

   - 只移动本次顶层的 `00-index.md` 与 `step-*.md`；`step/archive/` 下既有历史目录（含 `20260926-202830-agent-context-boundary-fixes`）一个都不动。
   - 本归档 step 文件会被一起移走，属预期。
5. 在归档目录写 `REPORT.md`：三个修复各一行（逃逸链封堵 / 按钮接线 / 加固收口）、每步验证结果、git 提交清单、执行阶段代码审查结论与处置、遗留问题，一行一条，不长篇复述。

## 验收标准

- [ ] `Get-ChildItem step/*.md` 无输出（顶层无残留）
- [ ] 归档目录名匹配 `^[0-9]{8}-[0-9]{6}-approval-boundary-hardening(-2)?$`
- [ ] 归档目录内共 **8 个文件**（00-index + step-01..06 六个 step + REPORT.md；`step-06-archive.md` 自身也在其中）
- [ ] `00-index.md` 里「归档目录」与实际目录名逐字符一致
- [ ] 本文件与索引第 6 行均为 `done`（随文件进归档目录）
- [ ] 归档路径已在回复中告知用户

## 规则

- 命名与流程细则以 `step-runner` skill 的《归档目录命名规范》为准；冲突时以规范为准。
- 只移动，不删除；不顺手清理其他文件。

## 执行记录

（执行后填写：实际改动、验证结果、遗留问题）
