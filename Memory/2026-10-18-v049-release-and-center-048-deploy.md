---
date: 2026-10-18
title: v0.4.9 三源发布（GitHub + Center）与 Center 0.4.8 阿里云换装记录
tags: [发布, 打包, 更新源, Center, GitHub, 部署, 记录]
source: 模型自动记录
---

# v0.4.9 桌面安装包 + Center 0.4.8 发布记录（2026-10-18）

## 发布结果（三源一致，已实测）

| 项 | 值 |
| --- | --- |
| tag | `v0.4.9`，annotated，message 与 `docs/release-notes/v0.4.9.md` 逐字一致（首行 `# Aurora v0.4.9`）；tag 对象 `eb74158` |
| 提交 | release 提交 `0e24a94`；`main` 已推（`ccfea2c..0e24a94`），推送走 SSH 443（`~/.ssh/config` 已把 github.com 映射到 ssh.github.com:443） |
| GitHub | `LinePixel2025/Aurora-releases` releases/tag/v0.4.9（Latest），3 资产：exe / blockmap / latest.yml |
| Center | `http://120.24.223.65:8787/api/updates/current`：`version=0.4.9`、`files` 3 项、`publishedAt=2026-10-18T04:46:48Z` |
| 安装包 | `Aurora-Setup-0.4.9.exe` **203,131,158 B**，sha512 `HV/bHMt/…ws+0Q==`；GitHub 与 Center 的 `latest.yml` 与本地产物**逐字相同** |
| 下载链路 | Center 资产 `Range: bytes=0-15` → **206**；GitHub 的 `latest.yml` 用 `gh release download` 取回后与本地一致 |
| Center 服务 | `/opt/aurora-center` 从 `aurora-center:0.4.7` 换装到 **0.4.8**（healthy；CLI `version`=0.4.8；`status` 用户 4 / 客户端 3；`./data` 与 `.env` 原样保留） |

验收（本次实测）：`typecheck` / `lint` / `build` 全绿；`pnpm test` 177 文件 / 2639 用例；
`verify-p1` 26/26（`version=34`、迁移 34/34）；冒烟 **206/206**；窗口截图三轮 **96 条**
（仅范围外 `chat-model-picker` 恒红）；Center `verify:web` **96/96**；`verify-update` 14/14。

## Center 换装步骤（本次实测）

1. `pnpm --filter @aurora/shared build && pnpm --filter @aurora/center build`
2. `pnpm --filter @aurora/center deploy --prod --legacy $env:TEMP\aurora-center-deploy` →
   删 `src` / `web` / `tsconfig.json` / `vite.config.ts` → 拷 `Dockerfile` 与
   `docker-compose.yml`（`image:` 已改 `aurora-center:0.4.8`）
3. `tar -czf` → `scp` 到 `/opt/aurora-center/`；先在服务器
   `cp -a bin dist dist-web package.json docker-compose.yml Dockerfile .env backup-center-0.4.7-<ts>/`
4. 服务器 `tar -xzf` → `docker compose up -d --build`（`.env` 的 `AURORA_CENTER_SECRET`
   由 compose 插值；数据在 `./data`，不受影响）
5. 验证：`docker compose exec -T aurora-center node bin/aurora-center.js version`（=0.4.8）、
   `curl /api/updates/current`、`docker compose ps`（healthy）、客户端重连日志

## 发现（历史遗留）

- **v0.4.8 的 GitHub Release 资产为 0**（`gh api repos/LinePixel2025/Aurora-releases/releases/tags/v0.4.8 --jq '.assets|length'` → `0`），
  当时 Center 侧正常；v0.4.9 已按双投发齐。若要让 GitHub 回退源的历史也一致，可把本地
  `apps/desktop/release/Aurora-Setup-0.4.8.*` 与该版本 `latest.yml` 补传到那个 release。
- 发版前要先处理 pnpm `verify-deps-before-run` 在“版本号变化”后触发的自动安装，
  否则 `release.mjs` 会在 `pnpm build` 第一步就中断 —— 处置见
  [2026-10-18-pnpm-ci-install-purge.md](2026-10-18-pnpm-ci-install-purge.md) 的追加节。

## 下次提醒

- 顺序：**先换装 Center**（协议增量、兼容旧客户端）→ 再打包桌面安装包并双投；
  上传后用 `curl /api/updates/current` 与 `gh release view --json assets` 双向核对。
- 凭据（Center 管理员密码）只经命令行环境变量使用，不写仓库 / 记忆 / 日志。
- tag message 与 notes 的比对用 `git tag -l vX.Y.Z --format='%(contents)'`（别用 `git show`，
  会把 commit subject 混进来造成假不一致）；GitHub Release body 与 notes 的差异只是 CRLF，
  归一化后应逐字相同。
