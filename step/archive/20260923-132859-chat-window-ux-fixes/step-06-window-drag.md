# Step 06 — 窗口拖动统一（共享 composable + 四窗覆盖 + 探针改到 chat）

- Task: chat-window-ux-fixes
- Step: 6 / 8
- Status: done
- Depends on: step 1
- Produces: `apps/desktop/src/renderer/shared/composables/useWindowDrag.ts` + 各窗标题栏统一走同一套规则 + 一条拖动命中探针 + docs/07 §1/§2 更新

## 目标

用户问题 5 落地：每个能拖的窗口都有**够大、位置可预期**的拖动条，「哪些窗口能拖」由一份显式清单决定，
而不是各窗自己记得加没加 `drag-region` 这个 class。

## 现状事实（拆解时已核实）

- `-webkit-app-region` 只有两条原子类：`apps/desktop/src/renderer/shared/theme.css:196-202`。
- 用到 `drag-region` 的只有四处的**局部元素**：
  `chat/App.vue:174`（`.head`）、`onboarding/App.vue:204`（`.head`）、
  `settings/App.vue:102`（侧栏里的 `.brand`，高度只有约 22-30px，是「有些能拖有些不行」最直接的原因）。
  `mini-chat` 的那处（原 `mini-chat/App.vue:82`）已由 step 1 删除。
- `edge-bar` 用不了拖动：它的 `BrowserWindow` 是 `focusable: false`（`window-manager.ts:60`），
  且几何完全由「工作区右缘 + 垂直居中 + 折叠态」推导（`window-manager.ts:570-576` 明确写了「不参与用户拖动」）。
- 主进程侧不需要新通道：拖动由 Chromium 的 app-region 机制完成，位置记忆已有
  `moved` 事件 → `persistGeometry`（`window-manager.ts:243`）。

## 输入

- `apps/desktop/src/renderer/shared/theme.css:194-203`
- `apps/desktop/src/renderer/chat/App.vue`（step 1 改过 `.head` / `.head-actions`）
- `apps/desktop/src/renderer/settings/App.vue:99-157` 与 `:159-218`（`.sidebar` / `.brand` / `.content`）
- `apps/desktop/src/renderer/onboarding/App.vue:201-215`（`.head` / `.progress-wrap`）
- `apps/desktop/src/renderer/edge-bar/App.vue`（只需加注释，不改行为）
- `apps/desktop/src/main/capture.ts`（`EDGE_BAR_PANEL_SCRIPT` 的命中测试写法可照抄）
- `docs/07-ui-spec.md` §1 设计原则、§2.2-§2.6 各窗规格

## 操作

### 1. 共享 composable

1. 新建 `apps/desktop/src/renderer/shared/composables/useWindowDrag.ts`：

   ```ts
   /** 允许用户拖动的窗口（显式清单，docs/07 §1）。 */
   export const DRAGGABLE_WINDOWS = ['chat', 'settings', 'onboarding'] as const
   export type DraggableWindow = (typeof DRAGGABLE_WINDOWS)[number]

   export function isDraggableWindow(name: WindowName): name is DraggableWindow

   /**
    * 拖动区规则。
    *
    * 为什么要有这个东西：拖动能力此前靠各窗自己记得挂 `drag-region` class，
    * 结果 settings 窗只有侧栏里约 28px 的一小块能拖，用户感知就是「有些能拖有些不行」。
    * 现在把「哪些窗口能拖」收敛成一份显式清单，模板里用 `:class="dragClass"` 统一挂。
    */
   export function useWindowDrag(name: WindowName): {
     draggable: boolean
     /** 挂在拖动条元素上的 class（不可拖窗口返回空串） */
     dragClass: string
     /** 挂在拖动条内部交互元素上的 class（不可拖窗口返回空串） */
     noDragClass: string
   }
   ```

   - `dragClass` 为 `'drag-region'` / `''`，`noDragClass` 为 `'no-drag'` / `''`。
   - 不要在这里读 `window.aurora`（保持纯函数，渲染层组件挂载前也能用）。

### 2. 各窗接线

