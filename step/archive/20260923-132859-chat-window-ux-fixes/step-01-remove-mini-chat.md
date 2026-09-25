# Step 01 — 删除独立小窗，「收起」改为直接消失，快速会话并入交互窗侧栏

- Task: chat-window-ux-fixes
- Step: 1 / 8
- Status: done
- Depends on: none
- Produces: `mini-chat` 窗口从全仓消失；`chat:send` 的会话来源改为显式 `context`；交互窗侧栏具备「快速会话 / 会话列表」双栏；配置迁移 v5 → v6

## 目标

用户问题 1 与问题 1 的后半句落地：交互窗点「收起」= 窗口直接隐藏（不再弹出小窗）；
「快速对话」作为侧栏里的一个栏目，与历史会话列表并列。

## 输入

先读这些文件，不要凭记忆改：

- `apps/desktop/src/renderer/chat/App.vue`（`close()` 在 131-134 行；侧栏在 200-221 行）
- `apps/desktop/src/renderer/edge-bar/App.vue`（面板按钮在 296-327 行，注释里的「4 个入口」在 8、9 行）
- `apps/desktop/src/renderer/shared/composables/useChat.ts`（`sessionIdFor` 在 38-42 行）
- `packages/shared/src/config/schema.ts:20`（`WINDOW_NAMES`）、`packages/shared/src/ipc/types.ts:172,177`
- `packages/shared/src/mode/windowState.ts`（整个文件 56 行，全是主窗口互斥逻辑）
- `packages/shared/src/config/migrations.ts:206-212`（`MIGRATIONS` 数组）与 `:128-140`（v3 → v4 的删除先例，照它的写法）
- `apps/desktop/src/main/window-manager.ts`（`SPECS` 在 52-103 行、`showMiniChat` 在 327-331 行、`titleFor` 在 621-630 行）
- `apps/desktop/src/main/smoke.ts:291-297`、`apps/desktop/src/main/capture.ts:587`、`:216-252`

## 操作

### 1. 数据契约层（`packages/shared`）

1. `packages/shared/src/config/schema.ts`
   - `WINDOW_NAMES` 删掉 `'mini-chat'`，变成 `['edge-bar', 'chat', 'settings', 'onboarding'] as const`。
   - `packages/shared/src/config/migrations.ts`
     - `CONFIG_VERSION` 导出在 `schema.ts:9`，从 `5` 改为 `6`。
     - 新增 `migrateV5ToV6`（`from: 5, to: 6`，`describe: "v5 → v6：移除 general.windowState['mini-chat']（独立小窗已删除）"`），
       实现照抄 `migrateV3ToV4` 的 `delete windowState['service-dock']` 写法，改成删 `'mini-chat'`，
       并把 `next['version'] = 6`。追加进 `MIGRATIONS` 数组**末尾**。
       - 为什么必须做：`general.windowState` 是 `z.record`，多一个 `mini-chat` 键不会让 Schema 校验失败，
         它会作为死数据永久留在用户配置里；v3 → v4 删除 `service-dock` 已经立了这个先例。
2. `packages/shared/src/ipc/types.ts`
   - 删掉 `export type PrimaryWindow = 'mini-chat' | 'chat'`，`WindowState.primary` 的类型改为
     `'chat' | null`（保留 `primary` 字段本身，别顺手删——`smoke.ts` / `capture.ts` 与渲染层都在读它）。
3. `packages/shared/src/ipc/channels.ts`
   - 删掉 `window.showMiniChat`。**必须同步删掉** `apps/desktop/src/preload/channels.ts:31` 附近的同名字面量
     （两文件有编译期双向断言，漏一处 `pnpm typecheck` 就会报错，见 AGENTS.md 硬约束 2）。
4. `packages/shared/src/mode/windowState.ts`
   - 删掉 `PrimaryWindow` 导入、`enforceExclusivity()`，`showWindow` 不再有主窗口分支
     （`chat` 走普通 `withVisible` 即可）。
   - `isPrimaryWindow()` 改为只认 `'chat'`；保留导出（`listVisible` 与既有测试还在用）。
   - 文件头注释里的「迷你窗与交互窗同屏互斥」改成「交互窗是唯一主对话窗口」。
5. `packages/shared/src/mode/windowState.test.ts`
   - 删掉所有 `'mini-chat'` 断言；把互斥那组测试改写成「只有 chat 参与主窗口判定」：
     `showWindow(createInitialWindowState(), 'chat')` 后 `state.primary === 'chat'`；
     `hideWindow(..., 'chat')` 后 `state.primary === null`。
   - `isPrimaryWindow('settings') === false` 这条保留，另加 `isPrimaryWindow('chat') === true`、`isPrimaryWindow('edge-bar') === false`。
