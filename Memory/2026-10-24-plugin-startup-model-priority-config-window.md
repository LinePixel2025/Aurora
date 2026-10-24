---
date: 2026-10-24
title: 插件独立界面启动空窗、Center 官方模型抢占默认模型、插件重启/配置窗口
tags: [插件, 启动, IPC, Center, 模型优先级, 重启, 窗口, 探针, 坑, 口径]
source: 模型自动记录
---

# 插件独立界面启动空窗 / 默认模型优先级 / 插件配置窗口（2026-10-24）

## 现象

1. 安装带**页面型桌面小组件**的插件（实测 `com.classmanagement.board` v2.1.2）后重启 Aurora，
   桌面小组件窗口出现「小组件暂无内容」、页面永远不加载；同一次启动里另一张 widget 正常，
   说明是竞态而不是清单 / 页面写错。
2. 用户已在「AI 模型」页把默认模型设为本机 provider（如 `deepseek`），但 Center 页的
   「官方模型 → 语言模型」开关一开，默认就被改回 `center-llm`；之后每次读取都是官方。
3. 设置 → 插件里的「重启」点了像没反应：插件进程确实重启，但已打开的面板 / 页面 / 桌面小组件
   继续显示旧内容；配置表单又挤在设置页详情里，字段多时很难用。

## 根因（实测证据）

- **BUG 1（启动空窗）**：`main/index.ts` 在 `registerIpc()` 之前调用
  `widgetManager.sync()` 创建小组件窗口；widget 渲染层挂载即调 `plugins:list` /
  `settings:get`，此时没有 handler，`ipcRenderer.invoke` 直接 reject。
  `widget/App.vue` 的 `loadInfo()` 未捕获 reject，`onMounted` 在订阅 `plugins:changed`
  **之前**就中断，于是永久停在「小组件暂无内容」。
  隔离启动（`--user-data-dir` + `--remote-debugging-port`）复现：stderr 有
  `No handler registered for 'plugins:list' / 'settings:get'`；CDP 里一张 widget 没有
  `aurora-plugin://` webview，另一张有。
- **放大器**：`syncPluginContributions()` 的 `plugins:changed` 只发给 chat / settings，
  没有发给 edge-bar、桌面小组件窗口与新窗口；`PluginPageFrame` / `PluginPanel` 也没订阅，
  所以插件重启后已打开界面不重载。
- **并发隐患**：chat 的 `pendingPluginPageSrc` 是单例字符串；同时挂载两个页面型面板时
  `will-attach-webview` / `did-attach-webview` 可能交叉，A 的 URL 被登记给 B guest。
- **BUG 2（默认模型被顶替）**：`center/aware-settings.ts` 每次 `get()` 都在官方 llm 开启时写
  `next.llm.active = 'center-llm'`；`agent-host.ts` 的 provider factory 又有一层
  「official.enabled 就优先官方」；`modelPickerCore` 同样把 Center 放在本机 active 之前。
  用户现场 `config.json`：`llm.active="deepseek"` + `officialModels.llm.enabled=true`。
- **BUG 3（重启无用 / 配置简陋）**：重启只重启 utilityProcess；没有广播到 widget 窗口、
  页面 / 面板不订阅 `plugins:changed`、设置页也没有成功反馈。配置表单内联在详情里，
  没有独立空间与保存状态。

## 结论与做法（长期口径）

1. **`llm.active` 是全局默认唯一事实来源**：
   - `createCenterAwareSettingsStore` 只对 `imagegen / tts / stt` 做读时覆写，**不碰
     `llm.active`**；
   - `createProviderFactory` 只有 `llm.active === 'center-llm'` 才构造官方 Provider，
     并用 `resolveOfficialModelEntry`（选中 → defaultModel → 首个）取模型与参数；
     本机 active 时官方开关不参与；
   - 会话覆盖优先级不变；官方开启仍可作为会话来源；
   - `modelPickerCore` 的全局解析顺序改为「active 指向官方才 Center，否则本机」。
2. **Center 页 LLM 开关的语义**：首次开启（false → true）或从 Center 页显式改模型时把
   `llm.active` 切到 `center-llm`；关闭时若默认仍是官方，回落到首个可用本机 provider
   （没有则置空）；用户在本机默认时开关启停不覆盖 active。
3. **小组件窗口必须在 `registerIpc()` 之后创建**：`WidgetManager` 新增 `ready` 门，
   装配层在 `registerIpc` 之后 `markReady()`；渲染层同时「先订阅、再加载」+ 有界重试，
   启动竞态即使再次出现也能自愈。
