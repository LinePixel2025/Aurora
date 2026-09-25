# Step 05 — 设置页「语音」页（添加 / 编辑 TTS 模型）+ 侧栏 + 截图探针

- Task: agent-tts-voice
- Step: 5 / 8
- Status: done
- Depends on: step 3（IPC 与 `testConnection`）、step 4（`useTts` 试听播放）
- Produces: `apps/desktop/src/renderer/settings/pages/TtsPage.vue`；`settings/App.vue` 侧栏第 8 项；`main/capture.ts` 的 TTS 页探针与 `settings-tts*.png` 场景

## 目标

用户能在设置界面**添加 TTS 模型**：填 baseURL / API Key / 模型 / 音色 / 语速 / 输出格式，设为默认，试听，删除。

## 输入

- `apps/desktop/src/renderer/settings/pages/LlmPage.vue`（**主要参照**：provider 行列表 + 一次只开一张编辑卡 + 删除二次确认 + 凭据 write-only + `settingsStore.update` 的 `deepClone` 语义）
- `apps/desktop/src/renderer/settings/pages/AgentPage.vue`（更简单的页面骨架：`save(patch)` + `AppToast`）
- `apps/desktop/src/renderer/settings/App.vue`（`PageId` / `nav` / `navGroups` / 页面渲染分支）
- `apps/desktop/src/renderer/shared/stores.ts`（`useSettingsStore`）
- `apps/desktop/src/renderer/shared/components/{AppButton,AppToast,SettingField}.vue`
- `apps/desktop/src/main/capture.ts`（`SETTINGS_PAGE_IDS`、`SETTINGS_FIELDS_SCRIPT`、`SETTINGS_AGENT_FIELDS_SCRIPT`、设置页计划循环）
- step 1 的 `TTS_PRESETS` / `DEFAULT_TTS` / `TTS_FORMATS`（从 `@aurora/shared/browser` 取，**不要**从 `@aurora/shared` 取）
- step 3 的 `TtsTestRequest` / `TtsTestResult`、step 4 的 `useTts`

## 操作