6. `packages/shared/src/config/migrations.test.ts`
   - 新增一条 v5 → v6 的用例：给一份带 `general.windowState['mini-chat']` 的 v5 配置，
     迁移后该键消失、`chat` / `settings` 的几何**原样保留**、`version === 6`。
   - 顶端如果写死了 `CONFIG_VERSION` 或 `5`，一并更新到 6。

### 2. 主进程（`apps/desktop/src/main`）

7. `window-manager.ts`
   - `SPECS` 删掉 `'mini-chat'` 条目。
   - 删掉 `showMiniChat()` 方法、`computeBounds` 里 `'anchor-dock'` 分支、
     `bottomRightBounds()`（只为 mini-chat 与它的兜底存在）、`anchorToEdgeBar()`，
     以及 `WindowSpec.place` 的 `'anchor-dock'` 取值——删完 `screen` 导入若仍被 `place: 'edge'` 与
     `readGeometry` 使用则保留，用 `pnpm typecheck` 判定。
   - `titleFor()` 删掉 `'mini-chat'` 行。
   - `emit()` / `onStateChanged` / `getSnapshot` 等不要动。
8. `ipc.ts`
   - 删掉 `handle<WindowState>(IPC.window.showMiniChat, ...)`（287 行附近）。
9. `smoke.ts`
   - 删掉 `window.showMiniChat` 之后的「迷你窗可见且 primary=mini-chat」与「交互窗与迷你窗互斥」两条断言。
   - 替换为一条新断言，名字写清行为：`window.showChat` 后 `state.visible['chat'] === true && state.primary === 'chat'`，
     然后 `window.hide('chat')` 后 `state.visible['chat'] !== true && state.primary === null`。
   - **不要**在 smoke 里断言「收起按钮」的 DOM 行为——那是 capture 探针的活（见第 12 条）。

### 3. 渲染层（`apps/desktop/src/renderer`）

10. `shared/composables/useChat.ts`
    - 把 `sessionIdFor(windowName)` 换成显式的会话上下文参数，因为 `edge-bar` 需要读「快速会话」而它不再是窗口：

      ```ts
      /** 对话上下文（原为窗口名映射；mini-chat 删除后改为显式声明，会话 id 保持不变） */
      export type ChatContext = 'main' | 'quick' | 'settings'
      export function useChat(windowName: WindowName, context: ChatContext): ...
      ```

      `context === 'quick'` → `sessionId = 'quick'`，`'main'` → `'main'`，`'settings'` → `'settings'`。
      仍把 `windowName` 存下来作为 `chat:send` 的 `origin`（`SendMessageRequest.origin` 类型是 `WindowName`，别改契约）。
    - 新增一个供侧栏用的只读能力：`async function loadQuickPreview(): Promise<ChatMessageDto[]>`，
      内部走 `window.aurora.chat.history({ sessionId: 'quick', limit: 5 })`，**不碰 `sessionId` / `messages`**。
      调用方（交互窗）自己决定怎么渲染，避免把 quick 的历史塞进当前会话的消息流。
11. 删除 `apps/desktop/src/renderer/mini-chat/` 整个目录（`App.vue` / `index.html` / `main.ts`）。
    同时检查 `electron.vite.config.ts` 与 `apps/desktop/package.json`：若渲染层入口是显式列出的，删掉 `mini-chat` 那一项。
12. `chat/App.vue` —— 本步最主要的一处改动
    - `const chat = useChat('chat', 'main')`。
    - **「收起」按钮（187 行）改为 `@click="windowStore.hide('chat')"`**，删掉原来的 `close()` 函数
      （它正是「收起 = 打开快速对话」这个 bug 的实现）。按钮文案保持「收起」，
      并给它 `title="收起对话窗口（对话仍在后台继续）"`。
    - 侧栏（200-221 行）重做成双栏：新增 `const sidebarTab = ref<'quick' | 'sessions'>('sessions')`，
      侧栏顶部放两个 tab 按钮（「快速」「会话」），下面按 tab 渲染：
      - `'quick'`：显示 `loadQuickPreview()` 取到的最近 5 条（角色 + 截断正文），
        底部一个主按钮「继续快速对话」→ `await switchSession('quick')` 并把 `sidebarTab` 保持不动。
      - `'sessions'`：就是现在的会话列表（切换 / 当前项高亮），`newSession()` 按钮保留。
    - 头部的「历史」按钮改成切换 `showSidebar`（原来叫 `showHistory`），默认 `false`。
    - `onMounted` 里在 `hydrate()` 之后调一次 `loadQuickPreview()`，让「快速」栏一打开就有内容。
    - 「收起」按钮的行为要在代码注释里点明：**收起只隐藏窗口，正在进行的流式回复不会被 abort**
      （`hide()` 不触碰 `chat:abort`；这是有意为之，见 docs/02 §2.2「关闭 = 隐藏」）。
