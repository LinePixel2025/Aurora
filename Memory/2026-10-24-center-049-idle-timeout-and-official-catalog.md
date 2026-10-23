---
date: 2026-10-24
title: Center 官方模型两个线上 BUG：网关 120s 总时长截断流、启动期目录未就绪误报回落；Center 0.4.9 换装记录
tags: [center, 网关, 超时, 官方模型, 回落提示, 部署, 记录]
source: 模型自动记录
---

# Center 官方模型：长回复截断与回落误报（2026-10-24）

## 现象

1. 使用 Aurora Center 官方模型时，回复到一半出现"网络异常"、对话直接终止；回复越长越容易触发。
2. 每次用官方服务都会提示"官方服务故障，回落到 center_llm"，但 `center_llm` 本身就是官方镜像 Provider。

## 根因

- **总时长超时**：`packages/center/src/model-gateway.ts` 原先用单个
  `AbortSignal.timeout(120_000)` 覆盖**整个上游响应**（含流式正文），超 2 分钟即 abort，
  客户端表现为流中断。已发头之后 `res.destroy()` 在客户端就是"网络异常"。
- **目录只存内存**：官方模型目录（`/api/client/model-services/catalog`）原来每次启动重新拉取，
  启动期的自动化 / 首条消息常抢在拉取完成前；`aware-settings` 把"尚未加载"判成"不可用"并弹回落提示。
- **提示印错落点**：回落提示直接打印 `llm.active`，可能又是一个 `center-*` id。

## 结论与做法

- 网关超时改为**分段 + 空闲计时**：首字节 120s，之后每收到一块重置 120s（`touch()`），
  不再限制总时长；LLM / 图片 / TTS / 二进制四条响应通路都 `touch`，`finally` 里 `dispose()`。
  ⇒ 客户端这一侧的修复要**重新部署 Center** 才生效，不是重启客户端。
- 客户端目录加**磁盘缓存** `userData/center-model-services.json`（按 serverUrl 隔离），启动即拉一次；
  `loaded()` / `catalogLoaded` 让"未就绪"走**静默回落本机模型、不提示**；
  5xx / 网络失败保留旧快照，只有 401/403 清空。回落提示只写真实落点（本机 Provider id）。
- **改 Center 版本号后 `pnpm deploy` 前记得清掉产物里的 `verify` / `deploy` / `tsconfig.web.json`**：
  Dockerfile 只 COPY `bin dist dist-web node_modules package.json`，不清会把 tar 从 37MB 涨到 64MB。

## Center 0.4.9 换装（本次实测）

- 服务器 `/opt/aurora-center`：`aurora-center:0.4.8` → **0.4.9**，健康检查 healthy，
  CLI `version`=0.4.9；`./data` 与 `.env` 未动（备份 `backup-center-0.4.8-20261024-001136`）。
- 部署包 `aurora-center-0.4.9-idle-timeout-20261024-001136.tar.gz`（37MB，
  sha256 `ebfab6c4…74d1803`），上传后先 `sha256sum` 比对再解包。
- 验证：`docker compose ps` healthy、`docker compose exec -T aurora-center node bin/aurora-center.js version`；
  `/api/updates/current` 仍为 0.5.0（更新源资产与 Center 代码版本线互不影响）。
- 客户端在换装后自动重连成功（日志有"客户端已连接"），无需手动干预。
