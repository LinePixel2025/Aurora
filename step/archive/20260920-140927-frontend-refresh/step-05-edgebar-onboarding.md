# Step 05 — 提示条与首次引导的视觉重构与动效

- Task: frontend-refresh
- Step: 5 / 8
- Status: done
- Depends on: step 3
- Produces: 用新设计系统重写的 `renderer/edge-bar/App.vue` 与 `renderer/onboarding/App.vue`（含交互动效）

## 目标

提示条是删除 AI 悬浮窗后**唯一的常驻入口**，它必须好看且一眼看懂；首次引导是新用户看到的第一屏，同样要对齐 Apple 风格。
做完后这两个窗口与其他窗口视觉统一，且提示条在 220px 的面板宽度预算内排版正确。

## 输入

- 项目根目录：`D:/AICOP/Projects/Aurora`
- 先读：`apps/desktop/src/renderer/edge-bar/App.vue`（step-02 改过交互，注意 vol 保留行为）、
  `apps/desktop/src/renderer/onboarding/App.vue`（581 行）、
  `apps/desktop/src/renderer/shared/theme.css`（step-03 后的令牌）、
  `apps/desktop/src/renderer/shared/components/`（`AppButton` / `StatusDot` / `SettingField` 等）。
- 关键约束：
  - **提示条面板宽度预算是 220px**（窗口展开态 228px 减去 8px 竖条），超出就会被裁切或被 `overflow` 吃掉。
    这是 step-02 定的几何约定，改布局前先确认不会突破。
  - 提示条交互（悬停延迟展开、点击竖条 → `showChat()`、面板四个按钮、`mouseleave` 延迟收起）由 step-02 落地，
    本步**只换外观与动效**，不改事件绑定与 IPC 调用。
  - 提示条窗口 `focusable: false`，不要依赖键盘焦点与 `:focus-visible` 做唯一反馈。
  - 引导页窗口 720×560、`resizable: false`，布局必须在固定尺寸内成立。

## 操作

### A. 提示条 `apps/desktop/src/renderer/edge-bar/App.vue`

1. 收起态竖条（8px 宽，全高 200px）：改为更精致的形态——品牌渐变细条 + 顶部/居中一个状态点，
   圆角改左侧圆角（`--radius-pill` 的一半效果，例如 `border-radius: 6px 0 0 6px`），加 `--shadow-1` 让它与桌面有分离感。
   悬停时竖条加亮（`filter: brightness(1.12)` + 宽度微增 8→10px，用 `--ease-spring`），作为「可交互」的提示。
2. 展开面板（宽 220px）：`--radius-lg` + `.glass` 材质 + `--shadow-3`，左缘圆角、右缘贴屏幕边（`border-radius: var(--radius-lg) 0 0 var(--radius-lg)`）。
   内部由「状态块 → 当前模式 → 最近消息 → 系统状态 → 操作区」组成：
   - 每个 block 之间用 `--fill-1` 分组卡片或 `--border-subtle` 分隔线（二选一，全局统一），不要混用；
   - 状态行复用 `StatusDot` + `--weight-medium` 的状态文案；
   - 最近消息预览截断用 `-webkit-line-clamp: 3` 而不是固定 slice 字数导致的半行文字；
   - 系统状态行用 `--text-sm` / `--text-secondary`。
3. 操作区四个按钮（打开对话窗口 / 设置 / 小窗对话 / 隐藏提示条）：改用共享 `AppButton`（`ghost` 变体、`sm` 尺寸、整行左对齐），
   悬停用 `--fill-2`；「打开对话窗口」用 `primary` 变体作为主操作，视觉上明确它是主入口。
4. 动效：面板进场用 `.sheet-*`（从右滑出 + 淡入，`--dur-base` / `--ease-spring`），而不是只做透明度；
   面板内 block 依次以 30ms 递增延迟做 `.anim-rise`（`animation-delay` 实现，最多 5 个，避免排队过长）；
   在 `prefers-reduced-motion` 下由 step-03 的全局规则自动降级。
5. 品牌感：竖条与面板顶部加一条极细的 `--aurora-gradient` 高光（1px），作为 Aurora 的识别元素，不要满屏渐变。

### B. 首次引导 `apps/desktop/src/renderer/onboarding/App.vue`

6. 结构整理为「进度指示 + 单步内容 + 底部操作」三段式：
   - 顶部：步骤圆点进度（当前步用 `--aurora-gradient`，已完成用 `--text-muted`，未开始用 `--fill-2`）+ 可拖动的标题栏；
   - 中部：当前步内容（说明 + 表单 + 校验提示），步骤切换用 `.sheet-*` 或 `.collapse-*` 横向滑动
     （方向要跟「下一步/上一步」一致，不要两个方向同一个动画）；
   - 底部：`AppButton` 的「上一步」`ghost` / 「下一步·完成」`primary`，主按钮在窗口右下角视觉锚点位置。
7. 表单控件全部改用共享 `SettingField`（label + hint + control），消除页面内自写 `.input` 样式；
   错误提示用 `AppToast tone="error"` 或 `--status-error` 内联文案，二选一后全文统一。
8. 进度与反馈：模型连接测试 / 目录选择等异步动作要有「进行中」态（按钮 spinner 或 `StatusDot running`），
   不要把按钮点了没反应当成正常。
9. 完成页：品牌渐变 + 一句「一切就绪」，用 `.anim-rise` 依次进场（标题 → 说明 → 按钮），
   保持 step-01 改过的收尾行为（显示提示条或交互窗）不变。

### C. 验证与提交

