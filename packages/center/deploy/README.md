# Aurora Center 服务器部署（Docker）

`packages/center` 是纯 Node 程序（唯一运行时依赖 `ws`，另带 `@aurora/shared` 的两个常量），
本目录提供**离线容器化部署**方案：构建机打出自包含产物 → 上传服务器 → docker compose 启动，
服务器全程不需要访问 npm（适合国内云主机）。

> ⚠️ **镜像里的前端就是 `dist-web`**（`Dockerfile` 只 `COPY dist-web`，容器内不跑构建）。
> 少跑一次 `pnpm --filter @aurora/center build` 就会把一个**旧前端**打进镜像 —— 典型症状是
> 「客户端明明配了语音，网页上却没有麦克风 / 朗读按钮」（语音 UI 自 v0.3.2 才有）。
> 怀疑线上是旧包时，用 `pnpm --filter @aurora/center verify:web:status --server <url> --user <名>
> --password <密码>` 打印客户端的 `ClientStatus`（含 `voice`）：能力位是 `true` 而网页没有按钮，
> 就是网页包旧了。
>
> `docker-compose.yml` 的 `image:` tag 跟 **Center 自己的版本号**（`packages/center/package.json`，
> 当前 `0.4.8`，**不必与桌面端版本号相同**）走：更新 Center 先升那个版本号、同步换 tag，
> 别在同一 tag 上反复覆盖，否则排障时说不清线上跑的是哪一版。

## 0. Center 自身的更新口径（版本线独立）

- Center 版本号只认 `packages/center/package.json`，**不必与 Aurora 客户端相同**；
  更新时只升这个包的版本（不动 root / apps/desktop）。
- Center 更新**不创建 git tag、不上传 GitHub Releases** —— 「发布 tag / 发布双投 /
  release notes」那一套（docs/09 §7/§10、`scripts/release.mjs`）只约束**桌面安装包**，
  与本目录的部署流程无关。
- 完整更新流程就是：改代码 → `pnpm --filter @aurora/center build` → 按 §1 打包 →
  scp 上服务器 → `docker compose up -d --build`（数据在 `./data`，不受影响）。

## 1. 构建机：打部署包

```bash
# 仓库根目录执行；产物 dist / dist-web 必须新鲜
pnpm --filter @aurora/shared build
pnpm --filter @aurora/center build

OUT="$TEMP/aurora-center-deploy"
rm -rf "$OUT"
pnpm --filter @aurora/center deploy --prod --legacy "$OUT"
rm -rf "$OUT/src" "$OUT/web" "$OUT/tsconfig.json" "$OUT/vite.config.ts"
cp packages/center/deploy/Dockerfile packages/center/deploy/docker-compose.yml "$OUT/"

tar -czf "$TEMP/aurora-center.tar.gz" -C "$OUT" .
```

> `pnpm deploy --legacy` 会把 workspace 依赖 `@aurora/shared`（连同其 dist）与
> 生产依赖一起落到 `OUT/node_modules`；zod 目前不在 center 运行路径上，可不带。
> 版本更新：改完代码重新打包，服务器上 `docker compose up -d --build` 即可（数据在 `./data`，不受影响）。

## 2. 服务器：上传并启动

```bash
scp "$TEMP/aurora-center.tar.gz" root@<服务器IP>:/opt/aurora-center/

# 服务器上
cd /opt/aurora-center
mkdir -p data && chown 1000:1000 data   # 容器以 node(uid 1000) 运行
tar -xzf aurora-center.tar.gz
docker compose up -d --build
```

要启用官方模型，部署前设置一个稳定且不可丢失的主密钥，并在容器中透传：

```bash
export AURORA_CENTER_SECRET='至少 32 字节的随机值'
docker compose up -d
```

主密钥只用于加密上游 API Key；更换后旧密文不能自动解密，需在管理页重新填写。

## 3. 初始化与配对

```bash
# 首个管理员（强密码；也可不带 --admin-* 让 start 自动生成并打印一次性密码）
docker compose exec -T aurora-center node bin/aurora-center.js init \
  --data /data --admin-user admin --admin-password '<强密码>'
```

Web 控制台：`http://<服务器IP>:8787`（SPA hash 路由，`#/login` 登录 / 注册）。

客户端接入（v0.2.2 起，**不需要任何令牌**）：用户在网页端注册 / 登录，桌面端
设置 → Aurora Center → 点「登录账户」走设备授权（或填账号密码直登）。

## 4. 安全注意

- 服务是**纯 HTTP**：登录密码与客户端令牌明文过公网。生产建议二选一：
  - 1panel 的 OpenResty 反代 + 域名 + Let's Encrypt 证书（桌面端 serverUrl 填
    `wss://<域名>`，Web 填 `https://<域名>`）；
  - 已有的 cloudflared 隧道是 **token 托管模式**（本地无 config.yml），需在 Cloudflare
    Zero Trust 控制台给隧道加 Public Hostname 指向 `http://localhost:8787`。
- 阿里云**安全组**需放行 TCP 8787（ufw 未启用，安全组是唯一关口）。
- Center 可见全部远程会话明文（无端到端加密，docs/12 §11），勿在共享账户间使用。

## 5. 常用运维

```bash
docker compose logs -f          # 启动日志（含一次性管理员口令，如走了自动 init）
docker compose restart          # 重启
docker compose down             # 停止（数据保留在 ./data）
docker compose exec -T aurora-center node bin/aurora-center.js status --data /data
```

`aurora-center update` 的 npm 自更新通道对本仓库**无效**（`@aurora/center` 是 private
包，不走 npm 发布）——更新一律按 §1 重新打包上传。

## 6. 桌面安装包发布双投

每次发布桌面客户端时，安装包、blockmap 与 `latest.yml` 必须同时上传：

1. GitHub Releases：`LinePixel2025/Aurora-releases`；
2. Aurora Center 更新源：管理网页 Release 卡、`aurora-center releases publish` 或
   `scripts/release.mjs --publish-center`。

两端必须来自**同一次打包产物**，不得分别重新打包。发布后检查：

```bash
curl -fsS http://<Center>/api/updates/latest.yml
curl -fsS -r 0-15 -o /dev/null -w '%{http_code}\n' \
  http://<Center>/api/updates/Aurora-Setup-<版本>.exe
```

第二个命令应返回 `206`。只上传 GitHub、Center 尚未更新时，客户端无法通过 Center 触发更新，
本次发布不视为完成。
