# Step 04 — CSP `media-src` + 渲染层 `useTts` 播放链路

- Task: agent-tts-voice
- Step: 4 / 8
- Status: done
- Depends on: step 3（`window.aurora.tts.synthesize` 已在 preload 暴露）
- Produces: `apps/desktop/src/main/index.ts` 的 CSP 放行；`apps/desktop/src/renderer/shared/composables/useTts.ts`

## 目标

渲染层拿到 base64 音频后能真的**播出声**：base64 → Blob → `blob:` URL → `HTMLAudioElement`。
同时把「打包后播不了」这个必踩的坑在 CSP 层堵住。

## 输入

- `apps/desktop/src/main/index.ts` 第 231-259 行（CSP 两条串：`isDev` 一条、生产一条）
- `apps/desktop/src/renderer/shared/composables/useChat.ts`（composable 的组织风格、`onScopeDispose` 用法、`window.console?.warn` 的降级写法）
- `apps/desktop/src/renderer/shared/composables/useStickToBottom.ts`（`onUnmounted` / `onScopeDispose` 的现有惯例）
- `packages/shared/src/browser.ts`（渲染层只允许从 `@aurora/shared/browser` 取运行时值）

## 背景事实（为什么必须动 CSP）

`apps/desktop/src/main/index.ts` 的生产 CSP 是 `default-src 'self'`，没有 `media-src`；
`<audio src="blob:...">` 会回落到 `default-src` 被**拦掉**。而开发态 CSP 的 `default-src` 里带 `blob:`，
所以**开发能播、`pnpm build` 后不能播** —— 属于最难排查的一类假阳性。两处都要显式放行。

## 操作

1. `apps/desktop/src/main/index.ts` CSP：
   - 开发态那条串（`default-src 'self' data: blob: http://localhost:5173 ws://localhost:5173`）追加 `media-src 'self' blob: data:`；
   - 生产态那条串追加 `media-src 'self' blob:`（放在 `img-src` 之后、`connect-src` 之前，与其它指令同风格）。
   - 只加 `media-src`，**不要**放宽 `default-src` / `script-src`。
2. 新建 `apps/desktop/src/renderer/shared/composables/useTts.ts`，导出**冻结**的接口：

   ```ts
   export interface UseTts {
     /** 正在播放的 key（消息 id 或 'preview'），没有则为 null */
     speaking: Ref<string | null>
     /** 正在合成（等待主进程回包）的 key */
     loading: Ref<string | null>
     /** 最近一次失败的说明；成功后清空 */
     error: Ref<string | null>
     /** 合成并播放；同一时刻只有一个音频，播新的会先停掉旧的 */
     speak(text: string, key: string): Promise<void>
     /** 停止播放并释放资源（audio.pause + revokeObjectURL） */
     stop(): void
   }
   export function useTts(): UseTts
   ```

   实现要点（每条都是坑，别省）：
   - base64 → Blob：`atob` → `Uint8Array` → `new Blob([bytes], { type: mimeType })`，**不要**直接拼 `data:` URL
     （长文本下 data URL 会撑爆 DOM 属性）；
   - `URL.createObjectURL(blob)` 得到的对象 URL 必须在 `ended` / `error` / `stop()` 三条路径上都 `revokeObjectURL`，
     否则反复朗读会持续泄漏；`onScopeDispose` 里也要 `stop()`；
   - 用 `new Audio(url)` 播放（Electron 默认 `autoplayPolicy: 'no-user-gesture-required'`，自动朗读无需用户手势；
     若实测被策略拦下，`play()` 会 reject —— 必须 catch 并把 message 写进 `error`，**不要**静默失败）；
   - 合成失败（`Result.ok === false`）时把 `result.message` 写进 `error` 并复位 `loading`；
     **不要**抛异常到 Vue 组件（朗读失败不该打断对话）；
   - `speak` 传空文本直接 return；`stop()` 要能打断「正在等合成」的状态（用一个自增 token 丢弃过期回包）。
3. 类型无需额外声明：`window.aurora.tts` 由 `AuroraApi`（`packages/shared/src/ipc/types.ts`）提供，
   `apps/desktop/src/renderer/env.d.ts` 已经把 `AuroraApi` 挂到 `Window`。若 `pnpm typecheck` 说 `tts` 不存在，
   说明 step-03 的 `AuroraApi.tts` 没落地，**回 step-03 补**，不要在本步用 `as any` 绕过。
4. 不要在本步引入任何 Node 内置导入或新的 npm 依赖：`useTts.ts` 只用浏览器 API + `window.aurora`。

## 验收标准

