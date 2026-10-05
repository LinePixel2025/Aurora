---
date: 2026-10-03
title: 已移除的功能、未生效的字段与"别误当 bug"的既有行为清单
tags: [限制, 状态, 坑]
source: 模型自动记录
---

# 尚未生效 / 已知限制（别误当成 bug）

## 现象

1. **全局快捷键默认 `Alt+Space` 注册失败**。
2. 提示条的**可穿透性**（`setIgnoreMouseEvents`）未接入；`general.language` 是死字段（无 i18n 消费方），
   **已从设置页与引导页移除**（Schema 里保留字段仅为兼容旧配置，改它不生效）。
3. **AI 悬浮窗（service-dock）已移除**（配置迁移到 v4：`v3 → v4` 删除 `general.windowState['service-dock']`），
   常驻入口为提示条 + 托盘。
4. **独立小窗（mini-chat）已删除**（迁移到 v6：`v5 → v6` 删除 `general.windowState['mini-chat']`）；
   2026-09 重构起标题栏是 Windows 式 caption 按钮 ——「关闭」= **直接隐藏窗口**（正在进行的流式回复不中止），
   「最小化」真最小化进任务栏；「快速对话」（`sessionId = quick`）只从主界面左栏固定项进入
   （提示条面板的快速对话已于 2026-10-05 移除），历史会话列表在左栏，提示条面板操作入口
   由 4 个减为 3 个。
5. **未配置 provider 时连麦克风按钮都不渲染**（不是 disabled）：`stt.enabled` + `stt.active` 指向一个
   `baseUrl` / `model` 齐全的 provider **才渲染**（`data-field="chat.mic"`）；TTS「朗读」按钮同款口径。
6. **电脑操控工具受 `agent.tools.enabled` 总开关门控**（现含 Office 专用工具），而**扩展工具六件套不受门控** —— 两组口径相反。
7. **Code Mode 是占位实现**；Work Mode 已初步实装（guide + systemPrompt）。
8. **`integrations/classisland-bridge` 不参与 CI 编译**（流水线没有 .NET SDK）。
9. 办公文件已有 `office_read` / `office_create` / `office_edit` 专用工具；旧格式与复杂 COM 能力仍是显式兜底。
10. **Markdown 渲染 P3 尚未落地**。

## 原因

- 第 1 条是预期路径：`Alt+Space` 在 Windows 上常被系统占用（系统窗口菜单键），
  `apps/desktop/src/main/hotkey.ts` 会把真实原因回传设置页，用户改绑即可 —— **不要"修"成静默成功**。
- 第 5 条是文档门控口径（docs/07 §2.3），不是渲染 bug。
- 第 6 条容易搞反：「扩展工具六件套」（`web_fetch` / `notify_user` / `clipboard_read` / `clipboard_write` /
  `generate_image` / `show_preview`）**不走** `agent.tools.enabled`，敏感项进入 `sensitivity: 'confirm'`
  确认链，是否弹卡由权限档与项目边界决定；
  而 2026-09 新增的 `edit_file` / `grep` / `glob` 与它们**同期但不同组**：是电脑操控工具、受总开关门控
  （`edit_file` 随 `files.enabled`、`grep` / `glob` 随 `search.enabled`，见 docs/06 §11.5 / §11.6）。
  同理，`todo_write` / `todo_read` / `task`（v9 起由 `registerAgentCoreTools` 注册，docs/06 §18 / §19）
  也**不受 `agent.tools.enabled` 门控**。
- 第 9 条：**读**只走附件提取管线（`apps/desktop/src/main/extract.ts`，officeparser；纯文本 + 8KB 截断、
  无表格结构、无 OCR、`.doc` / `.xls` 不支持），**且没有暴露成 Agent 工具** —— 模型无法主动"打开这个 docx 看看"，
  只能起 `run_command` 绕；**写零专用工具**：唯一路径是 `run_command` + PowerShell COM
  （配方在 `skills/office-work/SKILL.md`），**强依赖本机装了 Office**（`packages/agent-core` 里没有任何 office 依赖 / 工具）。

## 影响

- 上面前几条"不生效"都是**设计**：把注册失败改成静默成功、把未渲染的按钮当成渲染 bug、给六件套加上总开关门控，
  都是把预期行为"修"成缺陷。

## 结论与做法

- 按上面的口径理解现状；**改动相关代码前先确认它是不是"按设计的缺失"**。
- MCP HTTP 传输已支持自定义请求头（含鉴权头，`mcp.servers.<id>.headersEnc`，凭据链路与 env 同款，见 docs/08 §1）。
- `integrations/classisland-bridge` 已用 ClassIsland 2.1.0.1 的真实程序集在本机编译并实跑验证过
  （见该目录 README 的「已验证程度」），改动后请在装有 .NET SDK 与 ClassIsland 的机器上重新验证：
  `dotnet build -c Release -p:ClassIslandDir="<ClassIsland 安装目录>"`。
  注意 ClassIsland 的程序集**不在**安装根目录，而在 `app-<版本>/` 子目录（csproj 会自动往下一层找）。
- ClassIsland 桥接读取有**默认路径回落**（v0.2.4）：文件源端点读取失败时自动按插件默认输出
  `%APPDATA%\ClassIsland\aurora-bridge\schedule.json` 重试一次（`apps/desktop/src/main/index.ts` 注入
  `fallbackFilePath`，`classisland.ts` 只收参数、不碰 Electron），成功则告警提示对齐两端配置；
  默认路径常量别散落第二份。
  读取失败按「错误是否变化」分级记日志（变化才 warn，持续同一错误 debug），别改回全量 warn。
  ⚠️ 旧 AGENTS.md 里这个路径被写成了 `%APPDATA%\ClassIslandurora-bridge\...`（少了一个反斜杠），
  别照抄那份错字。
- Skill 的 `scripts/` 永不自动执行（只注入指令正文）；本地 OCR 未启用。自感知图片走视觉模型，
  关闭 vision 时才降级为文件名 / 尺寸 / 格式元数据。
  多语言、ARM64 / 便携版、macOS / Linux 未开始。
- Work Mode 的 `modes.work.workspaceDir` 自 v0.2.4 起已接进工具执行链的统一回落链，不再是死字段
  （见 `Memory/2026-10-03-permissions-and-project-root.md`）。
- **Markdown 渲染 P3（标题目录 / 折叠 / 脚注 / 引用 chip）尚未落地**：唯一副本在 `git stash@{0}`
  （7 文件、约 329 行插入；仓库里没有脚注实现）—— **清 stash 前先落地或转分支**，否则永久丢失。
