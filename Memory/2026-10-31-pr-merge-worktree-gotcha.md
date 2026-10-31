---
date: 2026-10-31
title: 合并 PR 时分支还挂在 worktree 里：gh 退出码 1 但合并已经成功，远端分支也没删
tags: [发布, git, GitHub, PR, worktree, 坑, 口径]
source: 模型自动记录
---

# `gh pr merge --delete-branch` 撞上 worktree：合并成功却报失败

## 现象

把 `risk/computer-use` 用 PR 并回 `main` 时执行：

```bash
gh pr merge 1 --squash --delete-branch
```

输出只有一行报错、退出码 1：

```text
failed to delete local branch risk/computer-use: failed to run git: error: cannot delete branch
'risk/computer-use' used by worktree at 'D:/AICOP/Projects/Aurora/.agents/worktrees/risk-computer-use'
```

看起来像「合并失败」，实际上：

- `gh pr view 1 --json state,mergedAt,mergeCommit` → `MERGED`，远端 `main` 已经前进到 squash 提交；
- **远端分支 `risk/computer-use` 仍然存在**（gh 在本地删分支这一步就中止了，没走到删远端）；
- 本地 `main` 还停在合并前，`git status` 显示「behind 1」。

另外 `gh pr view --json merged` 不是合法字段（只有 `state` / `mergedAt` / `mergeCommit`），
用它会多一条 `Unknown JSON field` 报错，容易和上面的失败混在一起看。

## 原因

`gh pr merge --delete-branch` 的顺序是：先合并 → 删**本地**分支（`git branch -D`）→ 删远端分支。
本地分支被 `git worktree` 占用时 `git branch -D` 必然失败（这是 git 的正确行为），
gh 把这个失败当整体失败返回非 0，于是后续删远端被跳过。

也就是说 **「退出码非 0」与「合并没发生」不是一回事**：合并是 API 侧先完成的一步。

## 影响

- 按退出码判断会误以为没合上，重试 `gh pr merge` 只会得到「already merged」之类的报错，越试越乱；
- 远端分支残留，`git branch -a` 里还看得见 `origin/risk/computer-use`，下次容易基于它再开分支；
- 本地 `main` 落后远端，后续开发会从旧基线上分叉，`release.mjs` 的发布检查也会受影响。

## 结论与做法

1. **先确认事实，再决定动作**：
   ```bash
   gh pr view <n> --json state,mergedAt,mergeCommit --jq '.state, .mergeCommit.oid'
   gh api repos/<owner>/<repo>/git/ref/heads/main --jq '.object.sha'
   ```
   `state = MERGED` 且远端 `main` 已前进 → 合并已完成，剩下的只是「收尾」。
2. **收尾三件事**（分支在 worktree 里时顺序不能换）：先移除 worktree，再删本地分支，最后删远端分支：
   ```bash
   git -C .agents/worktrees/risk-<主题> status --porcelain   # 必须先确认干净
   git worktree remove .agents/worktrees/risk-<主题>
   git branch -D risk/<主题>
   gh api -X DELETE repos/<owner>/<repo>/git/refs/heads/risk/<主题>
   ```
   合并前就先移除 worktree 更省事；若合并已经发生，远端残留直接走 `gh api -X DELETE`（不依赖 push 网络）。
3. **本地 `main` 对齐远端**：`git fetch origin --prune` → `git merge --ff-only origin/main`；
   本机 github.com HTTPS 被掐时按 [2026-10-16 那条](./2026-10-16-github-https-blocked-ssh443-push.md) 走 SSH 443 一次性 URL。
4. **别用退出码判断 PR 是否合并**：以 `gh pr view` 的 `state` + 远端 `main` 的 ref 为准。
