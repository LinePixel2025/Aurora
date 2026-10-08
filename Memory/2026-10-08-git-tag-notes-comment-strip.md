---
date: 2026-10-08
title: git tag -a -F 发布说明会剥掉首行 # 标题，必须 --cleanup=verbatim
tags: [发布, git, 坑]
source: 模型自动记录
---

# git tag 的 -F 会把 `#` 行当注释剥掉

## 现象

用 AGENTS.md 规定的发布方式打 tag：

```bash
git tag -a v0.4.6 -F docs/release-notes/v0.4.6.md
git tag -l -n1 v0.4.6
```

`git tag -l -n1` 输出的首行不是 `# Aurora v0.4.6`，而是正文第一句——
发布说明的标题行被静默剥掉了（其余正文完整）。

## 原因

git 的 `-F` / `-m` 默认走 **cleanup 模式（strip）**：把以 `#` 开头的行当作注释删除，
并修整尾部空行与空白。而本仓库的发布说明（`docs/release-notes/vX.Y.Z.md`）**首行恰是
`# Aurora vX.Y.Z`** —— 正好命中注释规则，标题首当其冲。

## 影响

- annotated tag 的完整 message 是发布口径的一部分（发布脚本会拿 `--notes-file` 硬检查、
  GitHub Release 也可能复用），标题丢失会让 tag 与说明文件**不一致**，且没有任何报错——
  只有 `git show vX.Y.Z --no-patch` 逐字核对才会发现。
- 与"发布 tag 必须写完整发布说明"的硬规则直接冲突，属于会造成发布不完整的坑。

## 结论与做法

- **打发布 tag 一律加 `--cleanup=verbatim`**：

  ```bash
  git tag -a vX.Y.Z --cleanup=verbatim -F docs/release-notes/vX.Y.Z.md
  ```

- 打完之后**核验首行**：`git show vX.Y.Z --no-patch --format='%B' | head -3`
  应当原样输出 `# Aurora vX.Y.Z`。
- 打错了就直接删掉重打（本地 tag 未推时无副作用）：
  `git tag -d vX.Y.Z && git tag -a vX.Y.Z --cleanup=verbatim -F …`。