1. 新建 `apps/desktop/src/renderer/settings/pages/TtsPage.vue`，信息架构照 `LlmPage.vue`：
   - 页头：标题「语音」+ 说明「让 Aurora 朗读回复。支持任何 OpenAI 兼容的语音合成服务；凭据加密保存在本机。」+ 摘要（当前默认 TTS 模型 / 音色，未配置时写「尚未配置 TTS 模型」）；
   - 常显区（`data-field` 必须是这些确切路径）：
     - `tts.enabled`：总开关复选框（**常显**，否则关掉就再也开不回来）；
     - `tts.active`：默认 TTS 模型的 provider id 选择（选项来自 `drafts`，空列表时禁用并给提示）；
     - `tts.autoRead`：自动朗读新回复；
     - `tts.maxChars`：单次朗读文本上限（数字输入，夹到 50–4096）；
   - provider 区：行列表（id + 凭据状态徽标「凭据已保存 / 缺少凭据」+ 是否默认 + 编辑 / 设为默认 / 删除）；
     `data-field="tts.providers"` 在容器上，每个 provider 行 `data-field="tts.providers.<id>"`；
     **列表为空时**整块换成空状态卡：`data-empty="tts.providers"` + 「还没有 TTS 模型」+ 主按钮「添加 TTS 模型」；
   - 「添加」流程：预设 chips 来自 `TTS_PRESETS`（`+ OpenAI TTS` / `+ SiliconFlow 语音`）+ 自定义 id 输入 + `+ 空白配置`；选中即进编辑卡；
   - 编辑卡（一次只渲染一张，`editingId` 单值）字段与 `data-field`：
     `tts.providers.<id>.baseUrl`（必填）、`tts.providers.<id>.apiKey`（write-only，`type="password"`，
     文案区分「已保存（留空表示不修改）」与「必填；明文只写入系统安全存储，页面不回显」）、
     `tts.providers.<id>.model`（必填）、`tts.providers.<id>.voice`（必填，配 `TTS_PRESETS` 的候选音色 chips）、
     `tts.providers.<id>.speed`（number，0.25–4，step 0.05）、`tts.providers.<id>.format`（`<select>`，选项来自 `TTS_FORMATS`）；
   - 卡片动作：`应用`（只提交这一张卡）、`取消`、`保存并试听`（先落盘再 `window.aurora.tts.testConnection({ providerId, baseUrl, apiKey, model, voice, speed, format })`，
     成功用 `useTts().speak(text, 'preview')` 播回传音频 —— 但 `testConnection` 只回 `ok/latencyMs/message/bytes`，
     **试听播放改走 `synthesize`**：先保存卡片、再 `synthesize({ text: '你好，我是 Aurora。', providerId })` 并把结果交给 `useTts` 播；
     `testConnection` 只用来做「连接测试」按钮（只回文字结果），别把两者混成一个按钮；
   - 删除走**就地二次确认条**（`确认删除` / `取消`），删除必须显式声明 `tts.removedProviders: [id]`
     —— 照 `LlmPage.removeProvider` 的做法，并在 `packages/shared/src/ipc/types.ts` 的 `SettingsPatch.tts`
     上加 `removedProviders?: string[]`、在 `apps/desktop/src/main/settings-patch.ts` 里照 `llm.removedProviders` 处理
     （`tts.providers` 同样是 record，**缺项 ≠ 删除**）；
   - 保存语义照抄 LlmPage：patch 必须经 `settingsStore.update()`（内部 `deepClone`，否则 reactive Proxy 过 IPC 会 `DataCloneError`）；
     `apiKeyEnc: ''` 表示为已有 provider「本次不改凭据」；明文 Key 只走 `window.aurora.settings.setSecrets({ ['tts.providers.<id>.apiKey']: key })`，
     且**先** update 落条目、**再** setSecrets。
2. `apps/desktop/src/renderer/settings/App.vue`：`PageId` 加 `'tts'`；`nav` 在 `llm` 之后加
   `{ id: 'tts', label: '语音', hint: 'TTS 朗读与音色' }`；`navGroups` 的「AI 能力」组改为
   `['llm', 'tts', 'skills', 'mcp', 'agent']`；模板加 `<TtsPage v-else-if="active === 'tts'" />` 分支与 import。
3. `packages/shared/src/ipc/types.ts`：`SettingsPatch` 加 `tts?: Partial<TtsSettings> & { removedProviders?: string[] }`。
4. `apps/desktop/src/main/settings-patch.ts`：`mergeSettingsPatch` 里照 llm 的两个环节补 tts ——
   ① 按 `patch.tts?.removedProviders` 从 `draft.tts.providers` 删除，并对「最终状态没有密文」的 id
   往 `cleared` 里 push `tts.providers.<id>.apiKey`；② 逐条合并 provider 时，已有条目 + incoming `apiKeyEnc === ''`
   要 `delete incoming['apiKeyEnc']`（否则设置页改一次模型名就把凭据清空）；③ 最后
   `draft.tts.providers = providers` 并把 `removedProviders` 从 `draft.tts` 上摘掉（它是指令不是字段）。
   同时 `extractPatchSecrets` 要抽取 `patch.tts.providers.*.apiKey` 明文（照 llm 分支加一段循环）。
   补 `apps/desktop/src/main/settings-patch.test.ts` 用例：删除 provider 时返回 `cleared` 含 tts 凭据路径；
   回传空 `apiKeyEnc` 不清空已有密文。
