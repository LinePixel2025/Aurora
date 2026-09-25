# Step 04 — 交互窗与小窗的视觉重构与动效

- Task: frontend-refresh
- Step: 4 / 8
- Status: done
- Depends on: step 3
- Produces: 用新设计系统重写的 `renderer/chat/App.vue` 与 `renderer/mini-chat/App.vue`（含交互动效）

## 目标

把用户日常使用最多的两个对话窗口（完整交互窗 420×640、小窗 320×480）改成 Apple 风格：
层级分明的材质、克制的圆角与阴影、流畅且有必要的动效。做完后这两个窗口不残留任何手写的旧令牌硬编码。

## 输入

- 项目根目录：`D:/AICOP/Projects/Aurora`
- 先读：`apps/desktop/src/renderer/chat/App.vue`（401 行）、`apps/desktop/src/renderer/mini-chat/App.vue`（220 行）、
  `apps/desktop/src/renderer/shared/theme.css`（step-03 后的新令牌）、
  `apps/desktop/src/renderer/shared/components/MessageList.vue`、
  `apps/desktop/src/renderer/shared/components/SensitiveToolCard.vue`、
  `apps/desktop/src/renderer/shared/composables/useChat.ts`（消息 / 流式 / 工具事件的数据结构，别改它的行为）。
- 关键约束：
  - 这两个窗口**不做交互语义改动**：会话切换、发送、中断、附件拖拽、工具卡片展开、
    小窗「展开到完整窗口」等行为一律保持，只改外观与动效。
  - 只允许用 `@aurora/shared/browser` 子路径引入运行时常量（本仓库硬约束 4）；本步预计不需要新增依赖。
  - 小窗仍与 `mini-chat` 的「快速会话」绑定，动效不能影响流式追加（不要在每次 `delta` 时重放整段进场动画）。

## 操作

### A. 完整交互窗 `apps/desktop/src/renderer/chat/App.vue`

1. 布局骨架：顶部标题栏（可拖动 `drag-region`，含会话标题 / 新建 / 会话列表入口）、中部消息区、底部输入区。
   容器用 `.glass` 材质 + `--radius-lg`，标题栏与输入区用 `--fill-1` 做「分层」而不是加粗边框。
2. 消息呈现：
   - 用户消息：右对齐胶囊气泡（`--radius-lg`，`--fill-2` 底，最大宽度 ~78%），
     助手消息：左对齐无气泡纯文本块（Apple 风格：助手内容铺开、不套气泡），代码块单独卡片。
   - Markdown 与代码高亮沿用现有 `renderer/shared/markdown.ts` 渲染结果，只调容器样式（代码块用 `--font-mono` + `--radius-sm` + `--fill-2`，
     并加「复制」按钮的 hover 显隐）。
   - 流式态：末尾加一个低频闪烁光标（`@keyframes caret`），**不要**对每条 `delta` 触发进场动画，
     仅对「新插入的整条消息」用 `.anim-rise`。
3. 工具执行卡片：折叠头行显示工具名 + 状态点（复用 `StatusDot`）+ 耗时；展开用 `.collapse-*` 过渡（高度/透明度）。
   状态色沿用 `--status-*` 语义。
4. 输入区（composer）：`--fill-1` 圆角容器（`--radius-lg`），聚焦时加品牌色柔和光晕
   （`box-shadow: 0 0 0 3px rgba(86,132,255,.18)` + 边框转 `--aurora-blue`）；发送按钮为渐变圆形（`--aurora-gradient`），
   禁用态降透明度；`/` 与 `@` 浮层用 `.glass` + `.anim-pop` 进场，键盘上下选择高亮用 `--fill-2`。
5. 会话列表：列表项 `--radius-sm`，当前项用 `--fill-2` + 左侧 3px 品牌色指示条；悬停用 `.interactive`；
   列表展开/收起用 `.sheet-*` 或 `.fade-*`（不要用突兀的 display 切换）。
6. 空状态：居中的品牌渐变圆点 + 一句引导（例如「开始对话」+ 拖入文件的提示），用 `.anim-rise` 进场一次。
7. 敏感工具确认卡（`SensitiveToolCard.vue`）：置顶悬浮，`--shadow-3` + `.anim-pop`；
   倒计时 ≤15s 转 `--status-error`；确认/拒绝按钮用 `AppButton` 的 `primary` / `danger`。行为链路不改。

### B. 小窗 `apps/desktop/src/renderer/mini-chat/App.vue`

8. 与交互窗同一套视觉语言，但更紧凑：气泡 + 流式文本 + 工具状态点（保持 docs/07 §2.4 的「无完整执行卡片」），
   头部保留「展开到完整窗口」按钮（图标 + hover 提示）。
9. 小窗是浮动小面板：整窗 `--radius-lg` + `--shadow-2`，头部 `drag-region`，无系统边框感；
   消息区滚动条细圆角；新消息进场用 `.anim-rise`（位移 4px，比大窗更轻）。
10. 流式时头部状态点走 `StatusDot` 的呼吸动画；回复完成后若窗口未聚焦，仍保持静态（不做系统级闪烁）。

### C. 一致性收尾

11. 两窗的 `scoped` 样式里 **不得出现字面量颜色**（`#xxx` / `rgba(...)` 除外：只允许用于品牌渐变与聚焦光晕这类需要精确值的场景），
    能换令牌的一律换；重复的 `.page` / 头部样式改用 step-03 的全局类。
12. 所有过渡统一走 `theme.css` 的缓动与时长令牌；`prefers-reduced-motion` 下位移类动画自动降级（由 step-03 的全局规则兜底，
    不要在组件里再写一份 media query）。

### D. 验证与提交

