---
date: 2026-10-06
title: Center 官方模型网关与自托管更新的长期接线口径
tags: [Center, 模型, 更新, 安全, 坑]
source: 模型自动记录
---

# Center 官方模型与自托管更新

## 现象

Center 现在同时承担三类容易混淆的职责：客户端连接与远程控制、官方模型网关、安装包更新源。
它们都要求登录 / Bearer 鉴权、都可能回落，但安全边界和数据留存不同。

## 原因

- 官方模型必须由 Center 持有上游 API Key 并转发，客户端只拿清洗后的模型目录；若把 Key
  下发给客户端，Center 无法可信记账，也会扩大凭据暴露面。
- 更新下载若依赖客户端令牌，令牌过期 / 未登录会阻断升级；现有 GitHub releases 本来就是
  公开只读，因此 Center 更新路由采用公开下载 + 管理员上传。
- 两种回落语义不能互换：模型失败是“提示后改走本机模型”，更新失败是“检查失败后改走 GitHub”。

## 影响

把更新下载也强制登录，会让无法登录的设备永远无法自我修复；把模型 Key 下发客户端，
会让“管理员配置”变成仅在 UI 上成立。反过来，把模型失败静默回落，则可能把请求发给用户未选择的服务。

## 结论与做法

- `AURORA_CENTER_SECRET` 是官方模型上游 Key 的唯一主密钥；缺失 / 错误时 Center 仍启动，
  仅把对应官方能力标为不可用。密钥不得回传网页或客户端。
- 客户端官方模型使用保留 Provider id `center-llm` / `center-imagegen` / `center-tts` /
  `center-stt`；这些条目由目录同步维护，API Key 固定取 `center.token`，本地 Provider 页隐藏。
- 官方模型请求只记录真实 `usage` 元数据，按日 NDJSON 保留 180 天、终身累计摘要不放；
  不持久化提示词、回复、音频或图片。
- 官方模型不可用时，语言模型按会话、其余能力按全局能力去重提示一次，随后回落本机 `active`
  Provider；没有本机 Provider 时明确报错，绝不静默发往其他服务。
- 客户端更新优先 `<center.serverUrl>/api/updates`；只有 Center 未配置、请求失败或 `latest.yml`
  缺失时才回退包内 GitHub 源。Center 返回“已是最新”时不再尝试 GitHub。
- Center Release 上传必须由管理员会话完成，先上传 staging，再校验 `latest.yml` 的 version /
  size / sha512 与 blockmap，全部通过才原子切换 latest；公开下载路由支持 Range。

## 2026-10-07 发布与部署记录

- 桌面端与 Center 已发布 **v0.4.4**；源码 `main` 与 annotated tag `v0.4.4` 已推送到
  `LinePixel2025/Aurora`，安装包 / blockmap / `latest.yml` / Center 部署包已上传
  `LinePixel2025/Aurora-releases`。
- 阿里云 Center 已更新到 `aurora-center:0.4.4`，数据目录仍为 `/opt/aurora-center/data`；
  升级前完整备份在 `/opt/aurora-center/backup-v044-20261007-080427/`。
- `AURORA_CENTER_SECRET` 已生成并只保存在服务器 `/opt/aurora-center/.env`（权限 600）；
  同一份密钥备份在该次升级备份目录的 `.env`。Memory 不记录密钥值，后续升级不得覆盖或丢失该文件。
- Center 自托管更新路由已发布 0.4.4：`http://120.24.223.65:8787/api/updates/latest.yml`，
  并发验证了安装包 Range 返回 `206`。

## 2026-10-07 v0.4.5 Center 发布记录

- 在阿里云 Center 新建独立管理员 `codex-release`；密码只保存在当前 Windows 用户环境变量
  `AURORA_CENTER_PASSWORD`，Memory 不记录密码值。原有 `admin` / `Line` 账号未改动。
- `Aurora-Setup-0.4.5.exe`、`Aurora-Setup-0.4.5.exe.blockmap`、`latest.yml` 已上传 Center
  并发布；线上 `/api/updates/latest.yml` 返回 `0.4.5`，安装包 Range 返回 `206`。
- 本机 GitHub 凭据当前无效，且 `api.github.com` / `ssh.github.com:443` 连接超时，因此
  GitHub Releases 尚未同步。按双投硬规则，本次发布仍视为未完成；网络与凭据恢复后必须用
  同一批产物补传 GitHub Releases，再宣布发布完成。

## 发布双投硬规则

- 每次上传桌面安装包时，必须使用**同一次打包产物**同时更新 GitHub Releases 与 Aurora Center；
  `installer`、blockmap 与 `latest.yml` 三者在两端版本、size、sha512 必须一致。
- 只上传 GitHub 会让客户端无法从 Center 看到新版本；只更新 Center 则会破坏 GitHub 回落链。
  任一上传失败时本次发布按失败处理，不得对外宣布完成。
- 推荐命令：

  ```powershell
  $env:AURORA_CENTER_PASSWORD='...'
  pnpm release -- --publish --publish-center --center-url http://120.24.223.65:8787 --center-user admin --push --notes-file docs/release-notes/vX.Y.Z.md
  ```

- 发布后必须验证 `<Center>/api/updates/latest.yml` 返回 200、资产 Range 返回 206，
  并确认 Center 数据目录 `releases/index.json` 已切到该版本。