2. `apps/desktop/src/renderer/chat/App.vue`
   - `const { dragClass, noDragClass } = useWindowDrag('chat')`。
   - `<header class="head" :class="dragClass">`、按钮区 `:class="noDragClass"`（替换写死的 class）。
   - 确认 `.head` 高度 ≥ 40px（现在是两行：标题 + 操作），保持现状即可。
3. `apps/desktop/src/renderer/onboarding/App.vue`
   - 同样改成 `useWindowDrag('onboarding')`；`.progress-wrap` 用 `noDragClass`。
4. `apps/desktop/src/renderer/settings/App.vue`（本步主要改动）
   - 目标：**侧栏整个顶部区域都能拖**，且 `.content` 顶部有一条足够高的拖动带，
     解决「只有 22px 品牌行能拖」的问题。做法：
     - `.sidebar` 加上 `padding-top: 0`，并在侧栏最前面放一个 `<div class="sidebar-drag" :class="dragClass" aria-hidden="true" />`
       （`height: var(--space-4)` 量级的透明条），`.brand` 本身保留 `dragClass`。
     - `.brand` 增加 `min-height: 36px`，让拖动条高度可见地变大。
     - `.content` 里加一条顶部拖动带 `<div class="content-drag" :class="dragClass" aria-hidden="true" />`，
       `height: 10px; flex: 0 0 auto;`，并在 `.content` 上加 `display: flex; flex-direction: column;`
       （若现有 `.content` 已是滚动容器，用 `position: sticky; top: 0; z-index: 1;` 保证它始终在顶部且不随内容滚走。
       **选哪种以不破坏现有页面滚动为准**：改完必须手工滚一遍 7 个设置页确认没有内容被压住或无法滚动）。
     - 关闭按钮继续保留 `no-drag`。
   - ⚠️ 同文件写冲突提醒：`settings/App.vue` **只在本步改**；
     step 4 与 step 5 只改 `pages/LlmPage.vue` 与 `chat/App.vue`，
     本步不要顺手改这两个文件里与拖动无关的部分。
     三个步骤都依赖 step 1 完成；彼此文件不重叠，可以并行。
5. `apps/desktop/src/renderer/edge-bar/App.vue`
   - 行为不变，只在文件头注释里补一句：
     「提示条窗口 `focusable: false` 且几何由主进程推导，**刻意不提供拖动**（docs/07 §2.2）」。

### 3. theme.css

6. `apps/desktop/src/renderer/shared/theme.css`
   - 给 `.drag-region` 补一条自解释注释与一条保险规则：

     ```css
     .drag-region {
       -webkit-app-region: drag;
       /* 拖动区默认不吃点击（按钮必须自己挂 .no-drag）——写在这里是为了让后人一眼看到这条约束 */
     }

     /* 拖动区内的交互元素：逐个挂 .no-drag 容易漏，这里按标签兜一层底 */
     .drag-region :is(button, input, select, textarea, a, [role='button'], [contenteditable='true']) {
       -webkit-app-region: no-drag;
     }
     ```

   - `:is(...)` 的优先级会被 `.no-drag` 覆盖，两者不冲突；若实测发现某处按钮仍点不到，
     以**显式挂 `no-drag`** 为准（兜底规则只是保险，不是替代）。

### 4. capture 探针

7. `apps/desktop/src/main/capture.ts` 新增 `WINDOW_DRAG_SCRIPT`：

   ```
   思路（照 EDGE_BAR_PANEL_SCRIPT 的命中测试风格写）：
   - 读 document.querySelectorAll('.drag-region')，对每个元素用 getBoundingClientRect() 量高度；
     若不可见（height/width 为 0）则跳过。
   - 取所有可见拖动区的最大高度 maxHeight、并按文档顺序记录 { tag, cls, w, h, top }。
   - 命中测试：至少有一个可见拖动区，且 **maxHeight >= 32**（足够用户抓住）。
   - 交互元素不被拖动区吃掉：在拖动区内部找第一个 button，量其中心点做
     document.elementFromPoint()，断言命中的是它本身或它的后代。
   - 读取生效的 app-region 值要兼容两种属性名（Chromium 上可能只认其一）：
     const css = getComputedStyle(el);
     const region = css.getPropertyValue('-webkit-app-region') || css.getPropertyValue('app-region');
     断言其 trim() === 'drag'。
   - pass = 至少一个可见拖动区 && maxHeight >= 32 && region === 'drag' && 交互元素命中自己。
   ```

   返回值要带 `regions` 数组，失败时能直接看出是「没挂类」还是「挂了但太小」。
