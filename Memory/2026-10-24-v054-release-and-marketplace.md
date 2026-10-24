---
date: 2026-10-24
title: v0.5.4 双投发布 + Aurora Center 0.5.0 插件市场换装上线
tags: [发布, 打包, 更新源, Center, GitHub, 插件, 市场, 部署, 记录, 口径]
source: 模型自动记录
---

# v0.5.4 发布与 Center 0.5.0 插件市场上线（2026-10-24）

## 结果

| 项 | 值 |
| --- | --- |
| 提交 | 功能 `0e9a1b1` / `ff0ab03`；Center `b3e0d11`；发布 `52748fa`；直连 IP 文档修正 `cbaf1b2` |
| tag | `v0.5.4` annotated（对象 `242e0f1`）；tag 正文与 `docs/release-notes/v0.5.4.md` **字节级一致** |
| 源码 | main 已推（`454492f..cbaf1b2`），走 SSH 443；tracking ref 已对齐 |
| GitHub | `LinePixel2025/Aurora-releases` releases/tag/v0.5.4，3 资产，body 与 notes 归一化后逐字一致 |
| Center 更新源 | `/api/updates/current`：`version=0.5.4`、3 文件；直连 IP 安装包 Range → **206** |
| 安装包 | `Aurora-Setup-0.5.4.exe` **203,251,616 B**，sha256 `16706A02733FEA144B288CABC98A3548C24F21E9901016347A89EE537C462300` |
| latest.yml | sha256 `9512FD7E80247B95F3AF5645233AB57DB55755C047DB2F95930FEBD9ED708C0`（本地 / Center / GitHub 三源相同） |
| Center 服务 | `/opt/aurora-center` 0.4.9 → **0.5.0**，healthy，CLI `version`=0.5.0；`./data` 与 `.env` 未动（备份 `backup-center-0.4.9-20261024-202927`） |
| 插件市场 | 公开 `/api/plugins` 200、管理员路由匿名 401、`#/marketplace` 前端 chunk 已上线；示例 `com.example.hello` v1.0.0 已发布（sha256 `e32834ca…`，size 10574） |
| 验收 | typecheck / lint / build 全绿；`pnpm test` **196 文件 / 2845 用例**；`verify` 26/26；冒烟 **243/243**；截图 98 + 6 + 3（唯一恒红 `chat-model-picker`）；Center `verify:web` **102/102**；独立子代理线上 10 项判据全 ok |

## 口径（长期）

- **Center 入口一律直连 IP `http://120.24.223.65:8787`**：用户 2026-10-24 明确 Cloudflare 隧道
  域名入口国内访问不稳定，**视为不存在，不要再写进文档 / 推荐给用户**（历史 release notes 里
  的旧域名属历史记录，不改）。
- 顺序：**先换装 Center**（协议增量兼容旧客户端）→ 再打包桌面并双投；Center 版本线独立
  （本次 0.4.9 → 0.5.0），**不建 tag、不上传 GitHub**。
- 安装包上传 Center 必须走直连 IP（203MB POST 经隧道会撞 Cloudflare 请求体限制）。
- `release.mjs --push` 走的是 origin HTTPS，会被 github.com 掐断 → 发布后手工
  `git push git@github.com:LinePixel2025/Aurora.git main` + 推 tag，再把
  `refs/remotes/origin/main` 对齐到新 sha。
- 需要改已发布 tag 正文时：`git tag -f -a vX.Y.Z -F <notes> --cleanup=verbatim` →
  `git push -f <ssh-url> refs/tags/vX.Y.Z` → `gh release edit vX.Y.Z --notes-file <notes>`，
  让 tag / GitHub body / notes 文件三处字节一致。

## Center 换装步骤（本次实测）

1. 升 `packages/center/package.json` 0.4.9→0.5.0 + `deploy/docker-compose.yml` image tag，
   并先 `pnpm install --frozen-lockfile` 刷 pnpm 依赖状态。
2. `pnpm --filter @aurora/shared build && pnpm --filter @aurora/center build`（dist-web 必须新鲜）。
3. `pnpm --filter @aurora/center deploy --prod --legacy $env:TEMP\aurora-center-deploy-0.5.0`
   → 删 `src / web / verify / deploy / tsconfig.json / tsconfig.web.json / vite.config.ts`
   → 拷 Dockerfile 与 compose → tar（本次 38,315,900 B）。
4. scp → 服务器先 `sha256sum` 比对 → 备份 `bin dist dist-web package.json docker-compose.yml Dockerfile .env`
   → `tar -xzf` → `docker compose up -d --build`。
5. 验证：`docker compose ps` healthy、CLI `version`=0.5.0、`curl /api/plugins` 200、
   `/api/admin/plugins` 401、`/api/updates/current` 的更新源资产不变。

## 市场示例上传

```
$env:AURORA_CENTER_PASSWORD='<admin 密码>'
node packages/center/bin/aurora-center.js plugins publish \
  --server http://120.24.223.65:8787 --user admin \
  --dir plugin-dev-kit/examples/hello-aurora --changelog "官方示例插件…"
```

同版本不可覆盖；要重发先 `plugins unpublish`。上传前先
`node scripts/verify-plugin.mjs <目录>`。

## 踩坑

- 隧道域名下首轮请求常 45s 超时（重试即 200）——这是域名入口本身的问题，不是服务故障；
  现已弃用域名，线上验收一律打直连 IP。
- `format:check` 有 **57 个历史文件**格式不合格（plugin v36 轮引入，非本次发布引入）；
  本轮没有顺手格式化（避免 prettier 改坏 `.vue` 模板），CI 要绿需单独清理。
- 版本号变更后不先 `pnpm install --frozen-lockfile`，`release.mjs` 会在 `pnpm build`
  第一步被 verify-deps-before-run 打断（老坑复现条件）。
- 全量截图轮里 `chat-stream-burst` 偶发一次性能判据红（单次 282ms 心跳尖峰），
  定向重跑 3/3 与复跑全量均绿——按环境抖动处理，不是回归。
