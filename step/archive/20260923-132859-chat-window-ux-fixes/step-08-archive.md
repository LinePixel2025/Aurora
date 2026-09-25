# Step 08 — 归档清理

- Task: chat-window-ux-fixes
- Step: 8 / 8
- Status: done
- Depends on: step 1..step 7

## 目标

本次任务全部步骤完成后，把这次生成的 step 文件归档，恢复干净的 `step/` 目录。

## 前置检查

先确认前面每一步的 Status 都是 done、验收标准都勾选完成，并且 `step/00-index.md` 里「完成标准」已满足。
**只要有任何一步没完成或验证没过，就不要归档**，把缺哪一步报给用户，然后结束。

本任务的必要证据（在 `step/00-index.md` 的执行记录里必须能查到）：

- `pnpm format:check` / `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm build` 全部退出码 0；
- `AURORA_SMOKE_RESULT` FAIL 数为 0；
- `AURORA_CAPTURE` 的 `report.json` 里无 `pass: false`，退出码 0；
- 六个问题的逐条结论（含实际观测值）已写入执行记录。

## 操作

本仓库运行在 Windows PowerShell 上，下面的命令用 pwsh 写（不要照抄 skill 模板里的 bash 版）。

1. 冻结时间戳并算出归档路径（后面几步都用这两个值，**不要**重新取一次时间，
   否则索引里记的路径会和实际目录名差几秒）：

   ```powershell
   Set-Location 'D:\AICOP\Projects\Aurora'
   $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
   $dest = "step/archive/$stamp-chat-window-ux-fixes"
   Write-Output $dest   # 记下来，下面几步都用它
   ```

2. 把 `step/00-index.md` 的「归档目录」填成刚算出的 `$dest`、「归档时间」填当前时间
   （`Get-Date -Format 'yyyy-MM-dd HH:mm'`）。
3. 建归档目录并移动本次生成的文件：

   ```powershell
   Set-Location 'D:\AICOP\Projects\Aurora'
   $dest = '<把第 1 步打印出来的路径原样填在这里>'
   New-Item -ItemType Directory -Path $dest -Force | Out-Null
   if (Test-Path 'step/00-index.md') { Move-Item 'step/00-index.md' $dest }
   Get-ChildItem -Path 'step' -Filter 'step-*.md' -File | Move-Item -Destination $dest
   ```

   - 只移动 `step/` **顶层**的 `00-index.md` 与 `step-*.md`；`step/archive/` 里的历史归档不要动
     （上面的 `Get-ChildItem -Path 'step' -File` 不会递归，天然满足）。
   - 本次的归档 step 文件（就是你现在执行的这个 `step-08-archive.md`）也会被一起移走，这是预期的
     —— 它的内容已经在上下文里，继续完成剩余操作即可。
4. 在归档目录里写 `REPORT.md`，一行一条，不要长篇复述：
   - 本次任务做了什么（六个问题各一句结论）；
   - 每步的验证结果（命令 + 退出码 + FAIL 数）；
   - 截图核对结论（哪些场景 pass，看了哪几张 PNG）；
   - 遗留问题（例如 step 6 里「`-webkit-app-region` 计算值是否可读」的待确认项处置结论）；
   - 执行阶段的代码审查结论与处置（若 step-runner 派过审查子代理，把结论与是否已修一并写上）。
5. 归档后自检（证据要留在回复里）：

   ```powershell
   Set-Location 'D:\AICOP\Projects\Aurora'
   Get-ChildItem -Path 'step' -Filter '*.md' -File          # 应无输出
   Get-ChildItem -Path 'step/archive/<刚算出的目录名>'       # 应有 10 个文件
   ```

## 验收标准

- [ ] `Get-ChildItem step/*.md` 无输出（无残留文件；`step/` 顶层只剩 `archive/`）
- [ ] 归档目录里文件齐全：8 个 step 文件 + `00-index.md` + `REPORT.md`（共 10 个；`step-08-archive.md` 自身也在其中）
- [ ] `00-index.md` 里记的「归档目录」与实际目录名完全一致
- [ ] `00-index.md` 的「归档时间」已填写
- [ ] 归档目录路径已在回复中告知用户

## 规则

- 只移动，不删除。用户要的是能回查的提示词，不是消失的文件。
- 不要顺手清理用户自己的其他文件（`step/archive/` 下的历史归档、`%TEMP%` 下的截图、用户配置都不要动）。
- 如果第 2 步改完 `00-index.md` 才发现某步没完成，把索引改回去并终止归档，不要留下半成品归档目录。

## 执行记录

（执行后填写：归档目录实际路径、文件数、自检输出）
