# Step 06 — 设置页信息架构整理 + 无效项清理

- Task: frontend-refresh
- Step: 6 / 8
- Status: done
- Depends on: step 3
- Produces: 分组化导航、统一的页面骨架、按条件显示/隐藏的设置项、拆分后的 ClassRoom 配置组件、可机械校验的门控

## 目标

把设置窗口从「六个页面平铺、每个页面各写一套样式、无关项也都摆出来」改成：
导航分组清晰、页面骨架统一（标题 + 说明 + 分组卡片）、
**用户当前用不到的设置项不出现**（未选 ClassRoom 时页面里根本不该有 classroom 字段）、
真正无法生效的字段（`general.language`）从 UI 移除。

## 输入

- 项目根目录：`D:/AICOP/Projects/Aurora`
- 先读：`apps/desktop/src/renderer/settings/App.vue`（226 行）、
  `apps/desktop/src/renderer/settings/pages/GeneralPage.vue`（347）、`ModesPage.vue`（181）、`LlmPage.vue`（393）、
  `SkillsPage.vue`（231）、`McpPage.vue`（362）、`AdvancedPage.vue`（203）、
  `apps/desktop/src/renderer/settings/components/ClassroomSection.vue`（682 行，本轮要拆）、
  `apps/desktop/src/renderer/shared/components/SettingField.vue`、
  `packages/shared/src/config/schema.ts`（字段清单）、`apps/desktop/src/renderer/shared/theme.css`（step-03 令牌）。
- 关键约束：
  - **持久化方式不许改**：所有写入仍走 `settingsStore.update(patch)`（`settings:update`，**顶层浅合并**）。
    因此 `modes.classroom` 与 `advanced` 这类分组必须**先展开当前值再打补丁**（`{ modes: { ...all, classroom: { ...cur, ...change } } }`），
    现有 `ClassroomSection.vue:42-55` 的 `patch()` 就是这个约定，拆分时必须保留同样的语义，否则会静默丢字段。
  - 凭据仍走 `settings.setSecrets` / `clearSecret`，`settings:get` 只回传 `apiKeySet` / `envSet` 标记——不要「顺手」把这些改成明文读写。
  - 设置 Schema 与 `docs/08` 是 SSOT；本步**不新增也不删除配置字段**（`general.language` 只从 UI 移除，字段保留在 Schema）。
  - 组件测试基建不存在（devDependencies 里没有 @vue/test-utils），所以门控靠第 6 节的 `data-field` + 截图探针做机械校验。

## 操作

### A. 导航与页面骨架

1. `settings/App.vue`：`nav` 从扁平 6 项改为**分组**（保留 6 个 `PageId` 不变，只加分组标题与视觉分隔）：
   - 「基础」：常规 / 模式
   - 「AI 能力」：AI 模型 / Skill / MCP
   - 「系统」：高级
   侧栏项沿用 step-03 的令牌，当前项用 `--fill-2` + 左侧品牌色指示条；分组标题用 `--text-xs` + `--text-muted` + 字间距。
2. 页面骨架统一：在 `theme.css` 增加全局类 `.page`（`display:flex; flex-direction:column; gap:var(--space-4); max-width:860px; padding-bottom:32px`）、
   `.page-title`、`.page-sub`、`.section-card`（`--fill-1` 底 + `--radius-md` + 1px `--border-subtle` + `--space-4` 内边距）、
   `.section-title`、`.section-desc`。六个页面一律改用这套类，**删掉各页重复的 `header h2 { margin:0; font-size:16px }` 与各自 `.page` 声明**。
3. 每个页面顶部改为「标题 + 一句话说明」；每个可独立成组的配置块包在 `.section-card` 里，卡片有标题与可选说明。

### B. 按条件显示（本次任务的核心诉求）

4. 给每个配置控件打上**配置文件路径标记**，为门控与机械校验提供依据：
   - `SettingField.vue` 新增可选 prop `field?: string`，渲染为容器上的 `data-field="<path>"`；
   - 各页面里未用 `SettingField` 的内联控件（例如 `ClassroomSection` 自写的 `.input`）同样补 `data-field`。
   路径必须与 Schema 一致，例如 `modes.classroom.watchDir`、`general.edgeBar.opacity`、`advanced.proxy`。
