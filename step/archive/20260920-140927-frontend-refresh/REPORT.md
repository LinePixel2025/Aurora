# REPORT — frontend-refresh（Aurora 前端刷新）

- 任务：优化 Aurora 前端（提示条呼出交互窗 / 删除 AI 悬浮窗 / Apple 风格重构 / 设置页整理）
- 项目根目录：`D:/AICOP/Projects/Aurora`
- 基线提交：`22e2718`（任务开始前的 HEAD）
- 归档于：**2026-09-20 14:09**
- 归档路径：`step/archive/20260920-140927-frontend-refresh`
- 结果：**7 个工作步骤全部 done**；16 条提交；独立代码审查结论「有条件可交付，P0 无」，
  3 条 P1 + 2 条 P2 已修并复验

## 归档后补记（2026-09-20 14:17）

归档后用户要求「打开软件」，用**真实** `%APPDATA%/Aurora/config.json` 启动时发现应用**起不来**：

```
ERROR 启动失败 invalid_enum_value: general.windowState.service-dock
```

- 根因：`sanitizeWithDefaults` 对动态键路径不校验键，已删除窗口的键活到 `SettingsSchema.parse` 硬抛；
  迁移链只在 `version < CONFIG_VERSION` 时运行，兜不住「声明已是 v4、却仍留着 `service-dock`」的状态；
  且 parse 抛错没有兜底（文档写的「备份后重建默认」只覆盖 JSON 解析失败）。
- 修复：`01d2475` `fix(config): 残留已下线窗口几何会让应用启动失败，改为读盘时自动修复`
  （读盘时按 `WINDOW_NAMES` 摘掉未知键并立刻落盘 + `SettingsSchema.parse` 失败走备份重建路径 + 单测）。
- 复现验证：把损坏态放回真实配置 → 启动 → `清理已下线窗口的几何记录 {"retired":["service-dock"]}` →
  正常就绪 → 磁盘配置里的 `service-dock` 消失，用户模型 / 科目 / 感知文件夹全部保留。
- 修复后门禁：`format:check` / `lint` / `typecheck` / `test`（**598 用例**）/ `build` / `verify`（26/26）全绿。
- 因此本次任务的提交总数为 **17 条**（`22e2718..01d2475`）。

## 三条原始诉求的达成证据

1. **提示条点击呼出交互窗 + 删除 AI 悬浮窗**
   - 真实 Electron DOM 探针：点击竖条后 `{"chatVisible":true,"miniChatVisible":false,"primary":"chat"}`；
     悬停展开面板 4/4 按钮 `elementFromPoint` 命中（`allClickable:true`），面板内容区 220px 不裁切。
   - `service-dock` 全类型残留扫描（**含 markdown**）只剩迁移本体与历史/需求文档文本；
     `apps/desktop/out/renderer/` 与 `src/renderer/` 均只有 5 个窗口；
     `window:setDockExpanded` 六处契约同步删除，新增 `window:setEdgeBarExpanded`。
   - 配置 `CONFIG_VERSION` 3 → 4，`v3 → v4` 迁移只删 `general.windowState['service-dock']`，
     幂等且保留其它窗口几何（单测断言到 `Object.keys(windowState)` 级别）。
2. **前端 Apple 风格 + 交互动画**
   - `apps/desktop/src/renderer/shared/theme.css` 重写为令牌体系（品牌 / 分层填充 / 字号阶梯 / 圆角 /
     材质 / 阴影 / 缓动与时长），**既有令牌名一个没删**；`.glass` / `.interactive` / `.anim-*` /
   `.sheet-*|rise-*|fade-*|collapse-*` 五窗共用；`prefers-reduced-motion` 全局兜底 + 组件局部降级两层。
   - 9 张关键截图逐张读图确认视觉同源；docs/07 §5 记录令牌表与动效规范。
3. **设置页整理 + 不显示无法设置的内容**
   - 侧栏分三组；`ClassroomSection.vue` 682 → 241 行并拆成 4 个子组件；控件带 `data-field="<配置路径>"`，
     条件不成立时**不在 DOM**，原位置改为 `data-empty` 说明。
   - 探针实测：常规页 `languageFields=0`、`edgeBarToggle=1/detail=3`；模式页 ClassRoom `classroomFields=38`，
     切到 Work 后 **0** + `data-empty="modes.work"`。门控矩阵见 docs/08 §6.1。

## 验证结论

| 检查 | 结论 |
|---|---|
| `pnpm format:check` / `lint` / `typecheck` / `test` | 全绿（**597 用例**） |
| `pnpm build` | 成功；`out/renderer/` 只有 5 个窗口 |
| `pnpm verify`（真实磁盘配置层） | **26/26**；`version=4`、迁移链 `count=4/4` |
| `AURORA_SMOKE=1 pnpm dev` | **93/93 passed**，0 FAIL；日志中 `service-dock` 命中 0 |
| `AURORA_CAPTURE`（16 张 PNG + 5 条 DOM 探针） | 16/16 非空、5/5 `pass: true`、退出码 0；不带 `AURORA_SMOKE` 也自动隔离 userData |
| v3 → v4 迁移幂等 | 是（单测覆盖删键 / 保留其它几何 / 保留 `general.language` / 重复执行一致 / 缺分组不抛错） |

