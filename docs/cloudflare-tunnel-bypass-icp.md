# 大陆服务器 + Cloudflare DNS：用域名访问而不被 ICP 拦截（可复用方法论）

> **适用场景**：服务器在**中国大陆**（阿里云 / 腾讯云 / 华为云等），域名托管在 **Cloudflare**，但域名**尚未完成 ICP 备案**，导致「直接访问 IP 正常、用域名访问就被拦」。
>
> **性质**：本文是**技术绕过**方案，属于 ICP 备案的**合规灰区**（详见第 6 节）。目标是让其他项目能照着复现，不是鼓励长期规避备案。
>
> **依据**：2026-09 在**阿里云 ECS（Ubuntu 24.04）+ 1Panel + Docker Compose** 环境实测，症状、拦截特征、隧道方案都已验证（含 WebSocket）。文中标注「未实测」的部分仅为原理与外链证据。

---

## 1. 先确诊：是 ICP 拦截，不是你的服务挂了

### 1.1 典型症状

| 现象 | 说明 |
|---|---|
| `http://IP:端口` 正常，`https?://域名` 报错 | 服务本身没问题 |
| 返回 **403**，页面标题 `Non-compliance ICP Filing` | 拦截页 |
| 响应头出现 **`Server: Beaver`** | 拦截页特征（阿里云） |
| HTML 里跳转 `http://www.aliyun.com/beian/beian-block?id=...` | 备案拦截页 |
| 浏览器提示「网站未备案」「非经营性互联网信息服务备案」 | 同上 |

### 1.2 一条命令确诊（把 IP / 端口 / 域名换成你的）

```bash
curl -s -i -H "Host: example.com" http://1.2.3.4:3001/ | head -20
```

看到下面这些就是被拦，**与你的应用无关**：

```
HTTP/1.1 403 Forbidden
Server: Beaver
...
<title>Non-compliance ICP Filing</title>
```

### 1.3 关键结论（实测，别走弯路）

| 试验 | 结果 | 含义 |
|---|---|---|
| 带未备案域名 `Host` 头直连 **非 80 端口**（如 3001） | **403** | **拦截只看 HTTP `Host` 头，与端口无关** → 换端口无用 |
| 直接访问 IP | 200 | 拦截不针对 IP |
| Cloudflare 橙云（代理开启）A 记录回源 | **403** | 回源请求的 `Host` 仍是那个未备案域名 → 照样被拦 |
| 通过 Cloudflare 代理访问 `域名:3001` | 连接超时 | Cloudflare 免费版**只代理白名单端口**，非标端口根本进不来 |
| 加一层 Nginx 反代（`proxy_set_header Host $host`） | **403** | 只要 Host 被透传到大陆服务器，就还是被拦 |

**一句话原理**：让**到达大陆服务器的请求不要带这个未备案域名作为 `Host`**，就不会被拦。所有可行方案都是围绕这一点。

---

## 2. 方案对比（先选路线再动手）

| 方案 | 原理 | 成本 | 需备案 | 适用 |
|---|---|---|---|---|
| **A. Cloudflare Tunnel**（推荐） | `cloudflared` 从服务器**主动外连** Cloudflare，公网流量经隧道进本机服务 | ~10 分钟，免费 | 否（灰区） | 想保留域名 + HTTPS，且能装东西 |
| **B. 改写回源 Host** | 在拦截点**之外**把 `Host` 改成源站 IP（CF Transform Rule，或上游 Nginx 不转发 `$host`） | ~5 分钟 | 否（灰区） | 源站能监听 CF 白名单端口，且应用不依赖 Host |
| **C. 迁到非大陆节点** | 香港 / 新加坡 / 日本等无需备案 | 迁移成本 | 否 | 追求长期合规、能接受延迟 |
| **D. ICP 备案** | 走正规备案流程 | 1–3 周 | 是 | 面向公众的正规业务 |
| **E. 只用 IP** | 直接 `http://IP:port` | 0 | 否 | 内部工具、临时验证 |

> 方案 A 与 B 都是「绕过技术拦截」，**不改变备案义务**。

---

## 3. 方案 A：Cloudflare Tunnel（详细步骤）

### 3.1 前置检查

```bash
# 域名 NS 是否在 Cloudflare（输出应为 *.ns.cloudflare.com）
dig +short NS example.com

# 服务器出站到 Cloudflare 隧道端点是否通（TCP 与 QUIC 都走 7844）
timeout 8 bash -c 'cat < /dev/null > /dev/tcp/region1.v2.argotunnel.com/7844' \
  && echo "出站 7844 可达" || echo "出站 7844 不通（需放行出方向）"

# 应用监听在本机回环或 0.0.0.0（隧道侧填 http://127.0.0.1:<port>）
ss -ltnp | grep ':<你的端口>'
```

