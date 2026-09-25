# Step 08 — 归档清理

- Task: agent-tts-voice
- Step: 8 / 8
- Status: done
- Depends on: step 1..7

## 目标

本次任务全部步骤完成后，把这次生成的 step 文件归档，恢复干净的 `step/` 目录。

## 前置检查

先确认前面每一步的 `Status` 都是 `done`、验收标准都勾选完成，并且 `00-index.md` 里「完成标准」4 条都已满足。
**只要有任何一步没完成或验证没过，就不要归档**，把缺哪一步报给用户，然后结束。

具体核对（在本文件所在目录 `D:\AICOP\Projects\Aurora` 下执行）：

```powershell
Select-String -Path step/step-0*.md,step/00-index.md -Pattern 'Status: pending'
```

有输出说明还有步骤没完成 → 停止，报给用户。

## 操作

按 1 → 2 → 3 的顺序做：先冻结时间戳、再补索引、最后移动文件。反过来就不知道该往索引里写哪个归档路径了。

1. 冻结时间戳并算出归档路径（后面都用这两个变量，**不要**重新取一次时间，否则索引里记的路径会和实际目录名差几秒）：

   ```powershell
   cd "D:\AICOP\Projects\Aurora"
   $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
   $dest  = "step/archive/$stamp-agent-tts-voice"
   $dest          # 记下来，第 2、3 步都用它
   ```

2. 把 `step/00-index.md` 的「归档目录」填成刚算出的 `$dest`（相对路径原样写），
   并记上归档时间（`Get-Date -Format 'yyyy-MM-dd HH:mm'`）。同时把「步骤」表里 8 行的状态改成 `done`
   （若执行阶段已经改过就不用重复改）。

3. 建归档目录并移动本次生成的文件：

   ```powershell
   cd "D:\AICOP\Projects\Aurora"
   $dest = "<第 1 步算出的路径>"
   New-Item -ItemType Directory -Force -Path $dest | Out-Null
   if (Test-Path step/00-index.md) { Move-Item step/00-index.md $dest }
   Get-ChildItem step -Filter 'step-*.md' -File | ForEach-Object { Move-Item $_.FullName $dest }
   ```

   - 只移动 `step/` **顶层**的 `00-index.md` 与 `step-*.md`；`Get-ChildItem` 不带 `-Recurse`，
     所以 `step/archive/` 里的历史归档不会被碰到。
   - 本次的归档 step 文件（就是你现在执行的这个 `step-08-archive.md`）也会被一起移走，这是预期的 ——
     它的内容已经在上下文里，继续完成剩余操作即可。
   - `step/` 目录本身保留（里面还有 `archive/`）。

4. 在归档目录里写 `REPORT.md`：本次任务做了什么、每步的验证结果、遗留问题、以及执行阶段的代码审查结论，
   一行一条，不要长篇复述。素材取自各 step 文件的「执行记录」与 `00-index.md` 的执行记录。
   至少包含：`pnpm typecheck/test/build` 结果、`AURORA_CAPTURE` 是否无 FAIL、真机试听 6 条的结论、
   未做项（STT 等）与已知限制。

## 验收标准

- [ ] `Get-ChildItem step -Filter '*.md' -File` 无输出（顶层无残留）
- [ ] 归档目录里文件齐全：8 个 step 文件 + `00-index.md` + `REPORT.md`（共 10 个；
      `step-08-archive.md` 自身也在其中）
- [ ] `00-index.md` 里记的「归档目录」与实际目录名完全一致
- [ ] `step/archive/` 下本次之前的 3 个历史归档目录（`20260920-140927-frontend-refresh`、
      `20260922-123340-computer-control`、`20260923-132859-chat-window-ux-fixes`）**仍在**且未被改动
- [ ] 归档目录路径已在回复中告知用户

## 规则

- 只移动，不删除。用户要的是能回查的提示词，不是消失的文件。
- 不要顺手清理用户自己的其它文件：工作区里未提交的 5 个 `package.json` 版本改动、
  未跟踪的 `.dsh/`、`Design/` 都不属于本次任务，**不要**动它们。

## 执行记录

（2026-09-25 00:01）**归档于 2026-09-25 00:01**，归档目录 `step/archive/20260925-000129-agent-tts-voice`。

- 前置检查：`Select-String -Path step/step-0*.md,step/00-index.md -Pattern 'Status: pending'` 仅命中本文件
  自身的状态行与它内部的检查命令文本，7 个工作步骤（step-01..07）全部 `done`。
- 索引「归档目录 / 归档时间」已按冻结时间戳填好；8 行状态全部 `done`。
- 移动：`00-index.md` + `step-0*.md`（含本文件）共 9 个 → 归档目录；`step/` 顶层清空（`archive/` 保留）。
- 本次之前的 3 个历史归档目录**未触碰**。
- `REPORT.md` 已写入归档目录（含每步验证结果、10 个提交、审查结论与处置、遗留）。

