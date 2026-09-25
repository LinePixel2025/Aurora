# Step 03 — 对话窗思考等级选择器

- Task: chat-window-ux-fixes
- Step: 3 / 8
- Status: done
- Depends on: step 1
- Produces: 交互窗输入区旁的「思考等级」下拉，读写当前生效 provider 的 `llm.providers.<active>.reasoningEffort`；一条新的 capture 探针

## 目标

用户问题 3 落地：对话窗口里能直接看到并调节 AI 思考等级，改完立即对下一次请求生效，无需进设置页。

## 背景事实（拆解时已核实）

- 数据链路已全通，**本步不需要改动任何主进程 / 内核代码**：
  `LlmPage.vue` 保存 `reasoningEffort` → `settings:update` → `llm.providers.<id>.reasoningEffort` →
  `createProviderFactory()`（`apps/desktop/src/main/agent-host.ts:163-186`）把 `'auto'` 映射成 `undefined`、
  其余原样透传 → `runAgentLoop` → 请求体 `reasoning_effort`。
- 已有先例可抄：`apps/desktop/src/renderer/shared/stores.ts` 的 `useSettingsStore.update()` 负责
  `deepClone(patch)` + IPC + 错误回填；`LlmPage.vue:350-361` 是同一个字段的现有 UI。
- 用户已确认：**不做按会话覆盖**，这个按钮改的就是配置里的当前值（单一事实来源）。
- `REASONING_EFFORT_LEVELS` 已从 `@aurora/shared/browser` 导出（`DEFAULT_REASONING_EFFORT` 已在
  `LlmPage.vue` 用过）。渲染层取值**必须**走 `@aurora/shared/browser`，否则会把 `node:fs` 拉进浏览器 bundle
  导致构建失败（AGENTS.md 硬约束 4）。

## 输入

- `apps/desktop/src/renderer/chat/App.vue`（step 1 改过；输入区 `.composer-bar` 在 278-296 行附近）
- `apps/desktop/src/renderer/settings/pages/LlmPage.vue:350-361`（现有下拉的 option 文案）
- `apps/desktop/src/renderer/shared/stores.ts`（`update()` / `settings` / `activeProvider`）
- `packages/shared/src/config/schema.ts:72-74`（`REASONING_EFFORT_LEVELS` / `ReasoningEffortSchema`）
- `apps/desktop/src/main/capture.ts`（`SETTINGS_LLM_EFFORT_ACT/CHECK` 在 506-569 行，照抄风格）

## 操作

### 1. 渲染层

1. 在 `apps/desktop/src/renderer/shared/components/` 下新建 `ThinkingLevelSelect.vue`：
   - props：`modelValue: ReasoningEffortLevel`、`disabled?: boolean`、`title?: string`。
   - emits：`update:modelValue`。
   - 渲染一个紧凑的 `<select class="input thinking-level">`，四个 option 与 `LlmPage.vue` 完全同文案：
     `auto（不指定，兼容性最好）` / `low（更快）` / `medium` / `high（更深入）`。
   - 尺寸要求：高度 ≤ 24px、宽度自适应（约 96px），能在 420px 宽的交互窗输入区里与发送按钮同行放下；
     `flex: 0 0 auto`，不参与 `.meta` 的压缩。
   - 必须带 `data-field="chat.reasoningEffort"`：这是 capture 探针与将来 UI 断言唯一稳定的抓手
     （不要用 class 名当断言点）。
2. 在 `apps/desktop/src/renderer/chat/App.vue` 里接线：
   - `import { REASONING_EFFORT_LEVELS, type ReasoningEffortLevel } from '@aurora/shared/browser'`。
   - 计算当前值：

     ```ts
     /** 当前生效 provider（无 provider 时为空串） */
     const activeProviderId = computed(() => settingsStore.settings?.llm.active ?? '')
     const effort = computed<ReasoningEffortLevel | null>(() => {
       const settings = settingsStore.settings
       if (!settings) return null
       const provider = settings.llm.providers[activeProviderId.value]
       return provider ? provider.reasoningEffort : null
     })
     ```
   - 写入（**只在用户真的改了值时写**，避免挂载时的空写）：

     ```ts
     async function setEffort(next: ReasoningEffortLevel): Promise<void> {
       const settings = settingsStore.settings
       const id = activeProviderId.value
       if (!settings || id === '') return
       const provider = settings.llm.providers[id]
       if (!provider || provider.reasoningEffort === next) return
       const ok = await settingsStore.update({
         llm: {
           active: settings.llm.active,
           // 必须原样回传全部 provider：settings:update 只有顶层浅合并，
           // 只传一个 provider 会把其它 provider 整块写丢（见 ipc.ts:563-568）。
           providers: {
             ...settings.llm.providers,
             [id]: { ...provider, reasoningEffort: next },
           },
         },
       })
       if (!ok) {
         chatError.value = settingsStore.error
         return
       }
       effortHint.value = `思考等级已改为 ${next}`
       setTimeout(() => (effortHint.value = null), 2000)
     }
     ```
   - UI：放在 `.composer-bar` 里、`.meta` 之后、「停止」按钮之前，用 `<label class="tiny muted">思考</label>` + `ThinkingLevelSelect`。
   - 无可用 provider 时（`effort === null`）**不隐藏**控件，而是 `disabled` + `title="先在「设置 → AI 模型」里配置并选中一个模型"`，
     并在旁边显示一行 `tiny muted` 提示。理由：用户抱怨的就是「找不到按钮」，
     在没有模型时彻底藏起来会让同一个抱怨复现；禁用态是「找得到但用不了」，且指向了修复路径。
     （这条与 docs/08 §6.1「用户无法设置的内容不要显示」不冲突：那不是死字段，只是暂时缺前置条件。）
   - `onMounted` 里不要主动写配置——只读不写。