### 3.2 安装 cloudflared（并校验完整性）

```bash
# 方式一：官方 deb（注意校验；被墙时可在本地下载再上传）
curl -fLO https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
dpkg -i cloudflared-linux-amd64.deb

# 方式二：独立二进制（推荐，避免 deb 依赖问题）
curl -fLO https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
head -c 4 cloudflared-linux-amd64 | xxd        # 应为 7f45 4c46（ELF）；大小约 38MB
install -m 0755 cloudflared-linux-amd64 /usr/local/bin/cloudflared
cloudflared --version
```

> **坑**：下载中断会留下**半截文件**，`dpkg -i` 会报 `internal gzip read error` / `unexpected end of file`。判断依据是文件大小与 ELF 魔数 —— 别只看「文件存在」就装（我踩过：脚本里 `Test-Path` 判断跳过了重新下载，装的是残包）。

### 3.3 建隧道 + 配入口

#### 方式一：Cloudflare 面板手动（不写脚本）

1. **Zero Trust → Networks → Tunnels → Create a tunnel → 选 Cloudflared**
2. 命名（如 `myapp-ecs`），复制生成的 **Token**
3. 在隧道的 **Public Hostname** 加一条：
   - Hostname: `example.com`
   - Service: `http://127.0.0.1:3001`
4. 面板会**自动创建** CNAME 记录（指向 `<隧道ID>.cfargotunnel.com`，代理开启）
5. 到服务器执行第 3.4 步装服务

#### 方式二：API 全自动（可脚本化，推荐给多项目复用）

**Token 权限**（Cloudflare → My Profile → API Tokens → Create Custom Token）：

| 范围 | 权限 |
|---|---|
| Account | Cloudflare Tunnel → **Edit** |
| Zone | DNS → **Edit** |
| Zone | Zone → **Read** |

```bash
API=https://api.cloudflare.com/client/v4
CF_TOKEN='<你的 API Token>'
ZONE_NAME=example.com
HOST=example.com
ORIGIN=http://127.0.0.1:3001
H=(-H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json')

# 1) 校验 token
curl -s "$API/user/tokens/verify" "${H[@]}"

# 2) 取 zone_id 与 account_id
ZONE=$(curl -s "$API/zones?name=$ZONE_NAME" "${H[@]}" | jq -r '.result[0].id')
ACCT=$(curl -s "$API/zones?name=$ZONE_NAME" "${H[@]}" | jq -r '.result[0].account.id')

# 3) 建隧道（config_src=cloudflare → 配置托管在 Cloudflare 侧）
RESP=$(curl -s -X POST "$API/accounts/$ACCT/cfd_tunnel" "${H[@]}" \
  -d '{"name":"myapp-ecs","config_src":"cloudflare"}')
TUNNEL=$(echo "$RESP" | jq -r '.result.id')
echo "$RESP" | jq -r '.result.token' > /tmp/tunnel.token     # 只在此处落盘，用完删除

# 4) 配置入口规则（末尾必须要 catch-all，否则隧道起不来）
curl -s -X PUT "$API/accounts/$ACCT/cfd_tunnel/$TUNNEL/configurations" "${H[@]}" \
  -d "{\"config\":{\"ingress\":[
        {\"hostname\":\"$HOST\",\"service\":\"$ORIGIN\"},
        {\"service\":\"http_status:404\"}
      ]}}"

# 5) DNS：同名的 A/CNAME 记录必须先删再建（类型不能共存）
for ID in $(curl -s "$API/zones/$ZONE/dns_records?name=$HOST" "${H[@]}" | jq -r '.result[].id'); do
  curl -s -X DELETE "$API/zones/$ZONE/dns_records/$ID" "${H[@]}" >/dev/null
done
curl -s -X POST "$API/zones/$ZONE/dns_records" "${H[@]}" \
  -d "{\"type\":\"CNAME\",\"name\":\"$HOST\",\"content\":\"$TUNNEL.cfargotunnel.com\",\"proxied\":true}"
```

### 3.4 在服务器上装成开机自启服务

```bash
# Token 经 stdin 传入，避免写进 shell 历史 / 命令参数
echo '<TUNNEL_TOKEN>' | ssh root@<服务器> 'cloudflared service install $(cat)'

# 校验（install 通常已 enable + start）
systemctl is-enabled cloudflared && systemctl is-active cloudflared
journalctl -u cloudflared -n 30 --no-pager | grep -E "Registered tunnel connection|ERR"
```