13. `edge-bar/App.vue`
    - `const chat = useChat('edge-bar', 'quick')`。
    - 面板操作区由 4 个入口减为 3 个：删掉「小窗对话」按钮与 `openMiniChat()`，
      保留「打开对话窗口 / 设置 / 隐藏提示条」。
    - 文件头注释第 8、9 行的「四个操作按钮」改为「三个操作按钮」，并说明快速会话已并入交互窗侧栏。
    - 「最近消息」卡片文案「点「小窗对话」开始」改为「点「打开对话窗口」开始」。

### 4. 截图/自测工具（`apps/desktop/src/main/capture.ts`）

14. `EDGE_BAR_PANEL_SCRIPT`（222-257 行）
    - `buttons.length === 4` 改为 `buttons.length === 3`；`pass` 里对应条件同步改。
15. `defaultCapturePlan`（576-654 行）
    - 删掉 `{ name: 'mini-chat', file: 'mini-chat.png', check: CHAT_AUTO_SCROLL_SCRIPT }` 这一条。
    - 新增一条交互窗探针场景，钉住本次修复的行为：

      ```ts
      { name: 'chat', file: 'chat-collapse.png', act: CHAT_COLLAPSE_ACT, check: CHAT_COLLAPSE_CHECK }
      ```

      新增两个脚本常量（放在 `CHAT_AUTO_SCROLL_SCRIPT` 附近）：
      - `CHAT_COLLAPSE_ACT`：在交互窗里找到 `.head-actions` 里文本为「收起」的按钮并 `.click()`，
        等 400ms，然后 `return { clicked: true }`。
      - `CHAT_COLLAPSE_CHECK`：`await window.aurora.window.getState()`，
        `pass` 条件为 `visible['chat'] !== true && primary === null`，并把整个 state 放进返回值便于排查。
    - 文件头注释（572-575 行）里「五个窗口」改为「四个窗口」，并说明小窗已删除。

### 5. 文档（与代码同一步改，否则验收对不上）

16. 逐处改正（先 `Select-String -Path docs -Pattern 'mini-chat|迷你窗|小窗'` 把所有命中捞出来，一条条消掉）：
    - `docs/02-architecture.md:102,124`：目录树里的 `mini-chat` 去掉；「交互窗 / 小窗输入」改为「交互窗输入」。
    - `docs/06-agent-core.md:40-41`：会话划分改为「快速会话（交互窗侧栏「快速」栏）× 1，完整会话 × 1」，
      并写明「快速会话与完整交互窗共用同一个窗口，靠侧栏切换」。
    - `docs/07-ui-spec.md`
      - §2.4「小 AI 交互窗口（Mini Chat）」整节删除；§2.3 里补一小节说明「收起 = 隐藏；侧栏含「快速 / 会话」双栏」。
      - `:19` 面板入口列表删掉「小窗对话」；`:51`「小窗（2.4）同样支持拖拽」删掉。
      - `:133-141` §3 窗口间状态机：删掉「面板 → 小窗对话 → 展开到交互窗」这条路径与 `mini-chat` 互斥规则，
        改成「提示条面板 → 打开对话窗口（唯一主对话窗口）」。
      - `:200,216,217` §5.3 截图清单：小窗截图去掉，改成新的 `chat-collapse.png` 场景。
    - `docs/08-settings-onboarding.md:15,81`：`WINDOW_NAMES` 的 key 集合删掉 `mini-chat`，版本号相关描述若有 v5 改成 v6。
    - `docs/10-user-guide.md:67,77`：表格里「小 AI 交互窗」那行删掉，「小窗对话」的入口说明改成侧栏「快速」栏。
    - `docs/README.md:68`：窗口体系描述里的「小窗」去掉。
    - `docs/04-roadmap.md`：**:17、:33、:86、:90、:96、:339** 是历史记录性的陈述，**不要改历史条目**；
      只在文件顶部或对应阶段的「已完成」表里加一行本轮变更说明（例如 P2 行后加注「小窗已于 v1.0 轮次删除，
      快速会话并入交互窗侧栏」）。改历史正文会让 roadmap 失去「当时做了什么」的语义。

### 6. 收尾

