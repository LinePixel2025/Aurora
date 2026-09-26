# Step 06 — 归档清理

- Task: agent-prod-mainline
- Step: 6 / 6
- Status: pending
- Depends on: step 1..5

## 目标

本次任务（agent-prod-mainline：项目机制 + 三档权限 + 写前快照 + Task/Job 持久化续跑）全部步骤完成后，把这次生成的 step 文件整体归档进 `step/archive/<YYYYMMDD-HHMMSS>-agent-prod-mainline/`，让 `step/` 顶层恢复干净，供下一批任务（多模态 + Responses API、子代理对齐 Codex、上下文压缩修正）使用。

## 前置检查

先逐条确认，**任何一条不成立就停下并报告，不要归档**：

1. `step/00-index.md` 的「步骤」表里，step 1–5 的 Status 全部是 `done`（执行阶段应已把每步文件的 `Status:` 字段改成 `done` 并勾选验收标准）。
2. `step/00-index.md` 的「完成标准」里 6 条全部勾选。
3. 「假设与待确认」里没有悬而未决的"待确认"项（本计划的「待确认」原文就是"无"，只需确认没有被改成别的内容）。
4. 「执行记录」里已经填了：全量验证数字、`AURORA_SMOKE` 结果、两次启动续跑的观测输出、capture 的 `report.json` 结论、独立审查结论（或未做审查的原因）、commit 列表。
5. 工作区没有未提交的功能性改动：`git status --short` 里除 `.dsh/`、`Design/` 这类既有的未跟踪目录外，**不应再有本轮涉及文件的未提交修改**（若有，先提交或说明）。

## 操作

按 1 → 2 → 3 → 4 的顺序做：先冻结时间戳、再补索引、再移动文件。反过来就不知道该往索引里写哪个归档路径了。

1. 冻结时间戳并算出归档路径（后面几步都用这两个变量，**不要重新取一次时间**，否则索引里记的路径会和实际目录名差几秒）：

   ```powershell
   cd D:\AICOP\Projects\Aurora
   $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'          # 只取一次
   $dest  = "step/archive/$stamp-agent-prod-mainline"   # slug 必须与 00-index.md 的「任务标识」逐字符相同
   if (Test-Path $dest) { $dest = "$dest-2" }           # 撞名才追加 -2，绝不合并进已有目录
   $dest                                                # 记下来，第 2、3 步都用它
   ```

2. 把 `step/00-index.md` 的「归档目录」填成第 1 步算出的 `$dest`，并记上归档时间（`Get-Date -Format 'yyyy-MM-dd HH:mm'`）。

3. 建归档目录并移动本次生成的文件：

   ```powershell
   cd D:\AICOP\Projects\Aurora
   $dest = "<第 1 步算出的路径>"
   New-Item -ItemType Directory -Force -Path $dest | Out-Null
   if (Test-Path step/00-index.md) { Move-Item step/00-index.md $dest/ }
   Get-ChildItem step/step-*.md | Move-Item -Destination $dest/
   ```

   - **只移动 `step/` 顶层的 `00-index.md` 与 `step-*.md`**；`step/archive/` 下的历史归档（`20260920-140927-frontend-refresh`、`20260922-123340-computer-control`、`20260923-132859-chat-window-ux-fixes`、`20260925-000129-agent-tts-voice`、`20260925-035034-aurora-visual-themes`、`20260926-052221-opencode-parity`）**一律不要动**。
   - 本次的归档 step 文件（就是你现在执行的这个 `step-06-archive.md`）也会被一起移走，这是预期的 —— 它的内容已在上下文里，继续完成剩余操作即可。
   - 只移动、不删除：不清理用户自己的任何其它文件。

4. 在归档目录里写 `REPORT.md`：本次任务做了什么、每步的验证结果（含真实命令与数字）、遗留问题、独立审查结论与处置、commit 列表。一行一条，不要长篇复述 step 文件内容。

## 验收标准

- [ ] `Get-ChildItem step/*.md` 无输出（`step/` 顶层无残留文件）。
- [ ] 归档目录名匹配 `<YYYYMMDD-HHMMSS>-agent-prod-mainline`（时间戳为 8+6 位数字，slug 与 `00-index.md` 的「任务标识」逐字符相同）。
- [ ] 归档目录里文件齐全：**7 个文件** = `00-index.md` + 6 个 step 文件（`step-01-project-agents-md.md`、`step-02-permission-modes.md`、`step-03-write-snapshots.md`、`step-04-durable-jobs.md`、`step-05-verify-integrate.md`、`step-06-archive.md`）+ `REPORT.md`。用 `(Get-ChildItem $dest).Count` 核实为 7。
- [ ] `step/00-index.md`（现在位于归档目录里）记的「归档目录」与实际目录名完全一致。
- [ ] `step/archive/` 下的 6 个历史归档目录仍在，数量与归档前一致。
- [ ] 归档目录路径已在回复中告知用户。

## 规则

- 只移动，不删除。用户要的是能回查的提示词，不是消失的文件。
- 不要顺手清理用户自己的其它文件，也不要动 `step/archive/` 里的历史归档。
- 归档目录命名规范：`step/archive/<YYYYMMDD-HHMMSS>-<task-slug>/`，时间戳只取一次；已有同名目录只能追加 `-2`，**绝不合并覆盖**。