> 也可以用本地配置文件方式（`/etc/cloudflared/config.yml` + `tunnel run`），但 **Token 方式最省事**，配置改在 Cloudflare 侧即可。

### 3.5 验收（四件事都要过）

```bash
# ① HTTP 200
curl -s https://example.com/api/health

# ② 首页
curl -sI https://example.com/ | head -1                   # HTTP/2 200

# ③ WebSocket（若应用有；隧道原生支持，无需额外配置）
curl -si -N --max-time 8 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://example.com/ws | head -1                        # HTTP/1.1 101

# ④ 证书（Cloudflare Universal SSL，自动续期）
openssl s_client -connect example.com:443 -servername example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates
```

---

## 4. 方案 B：改写回源 Host（不想装 cloudflared 时）

思路：拦截只认 `Host`，那就**在拦截点之外**把 `Host` 改掉。两种变体：

**变体 1 — Cloudflare Transform Rule（未经本仓库实测）**
- Rules → Transform Rules → **Modify Request Header** → Set `Host` = 源站 IP
- 源站必须监听 Cloudflare **白名单端口**（见第 5.2 节），否则连接根本到不了
- 缺点：应用若依赖 Host（绝对 URL、Cookie 域、CSRF/Origin 校验、CORS、WebSocket Origin）可能异常