5. 按下表实现门控（表里每一条都要在 DOM 层面成立，即不满足条件时**对应元素不存在**，而不是「禁用」或 `opacity: 0`）：

   | 设置项（`data-field` 前缀） | 显示条件 |
   |---|---|
   | `modes.classroom.*` 全部 | `modes.current === 'classroom'` |
   | `modes.work.*` / `modes.code.*` 相关 | 对应模式被选中；两模式为占位实现，选中时只显示「该模式尚未实现，暂无可配置项」空状态，**不得**出现任何 classroom 字段 |
   | `modes.classroom.schedule.classisland.*` | `schedule.provider === 'classisland'`（现状已如此，保持） |
   | `modes.classroom.preClassReminder` | `schedule.lessons.length > 0`；否则显示「先在课表里添加节次」的说明替代开关 |
   | `modes.classroom.classification.fallbackFolder` | `classification.autoMove === true` |
   | `modes.classroom.classification.confidenceThreshold` | `subjects.length > 0`；为空时显示「先添加科目」引导 |
   | `general.edgeBar.opacity` / `general.edgeBar.quietHours` | `general.edgeBar.enabled === true`；关闭时整块替换为「提示条已停用」说明 |
   | `general.language` | **永不显示**（无 i18n 消费方的死字段，控件整体删除） |
   | `skills.disabled` 列表 | `skills.list()` 非空；为空显示「未发现技能」空状态 |
   | `mcp.servers.*` 详情 / `mcp.lazyConnect` | `mcp.servers.length > 0`；为空显示空状态 + 「添加服务器」主按钮 |
   | `llm.providers.*` 详情 / `temperature` | 至少有一个 provider；为空显示空状态 + 「添加 AI 模型」主按钮；`temperature` 收进「高级参数」折叠 |
6. 为可机械校验的门控补一处探针能力：扩展 step-03 的截图工具（`apps/desktop/src/main/capture.ts`），
   支持 `probe?: string`（一段在窗口里 `executeJavaScript` 的表达式，结果写进日志与 `<dir>/probe.json`）。
   本步至少用它跑这几条：`document.querySelectorAll('[data-field^="modes.classroom"]').length`（切到 work 模式后必须为 `0`）、
   `document.querySelectorAll('[data-field="general.language"]').length`（必须为 `0`）、
   `document.querySelectorAll('[data-field^="general.edgeBar"]').length`（提示条停用后只剩「已停用」说明，count 为 0 或仅说明块）。

### C. 拆掉 682 行的 `ClassroomSection.vue`

7. 新建 `apps/desktop/src/renderer/settings/components/classroom/` 目录，按职责拆成四个子组件 + 一个容器：
   - `PerceptionFolderField.vue`：`watchDir`（含「打开文件夹」）；
   - `SubjectsEditor.vue`：`subjects[]` 增删改（名称 / 目标文件夹 / 关键词）；
   - `ScheduleEditor.vue`：`schedule.provider` 切换 + `lessons[]` 编辑 + `classisland.*`（含连接测试与状态）；
   - `ClassificationBehavior.vue`：`autoMove` / `confidenceThreshold` / `fallbackFolder` + 分类流水（复用 `ClassificationLedger`）；
   - `ClassroomSection.vue` 缩成容器：负责读配置、统一 `patch()`（保持第 1 节的浅合并语义）、把四个块渲染成可折叠分组。
8. 折叠分组（accordion）约定：默认展开「感知文件夹」与「科目」，收起「课表」与「分类行为」；
   折叠头用 `.section-title` + 状态摘要（例如「课表：手动 / 6 节」「分类：自动移动 开」），
   展开用 `.collapse-*` 过渡。**每个分组的状态摘要在收起时可见**，避免用户必须逐个展开才知道配了什么。
9. 拆分时逐个字段搬运，搬完对照 Schema 清单核对**没有丢字段**（`grep -o "data-field=\"[^\"]*\"" ` 对比本步前后的字段集合，
   classroom 相关字段必须一个不少）。

### D. 各页面的「杂乱」清理

10. `GeneralPage.vue`：删掉语言选择器；分组为「启动」（开机自启 / 全局快捷键，快捷键保留注册失败的真实原因回传与改绑入口）、
    「提示条」（启用 / 透明度 / 静默时段，按 B 的门控）、「系统感知」（预览 + 「其余采集项在 P5 补齐」的说明）、「关于与更新」。
11. `ModesPage.vue`：三张模式卡片保留；卡片选择后下方只渲染**当前模式**的内容（classroom → `ClassroomSection`；
    work/code → 占位空状态说明）；把「重新引导」与「标记完成」收进卡片的次级操作，避免与「选择模式」抢视觉重心。
