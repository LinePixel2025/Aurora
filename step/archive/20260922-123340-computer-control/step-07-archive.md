# Step 07 — 归档清理

- Task: computer-control
- Step: 7 / 7
- Status: done
- Depends on: step 1..6

## 目标

本次任务全部步骤完成后，把这次生成的 step 文件整体移入 `step/archive/`，恢复干净的 `step/` 目录。

## 前置检查

先确认前面每一步的 Status 都是 done、验收标准都勾选完成，并且 `00-index.md` 里「完成标准」已满足。
**只要有任何一步没完成或验证没过，就不要归档**：把缺哪一步、卡在哪条验收上报告给用户，然后结束。

具体核对（在 `D:\AICOP\Projects\Aurora` 下）：

```powershell
Select-String -Path step\step-*.md -Pattern '^- Status:' | ForEach-Object { $_.Line }
```

- 六份工作步骤文件里不得再出现 `Status: pending`；
- `step\step-06-e2e-and-docs.md` 的「执行记录」里要有全量验证（typecheck / test / build / verify、
  smoke、capture）的实际结果；
- 若 `docs/README.md` 仍未记录本轮能力，或 smoke/capture 有 FAIL 未处置，同样不要归档。

## 操作

按 1 → 2 → 3 的顺序做：先把时间戳冻结、索引补全，再移动文件。反过来就不知道该往索引里写哪个归档路径了。

1. 冻结时间戳并算出归档路径（后面两步都用这两个变量，不要重新取一次时间，否则索引里记的路径会和实际目录名差几秒）：

   ```powershell
   Set-Location 'D:\AICOP\Projects\Aurora'
   $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
   $dest  = "step/archive/$stamp-computer-control"
   $dest
   ```

2. 把 `step/00-index.md` 的「归档目录」填成刚算出的 `$dest`，把「归档时间」填成当前时间，
   并在「执行记录」小节补上：每步的实际改动与验证结果、git 提交清单、代码审查结论与处置
   （一行一条，不要长篇复述）。

3. 建归档目录并移动本次生成的文件：

   ```powershell
   Set-Location 'D:\AICOP\Projects\Aurora'
   $dest = '<第 1 步算出的路径>'
   New-Item -ItemType Directory -Force -Path $dest | Out-Null
   if (Test-Path step/00-index.md) { Move-Item step/00-index.md $dest }
   Get-ChildItem -Path step -Filter 'step-*.md' -File | Move-Item -Destination $dest
   ```

   - 只移动 `step/` **顶层**的 `00-index.md` 与 `step-*.md`；`step/archive/` 里的历史归档不要动
     （用 `-Filter 'step-*.md'` 且不加 `-Recurse` 即可）。
   - 本次的归档 step 文件（就是你现在执行的这个 `step-07-archive.md`）也会被一起移走，这是预期的
     —— 它的内容已经在上下文里，继续完成剩余操作即可。

4. 在归档目录里写 `REPORT.md`：本次任务做了什么、每步的验证结果、遗留问题、以及执行阶段的代码审查结论，
   一行一条，不要长篇复述。建议内容：

   ```markdown
   # computer-control 执行报告

   - 归档时间：<YYYY-MM-DD HH:MM>
   - 基线提交：01d2475
   - 提交清单：<git log --oneline 摘录>
   - 步骤结果：step-01..06 各自的实际改动与验收结果（一行一条）
   - 验证证据：pnpm typecheck / test / build / verify 结果；AURORA_SMOKE 报告里新增断言；
     AURORA_CAPTURE 的 report.json 结论与截图数
   - 遗留问题：<例如「无可用模型凭据，真实对话手工验收未做」>
   - 代码审查结论与处置：<审查发现的问题、是否已修>
   ```

## 验收标准

- [x] `Get-ChildItem step -File` 无输出（`step/` 顶层无残留文件，仅剩 `archive/` 目录）
- [x] 归档目录里文件齐全：7 个 step 文件 + `00-index.md` + `REPORT.md`（共 9 个）
- [x] `00-index.md` 里记的「归档目录」与实际目录名完全一致
      （`step/archive/20260922-123340-computer-control`）
- [x] 归档目录路径已在回复中告知用户

## 执行记录

**状态：done（2026-09-22 12:33）· 归档目录 `step/archive/20260922-123340-computer-control`**

- 时间戳只取一次（`20260922-123340`），索引里记的路径与实际目录名一致。
- 归档前先把本文件 `Status` 与 `00-index.md` 表格第 7 行都改成 `done`，
  并把「归档目录 / 归档时间」两项填好（文件随后就被移走，事后再改就找不到了）。
- 只移动 `step/` **顶层**的 `00-index.md` 与 `step-*.md`，`archive/` 下的历史归档
  （`20260920-140927-frontend-refresh`）未被触碰。
- 本目录含 9 个文件，另写了 `REPORT.md`（任务做了什么、每步验证结果、提交清单、
  审查结论与处置、遗留问题）。
- `step/` 顶层现在没有文件，只剩 `archive/` 目录；`step/` 目录本身仍是未跟踪状态（与开工前一致）。

## 规则

- 只移动，不删除。用户要的是能回查的提示词，不是消失的文件。
- 不要顺手清理用户自己的其他文件（`step/archive/` 下的历史归档、仓库里的任何其它内容都不动）。
- 若第 3 步的 `Move-Item` 中途失败，先补齐 `$dest` 里已有的文件，把缺的补进去，再重跑剩余命令，
  不要反向把已归档的文件移回来。
