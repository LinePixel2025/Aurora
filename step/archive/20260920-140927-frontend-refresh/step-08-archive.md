# Step 08 — 归档清理

- Task: frontend-refresh
- Step: 8 / 8
- Status: done
- Depends on: step 1..7

## 目标

本次任务全部步骤完成后，把这次生成的 step 文件归档，恢复干净的 `step/` 目录。

## 前置检查

先确认前面每一步的 Status 都是 done、验收标准都勾选完成，并且 `00-index.md` 里「完成标准」已满足
（尤其：`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全绿、`pnpm verify` 通过、
`AURORA_SMOKE` 全绿、step-07 的独立审查 P0/P1 已处置）。
**只要有任何一步没完成或验证没过，就不要归档**，把缺哪一步报给用户，然后结束。

## 操作

按 1 → 2 → 3 的顺序做：先把时间戳冻结、索引补全，再移动文件。反过来就不知道该往索引里写哪个归档路径了。

1. 冻结时间戳并算出归档路径（后面两步都用这两个变量，不要重新 `date` 一次，否则索引里记的路径会和实际目录名差几秒）：

   ```bash
   cd "D:/AICOP/Projects/Aurora"
   stamp="$(date +%Y%m%d-%H%M%S)"
   dest="step/archive/${stamp}-frontend-refresh"
   echo "$dest"     # 记下来，第 2、3 步都用它
   ```

2. 把 `step/00-index.md` 的「归档目录」填成刚算出的 `$dest`，并记上归档时间。
3. 建归档目录并移动本次生成的文件：

   ```bash
   cd "D:/AICOP/Projects/Aurora"
   dest="<第 1 步算出的路径>"
   mkdir -p "$dest"
   [ -f step/00-index.md ] && mv step/00-index.md "$dest"/ || true
   mv step/step-*.md "$dest"/ 2>/dev/null || true
   ```

   - 只移动 `step/` 顶层的 `00-index.md` 和 `step-*.md`；`step/archive/` 里的历史归档不要动。
   - 本次的归档 step 文件（就是你现在执行的这个 `step-08-archive.md`）也会被一起移走，这是预期的 ——
     它的内容已经在上下文里，继续完成剩余操作即可。
4. 在归档目录里写 `REPORT.md`：本次任务做了什么、每步的验证结果、遗留问题、以及执行阶段的代码审查结论，
   一行一条，不要长篇复述。素材直接取 `00-index.md` 的「执行记录」，至少覆盖：
   - 三条原始诉求各自的达成证据（提示条点击呼出交互窗 / service-dock 已删除 / Apple 风格与动效 / 设置页门控）；
   - `pnpm verify` 与 `AURORA_SMOKE` 的结论；配置版本 3 → 4 的迁移是否幂等；
   - step-07 独立审查的 P0/P1 处置结果；
   - 已知残留（例如提示条透明窗口截图的可读性限制、`general.language` 仍保留在 Schema）。

## 验收标准

- [ ] `ls step/*.md` 无输出（无残留文件）
- [ ] 归档目录里文件齐全：7 个 step 文件（`step-01`..`step-07`）+ 1 个 `step-08-archive.md` + `00-index.md` + `REPORT.md`
      （共 10 个）
- [ ] `00-index.md` 里记的「归档目录」与实际目录名完全一致
- [ ] 归档目录路径已在回复中告知用户

## 规则

- 只移动，不删除。用户要的是能回查的提示词，不是消失的文件。
- 不要顺手清理用户自己的其他文件。