5. `apps/desktop/src/main/capture.ts`：
   - `SETTINGS_PAGE_IDS` 追加 `'tts'`（顺序放在 `'llm'` 之后）；
   - 新增 `export const SETTINGS_TTS_FIELDS_SCRIPT`：照 `SETTINGS_AGENT_FIELDS_SCRIPT` 的套路，读
     `[data-field^="tts.providers"]` 计数、`tts.enabled` 复选框实际状态、`tts.autoRead` 与 `tts.maxChars` 计数、
     `data-empty` 列表；`pass` 条件写成：
     ① `tts.enabled` 开关存在（常显）；② provider 列表为空时 `autoRead` 与 `maxChars` 计数为 0 且 `data-empty` 含 `'tts.providers'`；
     ③ provider 列表非空时 `autoRead` 与 `maxChars` 都存在且 `data-empty` 不含 `'tts.providers'`；
   - 计划循环里把 `page === 'tts'` 指向 `SETTINGS_TTS_FIELDS_SCRIPT`（现在只有 `general` / `agent` 有 check）；
   - 新增一条 `act` 场景 `SETTINGS_TTS_ADD_ACT`：在 `?page=tts` 下点「+ 空白配置」（或第一个预设），
     使编辑卡出现；配套 `SETTINGS_TTS_CARD_CHECK` 断言六个字段的 `data-field` 都在
     （`baseUrl` / `apiKey` / `model` / `voice` / `speed` / `format`）；
     **act 不得点「应用」**（capture 会改真实 userData，必须像 `SETTINGS_LLM_MODELS_ACT` 那样只动本地 draft）；
   - 计划里追加两条：`settings-tts.png`（`query: { page: 'tts' }` + `SETTINGS_TTS_FIELDS_SCRIPT`）
     与 `settings-tts-card.png`（`query: { page: 'tts' }` + `SETTINGS_TTS_ADD_ACT` + `SETTINGS_TTS_CARD_CHECK`）。

## 验收标准

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 全绿（含新增的 `settings-patch.test.ts` 用例）
- [ ] `pnpm build` 通过
- [ ] `$env:AURORA_CAPTURE="$env:TEMP\aurora-capture-tts"; $env:AURORA_CAPTURE_WINDOWS='settings'; pnpm dev`
      结束后：`$env:TEMP\aurora-capture-tts\settings-tts.png` 与 `settings-tts-card.png` 存在；
      `report.json` 里这两条的探针结果 `pass` 为 `true`；进程退出码为 0（有 FAIL 时为 2）
- [ ] 打开 `settings-tts.png` 肉眼核对：空状态卡文案与「添加 TTS 模型」主按钮可见，总开关 / 自动朗读 / 上限三处控件排布正常
- [ ] `Select-String -Path apps/desktop/src/renderer/settings/pages/TtsPage.vue -Pattern "tts.providers"` 有命中
- [ ] `git diff --stat` 覆盖：`TtsPage.vue`（新）、`settings/App.vue`、`ipc/types.ts`、`settings-patch.ts` + `.test.ts`、`capture.ts`

## 交接

- 页面上的 `data-field` 路径就是 step-01 的 Schema 路径，探针与文档门控矩阵靠它对齐；
  **不要**为了排版改这些属性值。
- `tts.removedProviders` 与 `llm.removedProviders` 是**同一套语义**（record 缺项 ≠ 删除）。
- step-06 只需要读 `settingsStore.settings.tts.{enabled,active,autoRead,providers}`，不必知道本页的内部状态。

## 执行记录

（2026-09-24）**Status: done** —— 本步按 3 个互不重叠的写范围**并行派发**了 3 个子代理，主代理负责集成、修探针缺陷与全部验收。

### 分片与结果

| 分片 | 子代理 | 写范围 | 结果 |
| --- | --- | --- | --- |
| 5a `settings-patch` tts 合并/删除/抽明文 | A | `settings-patch.ts` + `.test.ts` | 完成（+48 / +117），主代理复跑 22 passed |
| 5b `TtsPage.vue` + 侧栏接入 | B | `TtsPage.vue`（新，897 行）+ `settings/App.vue` | 完成，主代理复跑 typecheck/build |
| 5c `capture.ts` 探针与两张截图 | C | `capture.ts` | 完成（+149），**但探针有两处缺陷，由主代理修正** |

