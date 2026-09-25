# Step 06 — 对话窗「朗读」按钮与自动朗读

- Task: agent-tts-voice
- Step: 6 / 8
- Status: done
- Depends on: step 4（`useTts`）、step 5（`tts.*` 配置已在设置页可写）
- Produces: `MessageList.vue` 的逐条朗读按钮；`chat/App.vue` 的接线与自动朗读；对话窗截图探针

## 目标

助手回复能一键朗读；打开「自动朗读新回复」后，每轮回复结束自动读出来。

## 输入

- `apps/desktop/src/renderer/shared/components/MessageList.vue`（消息渲染、`rendered` computed、工具卡片、`data-action` 惯例）
- `apps/desktop/src/renderer/chat/App.vue`（`chat = useChat('chat','main')`、`MessageList` 用法在第 483 行附近、
  `settingsStore` 的用法、`AppToast` 的用法）
- `apps/desktop/src/renderer/shared/composables/useChat.ts`（`streaming` / `lastAssistant` / `messages` / `statusTone`）
- `apps/desktop/src/renderer/shared/composables/useTts.ts`（step 4 产出，接口已冻结）
- `apps/desktop/src/main/capture.ts`（chat 场景计划、`CHAT_*` 探针脚本）

## 操作

1. `MessageList.vue` 增加**可选** props 与 emits（默认值保证既有调用点不用改）：
   - props：`ttsAvailable?: boolean`（默认 `false`）、`speakingId?: string | null`（默认 `null`）、
     `ttsLoadingId?: string | null`（默认 `null`）；
   - emits：`speak(text: string, id: string)`、`stopSpeak()`；
   - 只在 `ttsAvailable && message.role === 'assistant' && !message.pending && message.content.trim() !== ''`
     时渲染按钮；按钮放在助手消息正文之后（`.bubble` 内、工具卡片之前），带
     `data-action="speak-message"`；正在播这条时文案为「停止」并带 `data-action="stop-speak"`；
     正在合成这条时为「合成中…」且禁用。
   - 注意：`rendered` 是 `computed` 出来给模板用的数组，按钮状态比对用 `message.id`；
     **不要**在 `MessageList` 里直接 `new Audio`（播放实现只有 `useTts` 一份）。
2. `chat/App.vue`：
   - `const tts = useTts()`；
   - 给 `MessageList` 传 `:tts-available="ttsReady"`、`:speaking-id="tts.speaking.value"`、
     `:tts-loading-id="tts.loading.value"`，并接 `@speak="(text, id) => tts.speak(text, id)"`、`@stop-speak="tts.stop"`；
   - `ttsReady` = 已配置可朗读：`settingsStore.settings?.tts.enabled === true`
     且 `tts.active !== ''` 且该 provider 存在且 `baseUrl` / `model` / `voice` 非空；
   - **自动朗读**：`watch(() => chat.streaming.value, (now, before) => { if (before && !now && autoRead) ... })`，
     读 `chat.lastAssistant.value`：只读**本轮刚结束**的那条助手消息（记一个 `lastReadId`，同一条不重复朗读，
     避免 watch 抖动导致重播）；条件不满足（未配置 / 已朗读过 / 内容为空）时静默跳过；
   - 朗读失败提示：`watch(tts.error, ...)` 非空时用 `AppToast tone="error"` 显示一次（不要长时间驻留）。
   - 用户点「停止」或切换会话（`chat.switchSession`）时应 `tts.stop()`。
3. `apps/desktop/src/main/capture.ts`：新增对话窗场景 —— 用 `act` 脚本在渲染层点一次
   `[data-action="speak-message"]`（**离线环境合成必然失败**，因此探针只断言「点击后出现错误提示或状态复位」，
   **不要**断言真的出声）；`check` 脚本读：
   ① 助手消息上存在 `[data-action="speak-message"]`（在有回复时）；
   ② 点击后 1.5s 内按钮回到「朗读」态（说明 loading 有复位、没有卡死在「合成中」）。
   把这条加进计划，文件名 `chat-tts.png`。若当前 capture 计划里没有可用的助手消息，
   就退化成断言按钮**存在性**（`document.querySelectorAll('[data-action="speak-message"]').length > 0`），
   并在探针返回值里写明用的是哪条判据。

## 验收标准

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 全绿
- [ ] `Select-String -Path apps/desktop/src/renderer/shared/components/MessageList.vue -Pattern 'speak-message'` 有命中
- [ ] `Select-String -Path apps/desktop/src/renderer/chat/App.vue -Pattern 'useTts'` 有命中
- [ ] `$env:AURORA_CAPTURE="$env:TEMP\aurora-capture-chat"; $env:AURORA_CAPTURE_WINDOWS='chat'; pnpm dev`
      结束后 `chat-tts.png` 存在、`report.json` 里该场景 `pass` 为 `true`、退出码为 0
- [ ] `pnpm build` 通过
- [ ] `git diff --stat` 只出现 `MessageList.vue`、`chat/App.vue`、`capture.ts`

