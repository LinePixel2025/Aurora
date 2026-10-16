---
date: 2026-10-11
title: v0.4.7 安装包双投（GitHub + Center）：发布说明要先补桌面改动，UAC 会卡死远端 verify:update
tags: [发布, 打包, 更新源, Center, GitHub, 验收, 坑]
source: 模型自动记录
---

# v0.4.7 桌面安装包首次真正发布（2026-10-11）

用户说「打包安装包 v0.4.6，上传 GitHub，上传 Center」，但仓库实际已在 **0.4.7**：确认后按
**v0.4.7** 发布。本轮把「安装包长期停在 0.4.5」这条悬空状态收口：**v0.4.5 → v0.4.7** 之间的
全部桌面改动（v32 个性化三件套 / 提示条 Acrylic / v33 四周流光）随本安装包一起发出。

## 发布结果（三源一致，已实测）

| 项 | 值 |
| --- | --- |
| tag | `v0.4.7`，annotated，message **逐字**等于 `docs/release-notes/v0.4.7.md`（首行 `# Aurora v0.4.7` 保留） |
| GitHub | `LinePixel2025/Aurora-releases` releases/tag/v0.4.7（Latest），3 资产 uploaded |
| Center | `http://120.24.223.65:8787/api/updates`：`current.version = 0.4.7`、`files` 3 项、已 publish |
| 安装包 | `Aurora-Setup-0.4.7.exe` 203,134,538 B，sha512 `YHSbZXyh…nBmcA==`；三源 `latest.yml` **逐字相同** |
| 源码 | `origin/main` 已推（`9bc7402..f6e37fa`，含 28 个积压提交） |

验收数字（本轮实测）：`pnpm typecheck` / `lint` 全绿、`pnpm test` **171 文件 / 2554 用例**、
`verify-update` **14/14**、打包应用对本地假更新源 **5/5**（发现了 99.0.0）。

## 坑一：发布说明会**先骗你一次**——它写着"本版桌面不变、安装包不发布"

`docs/release-notes/v0.4.7.md` 是 2026-10-08 按「Center-only 发布」写的，开头明写
**「桌面端本版无功能变更（安装包不重新发布，自动更新源保持 0.4.5/0.4.6 现状）」**。
而这次要做的恰恰是发安装包 —— 直接拿它去 `--notes-file` 会得到一个**自相矛盾的 tag**：
正文说没发安装包，tag 却挂在安装包产物上。

同类风险：`release.mjs` 的硬检查只看「正文是否包含上一版本 tag 字符串」，**不检查语义**，
所以这种矛盾能一路通过校验并进 GitHub Release。

**做法**：打包前先通读 notes 文件，凡是「本版不动 X」的声明都要与本次实际动作对齐；
本轮把它重写成「相对 v0.4.6 的完整更新 ＋ 因安装包自 v0.4.5 起未发、一并收进全部桌面改动」，
并补上 v32/v33 的两节与实测验收数字（74 行 → 68 行，信息更全但更紧凑）。

## 坑二：`pnpm verify:update` 在本机可能**必然失败**——UAC 把启动卡在提权那一步

现象：helper 报 `2/5`，三条失败分别是「更新源被环境变量覆盖（自测开关生效）」「发现新版本 99.0.0」
「向本地更新源请求过 latest.yml」，且**服务端一个请求都没收到**；打包应用日志只写到
`系统代理已应用` 就停住（873 B）。

根因不是更新链路坏了，而是**启动顺序**：`ensureElevation()` 排在代理之后、建窗之前，
`general.requireAdmin` 默认 **true** + `probeElevated()` 正确判出「非管理员」→ 走
`defaultRelaunch` 用 PowerShell `Start-Process -Verb RunAs` 拉提权实例，而它**要等 UAC 弹窗被点**
（超时 120 s）。非交互 shell 里没人点「是」，于是应用就合法地卡在那里，永远走不到
`updater.scheduleAutoCheck()`。

**判定与做法**：
- 用 `--user-data-dir=<临时目录>` 手动起一次打包应用，看日志能走到哪一步 —— 停在
  `系统代理已应用` 且**没有** `[elevation]` 任何一行，就是这条。
- 让 helper 跑通：**先往它的 `userData/config.json` 播种** `createDefaultSettings()` 且
  `general.requireAdmin=false`，再跑 `node scripts/verify-update-e2e.mjs` → **5/5**
  （`PASS 发现了伪装的新版本 99.0.0`、`/updates/latest.yml` 真被请求）。
- **不要因此"修"提权逻辑**：`VAC` 等待是设计（`elevation.ts` 注释写明「等待 powershell 退出
  是用户有没有点否的唯一信号」）；这是**环境**限制（无交互桌面），不是 bug。
  用户双击安装包装出来的实例有自己的 userData，不影响真实升级路径。

**顺带确认打包产物本身健康**（同一次诊断日志）：`Aurora 启动 {version:0.4.7, electron:44.5.1,
isDev:false}` → `配置就绪` → `Aurora 就绪` → 工具清单与 `set_appearance` 在列、
`[elevation] 配置未要求管理员身份，跳过提权流程` → `[updater] 使用更新源`。
即**安装包可正常启动、迁移到 v33、更新链路会真的出网**。

## 坑三（旧坑复现口径）：GitHub 连通性依旧间歇

`Invoke-WebRequest` 拉 `releases/latest/download/latest.yml` 会偶发
`远程主机强迫关闭了一个现有的连接` / 超时；`gh release download --pattern latest.yml` 一次成功。
**核对 GitHub 资产内容优先用 `gh`，别用裸 HTTP 重试赌运气**。
另外 `gh release view --json` 的字段名是 `isDraft`/`isPrerelease`，**没有 `isLatest`**
（列表里的 "Latest" 列来自 `gh release list`）。
> **2026-10-16 补充**：同一现象后来被定位为**不是间歇** —— `github.com` 这个域 / IP 被整域掐断时
> HTTPS 重试永远不通，而 `api.github.com` 仍可达（所以 `gh` 正常）。此时改走 SSH 443 的一次性 URL：
> `git push git@github.com:LinePixel2025/Aurora.git main --follow-tags`，见
> [2026-10-16-github-https-blocked-ssh443-push.md](2026-10-16-github-https-blocked-ssh443-push.md)。
> 本轮的 5 个提交与 v0.4.5 / v0.4.6 / v0.4.8 三个 tag 就是因此积压到 10-16 才推上去。

## 下一版的提醒

- 发安装包 = 三件事同时成立：**产物**（exe/blockmap/latest.yml）＋ **tag（annotated，verbatim）**
  ＋ **双投**（GitHub Releases 与 Center 更新源）。任一缺失都按「未完成」算。
- 每轮务必用 `git tag -l vX.Y.Z --format='%(contents)'` 抽出 tag 正文与 notes 文件逐行比对
  （PowerShell 的 `git show --format=%B` 会把 commit subject 混进来，看着像不一致的假警报）。
