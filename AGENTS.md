# AGENTS.md

面向在本仓库工作的 ZCode / 编码代理。**先读 [docs/README.md](docs/README.md) 了解设计（它是 SSOT）**，本文件只记录不读代码就容易踩的工程事实。

## 项目是什么

**Aurora** —— 把 Windows 接入 AI 生态的**系统级 Agent 工具**：常驻托盘，以「右侧提示条」提供无感 AI 服务。Electron + Vue 3 + TypeScript，pnpm workspace monorepo，所有文档与注释以中文为主。

## 目录与职责

```
apps/desktop/
  src/main/          Electron 主进程：托盘、窗口管理、配置、文件监听、分类管线、
                     系统感知、主动引导、Agent 装配、IPC 注册
  src/preload/       沙箱化 contextBridge 白名单（自包含，见下）
  src/renderer/      四个窗口入口：edge-bar / chat /
                     settings / onboarding + shared/ 共享组件
                     （chat 即主界面：1120×720 常驻三栏；可直接输入的快速对话在**提示条面板**
                     ——窗口 focusable 跟随展开/收起切换；主界面左栏固定项点击切 quick 会话；
                     主界面与设置有 Windows 式「最小化 / 关闭」caption 按钮，关闭 = 隐藏）
packages/shared/     配置 Schema、SettingsStore、IPC 契约、模式/窗口类型
  src/main/automation/ 自动化引擎：调度（trigger 评估）、操作组件执行、定义与历史存储、
                     内置自动化（课前提醒 / 课前打开科目文件夹，docs/13）
packages/agent-core/ Agent 内核：LLM / 会话 / 工具循环 / Skill / MCP / Prompt 组装
packages/modes/      IMode 框架、ClassRoom 完整实现、Work 初步实装（BetaV2）/ Code 占位
                     packages/modes/src/capabilities.ts：模式能力矩阵（docs/05 §6）
packages/center/     Aurora Center 服务器 + `aurora-center` CLI + Web UI（docs/12），
                     纯 Node 可跨端；构建 = tsc + vite（web/ → dist-web/）
skills/              内置 SKILL.md（file-classify / system-status / timetable）
scripts/             图标生成、验收、发布脚本
docs/                项目文档（SSOT，01–11 分册）
```

版本号以各 `package.json` 为准，**根 `README.md` 的版本与状态可能滞后**，当前进度看 `docs/README.md` 与 `docs/04-roadmap.md`。

## 常用命令

```bash
pnpm install          # 首次会下载 Electron 运行时（约 100MB）
pnpm dev              # Electron 开发（主进程 / preload / 渲染层 HMR）
pnpm build            # 三个包 + Electron 产物（apps/desktop/out）
pnpm typecheck        # 全仓 tsc / vue-tsc
pnpm test             # vitest 全量单测
pnpm lint             # ESLint        pnpm format  # Prettier
pnpm verify           # 真实磁盘配置层验收（需先 pnpm build）
pnpm package          # 构建 + electron-builder NSIS 安装包
# Aurora Center 服务器（docs/12）：开发态直接 node 跑
# node packages/center/bin/aurora-center.js start --port 8787 --data <目录>
# （数据目录默认 ~/.aurora-center；CLI 子命令 init/users/token/status/update）
```

- **跑单个/单包测试**：`pnpm vitest run <文件路径>`（如
  `pnpm vitest run packages/agent-core/src/session/store.test.ts`）；按目录过滤就写目录
  （如 `pnpm vitest run packages/agent-core/src`）。
  ⚠️ **别用 `pnpm --filter @aurora/agent-core test`**：根 `vitest.config.ts` 的 `include`
  是**根相对**路径，在包目录下执行会一个用例都匹配不到，直接以 `No test files found` 退出码 1 失败
  （2026-09-26 实测；各包 package.json 里的 `test: vitest run` 只在仓库根调用时才对）。
- **端到端自测（真实 Electron + IPC，离线可跑）**：PowerShell 下 `$env:AURORA_SMOKE='1'; pnpm dev`，结束后看 `%TEMP%\aurora-smoke-logs` 里的 `AURORA_SMOKE_RESULT`。调试渲染层加 `AURORA_DEVTOOLS=1`。
  **全量一轮约 25 秒、178 条断言应当全绿（`SUMMARY 178/178 passed`）**——
  基线不是绿的说明断言或夹具过期了，**先把基线修绿再动被测代码**，别在红基线上判断"这次是不是我引入的"。
  只跑相关的那一段用 `$env:AURORA_SMOKE_ONLY='2.3'`（段号或子串，逗号分隔；留空 = 全量）。
  它**只切主进程侧那十几个段**（2.1~5），渲染层脚本（约 135 条断言）始终全跑 ——
  所以一轮的下限仍在 20 秒上下，它的价值是**聚焦**（只跑相关断言、不被无关噪声干扰），
  不是把 24 秒压到几秒。**提交前仍必须跑全量**。
  另有一条跨进程续跑段用 `AURORA_SMOKE_PHASE='resume'` + `AURORA_SMOKE_WORKSPACE=<同一目录>`。
- **Center 网页端验收（视觉 + 行为，`packages/center/verify/`）**：
  `pnpm --filter @aurora/center build && pnpm --filter @aurora/center verify:web`
  —— 起**真实服务器子进程**（临时数据目录）+ 一台**协议忠实的桩客户端**（脚本化制造流式正文 /
  工具三态 / 子代理快照 / 确认卡 / 提问卡 / 文件上传）+ `puppeteer-core` 驱动的系统 Edge，
  逐场景推进状态后**截图 + 读 DOM**，写 `report.json`（口径同 `capture.ts`：任一条 `ok: false` → 退出码 2）。
  当前基线 **74/74**（37 场景 × 暗浅两档）。开关：`AURORA_CWEB_ONLY`（子串过滤 / 特殊值 `failed`）、
  `AURORA_CWEB_THEME=dark|light`、`AURORA_CWEB_VIEWPORT=mobile`、`AURORA_CWEB_OUT`、
  `AURORA_CWEB_KEEP=1`（保留子服务器与数据目录排障）、`AURORA_CWEB_BROWSER`（找不到浏览器时明确 SKIP、退出码 0）。
  **改网页端 UI 别每次全量跑**：`pnpm --filter @aurora/center dev:web`（vite dev，`/api` 与它的 WS
  一起代理到本地 Center，`AURORA_CENTER_URL` 改目标），秒级迭代；生产托管方式不变（服务器吐 `dist-web`）。
  诊断**真实部署**的语音能力位：`pnpm --filter @aurora/center verify:web:status --server <url>
  --user <名> --password <密码>`（管理员身份连上去打印每个客户端的 `ClientStatus`，含 `voice`）——
  用来区分「客户端没上报语音」与「网页是旧包」（后者见 `packages/center/deploy/README.md`）。