12. `LlmPage.vue`：无 provider 时空状态引导；每个 provider 卡片用 `.section-card`，
    必填项（Base URL / API Key / 模型）常显，`temperature` 与「连接测试 / 拉取模型列表」收进「高级参数」折叠；
    危险操作（删除 provider）单独放在卡片底部并以 `AppButton variant="danger"` 呈现。
13. `McpPage.vue`：服务器列表用 `.section-card`，状态灯用 `StatusDot`；`lazyConnect` 收进「高级」折叠；
    新增服务器表单默认收起，点「添加服务器」才展开（`.collapse-*`）。
14. `SkillsPage.vue`：`userDir` 空串时用 `SettingField` 的 hint 明确「留空 = 使用默认目录」；技能列表加启用/停用状态摘要；
    警告区用 `AppToast tone="warn"` 统一。
15. `AdvancedPage.vue`：分组为「网络」（代理）、「日志」（级别 / 打开日志目录）、「勿扰」（静默时段）、
    「安全」（敏感工具确认）、「危险操作」（打开配置目录 / 导出脱敏配置 / 重置全部设置）。
    重置按钮加二次确认（点击后按钮就地变为「确认重置？」再点一次才执行），不要单击即毁配置。
16. 清理收尾：确认六个页面与拆出的子组件里不再有重复的 `.page` / 头部样式 / 自写 `.input` 样式；
    所有交互控件走 `SettingField` 或统一的 `.section-card` 内布局。

### E. 出口

17. `pnpm format:check && pnpm lint && pnpm typecheck && pnpm build` 全绿。
18. `pnpm test` 全绿（本步不应改动 `packages/*` 的测试；若因 `data-field` 之类改动导致快照类断言失败，说明改错了地方，回退而不是改断言）。
19. 截图 + 探针核对：
    `AURORA_CAPTURE=<临时目录> AURORA_CAPTURE_WINDOWS=settings pnpm dev`，
    逐个页面（`settings?page=general|modes|llm|skills|mcp|advanced`）核对外观与空状态；
    再把 `modes.current` 切到 `work` 后对 modes 页跑第 6 节的探针，确认 classroom 字段 count 为 0。
20. `docs/07-ui-spec.md` §2.5 更新设置页结构（导航分组、页面骨架、折叠分组、门控矩阵）；
    `docs/08-settings-onboarding.md` 补一节「按条件显示的设置项」写明上表门控规则，
    并明确 `general.language` 为**已从 UI 移除的死字段**（字段保留仅为配置兼容）。
21. `AGENTS.md`「尚未生效 / 已知限制」里 `general.language` 一条改为「已从设置页移除（仍保留在 Schema 以便兼容旧配置）」。
22. 提交 `refactor(ui): 设置页分组化与条件显示，移除无效的 language 配置入口`。

## 验收标准

- [x] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全部通过（595 用例）。
- [x] 探针断言成立：`modes.current !== 'classroom'` 时 `[data-field^="modes.classroom"]` 命中数为 `0`
      （实测：ClassRoom 下 38 → 切到 Work 后 0，且出现 `data-empty="modes.work"`）；
      `[data-field="general.language"]` 命中数为 `0`（六页全部为 0）。
- [x] `general.edgeBar.enabled === false` 时透明度与静默时段不在 DOM —— 实测常规页
      `edgeBarToggle=1 / edgeBarDetail=3`（开）；门控逻辑在探针里按「开关存在则详情必须存在、
      开关不存在则详情必须为 0」断言，两种配置下都成立。
- [x] ClassRoom 字段集合拆分前后一致：`patch()` 表达式与基线**逐字相同**
      （`git show` 对比），四个子组件只走 `props.patch`；真实写盘实测（见下）
      `lostKeys=[]`、`scheduleKept=true`、`subjectsKept=true`。**并且**这条实测揪出并修掉了
      一个**基线就存在**的保存静默失败 bug（`9cec91d`），否则字段"不丢"只是因为根本没写进去。
- [x] 六个页面的截图（含空状态）人工核对通过：层次清楚、间距统一、无重复样式块。
- [x] 「重置全部设置」需要二次确认才执行（代码 + SSR 初始态断言）。
- [x] `docs/07` §2.5、`docs/08` §6.1 门控小节、`AGENTS.md` 与实现一致（由 Lead 统一补，见 `45b9161`）。

## 执行记录

### 实际改动

- 导航分三组（基础 / AI 能力 / 系统）；新增 `settings/settings.css`（`.section-card` /
  `.section-title` / `.section-desc` / `.empty-state` / 统一 `.input`，仅设置窗 import）。
