---
date: 2026-10-03
title: set_setting 的判定顺序、只读前缀清单与密文路径的 5 处同步
tags: [安全, 设置, 配置, 工具]
source: 模型自动记录
---

# 设置写入闸门与凭据路径

## 现象

- `set_setting`（AI 改配置）判定顺序：命中 `WRITABLE_PATH_OVERRIDES` 显式放行（**先于黑名单**）→ 命中 `SETTINGS_READONLY_PREFIXES` 拒绝 → Schema 登记过的叶子路径默认可写。
- 覆盖表是「黑名单内的显式放行 + 可写面清单」，**不是白名单**：只「不登记进覆盖表」挡不住新分组。
- 新增密文路径漏改一处就出事：漏 `writeSecretField` = 凭据静默丢失；漏 `redactSettings` = 密文泄漏进渲染层。
- `SENSITIVE_KEY_PATTERN` 原先整体锚定，`apiKeyEnc` 这类派生字段名不命中。

## 原因

- 只读前缀的存在理由都是防自我提权 / 防自我 DoS：AI 给自己加免确认命令模式、放大轮次 / token 预算、关掉写前快照，都是摘掉自己的闸门。
- 凭据读写分散在 4 处（`canonicalSecretPath` / `readSecretField` / `writeSecretField` / `toPersisted`）外加主进程 `redactSettings`，共 5 处。

## 影响

- 判定顺序写反会让显式放行的路径全部失效，或让新敏感分组静默可写。
- 密文路径漏改的表现都不可见：凭据丢失只在重启后表现为「配置没了」，泄漏只在渲染层看得到。

## 结论与做法

- 新增安全敏感分组**必须显式进黑名单**，别指望覆盖表；要放行新的可写路径先改 `WRITABLE_PATH_OVERRIDES`，再同步 `set_setting` 工具 description 与 systemPrompt 的 settingsHint。
- 只读前缀（AI 一律拒绝，用户可在设置页经 `settings:update` 改）：`agent.permissionMode`、`agent.tools.terminal.allowPatterns`、`agent.snapshots`、`agent.loop`、`advanced.readonlyPrefixes`、`tts.providers`、`center`、`automations`、`agent.browser`、`plugins` 等。
- 新增 shared 密文路径，**5 处必须同时改**：`canonicalSecretPath` / `readSecretField` / `writeSecretField` / `toPersisted` / 主进程 `redactSettings`；派生字段名（`apiKeyEnc` 这类）另补 `SENSITIVE_KEY_PATTERN`（已含 `.*api[-_]?key.*`）；`mcp.servers.<id>.headersEnc` 与 `envEnc` 同款。
- `center.token`（⇄ `center.tokenEnc`）走同 5 处；Center **远程配置**走 `apps/desktop/src/main/center/remote-control.ts` 的独立白名单 `CENTER_REMOTE_CONFIG_PREFIXES` —— 两条通道语义不同，别混改。
- 远程补丁应用前可在 `structuredClone` 副本上演练，但**别再说「draft 是活对象」**：`store.get()` 返回 `deepClone`、`update()` 也对入参 `deepClone`，`mutate` 拿到的 draft 已是拷贝，「失败半写污染内存态」不成立。
- 配置字段「能写」不等于「生效」：新增项要么接消费方，要么明确标注未生效。