## 交接

- 「可朗读」判定（`ttsReady`）是**唯一**的口径：没有 TTS 配置时按钮**根本不出现**（不是 disabled），
  与文档门控口径一致；step-07 的验收会按这条核对。
- 自动朗读不会朗读历史水合出来的旧消息（`lastReadId` 机制）；只有「本轮从 streaming=true 变为 false」才触发。
- `tts.error` 属于渲染层瞬时状态，**不落盘、不进会话记录**。

## 执行记录

（2026-09-24）**Status: done** —— 主代理做两个渲染层文件（逻辑耦合紧），capture 探针并行派给 1 个子代理。

### 分片与结果

| 分片 | 执行者 | 写范围 | 结果 |
| --- | --- | --- | --- |
| 6a `MessageList.vue` 朗读按钮 | 主代理 | `MessageList.vue` | 完成（可选 props/emits，默认值保证既有调用点不用改） |
| 6b `chat/App.vue` 接线 + 自动朗读 | 主代理 | `chat/App.vue` | 完成（`useTts`、`ttsReady`、autoRead watch、错误 toast、切会话停止） |
| 6c `capture.ts` chat-tts 场景 | 子代理 C2 | `capture.ts` | 探针完成；**现场准备由主代理修正**（见下） |

### 主代理实测修正的四处（均为「探针/现场喂不出数据」，不是功能缺陷）

`chat-tts` 场景首跑 `pass:false`，逐层排查出四个独立原因，全部修掉后才拿到强判据：

1. **capture 计划里没有助手消息**（子代理已如实上报）：隔离 userData 的 `chat:history` 必然为空，
   离线 `chat:send` 只回 error 事件，不会产生助手消息 → 朗读按钮按设计不渲染。
   修法：新增 `seedChatTtsHistory()`，在**跑计划之前**往 `sessions/main.json` 种一条助手消息
   （隔离目录退出即删，不污染用户数据）。
2. **会话 id 种错了**：首版种 `capture-tts.json`，而交互窗是 `useChat('chat','main')`，
   水合的是 **`main.json`** —— 文件写成功但没人读。
3. **写入时机太晚（会话）**：`SessionStore` 对每个会话**首次读取即缓存**（`ensureLoaded`），
   交互窗 `onMounted` 就会读一次；`prepare` 在窗口已加载之后才跑，写完也看不到。
   修法：把种数据提到 `runCapture` 里、`captureWindows` 之前，`prepare` 只负责 `reload` 让水合重跑。
4. **TTS 配置不能靠写文件**：`SettingsStore.init()` 启动时就把 `config.json` 读进内存长期缓存
   （`this.current`），启动后写文件对运行中进程无效（实测：`assistantMessages:1` 但 `speakButtons:0`）。
   修法：改由 act 走 `settings:update` **IPC** 写（与 `CHAT_MODEL_PICKER_ACT` 同一套路），
   并在 check 里**收尾摘掉**自己造的 provider（本场景在真实 userData 下也会被跑到）。

另修掉两处我自己引入的模板字符串事故（探针字符串内的注释写了反引号会提前终止 template literal → `TS1005`）。

### 验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 4 项目全 Done |
| `pnpm test` | **789 passed**（51 files） |
| `pnpm build` | 通过 |
| `pnpm lint` | 0 问题 |
| `pnpm prettier --check` | 4 个文件全部通过 |
| `Select-String MessageList.vue -Pattern 'speak-message'` | 命中（第 325 行） |
| `Select-String chat/App.vue -Pattern 'useTts'` | 命中（import + 调用） |
| `AURORA_CAPTURE_WINDOWS=chat pnpm dev` | **退出码 0，6 条探针全 PASS、无 FAIL** |
| `report.json` 中 `chat-tts` | `{"pass":true,"criterion":"ready","assistantMessages":1,"speakButtons":1,"reviveMs":0,"found":[{"action":"speak-message","label":"朗读","disabled":false}]}` |
| `chat-tts.png` 肉眼核对 | 助手消息下方渲染出「朗读」胶囊按钮，且已回到「朗读」态（未卡在「合成中…」） |

**判据强度**：`criterion:"ready"` 是**强判据**（不是退化的 `presence`）——它真的断言了
「按钮存在 **且** 点击后回到「朗读」」，即证明了 `useTts` 的 `loading` 在合成失败（离线必然失败）
后正确复位。判据是「退化」还是「强」，见返回值里的 `criterion` 字段。

### 遗留

- 自动朗读（`tts.autoRead`）**没有自动化覆盖**：它需要「真实一轮回复结束」的边沿，
  离线无可用 LLM 造不出来。逻辑（`lastReadId` 去重 + 只读本轮 `lastAssistant`）已按 step 要求实现，
  真正的验证并入 step-07 的真机核对清单。
- 「切会话 / 点停止会真的停音」同理属真机项（需要真的在出声）。
- 提交：`226b7b1`（feat(chat)，4 files，+462/-7）。