17. 全仓搜一遍，确认没有残留引用才能进下一步。

    用 grep 工具搜 `mini-chat|miniChat|showMiniChat|小窗|迷你窗`，命中范围应只剩：
    `docs/04-roadmap.md` 的历史条目、`step/` 下的本计划文件、`step/archive/` 下的历史归档。
    任何 `src/` 或 `scripts/` 下的命中都必须处理掉。

## 验收标准

- [ ] `node node_modules/typescript/bin/tsc -p packages/shared/tsconfig.json --noEmit` 退出码 0
- [ ] `node node_modules/typescript/bin/tsc -p packages/agent-core/tsconfig.json --noEmit` 退出码 0
- [ ] `node node_modules/typescript/bin/tsc -p packages/modes/tsconfig.json --noEmit` 退出码 0
- [ ] `node node_modules/typescript/bin/tsc -p apps/desktop/tsconfig.node.json --noEmit` 退出码 0
- [ ] `node apps/desktop/node_modules/vue-tsc/bin/vue-tsc.js -p apps/desktop/tsconfig.web.json --noEmit` 退出码 0- [ ] `node node_modules/vitest/vitest.mjs run packages/shared/src/mode/windowState.test.ts packages/shared/src/config/migrations.test.ts packages/shared/src/config/store.test.ts packages/shared/src/config/schema.test.ts` 全绿
- [ ] 全局搜索 `mini-chat`，`src/` 与 `scripts/` 下 0 命中；`WINDOW_NAMES` 里没有 `mini-chat`（用 `Select-String` 或 grep 工具确认）
- [ ] `apps/desktop/src/renderer/mini-chat/` 目录已不存在
- [ ] `apps/desktop/src/renderer/chat/App.vue` 里 `grep '收起'` 命中的按钮绑的是 `windowStore.hide('chat')`，
      且文件里不再出现 `showMiniChat`
- [ ] `CONFIG_VERSION === 6` 且 `MIGRATIONS` 最后一项是 `migrateV5ToV6`

## 交接

- 给下一步（step 2）留的口径：`WINDOW_NAMES` 只剩 4 项；`WindowName` 类型不含 `'mini-chat'`；
  `useChat(windowName, context)` 是新签名（step 3、5 都要用）。
- 给 step 6 留的口径：`chat-collapse.png` 场景与 `CHAT_COLLAPSE_ACT/CHECK` 已存在，
  `EDGE_BAR_PANEL_SCRIPT` 的按钮数已改为 3。
- 待确认项：若 `electron.vite.config.ts` 里渲染入口是 glob 自动发现的，则第 11 条里「删入口配置」这半句不适用——
  以 `pnpm build` 是否仍能产出 4 个 HTML 为准。

## 执行记录

- 执行时间：2026-09-22（执行会话）；状态：**done**
- 基线：`1781d7d`；本步提交：`37bcb84`（refactor(chat): 删除独立小窗，「收起」改为直接隐藏，快速会话并入交互窗侧栏；40 文件）。

### 分片与结果（并行派发，写范围互不重叠）

| 分片 | 负责文件 | 结果 |
|---|---|---|
| **Lead · 共享契约** | `packages/shared/src/{config/schema.ts, config/migrations.ts, config/migrations.test.ts, ipc/types.ts, ipc/channels.ts, mode/windowState.ts, mode/windowState.test.ts, mode/types.ts}`、`packages/modes/src/{classroom,guide-runner,manager}.test.ts`、`apps/desktop/src/preload/{channels.ts,index.ts}` | `WINDOW_NAMES` 4 项；`PrimaryWindow` 删除、`primary: 'chat' \| null`；`IPC.window.showMiniChat` 与 preload 字面量同步删除；`ModeWindowPort.showMiniChat` 删除（3 个 modes 测试 mock 同步）；新增 `migrateV5ToV6`、`CONFIG_VERSION = 6` |
| **子代理 A · 渲染层** | `useChat.ts` / `stores.ts` / `chat/App.vue` / `edge-bar/App.vue` / `MessageList.vue` / `useStickToBottom.ts` / `bootstrap.ts` / `electron.vite.config.ts` / 删除 `renderer/mini-chat/` | `useChat(windowName, context)` + `ChatContext` + `loadQuickPreview()`；收起 → `windowStore.hide('chat')`，`close()` 删除；侧栏「快速 / 会话」双栏；面板 4→3 入口；`compact` prop 随小窗唯一调用方一起删除 |
| **子代理 B · 主进程** | `window-manager.ts` / `ipc.ts` / `smoke.ts` / `contracts.ts` / `index.ts` | SPECS 删 `mini-chat`；删 `showMiniChat()`、`computeBounds` 的 `anchor-dock` 分支、`bottomRightBounds()`、`existingWindow()`、`anchorToEdgeBar()`、`titleFor` 条目；smoke 两条旧断言 → 一条「showChat 后 chat 可见且 primary=chat」 |
| **子代理 C · 截图工具** | `capture.ts` | 删 `mini-chat.png` 场景；`EDGE_BAR_PANEL_SCRIPT` 4→3 按钮；新增「收起即消失」探针；头注释「五个窗口」→四个 |
| **子代理 D · 文档** | `docs/{01,02,04,06,07,08,10,README}.md`、`README.md`、`AGENTS.md` | 小窗从窗口体系/入口/会话划分/状态机/截图清单里消掉；配置版本 v5→v6；roadmap 只追加变更记录，历史条目逐字未改 |
| **Lead · 集成修正** | `docs/01-overview.md`、`main/index.ts`（两处注释）、`capture.ts` + `docs/07 §5.3`（探针重构） | 补齐白名单外的过期条目；修掉原计划里一个会让 `AURORA_CAPTURE` 卡死的设计缺陷（见下） |

