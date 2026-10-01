# Step 12 — 归档清理

- Task: bugfix-p0p1p2
- Step: 12 / 12
- Status: done
- Depends on: step 1..11
- Writes: step/

## 目标

本次任务全部步骤完成后，把这次生成的 step 文件归档，恢复干净的 step/ 目录。

## 前置检查

先确认前面每一步的 Status 都是 done、验收标准都勾选完成，并且 `00-index.md` 里"完成标准"已满足、"待确认"里已经没有悬而未决的问题。
**只要有任何一步没完成、验证没过，或有待确认项没解决，就不要归档**，把缺哪一步报给用户，然后结束。

## 操作

按 1 → 2 → 3 → 4 → 5 的顺序做：先把时间戳冻结、索引补全、状态标完，再移动文件。反过来就不知道该往索引里写哪个归档路径，文件一移走也再改不了。

1. 冻结时间戳并算出归档路径（后面两步都用这两个变量，不要重新 `date` 一次，否则索引里记的路径会和实际目录名差几秒）：

   ```bash
   cd "D:\AICOP\Projects\Aurora"
   stamp="$(date +%Y%m%d-%H%M%S)"                    # 只取一次；Windows 无 date 时用 Get-Date -Format 'yyyyMMdd-HHmmss'
   dest="step/archive/${stamp}-bugfix-p0p1p2"         # slug 固定用 00-index.md 的「任务标识」bugfix-p0p1p2，不许另起
   [ -e "$dest" ] && dest="${dest}-2"                 # 撞名才追加 -2，不许合并进已有目录
   echo "$dest"     # 记下来，第 2、4 步都用它
   ```

2. 把 `step/00-index.md` 的"归档目录"填成刚算出的 `$dest`，并记上归档时间。
3. **在移动任何文件之前**，把本归档 step 文件头部的 `Status` 改成 `done`，`00-index.md` 步骤表里归档那一行的状态也改成 `done`——文件马上就要被移走，事后改不到。
4. 建归档目录并移动本次生成的文件：

   ```bash
   cd "D:\AICOP\Projects\Aurora"
   dest="<第 1 步算出的路径>"
   mkdir -p "$dest"
   [ -f step/00-index.md ] && mv step/00-index.md "$dest"/ || true
   mv step/step-*.md "$dest"/ 2>/dev/null || true
   ```

   - 只移动 `step/` 顶层的 `00-index.md` 和 `step-*.md`；`step/archive/` 里的历史归档不要动。
   - 本次的归档 step 文件（就是你现在执行的这个 `step-12-archive.md`）也会被一起移走，这是预期的 —— 它的内容已经在上下文里，继续完成剩余操作即可。
5. 在归档目录里写 `REPORT.md`：本次任务做了什么、每步的验证结果、39 条条目的提交覆盖情况、遗留问题、以及执行阶段的代码审查结论，一行一条，不要长篇复述。

## 验收标准

- [ ] `ls step/*.md` 无输出（无残留文件）
- [ ] 归档目录名匹配 `<YYYYMMDD-HHMMSS>-bugfix-p0p1p2`（时间戳 8+6 位数字，slug 与 `00-index.md` 的「任务标识」逐字符相同）
- [ ] 归档目录里文件齐全：12 个 step 文件 + `00-index.md` + `REPORT.md`（共 14 个；`step-12-archive.md` 自身也在其中）
- [ ] `00-index.md` 里记的"归档目录"与实际目录名完全一致
- [ ] 本文件头部 `Status` 与 `00-index.md` 步骤表里归档那一行都是 `done`（移动前就标好，随文件一起进了归档目录）
- [ ] 归档目录路径已在回复中告知用户

## 规则

- 命名与流程细则以 `step-runner` skill 的《归档目录命名规范》为准：本文件的命令与它冲突时，以规范为准。
- 只移动，不删除。用户要的是能回查的提示词，不是消失的文件。
- 不要顺手清理用户自己的其他文件（`bug/` 目录是审查报告输入，保持原样）。
