---
date: 2026-11-10
title: Center 0.5.3 换装：补 ui.dialogs 清单校验（插件上传枚举报错的根因）
tags: [Center, 部署, 插件, 对话框, 权限, 清单, 坑, 口径]
source: 模型自动记录
---

# Center 0.5.3：补 `ui.dialogs` 清单校验

## 现象

- 插件开发完成后上传 Center 市场失败：
  `permissions.8: Invalid enum value. Expected ... 'ui.widgets' | 'themes' | 'events', received 'ui.dialogs'`。
- 同一份清单在桌面端 0.6.4 可以正常安装 / 开发加载；桌面 0.6.4 的 `resources/app.asar` 里
  `ui.dialogs` 已存在。
- Center 服务端仍是 **0.5.2** 镜像（`aurora-center:0.5.2`），市场列表 / 登录 / 更新源都正常。

## 原因

Center 服务器在**构建镜像时**把 `@aurora/shared` 的清单 schema 一起打进去；`ui.dialogs`
是桌面 0.6.4 才新增的权限与清单贡献，0.5.2 的 Center 镜像里 `PLUGIN_PERMISSIONS` 仍是旧的
16 项。市场发布接口在服务端调用 `parsePluginManifest`，因此先于桌面端拒绝。Center 版本线独立，
桌面双投不会自动更新服务器。

## 影响

- 桌面端更新到 0.6.4 后，**只上传安装包并不够**：任何带 `ui.dialogs` 的插件在旧 Center
  上都无法上传市场；错误看起来像插件清单写错，实际是服务端旧。
- Center 0.5.2 的 `dist-web` 也还是旧构建；本次增量换装保留它（该版本 UI 没有变化），
  但之后一次完整 Center 换装应重新带上新的 `dist-web`。

## 结论与做法

- **Center 0.5.3 已换装**（`aurora-center:0.5.3`，healthy）：
  - 只升 `packages/center/package.json` 与 `deploy/docker-compose.yml` 的 image tag（0.5.3）；
    **不创建 git tag、不上传 GitHub Releases**（Center 版本线独立）。
  - 服务器数据 `./data` 与 `.env`（`AURORA_CENTER_SECRET`）保留；换装前备份
    `/opt/aurora-center/backup-center-0.5.2-20261110-214907/`（package.json / bin / dist /
    dist-web / Dockerfile / docker-compose.yml / .env）。
- 本次为**增量换装**：完整部署包 37 MB，服务器上行约 3 MB/分钟，scp 3 分钟只传了 9.8 MB；
  停止并删除半截文件后，改传 206 KB 增量包（`package.json` / `Dockerfile` / compose +
  Center `dist` + shared `dist/plugin`、`dist/ipc`），服务器 `docker compose up -d --build`。
  这与 README 的正式流程同构，只是不重传未变化的 `dist-web` / 其余 `node_modules`。
  **正式全量 Center 换装仍按 `packages/center/deploy/README.md` §1/§2 打完整包。**
- 换装后核验：容器 healthy、镜像 `aurora-center:0.5.3`、容器内
  `node_modules/@aurora/shared/dist/plugin/permissions.js` 含 `ui.dialogs`、
  `docker compose exec -T aurora-center node --input-type=module -e "import('@aurora/shared')..."` 返回
  `uiDialogs:true`、管理员登录 `200`、`/api/updates/current` 仍返回桌面 **0.6.4**。
- 插件侧兼容口径：`ui.dialogs` 需要 **Aurora 桌面 0.6.4+** 与 **Center 0.5.3+**；
  旧 Center 的报错是枚举拒绝，不是插件清单问题。`minAuroraVersion` 不能替代服务端升级
  （旧 server 先解析 permissions 再比版本）。