### ⚠️ 与原计划的偏差（实测后修正，不是实现走样）

原 §4.15 要求「`CHAT_COLLAPSE_ACT` 在 `act` 里点收起，`CHAT_COLLAPSE_CHECK` 断言」。
**实测证明这个设计会让整轮截图卡死**：`act` 在截图**之前**执行，窗口被 `hide()` 之后紧接着的
`capturePage()` 在 Windows 上**永不返回**——实跑 8 分钟无进展、不写 `report.json`、进程不退出，只能强杀 Electron。

改为：该场景**不设 `act`**，点击写进 `CHAT_COLLAPSE_CHECK`（截图先发生；点击 → Vue handler → IPC → 主进程 hide
的因果链不变，仍在同一条 check 内完成），并给 `getState()` 加 4s 超时兜底。`CHAT_COLLAPSE_ACT` 已删除。
代价：`chat-collapse.png` 拍到的是**点之前**的交互窗（含「收起」按钮），「收起后窗口消失」由探针 `pass` 负责；
`docs/07 §5.3` 已按这个口径写明，避免后人以为截图能证明收起。

另一处偏差：`migrateV5ToV6` **只在该 key 存在时改写** `general.windowState`（不照抄 v3→v4 的「无条件补空对象」），
否则会把 v4→v5 用例里「迁移不碰 general」的既有断言变成假话，也会给没有窗口几何的配置凭空造出空对象。已在迁移注释里写明原因。

### 验收（Lead 亲自复跑，非子代理结论）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 退出码 0（4 个 workspace 全过） |
| `pnpm test` | ✅ 48 文件 / 681 用例全绿 |
| `pnpm build` | ✅ 退出码 0；`out/renderer` 只剩 `chat/ edge-bar/ onboarding/ settings/` 四个 HTML 入口，无 `mini-chat` |
| `pnpm format:check` / `pnpm lint` | ✅ 均通过 |
| `AURORA_CAPTURE=<tmp> AURORA_CAPTURE_WINDOWS='chat,edge-bar' pnpm dev` | ✅ 退出码 0；`chat-collapse` 探针 `pass:true`（`chatVisible:false, primary:null`，整份 state 已回传）；`edge-bar-expanded` 面板探针 `buttonCount:3, pass:true`；6 张 PNG + `report.json`；**无 `mini-chat.png`** |
| grep `mini-chat\|miniChat\|showMiniChat`（`apps/**`、`packages/**`、`scripts/**`） | ✅ 0 命中 |
| `CONFIG_VERSION === 6` 且 `MIGRATIONS` 末项为 `migrateV5ToV6` | ✅ 确认 |
| `renderer/mini-chat/` 目录 | ✅ 已不存在 |
| `chat/App.vue` 的「收起」 | ✅ 绑 `windowStore.hide('chat')`，文件内无 `showMiniChat` |

### 遗留 / 已知

- `WindowManager.get primary()` 保留但已无消费方（`capture` / `smoke` 读的是 `getState().primary`）；删除属范围外，未动。
- `computeBounds` 的 `switch` 由 `default` 承接 `'center'`，未改成显式 `case`（风格问题，未动）。
- `docs/04-roadmap.md` 的正文里仍保留「小窗」字样，那是历史阶段记录，按计划**故意不改**。
- 本仓库 `step/` 目录整体未被 git 跟踪（历史归档同样如此），因此执行记录只落本地文件，不随提交入库。
