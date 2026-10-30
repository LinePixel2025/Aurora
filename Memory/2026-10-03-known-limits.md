---
date: 2026-10-03
title: 已移除的功能、未生效的字段与「别误当 bug」的既有行为清单
tags: [口径, 坑, 窗口, 工具, 模型]
source: 模型自动记录
---

# 尚未生效 / 已知限制（别误当成 bug）

## 现象

1. 全局快捷键默认 `Alt+Space` 注册失败（Windows 系统窗口菜单键占用）。
2. 提示条可穿透性（`setIgnoreMouseEvents`）未接入；`general.language` 是死字段（无 i18n 消费方，设置页 / 引导页已移除，Schema 保留仅为兼容旧配置）。
3. AI 悬浮窗（service-dock）已移除（v3→v4 清 `general.windowState['service-dock']`）。
4. 独立小窗（mini-chat）已删除（v5→v6 清 `general.windowState['mini-chat']`）；标题栏是 Windows 式 caption，「关闭」= 隐藏窗口（流式回复不中止），「最小化」真最小化。
5. 「快速对话」（`sessionId = quick`）只从主界面左栏固定项进入；提示条面板的快速对话已移除，入口只剩 3 个。
6. 未配置 STT provider 时麦克风按钮**根本不渲染**（不是 disabled）：`stt.enabled` + `stt.active` 指向 `baseUrl` / `model` 齐全的 provider 才渲染（`data-field="chat.mic"`）；TTS「朗读」同款。
7. **门控口径两组相反**：电脑操控工具（含 `edit_file` / Office / `grep` / `glob`）受 `agent.tools.enabled` 总开关与子开关；扩展工具**八件套**（`web_fetch` / `notify_user` / `notify_banner` / `clipboard_*` / `generate_image` / `show_preview` / `show_image`）**不受**总开关；`todo_*` / `task` 也不受门控。
8. Code Mode 是占位实现；Work Mode 已初步实装（guide + systemPrompt）。
9. `integrations/classisland-bridge` 不参与 CI 编译（流水线没有 .NET SDK）。
10. 办公文件已有 `office_read/help/create/edit/render/pdf/raw_edit` 七件专用工具，走 utilityProcess 中固定版 OfficeCLI；旧格式与复杂 COM 能力仍是显式兜底。
11. Markdown 渲染 P3（目录 / 折叠 / 脚注 / 引用 chip）尚未落地，唯一副本在 `git stash@{0}`。

## 原因

- 第 1 条是预期路径：`hotkey.ts` 会把真实原因回传设置页，用户改绑即可 —— 不要「修」成静默成功。
- 第 6 条是文档门控口径（docs/07 §2.3），不是渲染 bug。
- 第 7 条容易搞反：八件套不走总开关，敏感项进 `sensitivity: 'confirm'` 确认链；`edit_file` 随 `files.enabled`、`grep` / `glob` 随 `search.enabled`；`todo_*` / `task` 是 Agent 自身的工作能力。
- 第 10 条：读写都已有专用工具（不再需要起 `run_command` 绕）；旧格式（`.doc` / `.xls`）与非 OfficeCLI 能力才是兜底。
- P3 未落地是整套改动暂缓（用户口径），不是遗漏。

## 影响

- 把注册失败改成静默成功、把未渲染的按钮当成渲染 bug、给八件套加上总开关门控，都是把预期行为「修」成缺陷。
- 把 `git stash@{0}` 当废物清掉会永久丢失 P3 的实施。

## 结论与做法

- 按上面口径理解现状；改动相关代码前先确认它是不是「按设计的缺失」。
- MCP HTTP 传输已支持自定义请求头（`mcp.servers.<id>.headersEnc`，凭据链路与 env 同款）。
- `integrations/classisland-bridge` 已用真实程序集本机编译并实跑验证；改动后在有 .NET SDK 与 ClassIsland 的机器上重验（程序集在 `app-<版本>/` 子目录）。
- ClassIsland 桥接读取有默认路径回落（`%APPDATA%\ClassIsland\aurora-bridge\schedule.json`），读取失败按「错误是否变化」分级记日志。
- Skill 的 `scripts/` 永不自动执行；本地 OCR 未启用，自感知图片走视觉模型，关闭 vision 时降级为文件名 / 尺寸 / 格式元数据。多语言、ARM64 / 便携版、macOS / Linux 未开始。
- Work Mode 的 `modes.work.workspaceDir` 已接进工具执行链的统一回落链（见 `Memory/2026-10-03-permissions-and-project-root.md`）。
- **清 `git stash@{0}` 前先落地或转分支**（`git stash list` 可验；7 文件、约 329 行）。