- **窗口截图核对（前端视觉验收）**：`$env:AURORA_CAPTURE="$env:TEMP\aurora-capture"; pnpm dev`，会把四个窗口、
  提示条两态、设置页各页与各条 DOM 探针场景（面板 / 收起 / 自动滚底 / 门控 / 拖动 / 思考等级 /
  模型列表与模型选择 / 真实写盘 / 提示条收尾图）截成一批 PNG ——
  BetaV2 起另有主界面三栏场景（左栏门控 / 右栏开关与 Work / 思考块 / 快速会话）、
  设置六页新门控与旧深链别名（`settings-legacy-tts-alias`）场景；
  **张数与具体构成以 `report.json` 的实际条目为准，不要按固定张数校验**，
  并写 `report.json`（渲染层 DOM 探针结果：
  面板按钮命中测试、点击竖条后的窗口状态、设置页 `data-field` 门控计数；探针返回 `pass` 时按 PASS/FAIL 落日志，
  有 FAIL 时进程退出码为 2）。
  只截部分窗口用 `$env:AURORA_CAPTURE_WINDOWS='edge-bar,chat'`；再细一级用
  `$env:AURORA_CAPTURE_ONLY='session-groups'`（按 PNG 文件名**子串**匹配，逗号分隔），
  特殊值 `failed` = 只重跑上次 `report.json` 里没过的那几张（上次全绿则一张不跑、退出码仍为 0）。
  命令结束后进程自行退出；
  userData **自动隔离**（探针会改配置），无需再手动同开 `$env:AURORA_SMOKE='1'`。规则见 docs/07 §5.3。
- **CI 是按需触发的，不跟随 push / PR 自动跑**（`.github/workflows/ci.yml`，Windows）。
  日常验证靠本地 `pnpm typecheck && pnpm test && pnpm build`——与 CI 同一套检查、全量约 15 秒；
  需要干净环境时手动发起（Actions → Run workflow，或 `gh workflow run ci.yml`）。
  CI 内部顺序：`format:check → lint → typecheck → test → build`。策略原因见 docs/09 §2。

## 架构硬约束（改错会直接构建失败或线上炸）

1. **`agent-core` 与 `modes` 不得依赖 Electron / DOM**——保持纯 Node，可独立单测，也为将来换壳层留后路。
2. **preload 必须自包含**：它跑在 `sandbox: true` 的渲染进程里，无 Node 能力、无法解析 pnpm 工作区包，只能 `require('electron')` + 字面量通道表。改 IPC 契约时**同时**改 `packages/shared/src/ipc/channels.ts` 与 `apps/desktop/src/preload/channels.ts`（两者有编译期双向断言，漏改 `pnpm typecheck` 会报错）。
3. **主进程必须内联工作区包**：`@aurora/*` 是纯 ESM，主进程产物是 CJS，`require()` ESM 会抛 `ERR_REQUIRE_ESM`。因此 `electron.vite.config.ts` 把它们排除在 `externalizeDepsPlugin` 之外——不要「顺手」加回去。
4. **渲染层只允许类型导入**：从 `@aurora/shared` 取**纯常量/运行时值**必须走 `@aurora/shared/browser` 子路径，否则会把 `node:fs` 拉进浏览器 bundle 导致构建失败。`packages/shared/src/browser.ts` 的依赖链禁止出现任何 Node 内置模块。
   **Markdown 渲染器就是这条规则的现成例子**（2026-10-02）：`browser/markdown/`
   （markdown-it + highlight.js 子集 + KaTeX/katex.min.css，图表两库**动态 import**）是
   桌面与 Center Web 的**唯一**渲染器，样式单源在 `browser/markdown/md.css`
   （经 `--md-*` 变量映射两端令牌；改输出类名必须同时对照 `MARKDOWN_CONTRACT_CLASSES`
   与两端截图）。两端的旧 `markdown.ts` 已删除 —— 不要再各自分叉一份。
   ⚠️ 渲染器依赖（含 CSS/字体）只声明在 **`packages/shared`**：pnpm 严格链接下
   宿主解析不到兄弟包的依赖（Center 曾因此在 `vite build` 报 unresolved import）；
   两库无 `eval`，生产 CSP `script-src 'self'` 下动态 chunk 可正常加载（已核 mermaid 12 /
   echarts 6 的 dist）。
   **视觉资产的其余部分也走同一条单源（2026-10-02 起）**：设计令牌 / 暗浅主题 / `aurora-*`
   keyframes / 过渡预设 / 原子类在 `@aurora/shared/browser/theme.css`；图标清单 `icons.ts`、
   工具语义查表 `toolIcons.ts` / `toolLabels.ts`、吸底状态机 `composables/stickToBottomCore.ts` +
   `useStickToBottom.ts`、实测高度动画 `useCollapseTransition.ts` 都在 `packages/shared/src/browser/`，
   **桌面四窗口与 Center Web 共用同一份**（center web 里的旧副本已删）。改这些 = 同时改两端界面：
   改完必须跑 `AURORA_CAPTURE`（桌面，73/73）与 `verify:web`（网页，74/74）两边核对。
   ⚠️ 齿轮图标在 shared 里叫 **`SettingsGear`**（lucide 的 `Settings` 与配置类型 `Settings` 同名，
   桶文件 `export *` 无法消歧 → TS2308）：要类型写 `Settings`、要图标写 `SettingsGear`。
   `lucide-vue-next` 与 `vue` 按同一条规矩声明在 `packages/shared` 的 devDependencies。
5. **重任务走子进程**：文档内容提取等 CPU/IO 重活由 `utilityProcess.fork` 启动 `extract-worker`（`electron.vite.config.ts` 的第二个 main 入口），不阻塞主进程事件循环。
6. **IPC 命名**：通道用 `namespace:action`（如 `chat:send`、`mcp:status`）；事件推送 `on/off` 成对暴露；大 payload（文件全文）只在主进程 / worker 内流转，不进渲染进程。

## 编码与安全约定

- TypeScript strict，开启 `verbatimModuleSyntax`、`noUncheckedIndexedAccess`、`noImplicitOverride`。ESLint 强制 `consistent-type-imports`（用 `import type` / 内联 `type`），未用变量需 `_` 前缀。
- Prettier：**无分号**、单引号、`printWidth: 100`、尾逗号 all、LF（见 `.prettierrc.json` / `.editorconfig`）。
- **日志**：业务包只依赖 `@aurora/shared` 的 `Logger` 接口；落盘实现在 `apps/desktop/src/main/logger.ts`（`userData/logs/`，按天轮转保留 7 天），所有输出统一脱敏。不要 `console.log` 当正式日志。
- **凭据绝不落明文**：API Key / MCP env 经 Electron `safeStorage` 加密写入 `%APPDATA%/Aurora/config.json`；`settings:get` 与 `settings:changed` 两条通道都只回传 `apiKeySet` / `envSet` 标记。日志与「导出脱敏配置」中凭据一律 `***`。
- **Markdown 渲染安全基线**：输出必须先转义再套白名单标记（渲染器 `html:false`），
  **绝不允许裸 `v-html` 模型原文**；链接 scheme 走 markdown-it `validateLink`（`javascript:` 拒绝）；
  外链一律 `target=_blank` + `rel="noopener noreferrer nofollow"`；图片降级为链接
  （生产 CSP `img-src 'self' data:` 会拦远程图）。