13. `pnpm format:check && pnpm lint && pnpm typecheck && pnpm build` 全绿。
14. 用截图核对：`AURORA_CAPTURE=<临时目录> AURORA_CAPTURE_WINDOWS=chat,mini-chat pnpm dev`，
    然后**逐张 Read PNG 亲自看**：确认无溢出、无重叠、层级清楚、对比度足够（正文与背景可辨）。
    如需看空状态与有消息态两种形态，可在截图前用自测桩让会话里有一条消息（或手动在 dev 里发一条再截）。
15. 真机交互核对（用 step-02 记录的脱离会话启动方式）：发送一条消息看流式光标与工具卡片状态推进；
    点工具卡片展开/收起过渡顺滑；小窗「展开到完整窗口」正常。
16. 提交 `refactor(ui): 交互窗与小窗改用 Apple 风格设计令牌与动效`。

## 验收标准

- [x] `pnpm typecheck && pnpm test && pnpm build` 通过，`AURORA_SMOKE=1 pnpm dev` 的对话链路断言仍全绿
      （说明消息 / 工具 / 附件行为没被外观改动破坏）—— Lead 实跑 **93/93 passed**。
- [x] `chat.png` 与 `mini-chat.png` 人工核对通过：布局不溢出、无内容被裁切、层级与对比度符合设计基线。
- [x] 流式追加时**没有**整段重放动画 —— 结构性证明：`<TransitionGroup>` 以 `message.id` 为 key，
      只有新插入的消息带 `.rise-enter-*`；增量只 patch `v-html`；光标是父级 CSS `::after`，与 delta 无关。
      **未做**「人眼盯着看一次真实流式」这一步（需要配置可用的模型），属已知的验证缺口。
- [x] 工具卡片展开 / 收起有过渡而非瞬变（`.collapse-*` 的 `max-height` + `opacity`）；
      `prefers-reduced-motion` 打开后位移类动画不再播放 —— 由 step-03 的 theme.css 全局规则兜底，
      两个窗口内**没有**任何自己的 `@media`（grep 为空），降级路径唯一。
- [x] 这两个文件里不再残留旧的手写过渡字面量，统一走令牌（grep 确认；唯一非令牌时长是流式光标的
      `animation: 1.1s`，与 `StatusDot` 的 `breathe 1.8s` 同属动画而非过渡）。

## 执行记录

### 实际改动（4 个文件，全部在写入范围内）

- `chat/App.vue`：`.glass` + `--radius-lg`；标题栏两行；会话列表 3px 品牌指示条 + `.interactive` +
  `.sheet-*`；输入区 `--fill-1` 圆角容器 + `:focus-within` 光晕 + 渐变圆形发送按钮；流式末尾光标；
  顺手修掉 `.wrap` 失效导致附件不换行。
- `mini-chat/App.vue`：同套视觉语言但更紧凑；头部图标按钮（展开 / 隐藏 + `title`）；空状态文案去掉
  已删除的「服务窗」入口。
- `shared/components/MessageList.vue`：用户消息右对齐胶囊气泡 / 助手消息左对齐纯文本块；
  代码块卡片 + hover 显隐「复制」（**在 `markdown.ts` 已转义的白名单 HTML 上按标记补结构**，
  不引入依赖、不改其输出契约）；`<TransitionGroup name="rise">`；工具卡片改折叠头行 + `.collapse-*`。
  复制按钮走事件委托（`v-html` 生成的 DOM 由 Vue 之外产生），剪贴板优先 `navigator.clipboard`，
  失败回落 `execCommand`。
- `shared/components/SensitiveToolCard.vue`：仅样式（`--shadow-3` + `.anim-pop` + 语义令牌）。

### 与计划的差异（均已说明理由）

1. 计划 A4 的 `/`、`@` 补全浮层**在代码里不存在对应功能**（composer 只有 textarea + Enter 发送，
  没有补全数据源）。按「不做交互语义改动」未凭空造，已记入 docs/07 §2.3「未实现」。
2. 计划 A3 的「耗时」：`AgentToolCall` 没有时间字段，改为**渲染层观察到的本次调用耗时**，
   历史水合出的卡片不显示耗时（不伪造数据）。要真实耗时需改 `agent-core` / 契约，属另一步。
3. 标题栏含「新建」后与历史面板里的「新建」重复（保留了两处，未去重）。
4. 敏感工具卡按**流内置顶**处理，没有做 `position: absolute` 悬浮覆盖（避免最长 60s 的倒计时遮住正文）。
5. 发送按钮由文字「发送」改为渐变圆形箭头图标 + `aria-label` / `title`。

### 验证命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm format:check` / `pnpm lint` / `pnpm typecheck` | 全绿 |
| `pnpm test` | 43 文件 / 595 用例通过 |
| `pnpm build` | 成功 |
| `AURORA_SMOKE=1 pnpm dev` | **93/93 passed**（对话循环、工具卡片状态、附件链路断言未受影响） |
| `AURORA_CAPTURE` | `chat.png` / `mini-chat.png` 非空；Lead 逐张读图确认无溢出、无裁切、层级与对比度正常 |

另由子代理自证（未改仓库）：`@vue/compiler-sfc` 编译 4 个 SFC 无错误；
用真实 `renderMarkdown` 输出验证复制按钮注入（含含 `</pre>` 的恶意样本 → 已被转义，结构未被打破）。

### git 提交

- `38d395f` `refactor(ui): 交互窗与小窗改用 Apple 风格设计令牌与动效`（4 文件）

### 遗留

- 小窗不是透明窗，`--radius-lg` 圆角与 `--shadow-2` 在桌面上不会真正呈现为浮动卡片 ——
  已作为已知限制写入 docs/07 §2.4，要改需动主进程（本轮未做）。
- 「真人观看一次真实流式」这一条验证缺口保留，已在验收标准里如实标注。