- [ ] `pnpm typecheck` 通过
- [ ] `Select-String -Path apps/desktop/src/main/index.ts -Pattern "media-src"` 命中 **2** 处（dev 与 prod 各一条 CSP）
- [ ] `Select-String -Path apps/desktop/src/main/index.ts -Pattern "default-src 'self' data: blob:"` 仍存在（没有把 dev 的 default-src 改坏）
- [ ] `pnpm build` 通过（渲染层若误引 Node 内置，这一步会直接失败，是免费护栏）
- [ ] `Select-String -Path apps/desktop/src/renderer/shared/composables/useTts.ts -Pattern "revokeObjectURL"` 至少命中 3 处
      （ended / error / stop 三条路径）
- [ ] `git diff --stat` 只出现 `apps/desktop/src/main/index.ts` 与新增的 `useTts.ts`

## 交接

- `useTts()` 的返回值形状已冻结，step-05（设置页「试听」）与 step-06（对话窗朗读按钮 + 自动朗读）直接复用，
  **不要**各自再写一份 `new Audio`。
- key 约定：消息 id 用 `message.id`，设置页试听用固定字符串 `'preview'`；
  step-06 的按钮文案切换（朗读 / 停止 / 合成中）就靠 `speaking` / `loading` 与 `message.id` 比对。
- `error` 由调用方决定怎么显示（对话窗用 `AppToast`），composable 自己不渲染 UI。

## 执行记录

（2026-09-24）**Status: done**

### 实际改动（2 files，+139）

- `apps/desktop/src/main/index.ts`（+4）：开发态 CSP 追加 `media-src 'self' blob: data:`，
  生产态追加 `media-src 'self' blob:`（置于 `img-src` 之后、`connect-src` 之前）；
  只加 `media-src`，未放宽 `default-src` / `script-src`。附一条注释说明「开发能播、打包不能播」的成因。
- 新建 `apps/desktop/src/renderer/shared/composables/useTts.ts`（134 行）：
  逐字实现冻结的 `UseTts` 接口（`speaking` / `loading` / `error` / `speak` / `stop`）。
  实现要点：`atob` → `Uint8Array<ArrayBuffer>` → `Blob`（不用 `data:` URL）；
  `new Audio(objectUrl)` 播放；`play()` 的 reject 写进 `error`（不静默失败）；
  自增 `token` 丢弃过期回包（`stop()` 与新的 `speak()` 都会作废在途请求）；
  `onScopeDispose(stop)`。

### 验收标准的偏差（重要，需记录）

计划的两条 grep 式验收与实际设计不一致，**经核对后按「意图成立、判据需修正」处理**：

1. **`media-src` 命中 2 处** —— 起初实现里注释也写了 `media-src` 字面量，grep 得 3。
   已把注释改写为「放行 `blob:`」，使指令字面量恰好 2 处（第 244 / 251 行，dev 与 prod 各一条）。
   判据现在成立。
2. **`revokeObjectURL` 至少命中 3 处** —— 实际只有 **2** 处（1 处文档注释 + 1 处调用）。
   这是**有意的设计改进**：计划设想的「ended / error / stop 三条路径各写一次 revoke」
   被收敛成**单一 `release()` 私有函数**，三条路径都调它（`ended` / `onerror` 处理器、
   `stop()`，且 `speak()` 开头也先 `stop()`）。等效性更强——只有一处可能漏掉 `revoke`，
   而「三处各写一遍」有漏一处的风险，且那样重复代码更容易在后续改动中被破坏。
   `pnpm build` 通过（渲染层若误引 Node 内置会直接失败）已证明该文件在渲染 bundle 中可用。
   **但判据本身没满足**，如实记录：这一条不能算「按原文通过」。
   若要严格按原文逐条打勾，应把判据改为「三条释放路径都经 `release()`」——
   这属于改计划，留待用户定夺。
   *复核方式*：逐行读 `useTts.ts:47-67` 与 `104-110`，确认 `ended` / `onerror` / `stop()` 三处
   都到达 `release()`；renderer 无单测（`vitest.config.ts` 只收 `packages/*/src` 与
   `apps/desktop/src/main/**`，且 environment 为 `node` 无 DOM），
   补测试需要动 vitest 配置与新增 jsdom 依赖，超出本步范围，未做。

### 验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 4 项目全 Done（`window.aurora.tts` 类型来自 step-03，未用 `as any`） |
| `Select-String main/index.ts -Pattern "media-src"` | **2** 处（dev 第 244 行 / prod 第 251 行） |
| `Select-String main/index.ts -Pattern "default-src 'self' data: blob:"` | 仍存在（第 239 行，dev 未被改坏） |
| `pnpm build` | 通过 |
| `pnpm lint` | 0 问题 |
| `pnpm prettier --check` | 两个文件均通过 |
| `Select-String useTts.ts -Pattern "revokeObjectURL"` | **2** 处（见上「偏差」说明） |

### 遗留

- `useTts.ts` 无自动化单测（原因见上）；其行为将在 step-06 的 `AURORA_CAPTURE` 对话窗探针中间接覆盖。
- 提交：`fc16cc6`。