4. **`plugins:changed` 全量广播**：chat / settings / edge-bar / plugin-config 与全部桌面小组件
   窗口；页面型面板 / 小组件重载 webview，声明式面板重拉 schema。重启按钮的可见效果依赖它。
5. **插件配置窗口 `plugin-config`**：设置列表只保留总览 / 启停 / 「配置」入口；配置、
   桌面小组件显隐 / 层级、权限与扩展点、重启 / 回滚 / 卸载收进单例窗口（880×760，
   `plugins:openWindow` + `plugins:windowRequest`，`showWithPayload` 等页面加载后推送）。
6. **页面 src 暂存按 partition FIFO**：同插件多页面并发挂载不串队；不同插件 / 浏览器
   guest 不消费彼此的队列项。

## 复现 / 验收方法（启动期插件界面）

```powershell
# 1) 复制真实 userData 到临时目录（config.json / plugins/registry.json / plugin-data / 布局）
#    改 general.requireAdmin=false、center.enabled=false、advanced.logLevel=debug
# 2) 用构建产物启动（--user-data-dir 会覆盖 app.getPath('userData')）
electron.exe --user-data-dir=<temp> --remote-debugging-port=9333 apps/desktop/out/main/index.js
# 3) 打开 http://127.0.0.1:9333/json：
#    - 每个页面型 widget 都应有 aurora-plugin:// 的 webview target；
#    - 页面 body 有插件自己的文本；
#    - 主进程 stderr 无 "No handler registered"。
```

## 本轮验收基线（2026-10-24 实测）

- `pnpm test` 196 文件 / 2849 用例全绿；`pnpm typecheck` / `pnpm lint` / `pnpm build` 通过；
  `pnpm verify` 26/26（version=36，迁移 36/36）。
- 端到端冒烟 **244/244**（新增「打开插件配置窗口」1 条）。
- 定向截图 `AURORA_CAPTURE_ONLY='plugin'` 10/10 全绿（新增 `plugin-config.png`）；
  `settings-llm-default` 定向通过。
- 全量窗口截图（排除已知会卡住的 onboarding；窗口 = edge-bar / chat / settings / automation /
  widget / plugin-config）**99 条 checks，仅已知范围外的 `chat-model-picker` 1 条红**；
  全量口径由此从 107 → 108（新增 `plugin-config` 1 条），onboarding 6 + memory/glow 3 未在本轮重跑。
- 启动回归：隔离真实 userData 后两个页面型小组件都挂上 webview 且有内容，
  stderr 无 IPC handler 缺失。

## v0.5.5 双投发布结果（2026-10-24）

| 项 | 值 |
| --- | --- |
| 提交 | 修复 `21a5328`；release `45da49a`（版本 0.5.4 → 0.5.5、notes、README / roadmap） |
| tag | `v0.5.5` annotated（远端对象 `93570d8`）；正文与 `docs/release-notes/v0.5.5.md` 归一化后逐字一致（sha256 `e81d4167…`） |
| 源码 | main 已推（`0c356ad..45da49a`，SSH 443）；tracking ref 已对齐 |
| GitHub | `LinePixel2025/Aurora-releases` releases/tag/v0.5.5，3 资产（exe 203,255,868 B / blockmap 211,786 B / latest.yml 341 B） |
| Center 更新源 | `/api/updates/current`：version=0.5.5、3 文件；`latest.yml` SHA-256 与本地 / GitHub 相同（`3C360962…`）；安装包 Range → 206 |
| 安装包 | `Aurora-Setup-0.5.5.exe`，SHA-256 `3F211117DF75AE630DB718FC43CFBD060A88617700010FB6B063B508CB687589` |
| 验收 | `verify-update` 15/15；其余数字见上节 |

- Center 管理员密码校验：旧用户环境变量对 `admin` / `codex-release` 均 401；更新为当前密码后
  `admin` 登录 200。发布账号固定 `admin`；`AURORA_CENTER_USER` 的历史值不可直接使用。
- `--push` 仍不可用（origin 是 HTTPS，`github.com` 443 被掐）；发布后手工
  `git push git@github.com:LinePixel2025/Aurora.git main --follow-tags` 并对齐
  `refs/remotes/origin/main`，与既有口径一致。
- 仓库里仍有 54 个与本轮无关的既存 `format:check` 告警；本轮改动文件单独 prettier 通过。

## 相关文档

- 窗口：docs/07 §2.2.2、§8；docs/02 §2.2；docs/14 §2.1 / §5.3 / §5.6 / §12。
- 模型优先级：docs/06 §3；docs/08 §5.2 / §8；docs/12 §12.2；docs/07 §7。
