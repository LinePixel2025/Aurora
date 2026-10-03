---
date: 2026-10-03
title: set_setting 的判定顺序、只读前缀清单与密文路径的 5 处同步
tags: [安全, 设置, 凭据, 坑]
source: 模型自动记录
---

# 设置写入闸门与凭据路径

## 现象

1. `set_setting`（AI 改配置）的判定顺序是：命中 `WRITABLE_PATH_OVERRIDES` 显式放行（**先于黑名单**）→
   命中 `SETTINGS_READONLY_PREFIXES` 拒绝 → **Schema 登记过的叶子路径默认可写**。
2. 覆盖表是「黑名单内的显式放行 + 可写面清单」，**不是白名单** —— 只"不登记进覆盖表"挡不住新分组。
3. 新增一个密文路径时，漏改一处就会出大问题：漏 `writeSecretField` = **凭据静默丢失**；
   漏 `redactSettings` = **密文泄漏进渲染层**。
4. `SENSITIVE_KEY_PATTERN` 原本是**整体锚定**的，`apiKeyEnc` 这类**派生字段名**不命中。

## 原因

- 只读前缀的存在理由都是"防自我提权 / 防自我 DoS"：AI 给自己加一条免确认命令模式（例如 `git*`）
  = 摘掉自己的确认闸门；
  给 AI 放大轮次 / token 预算 = 绕过"该停下来问用户"的闸门；关掉写前快照 = 拆掉回滚保险。
- 凭据读写的实现分散在 4 处（`SettingsStore` 的 `canonicalSecretPath` / `readSecretField` /
  `writeSecretField` / `toPersisted`）外加主进程 `redactSettings`，共 **5 处**。

## 影响

- 判定顺序写反（把黑名单放在覆盖表之前）会让显式放行的路径全部失效，或让新敏感分组静默可写。
- 密文路径漏改的表现都不可见：凭据丢失只在重启后表现为"配置没了"，密文泄漏只在渲染层能看到。

## 结论与做法

- **新增安全敏感分组必须显式进黑名单**，别指望覆盖表；要新增「Agent 可写的设置路径」先改
  `WRITABLE_PATH_OVERRIDES`，再同步 `set_setting` 的工具 description 与 systemPrompt 的 settingsHint。
- 只读前缀（AI 的 `set_setting` 一律拒绝，用户可在设置页 `settings:update` 调）：
  `agent.permissionMode`、`agent.tools.terminal.allowPatterns`（免确认命令模式，语义是「减少打扰」而非安全加固，
  命中即跳过确认卡片但仍写 `info` 级审计日志，见 docs/06 §11.7）、`agent.snapshots.*`、`agent.loop.*`、
  `advanced.readonlyPrefixes`（v15，黑名单配置自身）、`tts.providers`、`center.*`（连接目标是外发通道）、
  `automations.*`（AI 只能经 `automation_*` 六件套工具增删，写类四个是 `confirm`）。
- 新增任何 shared 的密文路径，下列 **5 处必须同时改**：`canonicalSecretPath` / `readSecretField` /
  `writeSecretField` / `toPersisted` / 主进程 `redactSettings`。
  派生字段名（`apiKeyEnc` 这类）要另补 `SENSITIVE_KEY_PATTERN` 分支（已补 `.*api[-_]?key.*`）。
  v9 起新增的 `mcp.servers.<id>.headersEnc` 与 `envEnc` 同款、位置并列。
- `center.token`（⇄ `center.tokenEnc`）与 apiKey 同款走这 5 处；
  但 Center 的**远程配置**走 `apps/desktop/src/main/center/remote-control.ts` 的独立白名单
  （`CENTER_REMOTE_CONFIG_PREFIXES`）—— **两条通道语义不同，别混改**。
- 远程补丁应用前先演练（在 `structuredClone` 副本上试一遍再落库）——但**别再把"draft 是活对象"当事实**：
  2026-10-03 核实 `packages/shared/src/config/store.ts`，`get()` 返回 `deepClone(this.current)`、
  `update()` 也对入参做 `deepClone`，所以 `mutate` 拿到的 draft **已经是拷贝**，"失败半写污染内存态"这条理由**不成立**
  （旧 AGENTS.md 与一处代码注释都基于旧认知；同一处滞后在 `step/archive/` 的历史报告里也被点过）。
  演练仍是无害的防御性做法，但引用理由时要按当前实现说。
- **配置字段"能写"不等于"生效"**：新增配置项时要么接上消费方，要么在 AGENTS.md 里明确标注为未生效
  （本仓库已修过一批死字段）。
