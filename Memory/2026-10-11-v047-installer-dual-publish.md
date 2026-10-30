---
date: 2026-10-11
title: 桌面双投 + Center 换装 runbook（历代卡点）
tags: [发布, 打包, 更新源, Center, 部署]
source: 模型自动记录
---

# 桌面双投 + Center 换装 runbook（2026-10-11 起，历代卡点汇总）

## 一、发布完成判据（三源一致）

- 产物：`apps/desktop/release/` 下 `Aurora-Setup-<ver>.exe` / `.exe.blockmap` / `latest.yml` 三个资产，来自**同一次打包**。
- 双投：GitHub Releases（`LinePixel2025/Aurora-releases`）与 Center 更新源**同时**上传同一批资产；只传 GitHub 不算完成。
- 校验：本地 / Center / GitHub 的 `latest.yml` sha256 相同；Center 安装包 `Range: bytes=0-15` → **206**；tag 正文与 `docs/release-notes/v<ver>.md` 逐字一致。
- 命令：`node scripts/release.mjs --publish --notes-file docs/release-notes/vX.Y.Z.md`，再 `--skip-package --publish-center --center-url <Center> --center-user admin`（`--skip-package` 不重复打包、跳过已存在 tag，只补发 Center）。
- `scripts/release.mjs` 硬检查 `--notes-file` 且要求相对上一版本 tag 汇总；tag 用 `git tag -a --cleanup=verbatim` 生成。

## 二、长期卡点（每轮至少踩一条）

1. **UAC 会卡死 `pnpm verify:update`**：出厂 `general.requireAdmin=true`（`packages/shared/src/config/defaults.ts`），非提权终端启动打包应用会等 UAC 120s，日志停在「系统代理已应用」且无 `[elevation]` 行；`scripts/verify-update-e2e.mjs` 用临时 userData 且**未播种** `requireAdmin=false`。处置：先往该 userData 的 `config.json` 播种 `createDefaultSettings()` 且 `requireAdmin=false`，或在已提权终端跑；别去「修」提权逻辑。
2. **`git tag -a -F` 会剥掉首行 `#`**：`release.mjs:175` 已硬编码 `--cleanup=verbatim`；手工重打 tag 也必须加，比对用 `git tag -l vX.Y.Z --format='%(contents)'`（`git show` 会混 commit subject）。
3. **`release.mjs:139` 拒绝脏工作区**：未跟踪文件也算（连需求书 `Design/*.md` 都会挡）；先提交或显式 `--force`。
4. **打包前停 dev**：`electron-vite dev` 占 `out/` 与 `node_modules/.pnpm/electron`，`taskkill /T` 不够要 `/F`，并确认没有自动重启的 dev。
5. **改版本号会触发 `pnpm install --production`**：无 TTY 报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`；先 `pnpm install --frozen-lockfile`（≈1s，up-to-date）再发布，**不要**用 `CI=true` 强装。
6. **429 前不能重试**：Center 登录限速 5 次/60s（`packages/center/src/server.ts` 的 `AUTH_RATE_LIMITS.login`），窗口内正确密码也 429。凭据最多试 1 次，然后问用户（`AURORA_CENTER_PASSWORD`，账号固定 `admin`）。
7. **`--push` 走 HTTPS**：`git push origin` 用的是 HTTPS remote，github.com 被掐时必失败（先按 github 条分域探测）；推源码用 `git push git@github.com:LinePixel2025/Aurora.git main --follow-tags`，再 `git update-ref refs/remotes/origin/main <sha>`。
8. **Qoder 等索引守护进程锁 `win-unpacked/resources/app.asar`**：electron-builder 覆盖报 EBUSY；改 `--config.directories.output=release/alt-<ver>` 打包到子目录，把三资产复制回 `release/`，再 `release.mjs … --unpacked release/alt-<ver>/win-unpacked` 校验真实解包目录。

## 三、Center 换装（版本线独立）

- 只升 `packages/center/package.json` + `deploy/docker-compose.yml` 的 image tag（跟 Center 版本走，别同 tag 反复覆盖）；不建 tag、不上 GitHub、不走 `release.mjs`。
- 步骤以 `packages/center/deploy/README.md` §1/§2 为准（`shared`/`center` build，**`dist-web` 必须新鲜**），换装 `docker compose up -d --build`。
- `.env` 不在部署包里（解压不覆盖）：换装前备份 `package.json bin dist dist-web Dockerfile docker-compose.yml` + **`.env`**；`AURORA_CENTER_SECRET` 保持原值（换后 `docker compose config` 会打印明文，别贴日志）。
- SSH 必须 `-i ~/.ssh/lineweb_aliyun`（`ssh -i ~/.ssh/lineweb_aliyun root@<IP>`）；默认密钥是 `Permission denied (publickey)`。
- 顺序：先换装 Center（协议增量兼容旧客户端）→ 再发桌面安装包并双投。

## 四、几件易忘的事实

- **Center 入口统一直连 IP**（`http://<Center-IP>:8787`）：Cloudflare 隧道域名入口国内不稳，按不存在处理；旧域名只留在历史 release notes 里。
- 市场列表路由是 **`GET /api/plugins`**（详情 `/api/plugins/:id`、下载 `/api/plugins/:id/download`）；没有 `/api/plugins/marketplace`。
- 市场同版本不可覆盖：重发先 `plugins unpublish`，上传前 `node scripts/verify-plugin.mjs <目录>`。
- 历史 release 缺资产（如 v0.4.8 曾 0 资产）可从 Center 的 `data/releases/files/<ver>/` 取回原 `latest.yml` / 安装包，再 `gh release upload --clobber`；别手写 YAML。
- `format:check` 的「57 个历史文件」已是过去时：`.gitattributes`（`* text=auto eol=lf`）终结了 CRLF 假红，真未格式化的另算。

> 2026-10-25 合并自 2026-10-18-v049-release-and-center-048-deploy.md、2026-10-18-v050-release-and-center-credentials.md、2026-10-24-v052-release.md、2026-10-24-v054-release-and-marketplace.md（原口径：逐版提交 sha / 字节数 / sha256 / 测试-冒烟-截图数与 v0.4.8–v0.5.4 换装流水已作废）