## 执行阶段揪出并修掉的 4 个真 bug（都不是顺手改，是验收要求）

1. `8aeba60` 提示条展开态只加宽不增高 → 4 个操作按钮落在可视区外（"看得到面板却点不到"）。
2. `9cec91d`（**基线既有**）设置页保存静默失败：`ipcRenderer.invoke` 的结构化克隆不能传 Vue
   `reactive` 产的 Proxy，patch 的嵌套子对象全是 Proxy → 整次保存以 unhandled rejection 失败，
   既不写盘也不报错。
3. `e443a9e`（**基线既有**，独立审查发现）`chat:send` 的 `attachments` 同类问题 → 拖入附件发送必失败，
   且输入区永久卡在「流式中」。两处统一改走 `deepClone` 并补单测钉住「Proxy 不可克隆」。
4. `0d91eef` 自测夹具 `endTime` 分钟溢出手算 → 三条断言在一天中大部分时段假失败（掩盖真实回归）。

## 独立代码审查（只读代理，范围 `22e2718..HEAD`）

结论：**有条件可交付**，P0 无。条件与处置全部完成：

- **P1-1** `docs/01` / `02` / `10` / `11` / `README.md` / `docs/README.md` 仍把已删除的服务窗写成现存能力
  → 已修（`02551db`）；并把「残留扫描必须含 markdown」写进 step-07。
- **P1-2** `AURORA_CAPTURE` 单独运行会改真实用户配置（切模式 / 翻开关）→ 已修（`4a4a0f3`）：
  `AURORA_CAPTURE` 自身即隔离 userData 并在退出时删除。
- **P1-3** `chat:send` 附件 Proxy（见上）→ 已修（`e443a9e`）。
- **P2** 提示条悬停即写配置 + 展开态退出丢垂直居中 → 已修（`90e1486`）；
  `AURORA_CAPTURE` 退出码不反映探针结论 → 已修（`4a4a0f3`）。
- 审查同时确认无问题：service-dock 清理彻底、IPC 六处契约一致、迁移幂等、浅合并不丢字段、
  定时器无泄漏、reduced-motion 两层覆盖、`v-html` 注入边界安全、`report.json` 无凭据、
  **测试未被削弱**。

## 已知残留（不阻塞交付，详见 step-07）

- **人工动效未闭合**：悬停/收起手感、流式「只有末尾光标在动」只能真机人眼确认（本轮无此条件）。
- 小窗不是透明窗 → `--radius-lg` 圆角与 `--shadow-2` 在桌面上不呈现为浮卡（docs/07 §2.4 已记）。
- 提示条展开态是全高（约 972px），空态中部偏空；`/`、`@` 补全浮层在代码里从来不存在。
- 提示条关闭后缺短路径入口（托盘菜单无"显隐提示条"，只能进设置页）；
  `deepClone` 的 `undefined` 语义只有注释无专门单测；写盘探针只覆盖一条路径。
- P3 清理项：`place:'anchor-dock'` 命名失真、`SPECS['edge-bar']` 宽高已是死值、
  `renderer/shared/window.ts` 整个是死模块（基线遗留）、硬编码语义色重复、关键帧时长未走令牌。
- `general.language` 仍保留在 Schema（避免再动一次配置版本），但已从设置页与引导页移除。

## 提交清单（`22e2718..HEAD`，16 条）

```
9296b56 refactor(ui): 移除 AI 悬浮窗（service-dock），常驻入口收敛为提示条
0d91eef fix(smoke): 课前提醒夹具的 endTime 分钟溢出导致自测假失败
b4e6d08 fix(ui): 提示条点击无法呼出交互窗，改为可展开面板并新增 setEdgeBarExpanded
8aeba60 fix(ui): 提示条展开态不增高，面板按钮被挤出可视区
7a280db feat(ui): 建立 Apple 风格设计令牌与动效体系，新增窗口截图核对工具
38d395f refactor(ui): 交互窗与小窗改用 Apple 风格设计令牌与动效
cf903f5 refactor(ui): 提示条与首次引导改用 Apple 风格设计令牌与动效
485bea7 refactor(ui): 设置页信息架构整理与条件显示
8d03e23 test(capture): 截图工具支持 DOM 探针与设置页门控断言
45b9161 docs: 同步前端刷新的 UI 规格、设置条件显示与已知限制
9cec91d fix(settings): 设置页保存因 reactive proxy 无法结构化克隆而静默失败
18547fb test(capture): 截图工具补一条「真实写盘」探针（classroom 浅合并回归）
e443a9e fix(chat): 拖入附件后发送失败，且输入区永久卡在「流式中」
90e1486 fix(ui): 提示条几何不再落盘，展开态对齐可自愈
4a4a0f3 fix(capture): 截图默认隔离 userData，退出码反映探针结论
02551db docs: 补齐服务窗删除后的文档残留（01 / 02 / 10 / 11 / README）
```

所有提交均未 push（`git status` 干净，仅本归档目录所在的 `step/` 为未跟踪）。
