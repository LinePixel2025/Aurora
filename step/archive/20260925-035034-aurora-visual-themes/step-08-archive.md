# Step 08 — 归档清理

- Task: aurora-visual-themes
- Step: 8 / 8
- Status: done
- Depends on: step 1..7
- Produces: 一份可回查的计划、执行报告及干净的 `step/` 顶层
- Phase: 测试与文档
- Writes: `step/`

## 目标

本次任务全部步骤完成后，将这次生成的 `00-index.md` 和八个 `step-*.md` 一起移到唯一的归档目录。

## 输入

- 项目根目录 `D:\AICOP\Projects\Aurora`，任务标识从 `step/00-index.md` 的「任务标识」读取，必须逐字符等于 `aurora-visual-themes`。
- 先读 `step/00-index.md`、全部 `step/step-*.md` 的 Status、验收标准和执行记录；检查完成标准已满足、待确认无未决事项、代码审查已完成。

## 前置检查

先确认前面每一步的 Status 都是 done，验收项逐条勾选完成，`00-index.md` 的完成标准已满足且待确认项没有未决问题。任何一步未完成、验证失败或仍有待确认时，**停止归档**并向用户报告缺哪一项。

## 操作

1. 只取一次时间戳，冻结路径；撞名只能追加 `-2`、`-3` 等，不得合并覆盖已有目录。PowerShell 示例（在同一个执行上下文中保留变量，后面不要重新取时间）：

   ```powershell
   $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
   $slug = 'aurora-visual-themes'
   $dest = "step/archive/$stamp-$slug"
   $suffix = 2
   while (Test-Path $dest) { $dest = "step/archive/$stamp-$slug-$suffix"; $suffix++ }
   $dest
   ```

2. **先**把 `step/00-index.md` 的归档目录填为冻结的 `$dest`、归档时间填为冻结时间，再移动文件。若工具调用不保留 PowerShell 变量，把第 1 步实际打印的路径原样写入索引与后续命令，不能重新 `Get-Date`。
3. `New-Item -ItemType Directory -Path $dest`；只移动本次 `step/00-index.md` 和顶层 `step/step-*.md` 到该目录，包括本 `step-08-archive.md` 自身；历史 `step/archive/` 原有目录和其它用户文件不动。可在保留 `$dest` 的同一 PowerShell 上下文中执行：

   ```powershell
   Move-Item step/00-index.md $dest
   Move-Item step/step-*.md $dest
   ```

4. 在 `$dest/REPORT.md` 写本次各步变更、验证结果、未决问题、执行阶段独立代码审查及处置结果，每项一行。只移动，不删除源文件内容。

## 验收标准

- [ ] `Get-ChildItem step -File -Filter '*.md'` 无结果，顶层没有残留步骤文件。
- [ ] 归档目录名符合 `step/archive/<YYYYMMDD-HHMMSS>-aurora-visual-themes/`（时间戳 8+6 位数字、slug 与 `00-index.md` 任务标识逐字符相同；同名时仅允许追加 `-2` 等且不覆盖历史目录）。
- [ ] 归档目录里有八个 `step-*.md`、`00-index.md`、`REPORT.md`，共 10 个文件；归档索引记载路径与真实路径完全一致。
- [ ] 在完成回复中告知用户实际归档目录与本次结果。

## 交接

归档路径与报告供日后追溯；不要清理用户其它文件。

## 执行记录

归档路径：`step/archive/20260925-035034-aurora-visual-themes`（时间戳 `20260925-035034` 只取一次，全程复用；移动前确认该目录不存在，故未追加 `-2`）。`step/00-index.md` 的「归档目录」「归档时间」已在本步移动文件**之前**填好；八个 `step-*.md`、`00-index.md` 与本文件自身一并移入，另写 `REPORT.md`（含各步变更、验证结果、独立审查结论与遗留项）。`step/` 顶层已无残留，历史归档目录未动。
