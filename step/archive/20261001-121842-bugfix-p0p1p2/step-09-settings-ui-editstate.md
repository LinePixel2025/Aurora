# Step 09 — 渲染层设置页编辑态与试听

- Task: bugfix-p0p1p2
- Step: 9 / 12
- Status: done
- Depends on: step 8（同改五个设置页组件，串行避免冲突）
- Produces: settings 广播不再清掉正在编辑的 provider 表单（含未落盘草稿）；MCP 删除两步确认；TTS「保存并试听」播的是编辑卡那个 provider
- Phase: 集成
- Writes: `apps/desktop/src/renderer/settings/pages/LlmPage.vue`、`apps/desktop/src/renderer/settings/components/TtsSection.vue`、`apps/desktop/src/renderer/settings/components/SttSection.vue`、`apps/desktop/src/renderer/settings/components/ImageGenSection.vue`、`apps/desktop/src/renderer/settings/components/McpSection.vue`、`apps/desktop/src/renderer/shared/composables/useTts.ts`
- Size: S
- Risk: 双列表改造是 LlmPage 向 TtsSection 看齐的结构性改动——保存链路（新增 / 编辑 / 删除 / 设默认）要逐条过一遍，别只顾广播不清表单把保存搞坏；渲染层无单测面，全靠 vue-tsc + 回归 + 代码核对

## 目标

编辑 provider 卡片打开期间，任何即时保存动作或 `settings:changed` 广播到达都不再回退编辑内容、不再丢失填了一半的新草稿；删除 MCP 服务器需要两次点击；试听请求携带正在编辑卡的 providerId。

## 输入

- `bug/P2-一般.md` 的 P2-23、P2-24、P2-25（每条含 文件:行、触发条件与修复建议）；证据在 `bug/_raw/U7-settings-onboarding-edgebar.md`
- 源码：`apps/desktop/src/renderer/settings/pages/LlmPage.vue`（syncDrafts 约 279-308、addPreset 直接 push 草稿约 429、名称校验已由 step-08 改在约 421-427）；`components/TtsSection.vue`（localDrafts/savedDrafts 双列表的参照实现约 135-149；试听约 393-399）；`SttSection.vue` 约 69-96 与 `ImageGenSection.vue` 约 78-105（同构实现）；`components/McpSection.vue`（删除按钮约 293、执行约 213-217）；`apps/desktop/src/renderer/shared/composables/useTts.ts`（约 82 行 `synthesize({ text })` 不带 providerId）
- 主进程契约：`packages/shared/src/ipc/types.ts` 约 248-252 的 `TtsSynthesizeRequest` 明确支持可选 `providerId`（缺省用 `tts.active`）——契约不用改，只补渲染层透传
- 仓库先例：LlmPage 的 `pendingRemoveId` 两步确认模式是 P2-24 要照抄的实现

## 操作

1. P2-23：`LlmPage.vue` 引入与 `TtsSection.vue` 同款的 `localDrafts` / `savedDrafts` 双列表结构——`addPreset` 的未落盘草稿进 `localDrafts`（不再直接 push 进会被重建的数组）；`syncDrafts` 对 `editingId` 指向的对象按 id 复用旧引用（广播到达不清编辑卡、不关编辑器）。
2. P2-23 收尾：`TtsSection.vue` / `SttSection.vue` / `ImageGenSection.vue` 的 `syncDrafts` 若仍整体替换 `savedDrafts`，同样改为按 id 复用引用（三处口径一致；注释声称不动编辑卡引用——让实现兑现注释）。
3. P2-24：`McpSection.vue` 删除照抄 LlmPage 的 `pendingRemoveId` 两步确认——第一次点进入确认态（按钮文案变化），再点才执行删除；点其他处 / 取消则复位。
4. P2-25：`useTts.ts` 的 `speak` / `synthesize` 调用增加可选 `providerId` 透传；`TtsSection.vue` 的「保存并试听」传正在编辑卡的 providerId（非默认 provider 的试听不再张冠李戴）。
5. 渲染层无单测面——验证靠 `pnpm typecheck`（vue-tsc）+ 全量回归 + 逐条代码核对；Conventional Commits 中文分组提交（`fix(settings): ...`），提交信息尾注覆盖的条目号（如 `...(P2-23, P2-25)`）。

## 验收标准

- [ ] `pnpm typecheck && pnpm build` 通过；`pnpm vitest run` 全绿（回归）
- [ ] 行为核对四项（代码路径核对 + 类型佐证）：① 广播到达时 LlmPage 编辑卡内容与打开状态不变；② `addPreset` 的草稿在广播后仍在输入框里；③ McpSection 删除需两次点击、有确认态；④ 试听请求带编辑卡 providerId（非默认卡试听走对 provider）
- [ ] 保存链路核对：新增 / 编辑 / 删除 / 设为默认四个操作在双列表结构下各自落盘正确（对照 `settings:update` 的调用点逐条过）

## 交接

- 若核对中发现本步文件之外的结构问题（如 store 层），记入「执行记录」不扩范围。
- step-11 全量验证与代码审查的关注点：双列表改造后的保存链路（见 00-index 审查重点）。

## 执行记录

**提交**：`8649b76 fix(settings): 广播不清编辑态、MCP 两步确认删除、试听带 providerId`

**分片与结果**：单分片，1 个实现子代理（general-purpose）在 step-08 提交之上继续改。主代理复跑验收命令。

