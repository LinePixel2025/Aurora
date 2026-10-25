# 项目记忆索引

本目录是 Aurora 的**项目记忆**：一条记忆 = 一个主题一个 md 文件，文件名带日期。
2026-10-03 从 `AGENTS.md` 拆分而来 —— **`AGENTS.md` 只留"每次动手都要遵守的硬规则"，
现象 / 根因 / 实测证据 / 历史排查过程都在这里**。

**读**：会话开始、或要判断"这件事以前有没有踩过坑"时，用 `memory-read` 技能 —— **索引必读，条目按当前任务
相关性选读**（检索词命中标签 / 主题 / 文件名的优先，跨子系统改动分组读全），不强制读完下面全部文件；
没有技能就直接读文件。**写**：用 `memory-create`（踩到新坑、确认长期口径、或用户说"记一下"）。
**整理**：删 / 并 / 精简 / 索引重排只走 `memory-summary`（用户手动 `/memory-summary` 触发）。
新增一条就补一行到本表（新条目放最上面，按日期倒序）。

| 日期       | 主题                                                                           | 标签                                   | 文件                                                                                                         |
| ---------- | ------------------------------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 2026-10-25 | v0.5.8 双投（页面面板参数修复 + Center 0.5.2）与 Qoder 锁打包目录 | 发布, 打包, 更新源, 锁, Qoder, Center, GitHub, 记录, 口径 | [2026-10-25-v058-release.md](2026-10-25-v058-release.md) |
| 2026-10-25 | v0.5.7 双投与 Center 0.5.1 换装（SSH 专用密钥、`.env` 保留、市场路由是 `/api/plugins`） | 发布, 打包, 更新源, Center, GitHub, 部署, 记录, 口径 | [2026-10-25-v057-release.md](2026-10-25-v057-release.md) |
| 2026-10-25 | Center 插件侧栏面板镜像：owner 口径、`/p/` 托管与订阅 refcount 的坑              | Center, 插件, 面板, iframe, CSP, 订阅, 安全, 坑, 口径 | [2026-10-25-center-plugin-panels.md](2026-10-25-center-plugin-panels.md) |
| 2026-10-25 | 记忆召回改相关性优先：不再强制全量读，但计分 / 放宽 / 补读 / 汇报四道护栏不能删 | 技能, 记忆, 流程, 口径 | [2026-10-25-memory-recall-relevance-first.md](2026-10-25-memory-recall-relevance-first.md) |
| 2026-10-25 | memory-summary 技能（记忆只增不减的解法）与技能名必须 kebab-case 的静默丢弃        | 技能, 记忆, DSH, 流程, 坑 | [2026-10-25-memory-summary-skill.md](2026-10-25-memory-summary-skill.md) |
| 2026-10-25 | 插件用量统计（ctx.usage）：本机按日账本、权限口径与面板取数的坑                    | 插件, 用量, Token, 生图, 语音, 隐私, 探针, 坑, 口径 | [2026-10-25-plugin-usage-stats.md](2026-10-25-plugin-usage-stats.md) |
| 2026-10-25 | v0.5.6 双投发布（流光提醒 + 提醒设置页，配置 v36→v38）与三个发布卡点                    | 发布, 打包, 更新源, Center, GitHub, 记录, 口径 | [2026-10-25-v056-release.md](2026-10-25-v056-release.md) |
| 2026-10-24 | 默认提醒方式（v37）：路由放在 NotificationService、去重先于通道、设置页两处接线              | 提醒, 通知, 配置, 迁移, 设置页, 探针, 坑, 口径 | [2026-10-24-default-reminder-channel.md](2026-10-24-default-reminder-channel.md) |
| 2026-10-24 | 流光提醒（Banner Notification）：窗口几何 / 内容高度回报 / 三条来源 / 探针口径 | 流光提醒, banner, Electron, 窗口, IPC, TTS, 探针, 坑, 口径 | [2026-10-24-banner-notification-channel.md](2026-10-24-banner-notification-channel.md) |
| 2026-10-24 | 插件独立界面启动空窗、Center 官方模型抢占默认模型、插件重启/配置窗口 | 插件, 启动, IPC, Center, 模型优先级, 重启, 窗口, 探针, 坑, 口径 | [2026-10-24-plugin-startup-model-priority-config-window.md](2026-10-24-plugin-startup-model-priority-config-window.md) |
| 2026-10-24 | v0.5.4 双投发布 + Aurora Center 0.5.0 插件市场换装上线（Center 入口统一直连 IP） | 发布, 打包, 更新源, Center, GitHub, 插件, 市场, 部署, 记录, 口径 | [2026-10-24-v054-release-and-marketplace.md](2026-10-24-v054-release-and-marketplace.md) |
| 2026-10-24 | 插件 / MCP 点号工具名发给严格网关会整请求 400：出站线路名编解码                | agent-core, 工具, 插件, MCP, LLM, provider, 坑, 口径 | [2026-10-24-tool-wire-names.md](2026-10-24-tool-wire-names.md) |
| 2026-10-24 | v0.5.2 三源发布：桌面小组件层级 / Acrylic + 独立插件工具包 + 双投验收          | 发布, 打包, 更新源, Center, GitHub, 记录 | [2026-10-24-v052-release.md](2026-10-24-v052-release.md) |
| 2026-10-24 | 桌面小组件层级（floating / normal / desktop）与原生 Acrylic：owner 亲和 / 恢复守护 / 圆角 shape | 插件, 小组件, Electron, 窗口, 毛玻璃, Win32, PowerShell, 坑, 口径 | [2026-10-24-widget-window-level-and-glass.md](2026-10-24-widget-window-level-and-glass.md) |
| 2026-10-24 | 插件小组件（桌面 / 提示条）与面板事件推送：窗口归属、限速与布局口径            | 插件, 小组件, Electron, IPC, 推送, 布局, 探针, 坑, 口径 | [2026-10-24-plugin-widgets-and-push.md](2026-10-24-plugin-widgets-and-push.md) |
| 2026-10-24 | 插件系统 v36：清单优先 / 独立进程 / 面板与沙箱页面 / Center 市场与踩坑口径 | 插件, 架构, Electron, webview, RPC, 自动化, Center, 坑, 口径 | [2026-10-24-plugin-system.md](2026-10-24-plugin-system.md) |
| 2026-10-24 | Center 官方模型：网关 120s 总时长截断流、启动期目录误报回落；0.4.9 换装记录 | center, 网关, 超时, 官方模型, 回落提示, 部署, 记录 | [2026-10-24-center-049-idle-timeout-and-official-catalog.md](2026-10-24-center-049-idle-timeout-and-official-catalog.md) |
| 2026-10-18 | v0.5.0 三源发布（内置浏览器 v35）：Center 账号误用与环境限流、GitHub 成功后的标准补发命令 | 发布, 打包, 更新源, Center, GitHub, 凭据, 限流, 记录 | [2026-10-18-v050-release-and-center-credentials.md](2026-10-18-v050-release-and-center-credentials.md) |
| 2026-10-18 | 内置浏览器 Agent 工具（v35）：guest 归属、先 attach 后导航、CDP 输入与并发槽位 | 浏览器, Agent, Electron, CDP, webview, 并发, 配置, 坑 | [2026-10-18-browser-agent-tools.md](2026-10-18-browser-agent-tools.md) |
| 2026-10-18 | v0.4.9 三源发布（GitHub + Center）与 Center 0.4.8 阿里云换装记录 | 发布, 打包, 更新源, Center, GitHub, 部署, 记录 | [2026-10-18-v049-release-and-center-048-deploy.md](2026-10-18-v049-release-and-center-048-deploy.md) |
| 2026-10-18 | 可拖窄左栏的会话行：标题 basis 0 归零、模型徽标容器查询与压测注入 | UI, chat, 左栏, flex, CSS, 模型徽标, 探针, 坑 | [2026-10-18-session-row-narrow-overlap.md](2026-10-18-session-row-narrow-overlap.md) |
| 2026-10-18 | 双端输入卡：缩略图必须在卡内、五浮层统一锚点、图片粘贴链路与探针口径 | UI, composer, 粘贴, 缩略图, 浮层, Center, 协议, 探针, 坑 | [2026-10-18-composer-paste-and-flyouts.md](2026-10-18-composer-paste-and-flyouts.md) |
| 2026-10-18 | pnpm verify-deps + CI=true 会真清 node_modules；dev 占 electron 时 install 必 EPERM；**改版本号也会触发自动安装** | 构建, pnpm, node_modules, Electron, 坑, 环境 | [2026-10-18-pnpm-ci-install-purge.md](2026-10-18-pnpm-ci-install-purge.md) |
| 2026-10-18 | 子代理多实例并行、写入串行与实际授予（限流/写锁/快照不说假话/测试口径） | agent-core, 子代理, 并发, 写权限, 测试, 口径 | [2026-10-18-subagent-parallel-write.md](2026-10-18-subagent-parallel-write.md) |
| 2026-10-17 | Agent 循环"任务编排"层四条形变约束：同轮并发批次、运行中插话注入、工具超时、job 账本死字段 | agent-core, 循环, 工具, 插话, job, 口径 | [2026-10-17-agent-loop-task-orchestration.md](2026-10-17-agent-loop-task-orchestration.md) |
| 2026-10-17 | 吸顶分组标题的三条硬约束（滚动区上内边距 / 不透明底 / 无外间距）与明细嵌在可点行里的冒泡 | 自动化, UI, CSS, 布局, 探针, 夹具, 坑  | [2026-10-17-sticky-day-head-and-nested-clickable-row.md](2026-10-17-sticky-day-head-and-nested-clickable-row.md) |
| 2026-10-16 | 自动化历史详略三层、auto- 会话对 Center 只放开两条只读命令，与两处只在打包后暴露的坑 | 自动化, 历史, Center, UI, 探针, 口径   | [2026-10-16-automation-history-detail-layers.md](2026-10-16-automation-history-detail-layers.md)             |
| 2026-10-16 | 自感知流光改 Apple Intelligence 光谱 + 只保留顶边 + 删除光帘                   | 自感知, 流光, UI, CSS, 口径, Apple     | [2026-10-16-awareness-glow-apple-spectral.md](2026-10-16-awareness-glow-apple-spectral.md)                   |
| 2026-10-16 | github.com 的 HTTPS 被整域掐断（重试无效），推 GitHub 改走 SSH 443 的一次性 URL ；并更正「重试即成功」旧口径 | 发布, git, GitHub, 网络, 坑, 口径      | [2026-10-16-github-https-blocked-ssh443-push.md](2026-10-16-github-https-blocked-ssh443-push.md)             |
| 2026-10-11 | 自感知流光改强调色单色（与提示条卡片同源）、浮层窗口要自己接 applyAppearance   | 自感知, 流光, UI, CSS, 口径            | [2026-10-11-awareness-glow-mono-accent.md](2026-10-11-awareness-glow-mono-accent.md)                         |
| 2026-10-11 | Aurora Center 版本线与桌面端解耦：更新 Center 不建 tag、不上传 GitHub          | 发布, Center, 版本, 口径               | [2026-10-11-center-independent-version.md](2026-10-11-center-independent-version.md)                         |
| 2026-10-11 | v0.4.7 安装包双投（GitHub + Center）：发布说明先补桌面改动、UAC 会卡死 verify:update | 发布, 打包, 更新源, Center, GitHub, 坑 | [2026-10-11-v047-installer-dual-publish.md](2026-10-11-v047-installer-dual-publish.md)                       |
| 2026-10-11 | 自感知流光改四边（全屏浮层 + CSS 布局摆位）、appearance.awarenessGlow 开关（v33） | 自感知, 流光, UI, CSS, 配置, 探针, 坑   | [2026-10-11-awareness-glow-four-edges-toggle.md](2026-10-11-awareness-glow-four-edges-toggle.md)             |
| 2026-10-11 | 提示条恢复原生 Acrylic：材质按窗口区域裁剪、圆角用 1px 阶梯区域、只在展开态挂（含取证通道坑） | UI, edge-bar, 毛玻璃, Electron, 坑     | [2026-10-11-edge-bar-native-acrylic-restore.md](2026-10-11-edge-bar-native-acrylic-restore.md)               |
| 2026-10-11 | 输入卡工具行的 flex 下限口径，与原生 select 弹出列表反色的唯一解               | UI, chat, flex, CSS, 原生下拉, 坑      | [2026-10-11-composer-toolrow-and-native-select.md](2026-10-11-composer-toolrow-and-native-select.md)         |
| 2026-10-10 | 截图验收的执行预算：迭代期只跑定向，全量截图只在最后验收阶段跑                 | 测试, 探针, capture, 流程, 性能        | [2026-10-10-full-capture-only-at-final-acceptance.md](2026-10-10-full-capture-only-at-final-acceptance.md)   |
| 2026-10-10 | 四条抖动截图探针的根因与判据策略（模式广播 / 身份键 / 有界等待 / 离群容忍）    | 测试, 探针, capture, 抖动, 坑          | [2026-10-10-flaky-capture-probes.md](2026-10-10-flaky-capture-probes.md)                                     |
| 2026-10-10 | 个性化三件套（明暗档位 / 毛玻璃开关 / set_appearance）的接线口径 + 沙箱跑不了 vitest 的边界 | UI, 主题, 毛玻璃, 配置, 工具, 沙箱, 坑 | [2026-10-10-personalization-theme-glass-tool.md](2026-10-10-personalization-theme-glass-tool.md)             |
| 2026-10-08 | Center 用量明细分页与官方模型表单的接线口径（含 verify:web 夹具、88 基线与 v0.4.7 云部署）    | Center, 分页, 模型, 验收, 部署, 坑           | [2026-10-08-center-usage-paging-official-models-form.md](2026-10-08-center-usage-paging-official-models-form.md) |
| 2026-10-08 | git tag -a -F 发布说明会剥掉首行 # 标题，必须 --cleanup=verbatim               | 发布, git, 坑                          | [2026-10-08-git-tag-notes-comment-strip.md](2026-10-08-git-tag-notes-comment-strip.md)                       |
| 2026-10-07 | Center 后台工作台毛玻璃与移动端适配的接线口径（含 verify:web 86 基线与 v0.4.6 云部署记录） | Center, UI, 毛玻璃, 移动端, 部署, 坑   | [2026-10-07-center-workbench-glass-mobile.md](2026-10-07-center-workbench-glass-mobile.md)                   |
| 2026-10-07 | Center 官网入口、登录后工作台与首屏性能的长期口径                              | Center, UI, 官网, 性能, 字体, 坑       | [2026-10-07-center-official-site-workbench.md](2026-10-07-center-official-site-workbench.md)                 |
| 2026-10-07 | SettingField 的 label 会把整行 hover / 点击代理给内部按钮                      | UI, 表单, Center, 坑                   | [2026-10-07-setting-field-label-button-proxy.md](2026-10-07-setting-field-label-button-proxy.md)             |
| 2026-10-06 | Center 官方模型网关与自托管更新的长期接线口径                                  | Center, 模型, 更新, 安全, 坑           | [2026-10-06-center-official-models-and-updates.md](2026-10-06-center-official-models-and-updates.md)         |
| 2026-10-06 | 自感知源删除要清库、前台 Agent 忙时暂停队列、流光用完整状态机                   | 自感知, 删除, Agent, 流光, 坑          | [2026-10-06-awareness-source-agent-glow.md](2026-10-06-awareness-source-agent-glow.md)                       |
| 2026-10-06 | 自感知重置只清 Aurora 管理数据，记录只保留变化终态                             | 自感知, 重置, 记录, UI, 坑             | [2026-10-06-awareness-reset-record-policy.md](2026-10-06-awareness-reset-record-policy.md)                   |
| 2026-10-06 | 顶部流光连续分析多个文件时不能在文件切换处广播空闲帧                           | 自感知, 流光, 队列, Electron, 坑       | [2026-10-06-awareness-glow-batch-handoff.md](2026-10-06-awareness-glow-batch-handoff.md)                     |
| 2026-10-06 | 删除会话必须级联清理 todo，否则固定会话重建会复活旧任务                        | session, todo, IPC, 生命周期, 坑       | [2026-10-06-session-delete-todo-cascade.md](2026-10-06-session-delete-todo-cascade.md)                       |
| 2026-10-06 | Agent 对话流按请求折叠，图片后置且流式期不能做最终消息分组                     | agent, 渲染, 性能, 会话, 坑            | [2026-10-06-agent-request-turn-grouping.md](2026-10-06-agent-request-turn-grouping.md)                       |
| 2026-10-05 | 会话自动标题是异步侧链路，不能阻塞回复或回填旧会话                             | session, title, agent, IPC, 坑         | [2026-10-05-session-auto-title.md](2026-10-05-session-auto-title.md)                                         |
| 2026-10-05 | 自动化详情改为单例独立窗口，弹层不再受主区层级影响                             | UI, automation, window, IPC            | [2026-10-05-automation-standalone-window.md](2026-10-05-automation-standalone-window.md)                     |
| 2026-10-05 | 提示条置顶需要 screen-saver 等级与 watchdog 恢复                               | edge-bar, Windows, 窗口, 坑            | [2026-10-05-edge-bar-topmost-watchdog.md](2026-10-05-edge-bar-topmost-watchdog.md)                           |
| 2026-10-05 | Center Web 的 mobile-single-column 探针读在动画中途，基线就红                  | center, 验收, 探针, 坑                 | [2026-10-05-cweb-mobile-drawer-probe.md](2026-10-05-cweb-mobile-drawer-probe.md)                             |
| 2026-10-05 | 应用图标改设计稿并固定圆角矩形裁切，同时修复托盘与 exe 图标丢失                | 图标, 打包, electron-builder, 坑       | [2026-10-05-app-icon-and-packaging.md](2026-10-05-app-icon-and-packaging.md)                                 |
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