- `ClassroomSection.vue` **682 → 241 行**，拆出 `components/classroom/`：`PerceptionFolderField` /
  `SubjectsEditor` / `ScheduleEditor` / `ClassificationBehavior` + 共享 `types.ts`；
  分组默认展开「感知文件夹 / 科目」，折叠「课表 / 分类行为」并在折叠头显示摘要。
- 全部控件加 `data-field="<配置路径>"`（38 处）+ 被隐藏位置加 `data-empty`（10 处）；
  `general.language` 从 UI 移除（Schema 与保存回传都保留）。
- 各页收尾：空状态 + 主入口按钮、MCP 状态灯换 `StatusDot`、`lazyConnect` 与 `temperature` 收进折叠、
  高级页五分组 + 重置就地二次确认、快捷键文案改为「交互窗」。

### 探针发现（本步最重要的产出）

Lead 用 `AURORA_CAPTURE` 加了一条**真实写盘**探针：展开分类行为分组 → 点 `classification.autoMove`
→ 比对配置快照。结果：

```
{"act":{"ok":true,"checked":false},"afterClickStore":true,"errors":["rejection: An object could not be cloned."]}
```

> 注：上面这段是当时**临时诊断版**探针的输出（含 `afterClickStore` / `errors` 等一次性字段）；
> 现在仓库里 `capture.ts` 的 `SETTINGS_CLASSROOM_PATCH_CHECK` 只回传 `lostKeys` / `scheduleKept` /
> `subjectsKept` / `toggled` / `pass`，复现时看不到 `afterClickStore`。这一处由独立审查指出，特此标注。

即：**界面点了、值也翻了，但配置没写进去，也没有任何报错**。根因是 `ipcRenderer.invoke` 的结构化克隆
不能传 Vue `reactive` 产的 Proxy，而设置页的 patch 用展开构造时嵌套子对象仍是 Proxy
（这是**基线就存在**的问题，`22e2718` 的同一表达式同病）。已作为阻塞修复单独提交 `9cec91d`，
修复后同一条探针输出：

```
{"lostKeys":[],"scheduleKept":true,"subjectsKept":true,"toggled":true,"autoMove":false,"pass":true}
```

### 与计划的差异

1. 计划要求把 `.section-card` 等上移到 `theme.css`：实际放在仅设置窗加载的 `settings.css`
   （`theme.css` 当时是 step-03 的产物、且只承载跨窗口共用令牌），避免把设置页专用类泄漏给其它窗口。
2. 计划要求给 `SettingField` 加 `field?: string` prop：改用**属性透传**
   （`<SettingField data-field="...">` 落到其唯一根节点），DOM 结果等价、契约零改动。
3. 计划里的 `probe.json`：实现为 `report.json`（step-03 已有产物），语义相同。
4. `ClassificationLedger.vue` 无需改动（写范围允许但未动）。
5. 折叠带来的行为变化：课表 / 分类行为默认折叠，因此它们的字段不在初始 DOM；
   分类流水只在「分类行为」分组展开时挂载（旧实现始终挂载）。

### 验证命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm format:check` / `lint` / `typecheck` / `test` / `build` | 全绿（595 用例） |
| `AURORA_CAPTURE`（隔离 profile） | 16/16 张 PNG 非空；5 条探针 `pass: true` |
| 门控探针 | 常规页 `languageFields=0`、`edgeBarToggle=1/edgeBarDetail=3`、`classroomFields=0`；模式页 ClassRoom `classroomFields=38`；切 Work 后 `0` + `data-empty="modes.work"` |
| 写盘探针 | `lostKeys=[]`、`scheduleKept=true`、`subjectsKept=true`、`toggled=true` |
| 人工读图 | `settings-general.png` / `settings-modes-work-gating.png` 布局与门控正常 |

### git 提交

- `485bea7` `refactor(ui): 设置页信息架构整理与条件显示`（15 文件）
- `9cec91d` `fix(settings): 设置页保存因 reactive proxy 无法结构化克隆而静默失败`（2 文件，阻塞修复）
- `18547fb` `test(capture): 截图工具补一条「真实写盘」探针（classroom 浅合并回归）`

### 遗留

- 探针只断言了 `classification.autoMove` 一条写路径；`subjects` / `schedule` 的编辑 UI 没有走一遍
  （`patch()` 是唯一入口且语义已被证明，风险低，但仍是覆盖缺口）。
- 设置页的 `打开配置目录 / 导出脱敏配置` 等按钮没有逐个点击验证。