三个写范围严格不重叠（无同一文件双写）；`step/*.md` 与 git 提交全程由主代理独占。

### 主代理集成时修正的探针缺陷（首跑实测抓到，2 处）

`AURORA_CAPTURE` 首跑两条 TTS 场景**均 FAIL**，均为 `capture.ts` 探针缺陷（页面本身符合契约）：

1. **门控条件自相矛盾**（`SETTINGS_TTS_FIELDS_SCRIPT`）：计划第 5 条明确 `tts.enabled` / `autoRead` / `maxChars`
   属**常显区**，但探针把 `autoRead` / `maxChars` 写进「列表为空 → 这两个必须为 0」的二选一，
   于是空列表下 `pass` **永远为 false**（实测 `autoReadFields:1, maxCharsFields:1, emptyStates:["tts.providers"]`）。
   改为：三个常显字段任何状态下都必须在，空列表唯一多出的断言是 `data-empty="tts.providers"` 必须在。
2. **按钮节点缓存导致 act 永远找不到目标**（`SETTINGS_TTS_ADD_ACT`）：
   ① 「+ 空白配置」渲染在 `v-if="mode === 'add'"` 的添加区里，初始列表态下**根本不在 DOM** —— 必须先点
   「添加 TTS 模型」/「+ 添加 TTS 模型」进添加态（实测 `act: null`、六字段全 0）；
   ② 更隐蔽的一处：探针在点击**前**把 `Array.from(querySelectorAll('button'))` 缓存进数组，
   进添加态后出现的是**全新节点**，永远不在那个陈旧数组里 —— 改为每次重新查询
   （`allButtons()` 函数）。修完 `actResult: {ok:true, opened:"添加TTS模型", label:"空白配置", editorFields:1}`。

另修掉主代理自己引入的两处模板字符串事故（注释里写了反引号会**提前终止**探针的 template literal，
导致 `TS1005`）与一处 UTF-8 乱码（`实��`）。

### 验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 4 项目全 Done |
| `pnpm test` | **789 passed**（51 files；step-03 时为 783，本步 +6） |
| `pnpm build` | 通过（settings bundle 166→202 KB） |
| `pnpm lint` | 0 问题 |
| `pnpm prettier --check`（5 个文件） | 全部通过 |
| `Select-String TtsPage.vue -Pattern "tts.providers"` | **17** 处命中 |
| `AURORA_CAPTURE_WINDOWS=settings pnpm dev` | **退出码 0**，12 条探针**全 PASS、无 FAIL** |
| `report.json` | `settings-tts.png` 与 `settings-tts-card.png` 均 `ok:true / pass:true` |
| 两张图肉眼核对 | 「语音」页：侧栏「AI 能力」组第 2 项、常显四控件、空态摘要「尚未配置 TTS 模型」；卡场景：工具行出现「1 个 TTS 模型」且 DOM 探针确认六字段可见 |

### 子代理自查发现的两个真 bug（已随提交合入）

B 在自查中修掉：① `testProvider` 在 `saveProvider` 之后读已被清空的 `draft.apiKey`，
导致明文 key 永远送不到 `testConnection`（只能回落旧凭据）——改为保存前捕获；
② `saveMaxChars` 曾展开 `settings.tts` 并带 `removedProviders: undefined`，
与其他三个常显控件统一为 `saveTts(patch)`。

### 遗留

- 「删除 provider 时清掉凭据」的端到端路径（`cleared` → `deps.settings.clearSecret`）只有单测覆盖，
  真机需在设置页实际删除一次再查 `config.json`（并入 step-07 手工核对）。
- 子代理 C 的临时脚本已确认清理干净（无 `.tmp-tts*` 残留）。
- 提交：`8e8096b`（feat(settings)，5 files，+1265/-8）。

