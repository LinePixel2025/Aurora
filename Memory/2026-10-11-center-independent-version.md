---
date: 2026-10-11
title: Aurora Center 版本线与桌面端解耦：更新 Center 不建 tag、不上传 GitHub
tags: [发布, Center, 版本, 口径]
source: 用户手动添加
---

# Center 版本线独立（2026-10-11 用户口径）

## 现象

历史上「只动 Center」的更新也被拖着走桌面发布流程：root / apps/desktop / packages/center
三个 `package.json` 一起升号（0.4.4 → 0.4.7 全程同号）、写 `docs/release-notes/vX.Y.Z.md`、
挂 annotated tag、部署包也传 `LinePixel2025/Aurora-releases`。而 v0.3.6 / v0.3.7 的发布说明
其实早已注明两者**分属两条独立的版本线**。

## 原因

「发布 tag」「发布双投」两条硬规则过去没写明**只适用桌面安装包**，Center-only 变更被套进
安装包发布链路；「三者版本一致」又被理解成「Center 版本号必须等于客户端版本号」。

## 影响

不按新口径会持续为 Center 更新多付 tag / GitHub 上传 / 发布说明的无用成本，并误以为
Center 版本号被客户端锁死、不能单独推进（镜像 tag、CLI `version`、握手 `welcome` 其实
只认 `packages/center/package.json`）。

## 结论与做法（用户 2026-10-11 定稿）

- Center 版本号**只以 `packages/center/package.json` 为准，不必与 Aurora 客户端相同**；
  `aurora-center version`、握手 `welcome`、`docker-compose.yml` 的 `image: aurora-center:<ver>`
  都跟着它走。
- Center 更新 = 只升该包版本（**不动 root / apps/desktop**）→ 按 `packages/center/deploy/README.md`
  §0/§1 重新打包换装；**不创建 git tag、不上传 GitHub Releases、不走 `scripts/release.mjs`**。
- 「发布 tag / 发布双投」（AGENTS.md、docs/09 §7/§10）明确**只约束桌面安装包**；
  往 Center 更新源传**安装包**（`--publish-center` / `aurora-center releases publish`）
  仍必须与 GitHub Release 双投 —— 那是桌面发布链路的一部分，与本口径不冲突。
- 历史记忆（如 [2026-10-06-center-official-models-and-updates.md](2026-10-06-center-official-models-and-updates.md)
  「双投硬规则」）按此理解：主语是桌面安装包。SSOT 落点：docs/12 §9、docs/09 §7/§10、
  `packages/center/deploy/README.md` §0、AGENTS.md「编码与安全约定」。
