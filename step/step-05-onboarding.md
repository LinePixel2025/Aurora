# Step 05 — 引导页与完成状态

- Task: aurora-visual-themes
- Step: 5 / 8
- Status: done
- Depends on: step 4
- Produces: 引导四步骤、主动作和完成页的克制深色视觉
- Phase: 集成
- Writes: `apps/desktop/src/renderer/onboarding/App.vue`；`apps/desktop/src/main/capture.ts`；`docs/07-ui-spec.md`（仅新增引导截图场景及 §5.3 对应说明）
- Risk: 加大留白可能压缩 720×560 窗口的表单与底部按钮；通过整页截图核对，不改窗口尺寸。

## 目标

在沿用现有流程的前提下，让引导页成为共享设计系统的展示窗口，并保持单一主动作和可用的步骤切换。

## 输入

- 读 `docs/07-ui-spec.md` §2.6/§5、`docs/08-settings-onboarding.md` §3、`apps/desktop/src/renderer/onboarding/App.vue`、`apps/desktop/src/renderer/shared/components/{AppButton,SettingField,AppToast}.vue`。
- 读 `.dsh/skills/aurora-design-system/references/window-playbook.md` §4；流程仍是欢迎 → AI 模型 → 模式选择 → 完成，模型测试/目录选择进行中态与错误 Toast 保留；标题栏有至少 32px 可见拖动区。

## 操作

1. 将分区留白、正文行高、步骤标题与主 CTA 统一为 Step 01-04 的令牌；完成页的极光渐变仅用于 hero/品牌标识，所有动作按钮 pill。
2. 保留 `sheet-next`/`sheet-prev` 方向、四步流转、异步状态和拖动区；新动画用 `--dur-*` + `--ease-*`，保留 reduced-motion 全局降级。
3. 当前 `apps/desktop/src/main/capture.ts:1676` 只有 `onboarding.png`。先在 `docs/07-ui-spec.md` §5.3 写四阶段截图口径，再于 `capture.ts` 增加欢迎、AI 模型、模式选择、完成四个独立 `CaptureTarget` 的 `act` 与 `check`：在隔离 userData 下通过引导界面既有按钮/表单按顺序前进，每一阶段截图后 `check` 验证当前步骤、主动作可见且在窗口内；失败要返回明确原因，不把离线连接测试伪装成功。禁止改变生产引导流程或凭据；如果流程需配置先在隔离配置/IPC 完成有效前置。逐张查看四阶段 PNG。

## 验收标准

- [ ] `pnpm typecheck` 和 `pnpm build` 退出 0；`onboarding/App.vue` 没有新加硬编码时长和外链字体，欢迎/模型/模式/完成四步及标题栏拖动结构保留。
- [ ] PowerShell：`$env:AURORA_CAPTURE="$env:TEMP\aurora-capture-onboarding"; $env:AURORA_CAPTURE_WINDOWS='onboarding'; pnpm dev` 退出 0；`report.json` 有 PNG，全部 `checks.ok` 为 true、有 `result.pass` 的为 true。
- [ ] `report.json` 中可按文件名识别欢迎、AI 模型、模式选择、完成四个阶段，四条检查均返回 `pass:true` 与实际阶段标识；四张 PNG 中主 CTA 未被 720×560 窗口裁切，表单不溢出，完成页渐变只作 hero 点缀；`docs/07-ui-spec.md` §5.3 说明阶段断言。

## 交接

深色四窗完成后，Step 06 在这份稳定基线上添加随系统切换的浅色主题。

## 执行记录

2026-09-25：与计划前提相比，现有 UI 实为五段（额外包含“模式设置”）。主代理先更新 `docs/07-ui-spec.md` §2.6/§5.3 为五段逐阶段截图与 CTA 断言；两个互不交叠子代理分别修改引导窗样式及 `main/capture.ts` 五阶段真实按钮脚本。捕获在隔离 userData 使用本地预设与占位 key，未触发网络连接测试；沿真实 UI 从欢迎推进到模式设置并点“稍后设置”，每阶段断言进度标识、标题、主 CTA 的可见、位置与命中。主代理审阅 diff、`pnpm typecheck` 与 `pnpm build` 均退出 0、Prettier 与 `git diff --check` 通过。首次捕获期间 HMR 更新，未作为最终证据；写入稳定后重新捕获退出 0，`%TEMP%\aurora-capture-onboarding-final` 的 5 图/5 检查均 `ok:true, pass:true`，逐张接触图检查无 CTA 裁切、表单溢出或糊字，完成渐变只在品牌标记/标题。提交 `f67bb9d`。
