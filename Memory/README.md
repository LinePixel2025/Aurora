# 项目记忆索引

本目录是 Aurora 的**项目记忆**：一条记忆 = 一个主题一个 md 文件，文件名带日期。
2026-10-03 从 `AGENTS.md` 拆分而来 —— **`AGENTS.md` 只留"每次动手都要遵守的硬规则"，
现象 / 根因 / 实测证据 / 历史排查过程都在这里**。

**读**：会话开始、或要判断"这件事以前有没有踩过坑"时，用 `memory-read` 技能（= 读本索引 + 下面全部文件），
没有技能就直接读文件。**写**：用 `memory-create`（踩到新坑、确认长期口径、或用户说"记一下"）。
新增一条就补一行到本表（新条目放最上面，按日期倒序）。

| 日期       | 主题                                                                           | 标签                                   | 文件                                                                                                         |
| ---------- | ------------------------------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 2026-10-05 | 自动化详情改为单例独立窗口，弹层不再受主区层级影响                             | UI, automation, window, IPC            | [2026-10-05-automation-standalone-window.md](2026-10-05-automation-standalone-window.md)                     |
| 2026-10-05 | 提示条置顶需要 screen-saver 等级与 watchdog 恢复                               | edge-bar, Windows, 窗口, 坑            | [2026-10-05-edge-bar-topmost-watchdog.md](2026-10-05-edge-bar-topmost-watchdog.md)                           |
| 2026-10-05 | Center Web 的 mobile-single-column 探针读在动画中途，基线就红                  | center, 验收, 探针, 坑                 | [2026-10-05-cweb-mobile-drawer-probe.md](2026-10-05-cweb-mobile-drawer-probe.md)                             |
| 2026-10-05 | 应用图标改设计稿，同时修掉托盘与 exe 图标在打包后丢失                          | 图标, 打包, electron-builder, 坑       | [2026-10-05-app-icon-and-packaging.md](2026-10-05-app-icon-and-packaging.md)                                 |
| 2026-10-05 | Windows 游戏模式没有公开运行态 API，需用 Game Bar 进程与独占全屏状态识别       | 游戏模式, Windows, 性能, 坑            | [2026-10-05-windows-game-mode-detection.md](2026-10-05-windows-game-mode-detection.md)                       |
| 2026-10-05 | Office 主路径改为包内 OfficeCLI，渲染与 PDF 走页面回看                         | Office, OfficeCLI, agent, snapshot, 坑 | [2026-10-05-office-structured-tools.md](2026-10-05-office-structured-tools.md)                               |
| 2026-10-05 | 自感知后台模型必须严格、记忆过期只停用不删除                                   | 自感知, 模型, 记忆, 隐私, 坑           | [2026-10-05-awareness-model-and-memory-expiry.md](2026-10-05-awareness-model-and-memory-expiry.md)           |
| 2026-10-05 | 自感知建议执行必须先持久化新会话再激活                                         | 自感知, session, IPC, 坑               | [2026-10-05-awareness-execute-session-order.md](2026-10-05-awareness-execute-session-order.md)               |
| 2026-10-05 | 自感知覆盖图片与常用文档，Office 走结构化提取                                  | 自感知, 文档, 图片, officeparser, 性能 | [2026-10-05-awareness-file-types-office-extraction.md](2026-10-05-awareness-file-types-office-extraction.md) |
| 2026-10-05 | 玻璃侧栏里的搜索框不能用透明 glass token 当底                                  | UI, 搜索, 毛玻璃, 坑                   | [2026-10-05-glass-rail-search-surface.md](2026-10-05-glass-rail-search-surface.md)                           |
| 2026-10-04 | 工作台入场动效与侧栏一体化材质                                                 | UI, 动效, 性能, 毛玻璃                 | [2026-10-04-motion-and-rail-surface.md](2026-10-04-motion-and-rail-surface.md)                               |
| 2026-10-04 | edge-bar 是自感知工作台，不承载快速对话                                        | UI, edge-bar, 自感知, 毛玻璃           | [2026-10-04-edge-bar-awareness-workspace.md](2026-10-04-edge-bar-awareness-workspace.md)                     |
| 2026-10-04 | 主界面要看见系统背景，必须使用 Electron 原生窗口材质，CSS backdrop-filter 不够 | UI, 毛玻璃, Electron, 性能             | [2026-10-04-window-native-acrylic.md](2026-10-04-window-native-acrylic.md)                                   |
| 2026-10-04 | 毛玻璃材质类不能擅自补边框，否则会改变标签容量与工作台盒模型                   | UI, 毛玻璃, CSS, 坑                    | [2026-10-04-glass-material-box-model.md](2026-10-04-glass-material-box-model.md)                             |
| 2026-10-04 | 客户端性能轮：探针 / 流式渲染 / 会话内存 / 心跳 / 图片 / 轮询的长期口径        | 性能, CPU, 渲染, 内存, 坑              | [2026-10-04-performance-round.md](2026-10-04-performance-round.md)                                           |
| 2026-10-04 | 内置浏览器、对话图片与 HarmonyOS Sans 的接线口径                               | 浏览器, 图片, 字体, Center, 打包       | [2026-10-04-browser-image-fonts.md](2026-10-04-browser-image-fonts.md)                                       |
| 2026-10-03 | DSH 的技能根清单与 `.system` 陷阱（技能该放哪一层）                            | 环境, 技能, DSH, 坑                    | [2026-10-03-dsh-skill-roots.md](2026-10-03-dsh-skill-roots.md)                                               |
| 2026-10-03 | 已移除的功能 / 未生效字段 / 别误当 bug 的行为清单                              | 限制, 状态, 坑                         | [2026-10-03-known-limits.md](2026-10-03-known-limits.md)                                                     |
| 2026-10-03 | 界面文案、输入卡与 Vue scoped 样式的三条硬口径                                 | UI, 文案, 样式, 坑                     | [2026-10-03-ui-style-and-copy.md](2026-10-03-ui-style-and-copy.md)                                           |
| 2026-10-03 | 右栏多标签容器与文件 / 浏览器 / 终端面板口径                                   | UI, 标签页, 终端, webview, 坑          | [2026-10-03-chat-right-tabs-and-panels.md](2026-10-03-chat-right-tabs-and-panels.md)                         |
| 2026-10-03 | 主界面 chat 的窗口几何与三栏宽度夹取                                           | UI, 布局, 坑                           | [2026-10-03-chat-shell-layout.md](2026-10-03-chat-shell-layout.md)                                           |
| 2026-10-03 | 渲染器与视觉资产两端单源（桌面对 Center Web）                                  | shared, 渲染层, 设计令牌, 坑           | [2026-10-03-shared-renderer-single-source.md](2026-10-03-shared-renderer-single-source.md)                   |
| 2026-10-03 | 跨进程接线：reactive 不可克隆、CSP 两处注入、ClassIsland 契约                  | IPC, CSP, 渲染层, 坑                   | [2026-10-03-ipc-and-csp.md](2026-10-03-ipc-and-csp.md)                                                       |
| 2026-10-03 | agent-core 接线点：getter 注入、续轮重算、ensureLoaded、快照顺序               | agent-core, 接线, 坑                   | [2026-10-03-agent-core-wiring-pitfalls.md](2026-10-03-agent-core-wiring-pitfalls.md)                         |
| 2026-10-03 | set_setting 判定顺序、只读前缀与密文路径 5 处同步                              | 安全, 设置, 凭据, 坑                   | [2026-10-03-settings-write-guards.md](2026-10-03-settings-write-guards.md)                                   |
| 2026-10-03 | 工具权限档与项目根边界的真实语义（两层判定 + 会话级唯一口径）                  | 权限, 安全, 工具, 坑                   | [2026-10-03-permissions-and-project-root.md](2026-10-03-permissions-and-project-root.md)                     |
| 2026-10-03 | 构建 / 运行环境坑（pnpm、Electron、dist 陈旧、无 TTY）                         | 构建, 环境, pnpm, Electron, 坑         | [2026-10-03-build-env-gotchas.md](2026-10-03-build-env-gotchas.md)                                           |
| 2026-10-03 | prettier --write 会改坏 .vue 模板                                              | 构建, 格式化, Vue, 坑                  | [2026-10-03-prettier-vue-template-break.md](2026-10-03-prettier-vue-template-break.md)                       |
| 2026-10-03 | 冒烟 / 截图自测的夹具过期、负对照失效与阈值误报                                | 测试, 冒烟, 夹具, 坑                   | [2026-10-03-smoke-capture-fixtures.md](2026-10-03-smoke-capture-fixtures.md)                                 |
| 2026-10-03 | 吸底跟随的「跟丢」与「滚不动」是同一条链                                       | UI, 滚动, 探针, 坑                     | [2026-10-03-scroll-stick-to-bottom.md](2026-10-03-scroll-stick-to-bottom.md)                                 |
| 2026-10-03 | capture 探针的编写与判据口径                                                   | 测试, 探针, capture, 坑                | [2026-10-03-capture-probe-gotchas.md](2026-10-03-capture-probe-gotchas.md)                                   |
| 2026-10-03 | 自动化引擎的三处接线与 auto- 会话的确认链                                      | 自动化, agent, 坑                      | [2026-10-03-automation-engine.md](2026-10-03-automation-engine.md)                                           |
| 2026-10-03 | Aurora Center 的接线、确认卡 / 提问卡中转与部署口径                            | center, 远程, 部署, 坑                 | [2026-10-03-center-remote-and-deploy.md](2026-10-03-center-remote-and-deploy.md)                             |