3. 顺手检查 mini-chat 删除后是否还有别的地方渲染思考等级（step 1 已删小窗，不应再有）。

### 2. capture 探针（`apps/desktop/src/main/capture.ts`）

4. 新增两个脚本常量（放在 `SETTINGS_LLM_EFFORT_CHECK` 之后）：
   - `CHAT_THINKING_LEVEL_ACT`：在交互窗里把 `[data-field="chat.reasoningEffort"]` 下拉切到 `high`，
     派发 `change` 事件，等 600ms（让 `settings:update` + `settings:changed` 往返完成），
     `return { changed: true }`。切之前先读一次 `window.aurora.settings.get()` 记下原值，
     存到 `window.__auroraEffortProbe`，供 check 比对与**恢复**用。
   - `CHAT_THINKING_LEVEL_CHECK`：
     `await window.aurora.settings.get()`，取 `llm.providers[llm.active].reasoningEffort`，
     同时读 DOM 里 `[data-field="chat.reasoningEffort"] select` 的 `.value` 与 option 数量；
     `pass` 条件 = 配置值 === `'high'` 且 DOM 值 === `'high'` 且 option 数量 === 4。
     结尾把原值写回（`settings.update`），保证后续截图场景不受影响，并把恢复结果放进返回值。
5. `defaultCapturePlan` 里加一条：

   ```ts
   { name: 'chat', file: 'chat-thinking-level.png', act: CHAT_THINKING_LEVEL_ACT, check: CHAT_THINKING_LEVEL_CHECK },
   ```

   位置放在 `chat-collapse.png` 那条**之前**——收起会隐藏窗口，之后就没法再对交互窗做 DOM 操作了。
6. `docs/07-ui-spec.md` §5.3 的截图清单里补上 `chat-thinking-level.png` 与新的探针说明。

### 3. 文档

7. `docs/07-ui-spec.md` §2.3「AI 交互窗口」补一段：输入区含「思考等级」下拉，
   读写当前生效 provider 的 `llm.providers.<active>.reasoningEffort`；`auto` = 不下发该参数；
   无可用 provider 时禁用并提示。
8. `docs/06-agent-core.md` 关于思考等级的那段（搜 `reasoningEffort` 或 `reasoning_effort`）补一句：
   「设置页与对话窗输入区两处入口写的是同一个字段，没有第二份来源」。
9. `docs/10-user-guide.md` 的「对话窗口」一节补一句操作说明（在输入框旁选思考等级）。

## 验收标准

- [ ] `node apps/desktop/node_modules/vue-tsc/bin/vue-tsc.js -p apps/desktop/tsconfig.web.json --noEmit` 退出码 0
- [ ] `node node_modules/typescript/bin/tsc -p apps/desktop/tsconfig.node.json --noEmit` 退出码 0（capture.ts 属主进程侧）
- [ ] `grep -n 'chat.reasoningEffort' apps/desktop/src/renderer/` 在 `ThinkingLevelSelect.vue` 与 `chat/App.vue` 各至少命中一次
- [ ] `grep -n "from '@aurora/shared/browser'" apps/desktop/src/renderer/chat/App.vue` 命中（不能从 `@aurora/shared` 取值）
- [ ] `pnpm build` 成功，且 `apps/desktop/out/renderer/chat/index.html` 存在
- [ ] `$env:AURORA_CAPTURE="$env:TEMP\aurora-capture"; $env:AURORA_CAPTURE_WINDOWS='chat'; pnpm dev` 结束后
      `report.json` 里 `chat-thinking-level` 条目的 `check.pass === true`，且进程退出码为 0
- [ ] `report.json` 里能找到 `chat-thinking-level.png`，文件大小 > 0

## 交接

- 给 step 4 的口径：思考等级现在**有两个入口写同一个字段**（设置页 AI 模型卡 + 对话窗输入区）；
  重构 `LlmPage.vue` 时若移动 `data-field$=".reasoningEffort"` 的位置，
  必须保证 `SETTINGS_LLM_EFFORT_ACT`（先造 provider、再点开第一张卡片的 `.more`）与
  `SETTINGS_LLM_EFFORT_CHECK` 仍能通过——它们依赖卡片上 `.more` 折叠区里有这个 `data-field`。