8. `defaultCapturePlan`：给交互窗与设置窗各加一条独立场景（`CaptureTarget.check` 只接受单个字符串，
   不能把 `WINDOW_DRAG_SCRIPT` 追加到已有场景的 `check` 上）：
   `{ name: 'chat', file: 'chat-drag.png', check: WINDOW_DRAG_SCRIPT }` 与
   `{ name: 'settings', file: 'settings-drag.png', query: { page: 'general' }, check: WINDOW_DRAG_SCRIPT }`。
   （若你想改成 `check` 支持数组，那是**本步范围外**的工具改动，不要顺手做——
   会让 `report.json` 结构与既有验收脚本不兼容。）
   - 交互窗场景的全局顺序由 step 3 定死：`thinking-level` → `model-picker` → `drag` → `collapse`
     → `chat.png`。`chat-drag.png` 必须排在 `chat-collapse.png` **之前**（收起会隐藏窗口，之后做不了 DOM 操作）。
9. `docs/07-ui-spec.md`
   - §1 设计原则加一条：「能拖的窗口有显式清单（`DRAGGABLE_WINDOWS`），拖动条高度 ≥ 32px；
     提示条不可拖（几何由主进程推导）」。
   - §2.2 补一句「提示条不可拖动」的理由；§2.5 设置窗补「侧栏顶部与内容区顶部均可拖」。
   - §5.3 截图清单补 `chat-drag.png` / `settings-drag.png`。

## 验收标准

- [ ] `node apps/desktop/node_modules/vue-tsc/bin/vue-tsc.js -p apps/desktop/tsconfig.web.json --noEmit` 退出码 0
- [ ] `node node_modules/typescript/bin/tsc -p apps/desktop/tsconfig.node.json --noEmit` 退出码 0
- [ ] `pnpm build` 成功
- [ ] `grep -rn 'drag-region' apps/desktop/src/renderer/` 的命中全部经由 `useWindowDrag` 或 `theme.css`，
      没有第三个窗口自己写死 `class="... drag-region"`（用 grep 逐条核对）
- [ ] `$env:AURORA_CAPTURE="$env:TEMP\aurora-capture"; pnpm dev` 结束后 `report.json` 里
      `chat-drag` 与 `settings-drag` 两条 `check.pass === true`，进程退出码 0
- [ ] 手工确认（必须真的点一次，不要只看代码）：设置窗在侧栏品牌行、侧栏顶部空白处、内容区顶部
      这三处都能按住拖动窗口；7 个设置页滚到底部时内容没有被拖动带回弹压住
- [ ] `report.json` 里既有条目（`edge-bar-expanded` 的 3 按钮断言、`chat-collapse`、
      `chat-model-picker`、`settings-llm-params`）无新增 FAIL

## 交接

- 给 step 7：capture 计划现在新增了 `chat-drag.png`、`settings-drag.png` 两条场景，
  以及 step 1/3/4/5 的新场景；全量跑的 FAIL 清单要以这一版为准。
- ⚠️ 写冲突：本步与 step 3、step 5 都要改 `apps/desktop/src/main/capture.ts` 的
  `defaultCapturePlan`。**不要并行改这个文件**——串行执行（3 → 5 → 6）或指定一人独占。
  本步新增的两条场景与既有场景的先后顺序：`chat-drag.png` 必须排在 `chat-collapse.png` 之前。
- 待确认项：若 `getComputedStyle` 在 Electron 33 上返回的 `-webkit-app-region` 为空串，
  说明该属性不可读——此时**不要**把探针改成永远 PASS，而是改成「按 `regions` 数组的存在性与尺寸」判定，
  并在 `report.json` 里保留 `region` 原始值，同时在 `docs/07 §5.3` 注明该属性不可读。
  （真实拖动仍可手测；这条待确认项的处置方式必须写进执行记录。）

