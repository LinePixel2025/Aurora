---
date: 2026-10-31
title: v0.5.9 双投发布（Computer Use + 插件工具包）与 gh release 先建轻量 tag 的坑
tags: [发布, 打包, 更新源, Center, GitHub, 插件, 工具包, git, 坑, 口径]
source: 模型自动记录
---

# v0.5.9 双投发布与插件开发工具包升级（2026-10-31）

## 现象

- 桌面 **v0.5.9** 已双投：tag `v0.5.9`（annotated，指向 `2695c7d`）、GitHub Releases 三资产
  （安装包 / blockmap / latest.yml）与 Aurora Center 更新源一致；Center `/api/updates/current`
  返回 0.5.9，sha512 / size 与本地 `latest.yml` 相同，安装包 Range → **206**。
- 发布脚本先打 tag、后上传；`gh release create` 时本地 tag **尚未 push**，GitHub 按默认分支
  HEAD（`fb2c6dd`）自动创建了一个**轻量 tag**，Release 因此挂在了发布提交的前一个 commit 上。
- 用 `git push origin v0.5.9` 被拒（remote tag 已存在），改用
  `git push --force origin v0.5.9` 换成 annotated tag 后恢复正确：GitHub Release 的
  `target_commitish` 仍是 `main`，tag ref 指向 annotated tag → `2695c7d`。

## 原因

- `gh release create <tag>` 在远端没有该 tag 时会**用当前默认分支 HEAD 新建轻量 tag**，
  不会读取本地同名 tag 的对象；而 `release.mjs` 的 `--publish` 分支不做 git push。
- Git tag 推到「已存在同名 tag」的远端时是普通 ref 更新，必须 `--force` 才能改写类型 / 指向。

## 影响

- 若只把 release 建出来就结束，源码 tag 与安装包内容会错位一版：页面显示的是旧提交，
  用户看不到本版源码；事后即使补推 tag 也要额外 force，且容易误以为「Release 内容丢了」。
- Center 的 `aurora.linetech.online` 域名当前返回 **530**（Cloudflare 隧道没通），
  但服务器直连 `<Center 主机>:8787` 正常；核验只能用直连地址，别因域名 530 误判服务挂了。

## 结论与做法

- 发布顺序改成：`git push origin main` → `git push origin v0.5.9` → 再跑
  `release.mjs --publish`（或至少 `gh release create` 前确保远端 tag 已是 annotated 版本）。
  已经发生错位时：`git push --force origin v0.5.9`，再用
  `gh api repos/<owner>/<repo>/git/tags/<tagObjectSha>` 确认 peel 到发布提交。
- `gh release create` 自带建 tag 行为**不能**当作「本地 tag 已上传」；发布后必须核对
  `tag object → commit` 与 Release 三资产大小 / `latest.yml` sha512。
- Center 直连地址与域名同时记着：域名故障时用 `<Center 主机>:8787`；管理员密码
  由用户当次提供，不落盘、不进 Memory。

## 本版工具包（plugin-dev-kit v0.5.9）

- 新增 `tools/create-plugin.mjs`（模板脚手架 + 自动填清单 + 附契约类型 + 立即校验）、
  `tools/pack-plugin.mjs`（零依赖 zip，包根 `manifest.json`，默认先校验）；
- `tools/check-plugin.mjs` 与宿主清单 zod schema 对齐：保留 id 段补 `system/core`、
  保留命令名、宿主事件白名单、主题令牌白名单与颜色 / 长度、配置字段（select 必填 options）、
  自动化动作 / 事件、工具超时 / 参数 schema 大小、图片文件存在、Skill 两种目录布局；
  未知字段只 warning，并支持 `--json`；
- `docs/01-contract.md` / `docs/02-guide.md` 由仓库 docs/14、docs/15 同步（去掉了仓库专有链接），
  模板补 `types/aurora-plugin.d.ts`；
- 校验口径：`pnpm typecheck`、`pnpm test` **211 文件 / 2979 例**、`pnpm build`、
  `pnpm verify` 26/26（迁移 39/39）、`verify:release` 15/15。

## 本版发布事实

- 配置 Schema **v39**（新增 `computerUse`，默认关闭）；插件 API 不变；Center 服务器仍 **0.5.2**，
  不随桌面版换装。
- 三资产双投同一次打包：`Aurora-Setup-0.5.9.exe`（203,440,211 B，sha512 `O2SPGaJ5…`）、
  `.blockmap`、`latest.yml`；GitHub 与 Center 的 version / size / sha512 一致。
