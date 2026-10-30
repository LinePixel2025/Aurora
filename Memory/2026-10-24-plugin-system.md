---
date: 2026-10-24
title: 插件系统 v36：清单优先、独立进程、面板沙箱与 Center 市场
tags: [插件, 权限, IPC, 坑]
source: 模型自动记录
---

## 现象

- 插件贡献若允许运行期动态注册，工具 / 面板 / 自动化就绕过了安装时的清单校验与用户确认。
- 插件页面跑在独立 `plugin-<id>` partition，默认 session 的 `protocol.handle` 不覆盖它：`loadURL` 直接 `ERR_FAILED`、页面白屏。
- `will-attach-webview` 拿到的 `src` 可能是空串，用它判 guest 归属会得到「插件页面请求必须来自已登记的页面」。
- 市场发布同版本被覆盖、或版本比较按字符串，会让用户装到旧包。

## 原因

- 插件能力面必须在安装前可见（工具 / Skill / 命令 / 自动化 / 面板 / 主题 / 配置全部写在 `manifest.json`）；运行期注册等于把授权边界推迟到看不见的时刻。
- 自定义协议按 session 生效；插件页面用独立非持久 partition，必须对 `guest.session` 逐 session 注册。
- guest 刚 attach 时 `getURL()` 仍是空串，页面地址只能由 `will-attach-webview` 的 `src` 暂存。

## 影响

- 清单外的能力 = 静默扩大攻击面；协议漏注册 = 整个插件页面不可用且报错难懂。
- 归属判错 = 可能把用户自己的标签当成插件页面接管。

## 结论与做法

- **清单优先**：所有贡献在 `manifest.json` 声明，运行期不得动态注册；安装器、Center 市场、`scripts/verify-plugin.mjs` 共用 `packages/shared/src/plugin/manifest.ts` 的 zod schema。
- **受控运行时（不是沙箱）**：一个启用插件一个 `utilityProcess`，同时运行上限 `PLUGIN_MAX_RUNNING = 8`；白名单 RPC 单帧 1 MiB、在途 32、带超时 / cancel 与权限门控。**插件进程仍有当前用户权限，安装即信任**，不要宣称隔离。
- **工具**：最终名 `plugin.<id>.<name>`（≤ 64）；默认 `confirm`，用户「信任此插件」后清单里的 `safe` 才生效；只读档只注册 `readonly: true` 的工具；不参与 `agent.tools.enabled`。
- **Skill 顺序**：builtin → plugin → user；用户覆盖插件，插件不能遮蔽内置，插件间先到先得。
- **页面沙箱**：插件页面只能走 `aurora-plugin://` + `src/preload/plugin-page.ts`；协议处理器**逐 session 注册**；`will-attach-webview` 只拦截该协议并强制 `sandbox` / `contextIsolation` / `nodeIntegration:false`，拒绝调用方自带 preload / partition；页面不得暴露 `window.aurora`。guest 地址要存 `pendingPluginPageSrc`（按 partition FIFO 排队），不能用 `getURL()` 判归属。
- **自动化**：`plugin-event` / `plugin-action` 边沿触发；`AutomationEngine.pluginEventsInFlight` 防自激（动作里再 emit 同名事件会无限递归），不要移除。
- **配置与安装态**：`plugins.enabled / devDirs / activeTheme`（AI 只读、无密文字段）；安装态在 `<userData>/plugins/registry.json`。
- **Center 市场**：与桌面共用清单 schema；同版本不可覆盖，`latestVersion` 用 `compareVersions` 取最高。
- 当前基线：`pnpm test` 204 文件 / 2928 用例、冒烟 263/263、`pnpm verify` 26/26（`version=38`）。