## 执行记录

- 执行时间：2026-09-22（执行会话）；状态：**done**；提交：`0478fed`（文档在 `26b5aed`、探针在 `6c98e76`、
  `chat/App.vue` 的 3 行接线在 `82ce244`）。

### 分片与结果

| 分片 | 负责文件 | 结果 |
|---|---|---|
| 子代理 · 拖动统一 | `shared/composables/useWindowDrag.ts`（新建）、`settings/App.vue`、`onboarding/App.vue`、`edge-bar/App.vue`（仅注释）、`shared/theme.css` | `DRAGGABLE_WINDOWS` 显式清单；settings 侧栏顶部 `.sidebar-drag`(16px) + `.brand`(min-height 36px) + 内容区 `.content-drag`(10px)；`theme.css` 兜底 `:is(button, input, …) { no-drag }` |
| Lead · `chat/App.vue` 接线 | `chat/App.vue` | `useWindowDrag('chat')` + `<header class="head" :class="dragClass">` + `.head-actions :class="noDragClass"`（原为写死 class） |
| Lead · 探针 | `capture.ts`（`WINDOW_DRAG_SCRIPT`） | 见 `6c98e76` |
| 子代理 · 文档 | `docs/07 §1/§2.2/§2.5/§5.3` | 见 `26b5aed` |

### 滚动方案选择（子代理判断，Lead 复核截图认可）

选「普通 flex 子项」而非 `position: sticky`：sticky 会把 10px 带子永久钉在视口顶部 ——
带子透明、截图看不出来，但那 10px 里的按钮点不到，是最难排查的隐形遮挡；
普通流内的带子随内容滚出视口，任何滚动位置都不与内容重叠。代价是 7 个设置页整体下移 10px
（已用负 margin 抵消 `.content` 的 gap，否则低 22px），截图核对首屏布局正常。

### 验收（Lead 亲自复跑）

| 命令 | 结果 |
|---|---|
| `vue-tsc` / `tsc(tsconfig.node)` / prettier / eslint | ✅ 全绿 |
| `AURORA_CAPTURE`（全量） | ✅ 退出码 0；`chat-drag` `pass:true`（`maxHeight:71, regionValue:"drag", buttonHit:true`）；`settings-drag` `pass:true`（`regions`: `.sidebar-drag` 16px / `.brand` 39px / `.content-drag` 10px，`maxHeight:39`，按钮 `✕` 命中自身） |
| `grep -rn 'drag-region' apps/desktop/src/renderer/` | ✅ 命中全部来自 `useWindowDrag` 或 `theme.css`，无第三个窗口写死（chat 的写死用法已在本步改掉） |
| `read_image settings-drag.png` | ✅ 侧栏顶部与内容区顶部可见拖动区，页面内容未被压住 |

### 计划里的「待确认项」处置结论（必须记录）

- **`-webkit-app-region` 计算值可读** —— 探针实测 `regionValue: "drag"`（`chat` 与 `settings` 两处都是），
  因此**不需要**退化成「按 regions 尺寸判定」的备选口径；`WINDOW_DRAG_SCRIPT` 保留严格三条件判定
  （可见拖动区 + 最大高度 ≥ 32 + `region === 'drag'` + 区内首个按钮 `elementFromPoint` 命中自身），
  失败时仍回传完整 `regions` 供排查。`docs/07 §5.3` 里对应的备选说明保留为「万一读不出时的处置原则」。
- **窗口缩放取舍**：settings 是 `frame:false + resizable:true`；侧栏那一列（左侧 200px）的上边缘
  现在从缩放热区变成拖动区，右侧 700px 的上边缘（24px 非拖动内边距）仍可缩放。
  这是无边框窗口自定义标题栏的常规取舍，**保留现状**（未再做改动）。

### 遗留

- 未做真人手测拖动（本环境只能跑探针与截图）：`AURORA_CAPTURE` 验证的是
  「拖动区存在、够大、属性生效、区内按钮不被吃掉」，真机手感仍需用户点一次确认。