- 给 step 5（模型列表与选择器）的口径：交互窗输入区现在有一个 `data-field="chat.reasoningEffort"`
  的 `<select>`；模型选择器要加在它**旁边**，别把 `.composer-bar` 挤到换行。
  两者都写同一个 provider 子树，请沿用本步 `setEffort()` 的写法（原样回传全部 provider 再覆盖当前一个），
  建议把它抽成 `updateActiveProvider(patch)` 小工具供两个控件共用。
- 给 step 6 的口径：capture 计划里交互窗现在有四条场景，顺序是
  `thinking-level` → `model-picker`（step 5 加）→ `drag`（step 6 加）→ `collapse`；
  所有需要在交互窗里操作 DOM 的场景都必须排在 `collapse` 之前——收起会隐藏窗口。
- ⚠️ 写冲突：本步、step 5、step 6 都要新增常量并改 `apps/desktop/src/main/capture.ts` 的
  `defaultCapturePlan`。**不要并行改这个文件**，串行执行（3 → 5 → 6）或指定一人独占。

## 执行记录

- 执行时间：2026-09-22（执行会话）；状态：**done**；提交：`82ce244`（文档在 `26b5aed`、探针在 `6c98e76`）。

### 分片与结果

| 分片 | 负责文件 | 结果 |
|---|---|---|
| 子代理 · 渲染层 | `shared/components/ThinkingLevelSelect.vue`（新建 113 行）、`chat/App.vue` | 紧凑 `<select>`（22px、`flex: 0 0 auto`、option 由 `REASONING_EFFORT_LEVELS` 驱动）；`data-field="chat.reasoningEffort"` 挂在 `<select>` 自身；`setEffort()` 只在真的变化时写、原样回传全部 providers、并剥掉 `apiKeyEnc`/`apiKeySet` |
| 子代理 · 文档 | `docs/07 §2.3/§5.3`、`docs/06 §3`、`docs/10` | 见 `26b5aed` |
| Lead · 探针与验证 | `capture.ts`（`CHAT_THINKING_LEVEL_ACT/CHECK`） | 见 `6c98e76` |

### 与原计划的两处偏差

1. 计划的 `ReasoningEffortLevel` 类型在 `@aurora/shared` 里不存在（那是 `agent-core` 的
   `Exclude<ReasoningEffort,'auto'>`），实际用 shared 导出的 `ReasoningEffort`。
2. `REASONING_EFFORT_LEVELS` 的**运行时**导入放在 `ThinkingLevelSelect.vue`（驱动 option 数必须为 4），
   `chat/App.vue` 只导入 type 与 `DEFAULT_REASONING_EFFORT` —— 在 App.vue 里 import 而不使用会踩 lint 的
   `no-unused-vars`。计划里「App.vue 必须命中 `from '@aurora/shared/browser'`」这条验收仍然满足。

### 验收（Lead 亲自复跑）

| 命令 | 结果 |
|---|---|
| `vue-tsc -p tsconfig.web.json` / `tsc -p tsconfig.node.json` / prettier / eslint | ✅ 全绿 |
| `AURORA_CAPTURE=<tmp> pnpm dev`（全量） | ✅ 退出码 0；`chat-thinking-level` 探针 `pass:true` —— `{"configValue":"high","domValue":"high","optionCount":4,"restored":true}` |
| 同一次全量跑里的 `settings-llm-params` | ✅ 仍 `pass:true`（两个入口共用同一字段、探针互不污染） |
| `grep -n 'chat.reasoningEffort' apps/desktop/src/renderer/` | ✅ 组件 1 处（真属性）+ App.vue 1 处（注释） |
| `read_image chat-thinking-level.png` | ✅ 输入区一行内：`会话…` → `思考` → `high（更深入）` → 提示 → 发送按钮，未换行、按钮未出框 |

### 遗留 / 待确认

- `auto（不指定，兼容性最好）` 在 11px 下约 145px，超过 `max-width: 128px`，
  默认选中 `auto` 时框内文案会被省略号截断（展开列表里完整）。这是计划「宽度约 96px」+「文案照抄」的必然取舍；
  若要完全不截断需把 `max-width` 提到约 150px，代价是进一步压缩 `.meta`。**保持现状**。
- 同文件里还带走了 step 6 的 3 行拖动接线（`useWindowDrag('chat')` 与两处 `:class`），
  因为两处改动落在同一个文件、按文件粒度无法干净拆分；已在上一条提交的消息里说明。
- 本步顺带发现并在 step 2 修掉的**凭据清空**缺陷（回传带空 `apiKeyEnc` 的全量 providers），
  详见 `step-02-setting-tool.md` 的执行记录；本步的 `setEffort()` 自身也做了防护。