- **文件/命令安全**：MCP 服务器以用户显式配置的 argv 数组启动、**绝不经过 shell**；Skill 的 `scripts/` 永不自动执行；敏感工具用 `sensitivity: 'confirm'` 标记，需确认后才执行（确认链路抛错按拒绝处理）。
- **配置改动**（当前 `CONFIG_VERSION = 24`）：Schema 在 `packages/shared/src/config/schema.ts`，改字段必须走版本迁移链（`migrations.ts`）并同步更新 `docs/08 §1`；`pnpm verify` 会断言 `version === CONFIG_VERSION` 与 `v0 → 当前版本` 的迁移条数，版本推进后必须复跑。

## 文档先行（Docs-first）

`docs/` 是**单一事实来源**：改配置 Schema、IPC 契约、窗口交互前**先改文档再改代码**。按主题查阅：

- 配置 / 引导 / 凭据 → `docs/08-settings-onboarding.md`
- Agent 内核（LLM / 会话 / 循环 / Skill / MCP / 感知 / 主动引导）→ `docs/06-agent-core.md`
- 模式系统与文件分类管线 → `docs/05-mode-system.md`
- 窗口体系与 UI 规格 → `docs/07-ui-spec.md`（视觉设计另见 `ui-ux-pro-max` / `frontend-design` skill）
- 进程 / 模块 / IPC 约定 → `docs/02-architecture.md`
- 打包发布与自动更新拓扑 → `docs/09-packaging-release.md`

## 环境相关坑

- **pnpm 11 默认拦截依赖安装脚本**：需要放行的依赖写在 `pnpm-workspace.yaml` 的 `allowBuilds`（写 `false` 表示显式拒绝）。不要再维护 `ignoredBuilds`，两处并存会导致 `pnpm test` 前置的依赖校验以 `ERR_PNPM_IGNORED_BUILDS` 失败。
- **Electron 二进制下载失败**（企业代理 / 证书拦截）：在 `apps/desktop/node_modules/electron` 下执行 `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; node install.js`。npm 镜像配置见 `.npmrc`。
- **vitest 只收「不 import 'electron'」的主进程测试**（`vitest.config.ts` 的 include）：`apps/desktop/src/main/**/*.test.ts` 下的用例若引入 Electron 会在 Node 环境加载失败。依赖 Electron 的行为靠 `AURORA_SMOKE` 端到端自测覆盖。
- 用户数据：配置 `%APPDATA%/Aurora/config.json`、会话 `sessions/*.json`、分类流水 `classification.json`、日志 `logs/`。写文件一律原子写 + 防抖（与 `SettingsStore` 同一套 `FileSystemPort` 约定），退出前 `flush()`；损坏文件备份后重建。
- 提交信息用 **Conventional Commits**，描述用中文（如 `feat(v0.5.0): ...`、`fix: ...`、`docs: ...`）。
- **`pnpm dev`（含 `AURORA_CAPTURE`）在 Electron 里跑不了时先查 `ELECTRON_RUN_AS_NODE`**：
  它若是 `1`，Electron 会把自己当纯 Node 启动，`require('electron')` 返回的是**二进制路径字符串**，
  主进程在 `!electron.app.isPackaged` 这行崩（`Cannot read properties of undefined`）——
  看着像打包产物坏了，其实只差 `Remove-Item env:ELECTRON_RUN_AS_NODE`。
  某些 agent 运行时（如 DSH 的 shell）默认就带这个变量，逐条命令前清一次最稳。
- **同一台机器上可能有别的 dev server 占着 5173**：`electron-vite dev` 会自动换到 5174 并照常工作，
  不是错误（截图与探针都不受影响）。

## 诊断与验证的时间成本（2026-09-30 「跟丢」排查的教训）

那一轮把「自动跟随跟丢」查穿花了远超预期的时间，**大头不是难度而是排查方式**。
下次碰到"跑起来才知道对不对"的问题，先按这几条走：

- **别用全量 `AURORA_CAPTURE` 当探针**：一轮 3–5 分钟、且必须串行重建。
  排查阶段先用**最小复现**（一个临时 HTML + 同一段 JS，几秒一轮）把
  "浏览器到底会不会那样表现"钉死，再回到仓库里改实现 —— 本轮最贵的一次绕路就是
  用 20 多轮全量截图去问一个可以用 20 行 HTML 回答的问题。
- **"绿灯"会骗人**：`pnpm typecheck` / `pnpm test` / 大多数探针一路是绿的，行为却可以是坏的。
  UI 类问题先构造**能直接读出事实**的观测（引擎自己的读数 vs 探针 querySelector 的读数、
  计数器、节点身份标记），**一次性把仪器插全**再跑，而不是每轮只加一个数字。
