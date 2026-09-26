# Aurora Center 服务器部署（Docker）

`packages/center` 是纯 Node 程序（唯一运行时依赖 `ws`，另带 `@aurora/shared` 的两个常量），
本目录提供**离线容器化部署**方案：构建机打出自包含产物 → 上传服务器 → docker compose 启动，
服务器全程不需要访问 npm（适合国内云主机）。

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

## 3. 初始化与配对

```bash
# 首个管理员（强口令；也可不带 --admin-* 让 start 自动生成并打印一次性口令）
docker compose exec -T aurora-center node bin/aurora-center.js init \
  --data /data --admin-user admin --admin-password '<强口令>'

# 创建客户端配对令牌（明文只显示一次，粘贴到 Aurora 桌面端 设置 → Aurora Center）
docker compose exec -T aurora-center node bin/aurora-center.js token create \
  --data /data --user admin --label <客户端备注>
```

Web 控制台：`http://<服务器IP>:8787`（SPA hash 路由，`#/login` 登录）。

## 4. 安全注意

- 服务是**纯 HTTP**：配对令牌 / 登录口令明文过公网。生产建议二选一：
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