**变体 2 — 自建反代且不透传 Host**
- 在另一台机器（非拦截范围）上反代：`proxy_pass http://<源站IP>:<端口>;`
- **关键**：不要写 `proxy_set_header Host $host;`，让 Host 回落到 upstream 地址
- 外部案例：[Nginx 路径转发返回网站未备案的问题及解决方案](https://blog.csdn.net/weixin_43898376/article/details/145724873)（该案例即通过删掉 `proxy_set_header Host $host` 解决）

> 本仓库最终选了方案 A（无需额外机器、不依赖 Host、自动 HTTPS），方案 B 仅作为备选记录。

---

## 5. 通用坑位清单（跨项目通用）

### 5.1 概念类

1. **拦截只看 Host 头，与端口无关** → 不要在「换端口」上浪费时间。
2. **橙云不是解法**：橙云回源时 Host 仍是原域名，照样 403。
3. **隧道不占入站端口** → 用隧道后可以考虑**关闭源站公网端口**，反而更安全。

### 5.2 Cloudflare 免费版可代理的端口（超范围会超时）

| 协议 | 端口 |
|---|---|
| HTTP | 80, 8080, 8880, 2052, 2082, 2086, 2095 |
| HTTPS | 443, 8443, 2053, 2083, 2087, 2096 |

参考：[Cloudflare 网络端口说明](https://developers.cloudflare.com/fundamentals/reference/network-ports/)。应用监听 3001/5173 之类端口时，**要么走隧道，要么改到白名单端口**。

### 5.3 操作类

4. **同名 DNS 记录会冲突**：把 A 记录换成 CNAME 时，必须**先删后建**。另外注意：目标域名可能**早就有一条指向旧隧道的 CNAME**（多项目/多机器共用域名时很常见），替换前先看一眼现有记录，否则会悄悄把另一个项目的入口切走。
5. **出站 7844 必须通**（TCP 或 QUIC/UDP）。企业网络只放行 443 时，隧道可能连不上。
6. **保留 IP 直连作为兜底**：隧道挂了还能用 `http://IP:port` 进去排查。
7. **有「主动外连的本地节点」时注意**：如果架构里有 Agent/存储节点连 `ws://IP:port`（如网盘存储节点、监控 Agent），把源站端口关掉前，先把它改成 `wss://域名`；隧道对 WebSocket 支持良好（实测 101）。
8. **管理面板不要绑域名**：面板自身的「域名绑定」功能会把 IP 访问拒掉。实测 1Panel 绑了域名后，用 IP 打开一直显示 `Access Temporarily Unavailable`（看起来像面板挂了），恢复命令：
   ```bash
   # 1Panel
   1pctl reset domain && systemctl restart 1panel-core
   ```
   其他面板（宝塔/AMH 等）同理：**面板只走 IP + 端口 + 安全入口**，别和业务域名混在一起。
9. **取真实客户端 IP**：走 CDN/隧道后，应用要知道自己在代理后面。
   - Express：`app.set('trust proxy', 1)`
   - Cloudflare 会带 `CF-Connecting-IP`；Nginx 透传 `X-Forwarded-For` / `X-Real-IP`
   - 否则限流、日志、设备识别都会把所有人看成同一个 IP

### 5.4 安全与密钥卫生

10. **API Token / 隧道 Token 不进仓库**：写进脚本时用环境变量；示例里用占位符。
11. **用完轮换**：贴到聊天记录、工单、CI 日志里的 Token 都应视为已泄露，事后到 Cloudflare **Roll/删除**。
12. **静态 token 文件别留**：临时落盘的隧道 Token 用完 `shred -u` 或 `rm -f`。

---

## 6. 合规提示（务必读）

- 大陆服务器对公众提供 Web 服务，法规上**要求 ICP 备案**；本方案绕过的只是**技术拦截**，**不改变备案义务**。
- 云厂商可能后续核查（收到整改通知仍需备案或迁出大陆），也存在被限制接入的风险。
- 要**彻底合规**，只有两条路：
  1. **ICP 备案**：留意两点 —— ① 域名后缀是否在工信部批复范围内；② 域名注册商是否为境内批复注册商（境外注册商通常需先转入境内）。
  2. **迁到非大陆节点**（香港/新加坡等），无需备案。

---

## 7. 回滚 / 备案通过后切回直连

```bash
# 1) DNS：CNAME(cfargotunnel.com) → A 记录指向源站 IP
# 2) 源站用 Nginx/OpenResty 监听 80/443 + 证书，反代到应用端口
#    - WebSocket 路径保留 Upgrade / Connection 头与长超时
#    - 大文件下载路径放宽 proxy_read_timeout / client_max_body_size
# 3) 应用侧确认 trust proxy（见 5.3 第 9 条）
# 4) 收敛安全组：只留 80/443，关闭应用端口
# 5) 停用隧道（保留 cloudflared 以便复用）
systemctl disable --now cloudflared
```

---

## 8. 可复制清单

```
[ ] 确诊：curl -H "Host: 域名" http://IP:端口  → 403 + Server: Beaver
[ ] 确认域名 NS 在 Cloudflare
[ ] 确认服务器出站 7844 可达
[ ] 安装 cloudflared 并校验 ELF 完整性（约 38MB）
[ ] 建隧道（面板或 API）拿到 Token
[ ] 配置 ingress：hostname → http://127.0.0.1:端口，末尾加 http_status:404
[ ] DNS：先删同名 A/CNAME，再建 CNAME → <隧道ID>.cfargotunnel.com（代理开启）
[ ] 服务器 cloudflared service install（Token 走 stdin）
[ ] 校验 systemctl is-enabled/is-active cloudflared
[ ] 验收：HTTPS 200、WebSocket 101、证书有效
[ ] （可选）关闭源站公网端口
[ ] 轮换 API Token
[ ] 记录：域名 / 隧道名 / 隧道ID / 源站端口 / 回滚步骤
```

---

## 附 A：本次实测的工作实例（供对照）

| 项 | 值 |
|---|---|
| 云厂商 / 系统 | 阿里云 ECS，Ubuntu 24.04.2 LTS |
| 应用 | Docker Compose（Express 容器 `:3001` + PostgreSQL 16 容器） |
| 域名 / 入口 | `web.linetech.online` → CNAME → `<隧道ID>.cfargotunnel.com`（Cloudflare 代理开启） |
| 隧道 | `lineweb-ecs`，`cloudflared` 2026.9.3，systemd `cloudflared`（enabled + active） |
| 入口规则 | `web.linetech.online` → `http://127.0.0.1:3001` |
| 验收结果 | HTTPS `/api/health` 200 且数据库 connected；首页 200；登录接口 200；`wss://…/ws/storage` 握手 **101** |
| 证书 | Google Trust Services，`CN = linetech.online`，自动续期 |
| 兜底 | IP 直连 `http://120.24.223.65:3001` 仍可用 |
| 踩过的坑 | ① 面板绑域名导致 IP 无法登录面板；② 域名原有 CNAME 指向**另一条旧隧道**，替换后旧隧道失去入口；③ 半截 deb 导致安装失败 |

---

## 附 B：参考链接

- [Cloudflare 支持代理的网络端口](https://developers.cloudflare.com/fundamentals/reference/network-ports/)
- [Cloudflare Tunnel 文档](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
- [Cloudflare API：Tunnel](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/)
- 第三方案例（Nginx 不透传 Host 解决「未备案」403）：[CSDN](https://blog.csdn.net/weixin_43898376/article/details/145724873)
- 1Panel 命令行工具（面板域名绑定恢复）：[1pctl 文档](https://1panel.cn/docs/v2/installation/cli/)