- **`capture.ts` 里的探针是 template literal 字符串**：字符串**内部**的注释写反引号 `` ` ``
  会提前终止字符串，直接 `TS1005` 且报错位置极具误导性。本轮在这个坑上反复栽了十几次 ——
  写注释用「」或单引号。这条在文件里已写过一次，**但教训是"每次改都要自查"**，不是"记住了就行"。
- **探针之间会互相污染**：本轮 `chat-follow-burst` 长时间 FAIL，根因是它前面那条
  `CHAT_AUTO_SCROLL_SCRIPT` 把跟随关掉后没恢复。每条场景都要**自带前置与收尾**，
  用应用自己的入口按钮恢复状态，不依赖别人的自律。
- **同一段语义的判据只写一份**：`pass` 与 `conditions` 表漂移过一次 —— 报告里每条都 `true`、
  探针恒定 FAIL。让 `pass` 直接取那一张表的乘积。
- **量事实，别量解析值**：`border-left-color` 在"没有左边框"时解析成 `currentColor`；
  展开动画中途的 `border-width` 是 `0.666667px`。判据要取"有没有这条边"（宽度）而不是颜色，
  且必须在**正确的时机**量（折叠态、点击之前）。

### 2026-10-01 追加（用户报「答完滚动不了历史 + 工作过程不折叠」）

两条都在**上一轮新写的代码**里，且**全量 34 条探针全绿** —— 记下四条可复用的：

- **「滚不动」和「跟丢」是同一条链的两个反向失效，别把前一版的语义当成不需要再验**：
  上一版为了修「跟丢」，把跟随状态的判定从 `scroll` 事件挪到了「真实输入」事件上。但**输入事件
  到达主线程时，合成器可能还没把视口挪过去**（`passive: true` 的 wheel 尤其如此），那一刻读数
  仍是"贴在底部"→ 判成"用户还在底部继续滚" → 浏览器随后派发的 `scroll` 排出一帧对齐，把这一滚
  原样抹回底部。滚轮**逐次被吞**。修法是真实输入开一个短窗口（250ms）按**当前读数**重判
  （`stickToBottomCore.ts` 的 `intentWindowMs`）：判定只由真实输入**发起**，但要看**之后的**读数。
- **旧探针的"前置"可能正好绕开了 bug**：`CHAT_AUTO_SCROLL_SCRIPT` 与 `CHAT_FOLLOW_BURST_SCRIPT`
  都是**先把 `scrollTop` 拨到 0 再发滚轮**，于是意图判定那一刻离底已经很远，永远测不到
  "从底部往上滚"这条真实路径；真实用户是从底部滚的。新探针 `CHAT_FOLLOW_WHEEL_UP_SCRIPT`
  如实复刻两拍（贴底 → 真实 wheel → 挪视口 + `scroll`），**反向复核（把修复 stash 掉）实测 FAIL**：
  `{"distanceAfter":0,"capsule":false}` = 滚动被抹掉、胶囊不出现。
- **「探针替应用做决定」= bug 永远不会被它发现**：`CHAT_TRACE_ACT` 会**自己先把轨迹收成折叠态**
  再量几何 —— 它测的是"折叠态长什么样"，所以状态机坏了它照样 PASS。要测状态机就得有一条
  **完全不碰状态、只读应用自己留下的结果**的探针（`CHAT_TRACE_FOLD_CHECK`）。
- **夹具要覆盖"字段缺一半"的分支**：轨迹自动折叠原先只收「**思考增量**到达时被打开过的」消息，
  而桩 LLM 的默认分流**每轮都发 `reasoning_content`** —— "有工具调用、没有思考增量"那一轮
  一次都没被覆盖，bug 就活在 34 条全绿的探针底下。给桩加一条专用分流（`SKILL_ONLY_MARKER`）才造出
  现场。**另注意桩分流判断"第几轮"不能看整段历史里有没有 `role: 'tool'`**（长会话里前面的提问有），
  要看**最后一条 user 消息之后**有没有（`hasToolResultSinceLastUser`）—— 否则第 1 轮就回正文、
  探针报出"没有轨迹"这种看着像渲染坏了的假 FAIL。
- **换容器时原生监听的归属**：`rebind()`（自愈入口）只重挂了两个观察者，`wheel` / 滚条 /
  翻页键 / `scroll` 四条**原生监听**只在 `core.start()` 那一次被消费 —— 注释写了"每次 rebind
  都重新挂一遍"、实现漏了。**注释里的承诺要当成待验证的断言读**，别信它已经发生。
- **探针字符串里的语法错现在有护栏**：`capture.probe-strings.test.ts` 的第二条把「静态开头是
  `(`」的 template literal 还原成源码（`${}` 换成占位符）再交给 TS 解析器。起因很典型：
  `SETTINGS_FIELDS_SCRIPT` 里删白名单时留下一行**多余的 `)`**，而字符串里的语法错**绕过
  `tsc` 与 `pnpm test`**，只在 `AURORA_CAPTURE` 跑到那张图时变成 `Script failed to execute`
  —— 它已经在两次全量截图里红着（2026-09-30 21:06 / 22:00 的报告可查），没人看见。
  另一类成因是**注释里写了反引号**（提前终止 template literal，后半截被当成代码解析）：
  本轮现写现踩，被这条护栏当场抓住。
- **JS 合成事件测不到原生滚轮管线（2026-10-01「无法用滚轮滚动」的教训）**：
  `dispatchEvent(new WheelEvent(...))` 能驱动意图链路（监听器照收、判定照跑），但**不触发
  合成器滚动** ——「程序把用户刚滚出去的视口吸回去」这类失效（意图与对齐帧的竞速、
  吸底补齐的时机）全都发生在合成器与主线程之间，合成事件面前必然 PASS。
  要测真实滚轮，走 `webContents.debugger` 发 CDP `Input.dispatchMouseEvent`（type `mouseWheel`），
  见 capture 的 `chat-trace-wheel` 探针与 docs/07 §5.2 ①‴。

### 2026-10-01 追加（用户报「大部分时间花在冒烟测试上」）

那一轮单跑一次冒烟要 2~3.5 分钟、且 176 条里有 13 条连续多轮恒红。三条可复用的：

- **口径变了就必须同改夹具，否则测试会以「恒红」的形式持续收税**：v17/v18 把项目根从
  「全局 `projects.current`」改成**按会话解析**（未绑定会话恒落 Agent 空间 `桌面\Aurora`，
  而它**排在全局当前项目之前**），smoke 的夹具却仍只设全局 current、写目标又在 `userData` /
  `%TEMP%` 下 —— 13 条断言测的全成了「越界拒绝」。**判据**：连续多轮失败项**逐字相同**
  （不是抖动）+ 失败详情里出现"按设计"的拒绝文案（如 `该路径在项目根之外`）→ 先怀疑夹具过期，
  再怀疑实现。修法是把夹具**绑定到会话**（`index.ts` 的 `bindSmokeProject`），别去"修"边界判定。
- **看见 `await confirmTool(...)` 先检查夹具**：夹具落不到 auto 档"根内"分支时，它会静默走进
  「等用户回执」—— 一个 60s 超时，两个就是每轮白扔 2 分钟，而失败详情只显示
  `approve:false noCard:true`，看着像"没批准"。同段里"**故意**要弹卡"的那半（根外）走的是
  轮询 + `rejectAll`，**不等超时** —— 两者别混为一谈。
- **「负对照」必须挂在"调用真的成功"之上**：`!text.includes('skipped.txt')` 这类判据在调用本身
  失败时恒真（错误文案里当然没有那个文件名），于是半条断言从没跑过却一直报 ok；
  2.6 段只读档的"内容一字未变"同款（文件压根没被写成功过）。加判据时先问一句
  「**调用失败时这条会不会也成立**」。


## 尚未生效 / 已知限制（别误当成 bug）

- 全局快捷键默认 `Alt+Space` **在 Windows 上常被系统占用**（它是系统窗口菜单键）。
  注册失败是预期路径：`main/hotkey.ts` 会把真实原因回传设置页，用户改绑即可 —— 不要"修"成静默成功。
- 提示条的 `可穿透性`（`setIgnoreMouseEvents`）尚未接入；`general.language` 是死字段（无 i18n 消费方），
  **已从设置页与引导页移除**（Schema 里保留字段仅为兼容旧配置，改它不生效）。
- **AI 悬浮窗（service-dock）已于本轮移除**，常驻入口为提示条 + 托盘；配置迁移到 v4
  （`v3 → v4` 删除 `general.windowState['service-dock']`）。提示条的悬停展开面板与点击呼出交互窗见 docs/07 §2.2。
- **独立小窗（mini-chat）已于早轮删除**；2026-09 重构起标题栏是 Windows 式 caption 按钮——
  「关闭」= **直接隐藏窗口**（正在进行的流式回复不中止），「最小化」真最小化进任务栏；
  「快速对话」（`sessionId = quick`）的输入入口在提示条面板（左栏固定项点击切会话），历史会话列表在左栏，
  提示条面板操作入口由 4 个减为 3 个；配置迁移到 v6（`v5 → v6` 删除 `general.windowState['mini-chat']`）。
- MCP HTTP 传输已支持自定义请求头（含鉴权头，`mcp.servers.<id>.headersEnc`，凭据链路与 env 同款，见 docs/08 §1）。
- **语音输入（STT）已实装（v0.0.1）**：对话窗 composer 的麦克风按钮（`data-field="chat.mic"`）
  门控口径同 TTS —— `stt.enabled` + `stt.active` 指向一个 `baseUrl`/`model` 齐全的 provider
  **才渲染按钮，未配置时连按钮都不渲染**（不是 disabled）——这是文档门控口径，别当 bug 修
  （TTS「朗读」按钮同款口径，见 docs/07 §2.3）。
- **电脑操控工具已由 5 个扩到 8 个**（2026-09 新增 `edit_file` / `grep` / `glob`，
  见 docs/06 §11.5 / §11.6）：三者都在 `agent.tools.enabled` 总开关与各自子开关
  （`edit_file` 随 `files.enabled`、`grep` / `glob` 随 `search.enabled`）之下 ——
  与「扩展工具六件套不受门控」的口径**相反**，别按六件套理解它们。
- **三档权限与项目根边界已落地（2026-09-26），但仍无 OS 级沙箱**：`agent.permissionMode` 取值
  `readonly` / `confirm` / `auto`（**默认 `auto` = 完全权限**，2026-09-29 起出厂档；镜像的老开关
  `advanced.confirmSensitiveTools` 出厂同为 `false`）—— `readonly` 档**不注册**写入 / 执行类工具
  （含 `todo_write`，保留 `todo_read`），`auto` 档在**当前项目根之内**免确认、越界仍逐次确认、
  未配置项目时只写日志留痕；
  v0.2.4 起两处放宽（Codex 式，docs/06 §11.2）：`center_send_file` **直接发送不逐次确认**
  （闸门在配置层 `center.enabled` / `allowFileTransfer` / `maxFileMb`，别再给它加确认），
  `confirm` 档下 `write_file` / `edit_file` 落在会话边界根内**免确认**（`run_command` 等仍逐次）；
  边界根的回落链见下面「会话级项目的解析唯一口径」（含 Work 模式工作目录一级）；
  项目根边界分**两层**：`auto` 档「要不要弹卡」用**字符串级判定**（含 `..` 段、取不到目标路径的
  工具一律按越界）；「能不能真碰」由主进程对**已存在的最近父目录**做 realpath 前缀校验
  （`file-port.resolveWithin`，越界即 `E_PATH_OUTSIDE_WORKSPACE`，六个文件类入口与
  `run_command.cwd` 都走它）。
  但**没有作业对象 / 容器 / 受限令牌**，`run_command` 仍是当前用户权限 —— 别把这两层说成"沙箱"。
  早前的确认判定逃逸**已封堵（2026-09）**：确认判定改为四态 decision，
  `approvedByUser` 仅当用户**当次**卡片批准 / 首次「总是允许」置位，机器放行不置位、
  realpath 兜底保留（根内链接指向根外在机器放行路径下被 realpath 拒绝且不弹卡）；
  详见 docs/06 §11.2。
- **`agent.tools.workspaceDir` 仍然只是"默认 cwd / 搜索根"，不是安全边界**：缺省工作目录 / 搜索根按
  三级回落——**当前项目根（配置了当前项目时）> `workspaceDir` > 用户主目录**，这条链**已按 docs/06 §5.1
  的 `effectiveWorkspaceDir` 接线**（**工具执行链的唯一口径**，别在执行链上再写一套）：配了
  当前项目后，不显式传 `cwd` 的 `run_command` 与不传根的 `grep` / `glob` 落在**项目根**；
  无项目时行为与之前一致。设置页「打开工作目录」按钮（`openPath kind:'workspace'`，`ipc.ts`）
  **也已接同一链**（2026-09，解析抽在 `main/tools/workspace-target.ts` 纯函数）：配了项目时打开项目根、
  与命令缺省落地目录一致，早前的分叉已消除（v25 起无 `kind:'project'` 入口：全局 current 已退役）。
  真正的安全边界是**「当前项目根」**，且**只有配置了当前项目时才生效**
  （无项目时行为与 v12 之前完全一致）。
  想当然地拿 `workspaceDir` 当护栏、或把 `openPath` 的 `kind: 'workspace'` 当成项目根，都是错的
  （v25 起无 `kind: 'project'`：全局 current 已退役，`kind:'workspace'` 走同一回落链）。
- **ClassIsland 桥接读取有默认路径回落（v0.2.4）**：文件源端点读取失败时自动按插件默认输出
  `%APPDATA%\ClassIslandurora-bridge\schedule.json` 重试一次，成功则告警提示对齐两端配置
  （`classisland.ts` 的 `fallbackFilePath`，主进程注入；默认路径常量别散落第二份）。
  桥接读取失败按「错误是否变化」分级记日志（变化才 warn，持续同一错误 debug），别改回全量 warn。
- **自动化（Automation，v0.2.5）已落地两种模式（docs/13）**：**Agent Mode** 触发后跑一次
  完整 Agent 会话（专属会话 id = runId = `auto-<ts36>-<n>`，`origin: 'automation'`），
  **Normal Mode** 触发后按预设操作组件执行（**封闭清单**：系统通知 / ClassIsland 提醒 /
  打开文件夹 —— 没有命令、没有任意写，这是它与 Agent Mode 的安全分界）。
  定义与历史落在 `<userData>/automations/{automations.json,history.json}`（**不是配置**、
  不进迁移链；历史上限 500 条）。ClassRoom 既有的**课前提醒 / 课前自动打开科目文件夹**由
  **内置自动化**（`builtin.pre-class-notify` / `builtin.pre-class-open-folder`）承接，
  行为逐字保留（同一提前窗口 / 文案 / 勿扰 / `lessonKey` 去重），旧 `PreClassReminder`
  服务已**删除**（`schedule.ts` 的 `preTrigger`/`needsNextDayLessons` 纯函数保留给条件评估用）；
  **自动分类不在迁移范围**（仍是独立管线）。`auto-` 前缀会话**不进主界面左栏**（只过滤展示，
  只从「自动化 → 历史」进入）。`automations.*` 整组在 `SETTINGS_READONLY_PREFIXES`
  （AI 只能经 `automation_*` 六件套工具增删，写类四个是 `confirm`）。
- Skill 的 `scripts/` 永不自动执行（只注入指令正文）；图片 OCR 未启用（只取文件名与尺寸）。
- Code Mode 为占位实现；Work Mode 已初步实装（guide + systemPrompt；v0.2.4 起 `modes.work.workspaceDir`
  已接进工具执行链的统一回落链，不再是仅提示词引用的死字段）。
  多语言、ARM64 / 便携版、macOS / Linux 未开始。
- `integrations/classisland-bridge` **CI 不编译**（流水线没有 .NET SDK）。
  它已用 ClassIsland 2.1.0.1 的真实程序集在本机编译并实跑验证过（见该目录 README 的「已验证程度」），
  改动后请在装有 .NET SDK 与 ClassIsland 的机器上重新验证：
  `dotnet build -c Release -p:ClassIslandDir="<ClassIsland 安装目录>"`。
  注意 ClassIsland 的程序集**不在**安装根目录，而在 `app-<版本>/` 子目录（csproj 会自动往下一层找）。

## 几个容易踩的接线点（改之前先看这里）

- **网络出网统一走 `main/net.ts` 的 `netFetch`**：它优先用 Electron `net.fetch`（走 Chromium
  网络栈 → 才受 `session.setProxy` 的代理影响），并保留 `globalThis.fetch` 回落。
  新增任何出网调用都要注入它，否则 `advanced.proxy` 对该调用无效。
- **`agent-core` / `modes` 不得 import electron**：代理、快捷键、窗口、日志实现全在主进程，
  内核只接受注入（`fetchImpl` / `summarize` / `confirmTool` 都是这个套路）。
- **配置字段"能写"不等于"生效"**：本轮修掉的就是一批死字段。新增配置项时要么接上消费方，
  要么在本文档里明确标注为未生效。
- **跨 IPC 不能传 reactive 代理**：`ipcRenderer.invoke` 用结构化克隆传参，Vue `reactive` / `ref` 产出的
  **Proxy 不可克隆**，会抛 `DataCloneError: An object could not be cloned.`——若在异步 handler 里
  await 它，表现就是「点了没反应、也不报错」（`settings:update` 与 `chat:send` 的附件列表都踩过）。
  注意 `{ ...reactiveObj }` 这类展开只让**顶层**变纯，嵌套子对象仍是 Proxy。
  渲染层往主进程送对象前统一走 `deepClone()`（`@aurora/shared/browser`，内部 structuredClone →
  JSON 回落，正好把 Proxy 变成纯数据）；只传字面量 / 字符串的通道不用处理。
- **ClassIsland 联动只认 `main/classisland.ts` 的 JSON 契约**，桥接端的实现细节不得泄漏到
  provider 与消费链；桥接数据的一切异常都必须降级为空课表 + 告警。
- **渲染层播放合成音频依赖 CSP 的 `media-src 'self' blob:`**（`main/index.ts` 两条 CSP 都要有）：
  生产 CSP 的 `default-src 'self'` 会拦掉 `blob:`，而开发态 `default-src` 里本来就带 `blob:` ——
  漏掉生产那条的症状是「**开发能播、打包不能播**」，属最难排查的一类假阳性。
  TTS 出网必须走 `main/net.ts` 的 `netFetch`（否则 `advanced.proxy` 对它无效），
  `TtsSynthesizer` 用 `resolveFetch` 注入；它**不得 import electron**，否则 vitest 收不了它的单测。
- **`tts.providers` 是凭据路径**，已进 `SETTINGS_READONLY_PREFIXES`（AI 的 `set_setting` 一律拒绝）。
  新增任何 shared 的密文路径时，`SettingsStore` 的 4 处（`canonicalSecretPath` / `readSecretField` /
  `writeSecretField` / `toPersisted`）**外加**主进程 `redactSettings` **必须同时改**：
  漏改 `writeSecretField` = 凭据静默丢失，漏改 `redactSettings` = 密文泄漏进渲染层。
  另注意 `SENSITIVE_KEY_PATTERN` 原本是**整体锚定**的，`apiKeyEnc` 这类**派生字段名**不命中 ——
  它已补 `.*api[-_]?key.*` 分支，日志脱敏才盖得住密文。
  v9 起新增的 `mcp.servers.<id>.headersEnc` 与 `envEnc` 同款、位置并列（同样要过这 5 处）。
- **`agent.tools.terminal.allowPatterns`（免确认命令模式）属只读前缀**：AI 的 `set_setting` 一律拒绝
  （否则 AI 给自己加一条 `git*` 就等于摘掉自己的确认闸门 = 自我提权），
  只能由用户在设置页的「免确认命令模式」栏里维护（设置页走 `settings:update`，不受该黑名单影响）。
  命中即跳过确认卡片、但仍写 `info` 级审计日志 —— 语义是「减少打扰」而非安全加固（见 docs/06 §11.7）。
- **`edit_file` 的「改前必须先读」守卫是会话级单例、建在 `registerComputerTools` 的闭包里
  （`sync()` 之外）**：`read_file` 与 `edit_file` 共享同一份「本会话读过哪些文件」的记录
  （键是**解析后的绝对路径**，按会话裁剪、只留最近 16 个会话）。`sync()` 会在每次
  `settings:changed` 时重建**全部工具实例**（这是让上限 / cwd 热改的必要设计）——
  **不要把这个守卫挪进 `sync()`**：挪进去后用户改一个无关开关（比如关掉终端）就会清空读记录，
  模型刚 `read_file` 过的文件立刻被 `edit_file` 拒绝「修改前必须先读」，看起来像工具坏了。
  守卫是内核的可注入端口（未注入时不拦截，供单测直接调工具），见 docs/06 §11.6。
- **写前快照的钩子在 `file-port.writeText` 内部，顺序不能换**（v14）：顺序是 `resolveWithin`
  （项目根 realpath 前缀校验）→ `capture`（把**原内容**存进 `<userData>/backups/<sessionId>/`）
  → 真正写盘。换成"先写再备份"就等于"改完才备份"，回滚拿不到改动前的内容；
  主写失败**不回滚快照**（文件可能已被部分改写，那份快照才是唯一退路），
  改成把快照 id 带进错误信息（见 docs/06 §11.8）。
- **`ensureLoaded` 的三处（会话 / 待办清单 / job 存储）都必须用 in-flight promise**：
  写成"先置 `loaded` 再 `await` 读盘"会让并发首读拿到**空快照**，随后那一次写入
  把磁盘上的历史**整体覆盖**（本仓库已修过两次，别再改回去）。job 存储还多一条：
  **落盘前必须已 `ensureLoaded`**，否则内存里的空表会冲掉盘上数据。
- **自动续轮的 history / systemPrompt 必须在 `for (;;)` attempt 循环内、每 attempt 重算**（2026-09 修复，docs/06 §4.1）：
  `agentLoop` 在 `appendUserMessage = false` 时**既不落盘也不 push** 用户消息，其语义前提是「提问已在 history 里」——
  只有每轮重读会话组装才成立。整块外置到循环之前 = 续轮拿**请求前**的旧快照，第二轮既没有本轮提问、
  也没有上一 attempt 的工具结果，模型会重复已执行的写 / 命令操作。回归护栏：
  `agentHost.test.ts` 的「自动续轮的请求带本轮提问与上一轮工具结果」用例。
- **`agent.permissionMode` 是只读前缀**（AI 的 `set_setting` 一律拒绝：改档位等于自我提权，
  与 `agent.tools.terminal.allowPatterns` 同款）。`agent.snapshots.*` / `agent.loop.*` 同为
  **`SETTINGS_READONLY_PREFIXES` 中的只读前缀**（用户可在设置页调，AI 一律拒绝）：
  让 AI 给自己放大轮次 / token 预算，等于绕过"该停下来问用户"的那道闸门；关掉写前快照
  等于拆掉回滚保险。`advanced.readonlyPrefixes`（黑名单配置自身）也已进黑名单（v15）：
  AI 往里追加等于自我收紧（自我 DoS），放宽本就不生效。
- **`agent.loop` 的三个上限是以 getter 注入内核的**（`() => settings.get().agent.loop.maxRounds`
  这种形式）：写成构造时常量值就变成"改设置要重启才生效"的死字段 ——
  与上面「配置字段"能写"不等于"生效"」是同一个坑，本仓库已修过一批。
- **BetaV2 新能力的注册口径**：STT / 生图 / 扩展工具六件套（`web_fetch` / `notify_user` /
  `clipboard_read` / `clipboard_write` / `generate_image` / `show_preview`）**不走
  `agent.tools.enabled` 门控**（那个总开关管的是 8 个电脑操控工具），敏感项靠
  `sensitivity: 'confirm'` 逐次确认；
  ⚠️ **反例与它们同期**：2026-09 新增的 `edit_file` / `grep` / `glob` **是电脑操控工具、受总开关门控**
  （分别随 `files.enabled` / `search.enabled`，见「尚未生效 / 已知限制」那条）——
  不要因为"同期落地"就把它们也当成不受门控的扩展工具；
  `set_setting` 的判定顺序是：命中 `WRITABLE_PATH_OVERRIDES` 显式放行（先于黑名单）→ 命中
  `SETTINGS_READONLY_PREFIXES` 拒绝 → **Schema 登记过的叶子路径默认可写**。覆盖表是
  「黑名单内的显式放行 + 可写面清单」，**不是白名单**：新增安全敏感分组必须**显式进黑名单**，
  只「不登记进覆盖表」挡不住——要新增「Agent 可写的设置路径」先改该表，
  再同步 `set_setting` 的工具 description 与 systemPrompt 的 settingsHint。
  v9 起 `todo_write` / `todo_read` / `task` 由 `registerAgentCoreTools` 注册（见 docs/06 §18 / §19），
  同样**不受 `agent.tools.enabled` 门控**。
- **主界面 `chat` 窗口是 1120×720、`alwaysOnTop=false` 的常驻大窗**（三栏布局 + 右栏模式感知，
  关闭仍 = 隐藏），别按旧版 420×640 侧弹交互窗的心智模型理解它的几何、层级与探针坐标。
- **右栏已 Tab 化（2026-10-03，docs/07 §2.3）**：「文件 / 终端 / 浏览器 / 上下文」四个 tab，
  既有 JobPanel + ContextPanel 收在**缺省的「上下文」tab**（旧探针因此零改动）；宽度 384px
  缺省、可拖拽（localStorage `aurora.chat.ctxWidth`，不进 config schema）。**左栏同样可拖拽**
  （`aurora.chat.navWidth`，240px 缺省 / 200–420；`--nav-w` 是 SessionNav 内容宽的唯一来源，
  与右栏共用 `startColumnResize`）。四个易踩点：
  ① 右栏宽度变量 `--ctx-w` 是 JobPanel / ContextPanel 固定宽的唯一来源，改宽度口径别再回
  硬编码 264px；② `webviewTag` 只对 chat 窗口开启（BrowserPanel 用 `createElement('webview')`
  绕开 Vue 编译器，重挂载会重载页面——这是已知取舍不是 bug）；③ `@lydell/node-pty` 必须
  留在 electron-builder 的 `asarUnpack`（.node 不能进 asar），终端是用户手动操作面，
  **别给它接 AI 工具面或确认闸门**（`show_preview` 走的是浏览器 tab，不是终端）；
  ④ **`onHeadersReceived` 的 CSP 注入必须只作用于自家窗口的页面**（按
  `details.webContentsId` 是否属于 `BrowserWindow.getAllWindows()` 判定，2026-10-03 修）：
  无条件注入会把 webview 里加载的外部页面一起打瘸（强加 `script-src 'self'` → 内联脚本 /
  CDN 资源全被拒），症状是「内置浏览器白屏、浏览器里点链接没反应」——别把它"简化"回无条件注入。
- **终端底色是固定黑（2026-10-03 用户口径）**：`TerminalPanel` 里就一份 `XTERM_THEME`
  （`background: '#000000'`）与 `.tp-host { background: #000 }`，**不要再按
  `prefers-color-scheme` 分两档**（浅色系统下白底黑字正是被用户点名的问题）。
  `.xterm` 元素本身是透明的（xterm 把主题背景画进 canvas），判据取容器 + `.xterm-viewport`。
- **文件 tab 是「小文件管理器 + 预览」（2026-10-03，docs/07 §2.3）**：根 = 会话边界根
  （绑了项目就是项目文件夹，标签「项目：<名>」；孤儿绑定按未绑定展示）——列目录走
  `preview:list`（`main/file-list.ts`，上限 500 条、目录在前、名称数字感知排序），
  预览走 `preview:read`，两条都在主进程侧做 `resolveWithin` 边界校验，**根不可用时直接拒绝**。
  `show_preview` 的「成果展示」走浏览器 tab（`preview:show` 推送 → 自动切 tab），
  别把两件事混成同一条通道。
- **输入卡有两条硬口径（2026-09-29 减负轮，docs/07 §2.3），别再改回去**：
  ① 权限 / 模型 / 思考三枚控件一律 `--control-h-xs`（28px）+ pill 圆角 + **静止态零边框**
  （悬停才浮 `--fill-2`），三者的尺寸与状态样式**逐字对齐** —— 40px + 逐枚边框会把输入卡
  顶成一条设置工具栏；② 占位文案只留一句（`输入消息…`），键位提示挂工具行右侧的
  `.composer-hint` —— textarea 的高度由**内容**决定（空内容 = 一行），占位串一旦换行，
  第二行就看不见了（用户实测「文字超出组件」的成因）。
- **改了 `packages/shared/src/**` 或 `packages/agent-core/src/**` 之后必须先 build 那个包再跑下游 typecheck**：
  两个包的 `types` 都指向 `dist/*.d.ts`，不重建的话 `apps/desktop` 会对着**旧类型**报错 ——
  常见症状是共享包「no exported member」、agent-core 新加的方法在 `main/ipc.ts` 里报
  `TS2339 Property 'xxx' does not exist on type 'SessionStore'`（看着像自己写错了，其实只是没编译）。
  命令：`pnpm --filter @aurora/shared build` / `pnpm --filter @aurora/agent-core build`。
- **Aurora Center（docs/12，v16）的四处坑**：
  ① `packages/center` 的 CLI `start` 必须**常驻**（`await` 信号后才 return）——
  bin 启动器在 `runCli` 返回后 `process.exit`，写成"注册完信号处理器就 return"服务器会秒退；
  ② `ws` 库**手动** `handleUpgrade` 时回调**替代**了 `'connection'` 事件
  （库内只有自动挂 upgrade 监听的那条路径会 emit），服务器端客户端握手是
  `beginClientSession(ws, token)` 直调，别改成依赖 `clientWss.on('connection')`；
  ③ `center.token` 是凭据路径（`center.token` ⇄ `center.tokenEnc`），与 apiKey 同款
  5 处同步；`center.*` 整组在 `SETTINGS_READONLY_PREFIXES`（连接目标是外发通道），
  但 Center 的**远程配置**走 `main/center/remote-control.ts` 的独立白名单
  （`CENTER_REMOTE_CONFIG_PREFIXES`），两条通道语义不同别混改；
  ④ 远程补丁应用前必须先在 `structuredClone` 副本上演练——`SettingsStore.mutate`
  的 draft 是**活对象**，失败半写会污染内存态。
  ⑤（2026-09 扩展轮）确认卡网页批复：**只有 `center-` 前缀会话**的敏感工具确认会经
  connector 推 Center（`confirm.request`），网页批复下发 `confirm.resolve` 命令最终调
  `proactive.resolve`（对已结算 confirmId 幂等，本地卡与网页卡先到先得）；v0.2.4 起
  `center_send_file` 直接发送不产生确认卡，本地会话不再有推网页端的确认；
  设备授权登录
  （`center:deviceLogin` IPC）与账号密码直登的**凭据落库路径共用同一函数**，改落库只改一处；
  上传文件 24h TTL 清理在 `packages/center/src/files.ts`（启动 + 每 15 分钟一轮）。
- **提问卡中转（`ask_user`，v0.3.3，docs/12 §5）**：Agent 向用户提问时，本地卡片之外经
  `ask.request` 上行到 Center（网页端渲染提问卡）、网页作答经 `ask.resolve` 下行回
  `AskUserService.resolve`，与本地卡**先到先得**（幂等，回执 `{ settled }`）。三条口径别改错：
  ① 只有 `center-` 前缀会话上行，且受 `center.allowRemoteSession` 闸门约束（比确认卡更严：
  关掉时连卡片都不推、也拒绝网页作答）；② `ask.resolve` 的 `requestId` 是**提问卡自身的 id**
  （客户端分配），不是网页端生成的命令 id —— 与其它命令的约定相反，改协议时别顺手“统一”；
  ③ 服务器为提问卡保留 `pendingAsks` 并在网页**新连上时回放未过期项**（180s 窗口，不回放会让
  刷新一下页永远答不上）；**确认卡没有这条回放**（60s 窗口，属既有行为），别把两者抄成一样。
  装配逻辑抽在 `main/center/ask-relay.ts`（纯函数、有单测）；把三层串起来的真端到端在
  `main/center/ask-relay.e2e.test.ts`（真服务器 + 真连接器 + 真 AskUserService，跑在 vitest 里，
  不需要 Electron —— 所以 `apps/desktop` 有一个**仅测试用**的 `@aurora/center` devDependency）。
- **Center 部署要「先构建、再打镜像」（docs/12 §10 / `packages/center/deploy/README.md`）**：
  `deploy/Dockerfile` 只 `COPY dist-web`，镜像里不跑构建 —— 忘了先在构建机执行
  `pnpm --filter @aurora/center build` 就会把一个**旧前端**打进镜像（症状正是「客户端配了语音，
  网页上没有麦克风/朗读按钮」：那段 UI 是 v0.3.2 才有的）。`docker-compose.yml` 的镜像 tag
  也要跟着版本号走（本轮从 `0.3.0` 提到当前版本），别在同一 tag 上反复覆盖 —— 排障时说不清
  线上到底是哪一版。
- **远程会话与本地发送是同一条链**：Center 的 `session.input` → `SessionBridge` →
  `agent.send({ origin: 'center' })`（`SendMessageRequest.origin` 已放宽）。
  只转发 `center-` 前缀会话的事件；别在别处再写一条"远程专用"发送通路。
- **会话级项目的解析唯一口径**（2026-09，v0.2.4 加模式级一级，docs/06 §5.1）：
  `main/tools/session-project.ts` 的
  `createSessionProjectResolver` —— 回落链是**会话绑定项目（`SessionMeta.projectId`）>
  会话空间目录（Agent → `桌面\Aurora`，Work → 模式工作目录）> 激活模式目录 >
  `agent.tools.workspaceDir` > 主目录**（全局 `projects.current` 一级已于 v25 **整体退役**：
  字段随 v24→v25 迁移删除、设置页「设为当前」与左栏「当前」徽标已删、
  `openPath kind:'project'` 已删 —— 别再把「当前项目」当回落位或入口加回来）；
  工具缺省 cwd / 搜索根、file-port 边界、confirmTool 的 auto 档根内免确认与 confirm 档
  根内写免确认、AGENTS.md 指令注入**全部按会话现解析**
  （getter 注入，同 `agent.loop` 上限套路）。不要在执行链上再写第二套项目根解析，
  也别把会话项目塞回全局设置或 CONFIG_VERSION 迁移链（它是会话数据）。
  Work 模式的 systemPrompt 描述的就是这条链（docs/05 §4.1）——别在提示词里另立「工作目录」口径。
  **子代理（task，docs/06 §19.2）**：工具执行链的取值经 `adaptForSubagent` 视图 ——
  缺省 cwd / 搜索根 / 边界根用 `parentSessionIdOf` 把 `-sub` 剥回**父会话**再解析
  （2026-10-02 修复：此前恒落 Agent 空间）；todo 清单等状态隔离仍按 `-sub`，别整体换 id。
- **SkillsService 的目录监听**（`startWatching`）：改 `skills.userDir` 走 `reconfigure`
  时会 `rearmWatcher`，新增监听路径时记得同样处理；create-skill 技能写文件后
  依赖这个监听自动重扫，没有任何"刷新"仪式。

- **自动化引擎（`main/automation/engine.ts`）的三处接线要点（docs/13 §3）**：
  ① 事件订阅在**构造期**建立（不是 `start()`）—— 否则「构造完成 → start() 之间」落下的
  `done` / `error` 会让历史永远停在 `running`（引擎只对 Agent 模式的运行做事件驱动收尾）；
  ② `firedKeys` **按自动化隔离**（两条内置共用同一个 `lessonKey`，共用一个集合会互相挡），
  条目 48h TTL（`lessonKey` 每周重复，不 TTL 会误挡下周同一节课）；
  ③ **手动触发与定时触发必须走同一条分派**（`runDefinition`）—— Agent 模式的定义没有
  `actions`，`runNow` 若只执行操作组件会落一条永远「进行中」的历史且从不调用 Agent
  （v0.2.5 的 smoke 实测就是这个症状，回归护栏在 `engine.test.ts`）。
  另注意：**引擎在 bootstrap 时就启动并首读 store**（in-flight 缓存），所以自测夹具在启动后
  写盘时必须调 `automationEngine.reload()` 重读 —— capture 的 `seedAutomationFixture` 就是这么用的。
- **`AgentEvent` 里 `auto-` 会话的确认卡走既有确认链**：无人值守时 60s 超时按拒绝处理；
  自动化**没有自己的权限体系**，也**不应用勿扰时段**（勿扰只门控内置自动化 / 既有课前提醒）。
  给自动化会话免打扰的正路是把权限档设为 `auto` 或在会话里点「本会话都允许」，
  **不要**为自动化新增静默放行通道。
- **capture / smoke 的探针改配置时注意两个缓存**：`SettingsStore.init()` 启动即把 `config.json`
  读进内存并长期缓存 —— 启动后**写文件对运行中的进程无效**，改配置只能走 `settings:update` IPC；
  而 `SessionStore` 是按会话**惰性**读盘且首次读即缓存，种会话文件必须赶在窗口第一次
  `chat:history` **之前**（`runCapture` 里、`captureWindows` 之前）。两者时机相反，容易搞混。
- **`capture.ts` 里那些探针是 template literal 字符串**：字符串**内部**的注释写反引号 `` ` ``
  会提前终止字符串，直接 `TS1005` 且报错位置极具误导性。写注释用「」或单引号。
  2026-10-01 追加：**反斜杠也要多写一层**——探针里本意是 JS 的 `/\s+/`、`/^\+/`，
  文件里少了那一层，模板层会把 `\+` 吃成 `+`，渲染层收到**非法正则 `/^+/`**；
  而这类错**不报在解析期**（`tsc` 与 `capture.probe-strings.test.ts` 的第二条都看不见，
  TS 不校验正则 pattern），只在 V8 编译那段脚本时炸成报告里一句无信息量的
  「Script failed to execute」——本轮在这上面白跑了两轮截图。
  现在有第三条护栏（同样在 `capture.probe-strings.test.ts`）把模板层 cook 过的文本
  交给 `new Function` 编译，能带行号指出非法正则；**写探针时不想数层数就别用带反斜杠的正则**。