**实际改动**
- `LlmPage.vue`（P2-23 主改）：单一 `drafts` 拆成 `localDrafts` + `savedDrafts` + `drafts = computed([...saved, ...local])`；`syncDrafts` 改为「只有**编辑卡那一行**按 id 复用旧引用（`editing === id ? previous.find(...) : undefined`），其余行照常重建」（别处改的值仍会反映）；`addPreset` 草稿 push 进 `localDrafts`；`closeEditor` 取消未落盘草稿时从 `localDrafts` 摘除；`saveProvider` 成功后摘除草稿再 `syncDrafts()`（避免同 id 同时存在于两列表）；`removeProvider` 补 `localDrafts` 摘除；编辑卡内新增未落盘提示样式。
- `TtsSection.vue` / `SttSection.vue` / `ImageGenSection.vue`（P2-23 收尾）：三处 `syncDrafts` 同款改成「按 id 复用编辑卡引用」，兑现各文件注释里「不动编辑卡对象引用」的承诺。
- `TtsSection.vue` + `useTts.ts`（P2-25）：`speak(text, key, providerId?)`，请求只在有值时带 `providerId`（空串/undefined 都回落 `tts.active`，避免主进程 `??` 把空串当成不存在的 id）；「保存并试听」传编辑卡自己的 `draft.id`。主进程契约 `TtsSynthesizeRequest` 本就支持可选 `providerId`，**未改**。
- `McpSection.vue`（P2-24）：照抄 LlmPage 的 `pendingRemoveId` 两步确认 —— 第一次点进入确认态（行按钮 `variant` 变 danger + 行内出现「确认删除 / 取消」），再点才执行；`add` / `toggleEnabled` / `setLazyConnect` / `saveServers` 开头复位确认态，列表变化时 `watch` 清理失效确认态。

**验证（主代理实跑）**
```
pnpm typecheck → 全部 Done
pnpm build     → 全仓 build 成功
pnpm test      → 115 files / 2028 tests 全绿
子代理另跑：pnpm vitest run apps/desktop/src/renderer → 3 files / 31 tests 绿；
           apps/desktop/src/main/tts.test.ts → 59 tests 绿（佐证 providerId 契约）
```

**行为核对四项（代码路径 + 类型佐证）**
1. 广播到达时编辑卡内容与打开状态不变：`stores.ts:94-96` → `LlmPage.vue:341-345` watch → `syncDrafts`，第 317-318 行对 `editing === id` 返回 `previous` 里**同一个对象引用**；打开状态由 `mode`/`editingId` 决定，`syncDrafts` 只在 `!isCreating && !hasSaved` 时才 `closeEditor`（:332），provider 仍在配置中 → 不关。
2. `addPreset` 草稿在广播后仍在：写入 `localDrafts`（:482）后 `openEditor`；`drafts` 计算属性含 `localDrafts`（:98），`syncDrafts` 只重建 `savedDrafts`（:312）→ 广播不触碰该草稿；守卫 `isCreating(editing)` 为真 → 不 `closeEditor`。
3. McpSection 删除需两次点击、有确认态：:337-344 只调 `requestRemove`（切 `pendingRemoveId`，不写配置），:348 `v-if="pendingRemoveId === server.name"` 渲染确认条，真正删除只在 :356-361 的「确认删除」。与仓库既有的会话删除探针口径一致（`capture.ts:1415-1420` 断言的正是「点删除后出现『确认删除』」）。
4. 试听带编辑卡 providerId：`TtsSection.vue:417` 传 `draft.id` → `useTts.ts:89-91` 组进 `request.providerId` → `preload/index.ts:86` 原样转发 → `main/tts.ts:295` `request.providerId ?? settings.tts.active`。

**保存链路四操作（双列表结构下逐条过 `settings:update` 调用点）**
- **新增**：`addPreset` → `localDrafts` → `applyDraft` → `saveProvider`（:390-444），`providers` **全量回传** + `setSecrets('llm.providers.<id>.apiKey')`，成功后摘草稿 + `syncDrafts`（该行改由 settings 镜像提供，不重复）。
- **编辑**：同一条 `saveProvider`；`saveAll`（:455）逐条调用同一函数；摘除先于 `syncDrafts`，不会出现行丢失或重复行。
- **删除**：`removeProvider`（:520-541）`delete next[id]` + `active` 归零 + **`removedProviders: [id]`**（record 缺项 ≠ 删除，必须显式声明）；随后摘 `localDrafts`、清 `pendingRemoveId`、编辑中就 `closeEditor`、`syncDrafts`。
- **设为默认**：`setActive`（:543-548）`llm: { active: id, providers }` **全量回传**，不动 `localDrafts`。
Tts / Stt / ImageGen 三处的 saveProvider / removeProvider / setActive 未改（仅 `syncDrafts` 复用口径），落盘语义与改造前一致。

**遗留 / 注意**
- **MCP 确认条的实现方式**：step 第 28 行写「按钮文案变化」，而验收标准 ③ 与 bug P2-24 都写「照抄 LlmPage 的 `pendingRemoveId` 两步确认」。按后者实现（行按钮 `variant` 变 danger + 行内确认条），与仓库既有会话删除探针的「确认删除」口径一致；**没有**把行按钮文案本身改成「确认删除」。若要字面改，是 20 行内的小调整。
- **编辑卡引用复用的边界**：复用只对正在编辑的那一个 id 生效；该 provider 若在别处被改（另一窗口改 baseUrl / 凭据状态），本窗口编辑卡显示的是用户正在改的版本，凭据徽标可能滞后到关闭编辑器后的下一次同步 —— 这是「不丢用户输入」的必然取舍，已写进注释。
- 渲染层无组件测试面（仓库无 Vue 组件测试基建），四项行为核对为代码路径 + 类型佐证 + 主进程契约单测，未做真实 Electron 跑测。

