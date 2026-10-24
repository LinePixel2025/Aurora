---
date: 2026-10-24
title: 插件系统 v36：清单优先 / 独立进程 / 面板与沙箱页面 / Center 市场
tags: [插件, 架构, Electron, webview, RPC, 自动化, Center, 坑, 口径]
source: 模型自动记录
---

# 插件系统 v36（2026-10-24）

## 结论（长期口径）

- **清单优先**：工具 / Skill / 命令 / 自动化 / 面板 / 主题 / 配置全部在 `manifest.json` 声明，
  运行期不得动态注册。安装器、Center 市场、`scripts/verify-plugin.mjs` 共用
  `packages/shared/src/plugin/manifest.ts` 的 zod schema。
- **受控运行时（不是沙箱）**：一个启用插件一个 `utilityProcess`（上限 8），白名单 RPC
  （单帧 1 MiB、在途 32、超时 / cancel）与权限门控；**插件进程仍有当前用户权限，安装即信任**。
- **工具**：最终名 `plugin.<id>.<name>` ≤ 64；默认 `confirm`，用户信任后才允许清单里的 `safe`；
  只读档只注册 `readonly:true`；不参与 `agent.tools.enabled`。
- **Skill 顺序**：builtin → plugin → user；用户覆盖插件，插件不能遮蔽内置，插件间先到先得。
- **自动化**：`plugin-event` / `plugin-action`；事件边沿触发，加入 `pluginEventsInFlight` 防自激
  （否则插件动作里再 emit 同名事件会无限递归）。
- **配置**：`plugins.enabled/devDirs/activeTheme`（v36，AI 只读，无密文字段）；安装态在
  `<userData>/plugins/registry.json`。

## 踩过的坑（每条都是实测）

1. **自定义协议的 partition**：`protocol.handle` 只作用默认 session；插件页面跑在独立
   `plugin-<id>` partition，必须在 `did-attach-webview` 里对 `guest.session` **逐 session 注册**，
   否则 `loadURL` 直接 `ERR_FAILED`、页面白屏。
2. **guest 刚 attach 时 `getURL()` 是空串**：`will-attach-webview` 拿到的 `src` 要存下来
   （`pendingPluginPageSrc`），`did-attach` 用它登记 guest 归属与显式 `loadURL`；
   用 `getURL()` 判归属会得到"插件页面请求必须来自已登记的页面"。
3. **webview 的 src 时序**：创建元素后先 `appendChild` 再赋 `src`（先设属性再入 DOM 时
   Electron 可能不触发 attach）；页面首个 RPC 可能早于 `dom-ready`，宿主取 guest id
   要现场 `getWebContentsId()` 兜底。
4. **smoke / capture 的异步口径**：插件事件触发的自动化是 fire-and-forget，`plugins:runCommand`
   回执早于历史落定 —— 断言要等 `status !== 'running'`，否则会读到 `running` 的假红。
5. **Center 市场与桌面共用 schema**：`fflate` 在 Center 与桌面各有一份依赖；
   市场发布同版本不可覆盖，`latestVersion` 用 `compareVersions` 取最高。
6. **Windows 测试抖动**：Center `model-gateway.e2e` 偶发清理临时目录 `ENOTEMPTY`（不是回归），
   重跑即过。

## 验证基线（2026-10-24）

- `pnpm test` 192 文件 / 2782 用例；`pnpm verify` 26/26（`version=36`、迁移 36/36）；
- 冒烟 **235/235**；Center `verify:web` 新增 `marketplace` / `plugins-admin`（暗浅两档）；
- 截图新增 `chat-plugin-panel` / `chat-plugin-page` / `settings-plugins-installed` /
  `settings-plugins-marketplace`；`node scripts/verify-plugin.mjs` 对示例与模板通过。
