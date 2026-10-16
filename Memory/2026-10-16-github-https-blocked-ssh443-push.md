---
date: 2026-10-16
title: github.com 的 HTTPS 被整域掐断（重试无用），推 GitHub 走 SSH 443 的一次性 URL
tags: [发布, git, GitHub, 网络, 坑, 口径]
source: 模型自动记录
---

# github.com HTTPS 连不上不是抖动：分域判断 + SSH 443 一次性 URL 推送

## 现象

2026-10-16 推 v0.4.8 那一轮（4 个提交 + tag 积压在本地）时：

- `git push origin main --follow-tags` 连续两次失败，且**不是超时抖动**：
  `fatal: unable to access 'https://github.com/LinePixel2025/Aurora.git/': Failed to connect to github.com port 443 after 21091 ms: Could not connect to server`
- 同一时刻 `gh api repos/LinePixel2025/Aurora` **返回 200 正常**。
- 逐域探测（`curl -s -m 15 -o /dev/null -w 'http=%{http_code} ip=%{remote_ip}' https://<host>`）：

  | 域名 | 结果 | 解析 IP |
  | --- | --- | --- |
  | `github.com` | **http=000（连不上）** | 20.205.243.**166** |
  | `api.github.com` | http=200 | 20.205.243.**168** |
  | `codeload.github.com` | http=301 | 20.205.243.**165** |
  | `objects.githubusercontent.com` | http=404（能建连） | 185.199.108.133 |

- `ssh -p 443 -T git@ssh.github.com` → `Hi LinePixel2025! You've successfully authenticated`，**认证通过**。
- 本机 `~/.ssh/config` 里本来就有映射：`Host github.com → HostName ssh.github.com, Port 443, User git`。

## 原因

掐的是 **github.com 这一个域名 / 这一个 IP** 的 443 出网（SNI 级别），不是本机代理、不是凭据、
也不是"整个 GitHub 都不可达"。`api.github.com` / `codeload.github.com` 落在相邻但不同的 IP 上，
仍然可达 —— 所以「`gh` 能用」「能下载 release 资产」与「`git push`（HTTPS）不能用」会**同时成立**，
这正是容易被误判成"网络不稳、再等等"的地方。

而 SSH 走的是 `ssh.github.com:443`（另一个主机名），加上 `~/.ssh/config` 已把 `github.com` 映射过去，
这条路由头到尾都是通的。仓库 `origin` 仍配的是 HTTPS URL，所以 `git push origin` 每次都撞墙。

## 影响

- **旧口径会把人带偏**：[2026-10-08 Center 用量分页](./2026-10-08-center-usage-paging-official-models-form.md)
  与 [2026-10-11 v0.4.7 双投](./2026-10-11-v047-installer-dual-publish.md) 里写的是
  「GitHub 连通性是间歇的，重试即推送成功」。按那条口径会得出"多试几次 HTTPS 就行 / 等网络恢复"，
  实际**等多久都不行**，正确反应是立刻换协议。
- 已经造成真实后果：v0.4.5 / v0.4.6 / v0.4.8 三个 tag 与 5 个提交在本地积压了 5 天才推出去
  （v0.4.7 当时已在远端），期间远端 main 落后、GitHub Releases 与本地不一致。
- 用显式 URL 推送**不会**更新 `refs/remotes/origin/main`，`git status` 会一直显示
  「领先 origin/main N 个提交」的**假象**，下次容易重复推送或误判没推成功。

## 结论与做法

1. **先分域判断，别按一次探测下结论，也别无脑重试 HTTPS**：
   ```bash
   curl -s -m 15 -o /dev/null -w '%{http_code}\n' https://github.com
   curl -s -m 15 -o /dev/null -w '%{http_code}\n' https://api.github.com
   ```
   `github.com` 拿到 `000` 而 `api.github.com` 有状态码 → 判定为整域被掐，**直接走 SSH**。
2. **一次性用 SSH URL 推，不改仓库配置**（`--follow-tags` 只带可达的 annotated tag）：
   ```bash
   git push git@github.com:LinePixel2025/Aurora.git main --follow-tags
   ```
3. **推完手动对齐跟踪引用**，否则状态误判：
   ```bash
   git update-ref refs/remotes/origin/main <刚推上去的 sha>
   ```
4. **不要因 HTTPS 不通就推迟打 tag / 发布**：SSH 通就等于远端可写，发布链路上没有额外前提。
5. 可选的根治做法（**本次未做，待用户确认**）：把 `origin` 换成 SSH URL，
   `git remote set-url origin git@github.com:LinePixel2025/Aurora.git`，之后 fetch / push 与
   跟踪引用都自然走通。

---

_修订说明（2026-10-16）：本条更正「GitHub 连通性间歇、重试即推送成功」的旧口径 ——
那个结论只在 `api.github.com` 等相邻域仍可达、且恰好赶上 `github.com` 未被掐的窗口时成立；
`github.com` 被整域掐断时重试无效，须改用上面的 SSH 443 路径。_
