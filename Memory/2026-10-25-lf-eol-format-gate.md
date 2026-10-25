---
date: 2026-10-25
title: format:check 在 Windows 本机假红：core.autocrlf=true 与 endOfLine=lf 打架，靠 .gitattributes 定死
tags: [构建, 格式化, 环境, pnpm, 坑]
source: 模型自动记录
---

# `format:check` 本机假红：换行符与真的没格式化混在一起

## 现象

- `pnpm format:check` 在本机报 **51 个文件** 不合规，但这些文件在别人机器 / CI 上是绿的；
  其中一部分（如 `packages/shared/src/plugin/ids.ts` 的 108 字符行）**确实**没格式化，
  另一部分（如 `apps/desktop/src/main/vision.ts`）内容没问题，只是**工作区是 CRLF**。
- 同一时刻 `git status` 会列出这些文件为 `M`，但 `git diff` 是空的、`git hash-object` 与
  `git rev-parse :<path>` **哈希完全相同**。

## 原因

1. Git for Windows 安装时默认 `core.autocrlf=true`，checkout 把仓库里的 LF 写成工作区 CRLF；
   而 [.prettierrc.json](../../.prettierrc.json) 是 `endOfLine: 'lf'` —— Prettier 读的是**工作区字节**，
   CRLF 一律判成「未格式化」。
2. 索引里存的是归一化后的 LF（`git ls-files --eol` 显示 `i/lf w/crlf`），所以 git 认为内容没变；
   `M` 与空 diff 的错位来自 stat 缓存 / racy 条目（`git update-index --refresh` 也只报 "needs update"）。
3. 仓库原先**没有 `.gitattributes`**，EOL 政策只靠各人本机的 `core.autocrlf`，两端必然不一致。

## 影响

- 本机 CI 门禁（`.github/workflows/ci.yml` 第一步就是 `format:check`）看起来长期是红的，
  容易把「换行符问题」误判成「有人提交了没格式化的代码」，也可能反过来把真的 26 个未格式化文件
  一起当成假红放过。CI 是**手动触发**，所以真红不会自己冒出来。
- 出现"哈希相同却显示 M"的假脏工作树时，会浪费一轮排查；删掉 `.git/index.lock` 后
  `git add` 一次即可恢复干净。

## 结论与做法

- **仓库根放 `.gitattributes`：`* text=auto eol=lf`**（属性优先级高于 `core.autocrlf`，
  Windows 与 CI 都按 LF 检出）；二进制扩展名另写 `binary`。
- 判断「真格式问题」还是「只是 CRLF」：`git ls-files --eol -- <path>` 看 `w/crlf`；
  把文件转成 LF 后再 `prettier --check --config .prettierrc.json` 跑一遍即可分离两类。
- 新增/改完 `.gitattributes` 要跑一次 `pnpm format`（顺带把工作区 CRLF 归一化成 LF），
  再 `pnpm format:check` 确认全绿；`.vue` 被 prettier 改过**必须重跑 build**再进截图。
- 日常 `pnpm <script>` 若被插一条 `pnpm install --production` 卡住（无 TTY），
  先确认 `node_modules/.modules.yaml` 是否晚于 `package.json` 的版本号改动，
  再 `pnpm install --frozen-lockfile` 刷新状态；不要用 `CI=true` 强装。
