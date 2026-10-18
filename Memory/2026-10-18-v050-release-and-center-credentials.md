---
date: 2026-10-18
title: v0.5.0 三源发布（GitHub + Center，内置浏览器 Agent 工具组 v35）与发布凭据 / 限流口径
tags: [发布, 打包, 更新源, Center, GitHub, 凭据, 限流, 记录]
source: 模型自动记录
---

# v0.5.0 三源发布记录（2026-10-18）

## 现象

v0.4.9 → v0.5.0 的发布内容只有一条功能提交 `86f99eb`（内置浏览器 Agent 工具组，配置 Schema
v34 → v35），但发布链路上出现了两类与代码无关的卡点：

1. **Center 登录连续 401**：环境变量 `AURORA_CENTER_USER=codex-release` 看起来像发布账号，
   实测该账号与 `admin` 都不是"这个密码能登录的账号"；反复试错又触发了 Center 的登录限流
   （`E_RATE_LIMITED`，HTTP 429）。
2. **Center 发布不是"重跑整条 release.mjs"就能补**：第一次 `--publish --publish-center`
   在 GitHub 上传成功、tag 已建之后，才在 Center 登录处失败退出（发布未完成）。

本次最终结果（三源一致，已实测）：

| 项 | 值 |
| --- | --- |
| 配置 Schema | **v35**（迁移 `v34 → v35`：新增 `agent.browser` 六个字段） |
| 提交 | 功能提交 `86f99eb`；release 提交 `df5735f`（版本号 + release notes + README/roadmap） |
| tag | `v0.5.0`，annotated，正文与 `docs/release-notes/v0.5.0.md` **逐字一致**（含首行 `# Aurora v0.5.0`） |
| 源码 | `main` 已推（`af25814..df5735f`），走 SSH 443；`refs/remotes/origin/main` 已手动对齐 |
| GitHub | `LinePixel2025/Aurora-releases` releases/tag/v0.5.0（Latest），3 资产 uploaded |
| Center | `/api/updates/current`：`version=0.5.0`、`files` 3 项、`publishedAt=2026-10-18T07:35:23.669Z` |
| 安装包 | `Aurora-Setup-0.5.0.exe` **203,182,972 B**，sha512 `LOHFPN03…yCbyA==`；blockmap 212,426 B；latest.yml 341 B |
| 三源一致性 | 本地 / Center / GitHub 的 `latest.yml` SHA-256 **完全相同**（`75236CCC…005D13D`）；Center 安装包 Range → **206** |
| 验收 | `typecheck` / `lint` / `build` 全绿；`pnpm test` **182 文件 / 2688 用例**；`verify-p1` 26/26（`version=35`、迁移 35/35）；`verify-update` 14/14 |

## 原因

- **账号口径过期**：`AURORA_CENTER_USER=codex-release` 是环境里遗留的值，不是 Center 管理员账号；
  Center 的初始化 / 部署文档（`packages/center/deploy/README.md` §3）明确首个管理员是
  `admin`。发布脚本的 `--center-user` 必须与"能登录 Web 管理页的账号"一致。
- **登录限流在密码校验之前判定**：`packages/center/src/server.ts` 的 `AUTH_RATE_LIMITS.login`
  是 **5 次失败 / 60 秒 / 源 IP**，窗口内连正确密码也返回 429（防止"每 N 次猜中一次"）。
  所以凭据不确定时**不能反复试**，试错本身会把 1 分钟窗口占满。
- **发布脚本的顺序**：`release.mjs` 先做 GitHub（建 release + 上传），最后才做 Center 登录；
  Center 失败时 GitHub 已生效，tag 也已创建，但按仓库硬规则**发布尚未完成**。

## 影响

- 把"环境里有 AURORA_CENTER_USER"误当成"账号就是它"，会得到 401 却不知道为什么；
  继续重试会升级成 429，看起来像"密码也不对"。
- 只重跑整条 `release.mjs` 会重复打包（几分钟）并撞上"tag 已存在"的分支；需要 `--skip-package`。
- 若只看 GitHub 的 3 个资产就宣布完成，会漏掉 Center 更新源 —— 客户端走 Center 优先的更新链路，
  等于新版本发不出去。

## 结论与做法

1. **Center 发布账号固定 `admin`**（`--center-user admin`）；环境变量里的
   `AURORA_CENTER_USER=codex-release` 不要直接拿来用，先确认它能否登录 Web 管理页。
2. **凭据不确定时最多试 1 次**；遇到 `E_RATE_LIMITED` / HTTP 429 **等满 60 秒**再试，
   期间不要继续请求登录接口。
3. **GitHub 已成功、只差 Center 时的标准补发命令**（不重新打包、不重复建 tag）：
   ```powershell
   $env:AURORA_CENTER_PASSWORD='<admin 密码>'
   node scripts/release.mjs --skip-package --publish-center `
     --center-url http://120.24.223.65:8787 --center-user admin `
     --notes-file docs/release-notes/vX.Y.Z.md
   ```
   它会重跑 `verify-update`（14/14）→ 跳过已存在的 tag → 上传三资产 → publish。
4. **推源码走 SSH 443**（`github.com` 的 HTTPS 被整域掐断时的既定口径）：
   ```powershell
   git push git@github.com:LinePixel2025/Aurora.git main --follow-tags
   git update-ref refs/remotes/origin/main <刚推上去的 sha>
   ```
   显式 URL 推送不会更新跟踪引用，不补这一步 `git status` 会一直显示"领先 origin/main"。
5. **发布完成判据**（每次照做）：三资产齐全（exe / blockmap / latest.yml）+ annotated tag 正文
   与 notes 逐字一致 + GitHub 与 Center 两端 `latest.yml` 哈希相同 + Center 安装包 Range 206。
6. **Center 服务器自身不动**：线上仍是独立版本线（本次未换装、不建 tag、不上传 GitHub）；
   `--publish-center` 只更新"更新源资产"，与 Center 代码部署无关。
