---
date: 2026-10-24
title: Center 官方模型网关与更新源口径
tags: [Center, 模型, 更新源, 安全, 坑]
source: 模型自动记录
---

# Center 官方模型网关与更新源口径（2026-10-24）

## 现象

1. 用 Center 官方模型时，回复到一半出现「网络异常」、对话终止；回复越长越容易触发。
2. 每次用官方服务都提示「官方服务故障，回落到 center_llm」——而 `center_llm` 本身就是官方镜像 Provider。
3. 客户端更新源与官方模型目录的行为容易互串，尤其在前端升级后。

## 原因

- **总时长超时**：`packages/center/src/model-gateway.ts` 原用单个 `AbortSignal.timeout(120_000)` 覆盖整个上游响应（含流式正文），超 2 分钟即 abort；已发头后 `res.destroy()` 在客户端就是「网络异常」。
- **目录只存内存**：官方模型目录（`/api/client/model-services/catalog`）每次启动重拉，启动期自动化 / 首条消息常抢在拉取完成前；`aware-settings` 把「尚未加载」判成「不可用」并弹回落提示。
- **提示印错落点**：回落提示直接打印 `llm.active`，可能又是一个 `center-*` id。
- Center 同时承担连接 / 模型网关 / 安装包更新源三类职责，鉴权与回落语义不同，混写会互相污染。

## 影响

长回复被截断看起来像网络故障；「官方服务故障」误报会引导用户去关一个本来正常的 Provider；更新下载若依赖客户端令牌，令牌过期 / 未登录会阻断升级。

## 结论与做法

- **网关超时分段 + 空闲计时**：首字节 120s，之后每收到一块重置 120s（`touch()`），不再限制总时长；LLM / 图片 / TTS / 二进制四条通路都 `touch`，`finally` 里 `dispose()`。这是 Center 侧修复，**必须重新部署 Center** 才生效，不是重启客户端。
- **目录磁盘缓存**：`userData/center-model-services.json`（按 serverUrl 隔离），启动即拉一次；`loaded()` / `catalogLoaded` 让「未就绪」走**静默回落本机模型、不提示**；5xx / 网络失败保留旧快照，只有 401/403 清空；回落提示只写真实落点（本机 Provider id）。
- **主密钥**：`AURORA_CENTER_SECRET` 是官方模型上游 Key 的唯一主密钥；缺失 / 错误时 Center 仍启动，只把对应官方能力标为不可用；密钥不回传网页或客户端。
- **保留 Provider id**：`center-llm` / `center-imagegen` / `center-tts` / `center-stt`，由目录同步维护、API Key 固定取 `center.token`、本地 Provider 页隐藏；`llm.active` 是全局默认唯一事实来源（只有它指向 `center-llm` 时才用官方模型）。
- **用量留存**：只记真实 `usage` 元数据，按日 NDJSON 保留 **180 天**、终身累计摘要；不持久化提示词 / 回复 / 音频 / 图片。
- **更新源**：由 `center.serverUrl` 推导为 `<http(s)-base>/api/updates`，优先 Center；只有未配置、请求失败或 `latest.yml` 缺失才回退 GitHub；Center 返回「已是最新」时不再试 GitHub。
- **更新上传**：必须管理员会话；先 staging 校验 `latest.yml` 的 version / size / sha512 与 blockmap，全部通过才原子切换 latest（`releases.ts` 归档到 `files/<version>/`）；公开下载路由支持 Range。
- **改 Center 版本号后 `pnpm deploy` 前记得清产物里的 `verify` / `deploy` / `tsconfig.web.json`**：Dockerfile 只 COPY `bin dist dist-web node_modules package.json`，不清会把 tar 从 37MB 涨到 64MB。

> 2026-10-25 合并自 2026-10-06-center-official-models-and-updates.md（原口径：v0.4.4/v0.4.5 逐版发布与部署记录、`--push` 推荐命令、`codex-release` 管理员账号已作废）
