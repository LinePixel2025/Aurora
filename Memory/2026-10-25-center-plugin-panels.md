---
date: 2026-10-25
title: Center 插件侧栏面板镜像：owner 口径、/p/ 托管与订阅 refcount 的坑
tags: [Center, 插件, 面板, iframe, CSP, 订阅, 协议, 安全, 探针, 坑, 口径]
source: 模型自动记录
---

# Center 插件侧栏面板镜像（2026-10-25）

## 现象

桌面插件只能在桌面端用（右栏声明式面板 / 页面型页面 / 小组件）。需求是让用户在 Center
登录后，**在工作台侧栏看到自己设备上已安装插件的侧栏面板**，内容经在线桌面客户端实时中继，
并允许远程操作。小组件（桌面 / 提示条）不上 Center。

## 结论与做法（长期口径）

- **只有 `contributes.panels`** 进 Center；`contributes.widgets`（桌面 / 提示条）永不出现。
  不新增清单字段、不新增权限、不升 `CONFIG_VERSION`。
- 总闸复用 `center.allowRemoteSession`：闸门关闭时客户端**不上报目录**（网页无任何插件入口），
  已打开面板的调用回 `E_REMOTE_DISABLED`。
- **只认设备属主**：`plugin.panelData` / `plugin.subscribe` / `plugin.event` 都要求
  `record.ownerUserId === 会话用户`，**管理员不跨用户**（插件内容属个人数据；与确认卡 /
  提问卡的「属主 + 管理员」口径刻意不同）。
- 目录（`ClientStatus.plugins`）由 `main/center/plugin-panels.ts` 的 `buildPluginCatalog()`
  生成：仅 enabled、仅 panels、按 id 排序、上限 64；重推时机 = 连接 / `settings:changed` /
  `plugins:changed`。
- 客户端调用链固定走 `main/plugins/panel-data.ts` 的 `readPluginPanelData()` —— 与桌面
  `plugins:panelData` 同一条（schema 面板 = 静态 schema + `invokePanel` 失败回落静态；
  page 面板 = 直接返回 invoke 结果）；connector 不另写一套。
- 网页侧：侧栏「插件」分区按 `pluginId/panelId` 去重、只取「在线 + 属主是自己」的设备、
  多设备页内切换、上限 24；声明式面板用与桌面同构的渲染器，页面型面板用
  `<iframe sandbox="allow-scripts">` + postMessage 桥。
- 页面型资源只从**已发布到本 Center 的市场 zip** 出（`/p/<id>/<version>/<path>`），
  本机文件不出机；该版本未发布时明确提示，不白屏。

## 坑（踩过的）

1. **`/p/` 路由必须排在 SPA 静态托管之前**：否则 hash 路由的 fallback 会把 `/p/...` 当文档
   路径回 index.html，页面型面板拿到一坨 HTML、白屏且无报错。位置在 `server.ts` 的
   web-session 门禁之前、静态托管之前。
2. **`ClientStatus` 是整对象覆盖**：`hub.registerClient` 用新快照整体替换旧状态。重连时
   hello 派生的占位快照没有 `voice` / `plugins`，必须显式沿用旧值（与 `voice` 同款），
   否则重连瞬间网页侧栏入口集体消失 / 麦克风按钮消失。
3. **订阅要两层记账**：服务器按「网页连接 × 面板」refcount（首个订阅才下发客户端，归零 /
   网页断开才退订）；客户端维护本地 `Set` 并在**断线时清空**（服务器重连后按现存订阅补发
   `plugin.subscribe`）。网页 WS 重连后打开中的视图必须重新订阅。少任何一层都会出现
   「事件只在部分页签 / 重连后不再推送」。
4. **opaque-origin 的 CSP 里 `'self'` 不可靠**：`sandbox="allow-scripts"` 的 iframe 没有
   same-origin，`script-src 'self'` 会拦掉自己的脚本。CSP 用**请求 Host** 显式放行
   （`pluginPageCsp(sanitizeRequestHost(host))`），并保持 `connect-src 'none'`、
   `frame-ancestors <host>`、`sandbox allow-scripts`；**绝不加** `allow-same-origin` /
   `allow-popups`。HTML 用 `no-cache`（桥注入随 Center 版本变），其余版本化资源才 immutable。
5. **Center Web 的运行时常量必须从 `@aurora/shared/browser` 取**：`PluginPageFrame.vue`
   一开始从 `@aurora/shared` 根导入 postMessage 源常量，构建把 `node:fs` 拉进浏览器包
   （AGENTS 硬规则 #4 的老坑）。协议常量放在 `shared/src/center/protocol.ts`，且
   `browser.ts` 已 re-export 整个 `./center/protocol.js`。
6. **页面型回执多一层 `data`**：链接器返回 `{ data: <invokePanel 结果> }`，iframe 桥收到
   `result` 后再取 `.data`；verify 里页面读 `count` 时按真实嵌套断言，别把两层拍平。
7. **verify 桩机状态会跨场景泄漏**：`plugin-panel` 场景点按钮把 `pluginCount` 从 3 加到 4，
   随后的 `plugin-page` 读到 4 导致断言失败。`StubClient.resetStatus()`（每个场景 `fresh()`
   调用）必须把夹具计数复位；口径变了同改夹具，别让新场景被旧状态收税。
8. **Puppeteer 可以检查 opaque-origin iframe**（`page.frames()` 按 URL 找 frame 后读 DOM），
   所以页面型面板能做真实的「iframe 内读数 + 点按钮 → 桥请求」断言，不必只截一张图。

## 验证

- 单测：hub（转发 / 拒绝 / 离线 / 超时 / 订阅 refcount / owner）、connector（命令与事件）、
  `panel-data`（两种面板）、`plugins.readAsset`（穿越 / MIME / 未知版本 / LRU）、
  `plugin-page`（CSP / shim / host 净化）、`buildPluginNav`（owner / 在线 / 去重 / 上限）。
- Center：`pnpm --filter @aurora/center build` + `verify:web`，新增 `plugin-panel` /
  `plugin-page` 两个场景，基线 **102 → 106**（54 个场景定义：52 个 × 暗/浅 + 2 个固定档）。
- 本机 Edge 在此环境启动 puppeteer 失败时，用
  `AURORA_CWEB_BROWSER='C:\Program Files\Google\Chrome\Application\chrome.exe'` 跑
  （环境问题，不是代码回归）。