10. `pnpm format:check && pnpm lint && pnpm typecheck && pnpm build` 全绿。
11. 截图核对：`AURORA_CAPTURE=<临时目录> AURORA_CAPTURE_WINDOWS=edge-bar,onboarding pnpm dev`，
    得到 `edge-bar.png`、`edge-bar-expanded.png`、`onboarding.png`，**逐张 Read 亲自看**：
    - 展开态面板内所有文字在 220px 内不裁切、不出现横向滚动；
    - 引导页在 720×560 内不溢出、不出现滚动条；
    - 无重叠、对比度足够。
    注意：提示条窗口是 `transparent: true`，PNG 的透明区域可能显示为黑或棋盘格，这是预期，不是 bug。
12. 真机核对（脱离会话启动）：悬停展开的手感（延迟是否自然）、面板按钮可点、点击竖条拉起交互窗、
    移开鼠标后收回 8px；引导页逐步走一遍「上一步 / 下一步」的切换方向是否正确。
13. 提交 `refactor(ui): 提示条与首次引导改用 Apple 风格设计令牌与动效`。

## 验收标准

- [x] `pnpm typecheck && pnpm test && pnpm build` 通过；`AURORA_SMOKE=1 pnpm dev` 全绿（Lead 实跑 **93/93**）。
- [x] `edge-bar.png` / `edge-bar-expanded.png` / `onboarding.png` 人工核对通过；展开面板无裁切、无横向滚动
      （Lead 逐张读图；DOM 探针同时断言面板内容区 220px、窗口宽 228px、4 个按钮全部落在窗口内）。
- [x] 展开面板宽度实测 ≤ 220px 内容区：`edge-bar/App.vue` 只有一处 `width: 220px`，
      探针实测 `styled: "220px"` / `windowWidth: 228`，无 >220 的固定宽度声明。
- [x] 提示条交互（悬停展开、点击呼出、四个按钮、移开收起）与 step-02 完全一致，行为零回归
      （事件绑定与 IPC 调用逐行未改；探针 `allClickable: true`、点击后 `chatVisible: true, miniChatVisible: false`）。
- [x] 引导页固定尺寸内无滚动条、无溢出（静态预算 + 截图核对）；步骤切换动画方向与操作方向一致
      （`sheet-next` / `sheet-prev` 两套独立动画）。
- [x] 两个文件不再残留旧令牌硬编码与手写 `.input` 样式（grep：0 处 `#hex` / `rgba(`、
      0 处 `.input`、0 处写死过渡时长；50 个 `var(--*)` 引用全部在 theme.css 有定义）。

## 执行记录

### 实际改动（2 个文件）

- `edge-bar/App.vue`：8px 极光竖条（状态点 + 悬停加亮与 8→10px 微增宽 + `--shadow-1`）
  + 220px 全高玻璃面板（`.glass` + `--radius-lg 0 0 --radius-lg` + `--shadow-3` + 顶部 1px 品牌高光）；
  面板内 5 个 `--fill-1` 分组卡片（状态 / 当前模式 / 最近消息 / 今日课程 / 系统状态）+ 底部 4 个 `AppButton`；
  进场 `name="sheet"` + 5 段 30ms 递增 `.anim-rise`。
- `onboarding/App.vue`：三段式（圆点进度 + 单步内容 + 底部操作），`sheet-next` / `sheet-prev`
  方向正确的切换，表单统一 `SettingField`，错误统一 `AppToast tone="error"`，异步动作有进行中态，
  完成页「一切就绪」渐进入场。

### 与计划的差异（均已说明理由）

1. **面板 `right: 0` → `right: 8px`**（唯一几何改动）：基线里面板盖住右缘 8px 竖条，
   导致 docs/07 §2.2 写的「展开态竖条仍是有效点击目标」实际不成立、竖条的悬停反馈也看不见。
   改后 228 = 220 面板 + 8 竖条，竖条始终贴屏幕右缘且可点（探针实测它仍能被 `elementFromPoint` 命中）。
2. **`onMounted` 调一次只读的 `chat.hydrate()`**：基线里该窗口从不水合，「最近消息」永远是空文案，
   等于一个死块。只读取、不写入、不改事件绑定，且能让面板中部（`flex: 1 1 auto`）有真实内容。
3. 删掉引导第一步的「界面语言」选择器（`form.language` 既未持久化也无消费方），与 step-06 一致。
4. 过期文案：「顶置 AI 服务窗」→「屏幕右侧提示条」。
5. 展开态竖条现在是**全高**（随窗口 200↔972px 伸缩，状态点与字标垂直居中）。
   若想要「200px 短手柄」形态，给 `.strip` 加 `height: 200px; align-self: center` 即可。

### 验证命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm format:check` / `pnpm lint` / `pnpm typecheck` | 全绿 |
| `pnpm test` | 43 文件 / 595 用例通过 |
| `pnpm build` | 成功 |
| `AURORA_SMOKE=1 pnpm dev` | **93/93 passed**（提示条两态真实窗口几何、互斥、点击链路断言全过） |
| `AURORA_CAPTURE` DOM 探针 | 面板 4/4 按钮 `hit=true`、`allClickable=true`、`styled=220px`、`windowWidth=228`、`windowHeight=972` |
| 人工读图 | `edge-bar.png` / `edge-bar-expanded.png` / `onboarding.png` 无裁切、无横向滚动，全高面板排版成立（分组卡片 + 底部操作区） |

### git 提交

- `cf903f5` `refactor(ui): 提示条与首次引导改用 Apple 风格设计令牌与动效`（2 文件）

### 遗留

- 展开态全高面板中「最近消息」卡片仍会吸收较大空白（空会话时尤甚），这是刻意让全高面板
  不至于只有上下两段内容；后续若要更紧凑可把面板高度收敛到内容高度。
- 真机手感（悬停 120ms / 收起 220ms 是否自然）没有人工核对的证据，只有参数与实现符合计划。
